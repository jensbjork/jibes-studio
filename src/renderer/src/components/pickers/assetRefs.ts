// How library assets (characters, environments, products, outfits, poses) map onto a form's reference images, and
// the edits the pickers and chips make to that list – with the prompt's @ImageN and @AudioN tokens following their
// pictures and clips. Pure functions, shared by the params form and the generate view.

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

// Renumbering the prompt's @ImageN and @AudioN tokens when the lists change (a chip's ✕, an outfit swap, a voice
// left out, a thumbnail dragged to another place) lives in src/shared/prompt-remap.ts, so the agent tools that
// edit sequence clips in main renumber by exactly the same rules as the form. Re-exported for the form's callers.
export { remapPromptImages, remapPromptReferences, sameList, type ListChange } from '@shared/prompt-remap'
