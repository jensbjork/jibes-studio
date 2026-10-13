// Keeping a prompt's @ImageN and @AudioN tokens on their pictures and clips when the reference lists change:
// a picture removed with its chip ✕, an outfit swapped, a voice left out, or the references dragged into a new
// order. Pure and shared, so the editor (renderer) and the agent tools that edit sequence clips (main) renumber
// tokens by exactly the same rules – a token pointing at the wrong picture spoils a paid generation just as
// quietly as a missing one.

import {
  findAudioTokens,
  findImageTokens,
  findMalformedTokens,
  type PromptToken,
  type ReferenceKind
} from './prompt-refs'
import type { Asset, GenerationParams, ReferenceAudio } from './types'

/** A near miss ("@Image 3", "@img3", "@Ljud1") whose suggested spelling names one picture or clip. */
const SINGLE_SUGGESTION = /^@(Image|Audio)(\d+)$/
/** A range's suggested spelling ("@Image1-3" → "@Image1, @Image2, @Image3"): its first and last numbers. */
const RANGE_SUGGESTION = /^@(Image|Audio)(\d+)(?:, @\1\d+)*, @\1(\d+)$/
/** A range near miss's numbers at its end: "1-3" in "@Image1-3" (the first may be full-width, as prompt-refs reads it). */
const RANGE_DIGITS = /([0-9\uFF10-\uFF19]+)([-\u2010-\u2015\u2212])([0-9]+)$/
/** A glued near miss's suggested spelling ("@Image3rd" → "@Image3 rd"): the number and what was glued on. */
const GLUED_SUGGESTION = /^@(Image|Audio)(\d+) (\S+)$/
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
  /** "@Image1-3", whose suggested fix spells out pictures 1 to 3: each of them is followed. */
  | { type: 'range'; ref: ReferenceKind; start: number; end: number; raw: string; from: number; to: number }
  /** "@Image3rd", whose suggested fix is "@Image3 rd": the number follows its picture, the glued word stays. */
  | { type: 'glued'; ref: ReferenceKind; start: number; end: number; raw: string; n: number; suffix: string }

type Found = PromptToken & { ref: ReferenceKind }

/**
 * The prompt's references as the shared rules read them (prompt-refs: any letter case, the same boundaries):
 * lone tokens, "(@Image3, @Image4, voice @Audio1)" groups made only of tokens, near misses that name one picture
 * or clip, ranges ("@Image1-3") and numbers with a word glued on ("@Image3rd") – every near miss whose suggested
 * fix names pictures or clips by number.
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
    const suggestion = m.suggestion ?? ''
    const kindOf = (word: string): ReferenceKind => (word === 'Audio' ? 'audio' : 'image')
    const { start, end, raw } = m
    const single = SINGLE_SUGGESTION.exec(suggestion)
    if (single && kindOf(single[1]) === m.ref && TRAILING_DIGITS.test(raw)) {
      units.push({ type: 'near-miss', ref: m.ref, start, end, raw, n: Number(single[2]) })
      continue
    }
    const range = RANGE_SUGGESTION.exec(suggestion)
    if (range && kindOf(range[1]) === m.ref && RANGE_DIGITS.test(raw)) {
      units.push({ type: 'range', ref: m.ref, start, end, raw, from: Number(range[2]), to: Number(range[3]) })
      continue
    }
    const glued = GLUED_SUGGESTION.exec(suggestion)
    if (glued && kindOf(glued[1]) === m.ref && raw.endsWith(glued[3])) {
      const head = raw.slice(0, raw.length - glued[3].length)
      if (TRAILING_DIGITS.test(head)) {
        units.push({ type: 'glued', ref: m.ref, start, end, raw, n: Number(glued[2]), suffix: glued[3] })
      }
    }
  }
  return units.sort((a, b) => a.start - b.start)
}

/**
 * A reference list before and after a change, as keys that are followed place by place when a
 * picture is in several places – a swapped-in asset with fewer photos reuses them, and every token would otherwise go
 * to the first place. Each place before is matched with one after – the k-th place of a picture with its k-th when
 * only the order changed, else along the longest common run (a removal or an addition anywhere) – and the two share
 * a key; a place left unmatched keeps a key of its own, so its tokens go. Without repeats the lists come back as they
 * are.
 */
