// How library assets (characters, environments, outfits, poses) map onto a form's reference images, and the
// edits the pickers and chips make to that list – with the prompt's @ImageN and @AudioN tokens following their
// pictures and clips. Pure functions, shared by the params form and the generate view.

import {
  findAudioTokens,
  findImageTokens,
  findMalformedTokens,
  type PromptToken,
  type ReferenceKind
} from '@shared/prompt-refs'
import { maxReferenceAudios, maxReferenceImages, supportsAudioInput } from '@shared/models'
import type { Asset, GenerationParams, ReferenceAudio } from '@shared/types'
import { addAudios, audioSourcesByPath, referenceAudioOf, voiceOf } from './audioRefs'
import { imageCount } from './text'

/** Image path → the asset the photo belongs to. */
export function assetsByPath(assets: readonly Asset[]): Map<string, Asset> {
  const map = new Map<string, Asset>()
  for (const a of assets) for (const img of a.images) map.set(img.path, a)
  return map
}

export interface AssetRef {
  asset: Asset
  /** 1-based @ImageN numbers of the asset's photos among the reference images. */
  indices: number[]
}

/**
 * The assets among the reference images, in order of first appearance. Images past the model's limit aren't
 * sent, so they get no @ImageN number here.
 */
export function assetRefsOf(refs: readonly string[], byPath: ReadonlyMap<string, Asset>, max: number): AssetRef[] {
  const out: AssetRef[] = []
  refs.forEach((path, i) => {
    const asset = i < max ? byPath.get(path) : undefined
    if (!asset) return
    const entry = out.find((r) => r.asset.id === asset.id)
    if (entry) entry.indices.push(i + 1)
    else out.push({ asset, indices: [i + 1] })
  })
  return out
}

/** A character's default outfit, if it has one that still exists. */
export function defaultOutfitOf(character: Asset, byId: ReadonlyMap<string, Asset>): Asset | undefined {
  if (character.kind !== 'character' || !character.defaultOutfitId) return undefined
  const outfit = byId.get(character.defaultOutfitId)
  return outfit?.kind === 'outfit' ? outfit : undefined
}

/**
 * Who wears each outfit in the form: outfit id → character id. `chosen` holds the "bärs av" choices made in
 * the form (null = nobody); a choice naming a character that is no longer there falls back to the default:
 * the character whose default outfit it is, else the only character present.
 */
export function resolvePairings(
  assetRefs: readonly AssetRef[],
  chosen: Readonly<Record<string, string | null>>
): Map<string, string> {
  const characters = assetRefs.filter((r) => r.asset.kind === 'character').map((r) => r.asset)
  const present = new Set(characters.map((c) => c.id))
  const pairings = new Map<string, string>()
  for (const { asset } of assetRefs) {
    if (asset.kind !== 'outfit') continue
    const choice = chosen[asset.id]
    if (choice === null) continue
    if (choice !== undefined && present.has(choice)) {
      pairings.set(asset.id, choice)
      continue
    }
    const owner =
      characters.find((c) => c.defaultOutfitId === asset.id) ?? (characters.length === 1 ? characters[0] : undefined)
    if (owner) pairings.set(asset.id, owner.id)
  }
  return pairings
}

/** The outfits a character wears in the form, in reference order. */
export function outfitsWornBy(
  characterId: string,
  assetRefs: readonly AssetRef[],
  pairings: ReadonlyMap<string, string>
): AssetRef[] {
  return assetRefs.filter((r) => r.asset.kind === 'outfit' && pairings.get(r.asset.id) === characterId)
}

/** A new reference list, and a note when not everything fitted. */
export interface RefsChange {
  refs: string[]
  note?: string
}

function fitNote(added: number, wanted: number, max: number): string | undefined {
  if (added >= wanted) return undefined
  return added
    ? `${added} av ${wanted} bilder fick plats – modellen tar max ${max}.`
    : `Det finns inte plats för fler bilder – modellen tar max ${max}.`
}

/** Appends the paths that aren't there yet, as many as fit under the model's limit. */
export function addPaths(refs: readonly string[], paths: readonly string[], max: number): RefsChange {
  const wanted = [...new Set(paths)].filter((p) => !refs.includes(p))
  const added = wanted.slice(0, Math.max(0, max - refs.length))
  return { refs: [...refs, ...added], note: fitNote(added.length, wanted.length, max) }
}

/**
 * Appends an asset's photos. A character brings its default outfit along when all of that outfit's photos
 * fit too; half an outfit would only confuse the model, so otherwise the note says it was left out.
 */
