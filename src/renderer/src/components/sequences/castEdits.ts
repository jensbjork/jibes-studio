// The edits the Cast panel makes to a sequence's cast (shared/cast.ts): an asset added at the end (a character with its
// default outfit and voice, as the pickers add them), one removed, moved before or after its neighbour, a character's
// voice on or off, and who wears an outfit. Main changes the clips that follow the cast with it. Pure, like the
// pickers' assetRefs.

import { DEFAULT_PARAMS, maxReferenceAudios, maxReferenceImages } from '@shared/models'
import { withOutfitWearer } from '@shared/outfits'
import type { Asset, ReferenceAudio, Sequence, SequenceCast } from '@shared/types'
import { addAssetToForm, addPaths } from '../pickers/assetRefs'
import { addAudios, audioSourcesByPath, clipsOf, referenceAudioOf, removeAudiosOf, voiceOf } from '../pickers/audioRefs'

/** One row of the panel: an asset with its places among the cast's pictures and audio, or a loose picture or clip. */
export interface CastEntry {
  key: string
  /** Undefined for a picture or clip that is no library asset's (any more). */
  asset?: Asset
  /** 1-based @Image numbers of its places. */
  images: number[]
  /** 1-based @Audio numbers of its places. */
  audios: number[]
}

/**
 * The cast as rows: the assets in the order their pictures come (an asset with only a voice after them), and a loose
 * picture or clip (its asset deleted since) as a row of its own. Every place is in exactly one row.
 */
export function castEntries(cast: SequenceCast, library: readonly Asset[]): CastEntry[] {
  const byPhoto = new Map<string, Asset>()
  for (const asset of library) for (const image of asset.images) if (!byPhoto.has(image.path)) byPhoto.set(image.path, asset)
  const byClip = audioSourcesByPath(library)
  const entries: CastEntry[] = []
  const byAsset = new Map<string, CastEntry>()
  cast.referenceImages.forEach((path, i) => {
    const asset = byPhoto.get(path)
    const entry = asset ? byAsset.get(asset.id) : undefined
    if (entry) {
      entry.images.push(i + 1)
      return
    }
    const fresh: CastEntry = { key: asset ? asset.id : `image:${i}`, asset, images: [i + 1], audios: [] }
    if (asset) byAsset.set(asset.id, fresh)
    entries.push(fresh)
  })
  cast.referenceAudios.forEach((ref, j) => {
    const asset = byClip.get(ref.path)?.asset
    const entry = asset ? byAsset.get(asset.id) : undefined
    if (entry) {
      entry.audios.push(j + 1)
      return
    }
    const fresh: CastEntry = { key: asset ? asset.id : `audio:${j}`, asset, images: [], audios: [j + 1] }
    if (asset) byAsset.set(asset.id, fresh)
    entries.push(fresh)
  })
  return entries
}

/** The model the cast's limits are counted for: the sequence's default model. */
export function castModel(sequence: Pick<Sequence, 'defaults'>): string {
  return sequence.defaults.model ?? DEFAULT_PARAMS.model
}

/** A cast change and a note when not everything fitted. */
export interface CastChange {
  cast: SequenceCast
  note?: string
}

/**
 * The asset added at the end, as a picker adds it to a form: all its photos, a character's default outfit when it fits
 * whole, and a character's first voice clip.
 */
export function addToCast(cast: SequenceCast, asset: Asset, library: readonly Asset[], model: string): CastChange {
  const next = addAssetToForm(
    { referenceImages: cast.referenceImages, referenceAudios: cast.referenceAudios },
    asset,
    library,
    model
  )
  return {
    cast: { ...cast, referenceImages: next.referenceImages, referenceAudios: next.referenceAudios ?? [] },
    ...(next.note ? { note: next.note } : {})
  }
}

/** One photo added at the end. */
export function addPhotoToCast(cast: SequenceCast, path: string, model: string): CastChange {
  const next = addPaths(cast.referenceImages, [path], maxReferenceImages(model))
  return { cast: { ...cast, referenceImages: next.refs }, ...(next.note ? { note: next.note } : {}) }
}

/** The row's places taken out (an asset: all its photos and clips). */
export function removeFromCast(cast: SequenceCast, entry: CastEntry): SequenceCast {
  const images = new Set(entry.images)
  const audios = new Set(entry.audios)
  return {
    ...cast,
    referenceImages: cast.referenceImages.filter((_, i) => !images.has(i + 1)),
    referenceAudios: cast.referenceAudios.filter((_, j) => !audios.has(j + 1))
  }
}

/** The row moved one place up (-1) or down (+1) among the rows: its pictures and clips move with it. */
export function moveInCast(cast: SequenceCast, entries: readonly CastEntry[], index: number, step: -1 | 1): SequenceCast {
  const to = index + step
  if (index < 0 || index >= entries.length || to < 0 || to >= entries.length) return cast
  const order = [...entries]
  ;[order[index], order[to]] = [order[to], order[index]]
  return {
    ...cast,
    referenceImages: order.flatMap((e) => e.images.map((n) => cast.referenceImages[n - 1])),
    referenceAudios: order.flatMap((e) => e.audios.map((n) => cast.referenceAudios[n - 1]))
  }
}

/** A character's (or place's) voice on – its first clip, at the end – or off: all its clips out. */
export function setCastVoice(
  cast: SequenceCast,
  asset: Asset,
  on: boolean,
  library: readonly Asset[],
  model: string
): CastChange {
  if (!on) return { cast: { ...cast, referenceAudios: removeAudiosOf(cast.referenceAudios, asset) } }
  const clip = voiceOf(asset) ?? clipsOf(asset)[0]
  if (!clip) return { cast }
  const wanted: ReferenceAudio[] = [referenceAudioOf(clip)]
  const next = addAudios(cast.referenceAudios, wanted, audioSourcesByPath(library), maxReferenceAudios(model))
  return { cast: { ...cast, referenceAudios: next.audios }, ...(next.note ? { note: next.note } : {}) }
}

/** Who wears an outfit: a character id, null for nobody, undefined for the default again. */
export function wearInCast(cast: SequenceCast, outfitId: string, wearer: string | null | undefined): SequenceCast {
  const wearers = withOutfitWearer(cast.outfitWearers, outfitId, wearer)
  const { outfitWearers: _, ...rest } = cast
  return wearers ? { ...rest, outfitWearers: wearers } : rest
}