export function placeKeys(before: readonly string[], after: readonly string[]): { before: string[]; after: string[] } {
  const repeats = (list: readonly string[]): boolean => new Set(list).size !== list.length
  if (!repeats(before) && !repeats(after)) return { before: [...before], after: [...after] }
  const pairs: Array<[number, number]> = []
  const sorted = (list: readonly string[]): string => [...list].sort().join('\n')
  if (before.length === after.length && sorted(before) === sorted(after)) {
    const places = new Map<string, number[]>()
    after.forEach((p, j) => places.set(p, [...(places.get(p) ?? []), j]))
    const taken = new Map<string, number>()
    before.forEach((p, i) => {
      const k = taken.get(p) ?? 0
      taken.set(p, k + 1)
      pairs.push([i, places.get(p)![k]])
    })
  } else {
    const n = before.length
    const m = after.length
    const run = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        run[i][j] = before[i] === after[j] ? run[i + 1][j + 1] + 1 : Math.max(run[i + 1][j], run[i][j + 1])
      }
    }
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (before[i] === after[j]) pairs.push([i++, j++])
      else if (run[i + 1][j] >= run[i][j + 1]) i++
      else j++
    }
  }
  const keysBefore = before.map((p, i) => `${p}\u0000-${i}`)
  const keysAfter = after.map((p, j) => `${p}\u0000+${j}`)
  for (const [i, j] of pairs) keysBefore[i] = keysAfter[j] = `${before[i]}\u0000${i}`
  return { before: keysBefore, after: keysAfter }
}

/** A reference list before and after a change, for remapping its tokens. */
export interface ListChange<T> {
  before: readonly T[]
  after: readonly T[]
}

/**
 * The prompt with its @ImageN and @AudioN tokens kept on their pictures and clips after the reference lists
 * changed (an asset removed with its chip ✕, an outfit swapped, a voice left out, the references reordered):
 * every token gets its new number. A token whose picture or clip left the list goes, and so does a "(…)" left
 * empty; the words around it stay. With `swap`, a group naming only the old outfits' photos is given to the new
 * outfit instead, name included: "Röd klänning (@Image3)" → "Blå jeans (@Image3, @Image4)". Tokens beyond
 * `before` name nothing and are left as they are, as are @AudioN tokens when `audios` is left out. Tokens are
 * found as the shared rules find them, so "@image3" (which the model reads as @Image3) follows its picture too,
 * and a near miss like "@Image 3", "@Image3rd" or "@Image1-2" keeps naming the pictures its suggested fix would
 * (a range whose pictures no longer follow each other is written out as that fix: "@Image3, @Image1").
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
  // Followed place by place: a picture or clip in several places (a swapped-in asset with fewer photos reuses them)
  // keeps each token on its own place rather than all of them going to the first.
  const imageKeys = placeKeys(before, after)
  const audioKeys = audios ? placeKeys(audios.before.map((a) => a.path), audios.after.map((a) => a.path)) : undefined
  const renumber = (ref: ReferenceKind, n: number): number | null | undefined => {
    const keys = ref === 'audio' ? audioKeys : imageKeys
    if (!keys) return undefined
    const key = keys.before[n - 1]
    if (key === undefined) return undefined
    const i = keys.after.indexOf(key)
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
    if (unit.type === 'glued') {
      const n = renumber(unit.ref, unit.n)
      if (n === undefined || n === unit.n) continue
      const head = unit.raw.slice(0, unit.raw.length - unit.suffix.length)
      // Its picture or clip gone: the reference goes, the word glued to it stays.
      if (n === null) put(start, end, unit.suffix)
      else put(start, end, head.replace(TRAILING_DIGITS, (digits) => digitsLike(digits, n)) + unit.suffix)
      continue
    }
    if (unit.type === 'range') {
      const numbers: number[] = []
      for (let n = unit.from; n <= unit.to; n++) {
        const next = renumber(unit.ref, n)
        if (next !== null) numbers.push(next ?? n)
      }
      if (numbers.length === unit.to - unit.from + 1 && numbers.every((n, i) => n === unit.from + i)) continue
      if (!numbers.length) drop(start, end)
      else if (numbers.length > 1 && numbers.every((n, i) => n === numbers[0] + i)) {
        // Still a run: the same near miss with its ends renumbered, so its fix spells out the same pictures.
        put(
          start,
          end,
          unit.raw.replace(
            RANGE_DIGITS,
            (_, first: string, dash: string, last: string) =>
              `${digitsLike(first, numbers[0])}${dash}${digitsLike(last, numbers[numbers.length - 1])}`
          )
        )
      } else {
        // No longer a run (the pictures were reordered apart, or one left): written out as its fix would have it,
        // each picture with its new number.
        put(start, end, numbers.map((n) => (unit.ref === 'audio' ? `@Audio${n}` : `@Image${n}`)).join(', '))
      }
      continue
    }
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

/**
 * The prompt with `oldName` changed to `newName` where it names a reference: right in front of a "(…)" group whose
 * tokens all belong to the swapped places (`owns`) – "Anna (@Image1, voice @Audio1)" → "Bo (@Image1, voice @Audio1)".
 * Letter case and Unicode form of the name are ignored; every number, and the rest of the text, stays as written.
 */