export function addAsset(
  refs: readonly string[],
  asset: Asset,
  byId: ReadonlyMap<string, Asset>,
  max: number
): RefsChange {
  const own = addPaths(
    refs,
    asset.images.map((img) => img.path),
    max
  )
  const outfit = defaultOutfitOf(asset, byId)
  const missing = outfit?.images.map((img) => img.path).filter((p) => !own.refs.includes(p)) ?? []
  if (!outfit || !missing.length) return own
  if (own.refs.length + missing.length <= max) return { refs: [...own.refs, ...missing], note: own.note }
  const skipped = own.note
    ? `Standardklädseln ”${outfit.name}” lades inte till.`
    : `Standardklädseln ”${outfit.name}” (${imageCount(missing.length)}) fick inte plats – ` +
      `modellen tar max ${max} bilder.`
  return { refs: own.refs, note: own.note ? `${own.note} ${skipped}` : skipped }
}

/**
 * Adds an asset to a form's references the way the pickers do: its photos (a character's default outfit along),
 * and – when the model takes reference audio and some of the character's photos made it in – the character's
 * first voice clip. For adding from outside the form, e.g. "Generera med karaktären" from the library.
 */
export function addAssetToForm(
  current: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'>,
  asset: Asset,
  library: readonly Asset[],
  modelId: string
): { referenceImages: string[]; referenceAudios?: ReferenceAudio[]; note?: string } {
  const byId = new Map(library.map((a) => [a.id, a]))
  const images = addAsset(current.referenceImages ?? [], asset, byId, maxReferenceImages(modelId))
  const audiosNow = current.referenceAudios ?? []
  const voice = voiceOf(asset)
  const present = asset.images.some((img) => images.refs.includes(img.path))
  const audio =
    voice && present && supportsAudioInput(modelId)
      ? addAudios(audiosNow, [referenceAudioOf(voice)], audioSourcesByPath(library), maxReferenceAudios(modelId))
      : undefined
  const audios = audio?.audios ?? audiosNow
  const note = [images.note, audio?.note].filter(Boolean).join(' ')
  return {
    referenceImages: images.refs,
    ...(audios.length ? { referenceAudios: audios } : {}),
    ...(note ? { note } : {})
  }
}

/** The references without the asset's photos. */
export function removeAsset(refs: readonly string[], asset: Asset): string[] {
  const paths = new Set(asset.images.map((img) => img.path))
  return refs.filter((p) => !paths.has(p))
}

/**
 * Takes off what a character wears and puts on `outfit` (null: nothing). The new photos go where the old
 * ones were, so swapping one photo for one photo keeps every other @ImageN number in the prompt valid.
 */
export function swapOutfit(
  refs: readonly string[],
  wearing: readonly Asset[],
  outfit: Asset | null,
  max: number
): RefsChange {
  const removed = new Set(
    wearing.filter((o) => o.id !== outfit?.id).flatMap((o) => o.images.map((img) => img.path))
  )
  // Everything before the first removed photo is kept, so its index is also the insert position in `kept`.
  const firstRemoved = refs.findIndex((p) => removed.has(p))
  const kept = refs.filter((p) => !removed.has(p))
  if (!outfit) return { refs: kept }
  const at = firstRemoved === -1 ? kept.length : firstRemoved
  const wanted = outfit.images.map((img) => img.path).filter((p) => !kept.includes(p))
  const added = wanted.slice(0, Math.max(0, max - kept.length))
  return {
    refs: [...kept.slice(0, at), ...added, ...kept.slice(at)],
    note: fitNote(added.length, wanted.length, max)
  }
}

/** A near miss ("@Image 3", "@img3", "@Ljud1") whose suggested spelling names one picture or clip. */
const SINGLE_SUGGESTION = /^@(Image|Audio)(\d+)$/
/** The number at the end of a near miss, in ASCII or full-width digits. */
const TRAILING_DIGITS = /[0-9\uFF10-\uFF19]+$/
/** The word in front of an @AudioN inside a reference's brackets ("voice @Audio1", "röst @Audio1"). */
const AUDIO_WORD = /^(voice|sound|röst|ljud)[ \t]+/iu

/**
 * `n` written the way `digits` was (leading zeros, full-width digits), so a renumbered near miss stays the
 * same near miss rather than turning into a valid token nobody checked.
 */
function digitsLike(digits: string, n: number): string {
  let out = String(n)
  if (digits.length > out.length && /^[0\uFF10]/.test(digits)) out = out.padStart(digits.length, '0')
  if (!/[\uFF10-\uFF19]/.test(digits)) return out
  return [...out].map((c) => String.fromCharCode(c.charCodeAt(0) - 0x30 + 0xff10)).join('')
}

/** One token inside a "(…)" reference: a picture, or a clip with the word in front of it. */
interface Member {
  ref: ReferenceKind
  n: number
  /** "voice" in "voice @Audio1", kept as written. */
  word?: string
}

/** What the remap works through, in prompt order. */
type Unit =
  | { type: 'token'; ref: ReferenceKind; start: number; end: number; raw: string; n: number }
  | { type: 'group'; start: number; end: number; raw: string; members: Member[] }
  /** A near miss naming one picture or clip: its number follows it, so its suggested fix stays right. */
  | { type: 'near-miss'; ref: ReferenceKind; start: number; end: number; raw: string; n: number }

type Found = PromptToken & { ref: ReferenceKind }

/**
 * The prompt's references as the shared rules read them (prompt-refs: any letter case, the same boundaries):
 * lone tokens, "(@Image3, @Image4, voice @Audio1)" groups made only of tokens, and near misses that name one
 * picture or clip.
 */
function referenceUnits(prompt: string): Unit[] {
  const tokens: Found[] = [
    ...findImageTokens(prompt).map((t) => ({ ...t, ref: 'image' as const })),
    ...findAudioTokens(prompt).map((t) => ({ ...t, ref: 'audio' as const }))
  ].sort((a, b) => a.start - b.start)
  const byStart = new Map(tokens.map((t) => [t.start, t]))
  /** The member starting at `pos`: a token, or "voice @AudioN". */
  const memberAt = (pos: number): { token: Found; word?: string } | undefined => {
    const token = byStart.get(pos)
    if (token) return { token }
    const word = AUDIO_WORD.exec(prompt.slice(pos))
    const audio = word ? byStart.get(pos + word[0].length) : undefined
    return audio?.ref === 'audio' ? { token: audio, word: word![1] } : undefined
  }
  const units: Unit[] = []
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i]
    const head = prompt.slice(0, first.start)
    const open =
      /\(\s*$/.exec(head) ?? (first.ref === 'audio' ? /\(\s*(voice|sound|röst|ljud)[ \t]+$/iu.exec(head) : null)
    if (open) {
      const members: { token: Found; word?: string }[] = [{ token: first, word: open[1] }]
      let end = first.end
      for (;;) {
        const comma = /^\s*,\s*/.exec(prompt.slice(end))
        const next = comma ? memberAt(end + comma[0].length) : undefined
        if (!next) break
        members.push(next)
        end = next.token.end
      }
      const close = /^\s*\)/.exec(prompt.slice(end))
      if (close) {
        const start = open.index
        end += close[0].length
        units.push({
          type: 'group',
          start,
          end,
          raw: prompt.slice(start, end),
          members: members.map((m) => ({ ref: m.token.ref, n: m.token.index, ...(m.word ? { word: m.word } : {}) }))
        })
        i += members.length - 1
        continue
      }
    }
    units.push({ type: 'token', ref: first.ref, start: first.start, end: first.end, raw: first.raw, n: first.index })
  }
  for (const m of findMalformedTokens(prompt)) {
    const single = SINGLE_SUGGESTION.exec(m.suggestion ?? '')
    const ref: ReferenceKind | undefined = single ? (single[1] === 'Audio' ? 'audio' : 'image') : undefined
    if (single && ref === m.ref && TRAILING_DIGITS.test(m.raw)) {
      units.push({ type: 'near-miss', ref, start: m.start, end: m.end, raw: m.raw, n: Number(single[2]) })
    }
  }
  return units.sort((a, b) => a.start - b.start)
}

/** A reference list before and after a change, for remapping its tokens. */
export interface ListChange<T> {
  before: readonly T[]
  after: readonly T[]
}

/**
 * The prompt with its @ImageN and @AudioN tokens kept on their pictures and clips after the reference lists
 * changed (an asset removed with its chip ✕, an outfit swapped, a voice left out): every token gets its new
 * number. A token whose picture or clip left the list goes, and so does a "(…)" left empty; the words around it
 * stay. With `swap`, a group naming only the old outfits' photos is given to the new outfit instead, name
 * included: "Röd klänning (@Image3)" → "Blå jeans (@Image3, @Image4)". Tokens beyond `before` name nothing and
 * are left as they are, as are @AudioN tokens when `audios` is left out. Tokens are found as the shared rules find
 * them, so "@image3" (which the model reads as @Image3) follows its picture too, and a near miss like "@Image 3"
 * keeps naming the picture its suggested fix would.
 */