export function renameReferenceNames(
  prompt: string,
  oldName: string,
  newName: string,
  owns: (ref: ReferenceKind, n: number) => boolean
): string {
  const from = oldName.trim()
  const to = newName.trim()
  if (!prompt || !from || !to || from === to) return prompt
  const key = (text: string): string => text.normalize('NFC').toLocaleLowerCase('sv')
  let out = ''
  let last = 0
  for (const unit of referenceUnits(prompt)) {
    if (unit.type !== 'group' || !unit.members.every((m) => owns(m.ref, m.n))) continue
    const head = prompt.slice(last, unit.start)
    const name = /\s*$/.exec(head)!
    const before = head.slice(0, name.index)
    if (before.length < from.length || key(before.slice(-from.length)) !== key(from)) continue
    // A whole word: "Johanna (@Image1)" is not "Anna".
    if (/[\p{L}\p{N}_]$/u.test(before.slice(0, -from.length))) continue
    out += before.slice(0, -from.length) + to + head.slice(name.index)
    last = unit.start
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

// ── Reordering ───────────────────────────────────────────────────────────────

/** "@Image3", "@image3", "@Audio2" … as a whole entry of a new order: the kind's word and the number. */
const ORDER_TOKEN = /^\s*[@\uFF20](image|audio)\s*0*([1-9][0-9]*)\s*$/i

const WORD: Record<ReferenceKind, string> = { image: 'Image', audio: 'Audio' }

/** "1 referensbild", "3 referensbilder", "2 ljudklipp": how many there are, for the messages. */
function countText(kind: ReferenceKind, n: number): string {
  if (kind === 'audio') return `${n} ljudklipp`
  return n === 1 ? '1 referensbild' : `${n} referensbilder`
}

/**
 * The positions (0-based, into the current list) of the references in their new order. Each entry of
 * `newOrder` names one reference: by its token ("@Image3", any letter case; "@Audio2" for audio) or by its
 * path. The ones named come first, in that order; the rest keep their order after them, so a partial list
 * moves only what it names to the front. Throws (Swedish) for an entry that names no reference, one of the
 * other kind, or a reference named twice.
 */
export function referenceOrder(paths: readonly string[], kind: ReferenceKind, newOrder: readonly string[]): number[] {
  const leading: number[] = []
  for (const entry of newOrder) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('Ordningen innehåller en tom post.')
    const token = ORDER_TOKEN.exec(entry)
    let index: number
    if (token) {
      const tokenKind: ReferenceKind = token[1].toLowerCase() === 'audio' ? 'audio' : 'image'
      const shown = `@${WORD[tokenKind]}${token[2]}`
      if (tokenKind !== kind) {
        throw new Error(
          kind === 'image'
            ? `${shown} är ett ljudklipp – bara referensbilder (@ImageN) kan ordnas här.`
            : `${shown} är en bild – bara ljudklipp (@AudioN) kan ordnas här.`
        )
      }
      index = Number(token[2]) - 1
      if (index >= paths.length) {
        throw new Error(
          paths.length
            ? `${shown} finns inte – det finns bara ${countText(kind, paths.length)}.`
            : `${shown} finns inte – det finns inga ${kind === 'audio' ? 'ljudklipp' : 'referensbilder'}.`
        )
      }
    } else {
      index = paths.indexOf(entry)
      if (index === -1) {
        const what = kind === 'audio' ? 'ett av ljudklippen' : 'en av referensbilderna'
        throw new Error(`${entry} är inte ${what} – ange @${WORD[kind]}N eller sökvägen.`)
      }
    }
    if (leading.includes(index)) {
      throw new Error(`@${WORD[kind]}${index + 1} står mer än en gång i den nya ordningen.`)
    }
    leading.push(index)
  }
  const placed = new Set(leading)
  return [...leading, ...paths.flatMap((_, i) => (placed.has(i) ? [] : [i]))]
}

/**
 * The params with their reference images (`kind` 'image') or reference audio clips ('audio') in a new order,
 * and every @ImageN / @AudioN token in the prompt and the negative prompt renumbered so it keeps pointing at the
 * same picture or clip (remapPromptReferences: any letter case, near misses, "(…)" groups). For example refs
 * [A, B, C] with "@Image1 hugs @Image3", C dragged first: [C, A, B] and "@Image2 hugs @Image1". `newOrder` names
 * the references by token or path (see referenceOrder); unnamed ones keep their order after the named ones.
 * Everything else – the clips' windows, the description flags – stays as it was. Returns the same object when
 * the order doesn't change. Throws (Swedish) for an entry that names no reference.
 */
export function reorderReferences<T extends GenerationParams>(
  params: T,
  kind: ReferenceKind,
  newOrder: readonly string[]
): T {
  if (kind === 'audio') {
    const current = params.referenceAudios ?? []
    const order = referenceOrder(current.map((a) => a.path), 'audio', newOrder)
    if (order.every((from, to) => from === to)) return params
    const after = order.map((i) => current[i])
    const change: ListChange<ReferenceAudio> = { before: current, after }
    const images = params.referenceImages ?? []
    const same: ListChange<string> = { before: images, after: images }
    return withRemappedPrompts({ ...params, referenceAudios: after }, params, same, change)
  }
  const current = params.referenceImages ?? []
  const order = referenceOrder(current, 'image', newOrder)
  if (order.every((from, to) => from === to)) return params
  const after = order.map((i) => current[i])
  return withRemappedPrompts({ ...params, referenceImages: after }, params, { before: current, after })
}

/** `next` with both prompts of `was` remapped for the change (the negative prompt may name references too). */
function withRemappedPrompts<T extends GenerationParams>(
  next: T,
  was: T,
  images: ListChange<string>,
  audios?: ListChange<ReferenceAudio>
): T {
  const prompt = remapPromptReferences(was.prompt, images, audios)
  const negative = was.negativePrompt ? remapPromptReferences(was.negativePrompt, images, audios) : was.negativePrompt
  return { ...next, prompt, ...(was.negativePrompt !== undefined ? { negativePrompt: negative } : {}) }
}

/**
 * Where each reference of `kind` went between two versions of params, matched by path: `{ from: '@Image3',
 * to: '@Image1' }` for each one whose number changed, in the new order. For telling an agent (or the user) how
 * a reorder renumbered the tokens. References that left or arrived are not included.
 */
export function referenceMoves(
  before: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'>,
  after: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'>,
  kind: ReferenceKind
): { from: string; to: string; path: string }[] {
  const paths = (p: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'>): string[] =>
    kind === 'audio' ? (p.referenceAudios ?? []).map((a) => a.path) : (p.referenceImages ?? [])
  const old = paths(before)
  return paths(after).flatMap((path, i) => {
    const was = old.indexOf(path)
    return was === -1 || was === i ? [] : [{ from: `@${WORD[kind]}${was + 1}`, to: `@${WORD[kind]}${i + 1}`, path }]
  })
}