export function remapPromptReferences(
  prompt: string,
  images: ListChange<string>,
  audios?: ListChange<ReferenceAudio>,
  swap?: { from: readonly Asset[]; to: Asset | null }
): string {
  const imagesSame = sameList(images.before, images.after)
  const audiosSame = !audios || sameList(audios.before.map((a) => a.path), audios.after.map((a) => a.path))
  if (!prompt || (imagesSame && audiosSame)) return prompt
  const units = referenceUnits(prompt)
  if (!units.length) return prompt
  const { before, after } = images
  const oldPhotos = new Set(swap?.from.flatMap((o) => o.images.map((img) => img.path)) ?? [])
  const newPhotos = new Set(swap?.to?.images.map((img) => img.path) ?? [])
  const newIndices = after.flatMap((p, i) => (newPhotos.has(p) ? [i + 1] : []))
  /** The token's new number; null when its picture or clip is gone, undefined when it named none. */
  const renumber = (ref: ReferenceKind, n: number): number | null | undefined => {
    if (ref === 'audio') {
      const path = audios?.before[n - 1]?.path
      if (path === undefined) return undefined
      const i = audios!.after.findIndex((a) => a.path === path)
      return i === -1 ? null : i + 1
    }
    const path = before[n - 1]
    if (path === undefined) return undefined
    const i = after.indexOf(path)
    return i === -1 ? null : i + 1
  }
  /** A lone token or near miss's new number, following an old outfit's photo to the new outfit's. */
  const follow = (ref: ReferenceKind, n: number): number | null | undefined => {
    const next = renumber(ref, n)
    if (next !== null || ref === 'audio') return next
    if (!newIndices.length || !oldPhotos.has(before[n - 1])) return null
    // A picture of the old outfit, written by hand: point at the new outfit's photo in the same place.
    const k = [...oldPhotos].indexOf(before[n - 1])
    return newIndices[Math.min(k, newIndices.length - 1)]
  }
  const tokenText = (m: Member): string =>
    m.ref === 'audio' ? `${m.word ? `${m.word} ` : ''}@Audio${m.n}` : `@Image${m.n}`

  let out = ''
  let last = 0
  let outfitGiven = false
  /** Leaves out prompt[start, end) and the space that would be left doubled. */
  const drop = (start: number, end: number): void => {
    out += prompt.slice(last, start)
    last = end
    const rest = prompt.slice(end)
    if (/^(?:$|[\s,.;:!?)])/.test(rest)) out = out.replace(/[ \t]+$/, '')
    if (!out || /[\n(]$/.test(out)) last += /^[ \t]*/.exec(rest)![0].length
  }
  const put = (start: number, end: number, text: string): void => {
    out += prompt.slice(last, start) + text
    last = end
  }

  for (const unit of units) {
    const { start, end } = unit
    if (unit.type === 'token' || unit.type === 'near-miss') {
      const n = follow(unit.ref, unit.n)
      if (n === undefined || n === unit.n) continue
      // In running text ("speaks with the voice @Audio2") a word in front is part of the sentence, so it stays.
      if (n === null) drop(start, end)
      else if (unit.type === 'token') put(start, end, unit.ref === 'audio' ? `@Audio${n}` : `@Image${n}`)
      else put(start, end, unit.raw.replace(TRAILING_DIGITS, (digits) => digitsLike(digits, n)))
      continue
    }
    const members = unit.members
    if (
      swap?.to &&
      !outfitGiven &&
      newIndices.length &&
      members.every((m) => m.ref === 'image' && oldPhotos.has(before[m.n - 1] ?? ''))
    ) {
      // The old outfit's reference becomes the new one's; its name in front of it follows.
      outfitGiven = true
      out += prompt.slice(last, start)
      last = start
      const oldName = swap.from.map((o) => `${o.name} `).find((name) => out.endsWith(name))
      if (oldName) out = out.slice(0, -oldName.length) + `${swap.to.name} `
      put(start, end, `(${newIndices.map((i) => `@Image${i}`).join(', ')})`)
      continue
    }
    const renumbered = members.map((m) => ({ member: m, next: renumber(m.ref, m.n) }))
    const kept = renumbered.flatMap(({ member, next }) =>
      next === null ? [] : [{ ...member, n: next === undefined ? member.n : next }]
    )
    if (!kept.length) drop(start, end)
    else if (kept.length !== members.length || kept.some((m, i) => m.n !== members[i].n)) {
      put(start, end, `(${kept.map(tokenText).join(', ')})`)
    }
  }
  return out + prompt.slice(last)
}

/** remapPromptReferences for the pictures only. */
export function remapPromptImages(
  prompt: string,
  before: readonly string[],
  after: readonly string[],
  swap?: { from: readonly Asset[]; to: Asset | null }
): string {
  return remapPromptReferences(prompt, { before, after }, undefined, swap)
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i])
}
