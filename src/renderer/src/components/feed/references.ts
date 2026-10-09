// What a generation was made from, in library terms: which character, environment, product, outfit or pose each of
// its pictures and sound clips is. Generations store plain file paths; the library index maps them back to assets.

import { generationAssetIds, indexAssetPaths, pathKey, type AssetPathIndex } from '@shared/generation-filter'
import { maxReferenceImages } from '@shared/models'
import type { Asset, AssetAudio, Generation, GenerationParams } from '@shared/types'

export interface LibraryIndex {
  /** Keyed by pathKey(path), the way the shared filter compares paths. */
  byImagePath: ReadonlyMap<string, { asset: Asset; photo: number }>
  byAudioPath: ReadonlyMap<string, { asset: Asset; clip: AssetAudio; number: number }>
  byId: ReadonlyMap<string, Asset>
  /** For the shared filter (src/shared/generation-filter.ts). */
  paths: AssetPathIndex
}

export function buildLibraryIndex(assets: readonly Asset[]): LibraryIndex {
  const byImagePath = new Map<string, { asset: Asset; photo: number }>()
  const byAudioPath = new Map<string, { asset: Asset; clip: AssetAudio; number: number }>()
  for (const asset of assets) {
    asset.images.forEach((img, i) => byImagePath.set(pathKey(img.path), { asset, photo: i + 1 }))
    // Older main processes (or kinds without sound) may not send the list at all.
    ;(asset.audio ?? []).forEach((clip, i) => byAudioPath.set(pathKey(clip.path), { asset, clip, number: i + 1 }))
  }
  return { byImagePath, byAudioPath, byId: new Map(assets.map((a) => [a.id, a])), paths: indexAssetPaths(assets) }
}

export interface ImageReference {
  /** "@Image3" for reference images; undefined for start and end images. */
  token?: string
  role: 'reference' | 'start' | 'end'
  path: string
  asset?: Asset
  /** 1-based position of the photo within its asset. */
  photo?: number
  /** Past the model's limit: kept in the params but never sent. */
  unsent?: boolean
}

export interface AudioReference {
  /** "@Audio1". */
  token: string
  path: string
  /** The window that was sent, in seconds. */
  start: number
  length?: number
  asset?: Asset
  /** 1-based position of the clip within its asset. */
  number?: number
}

export interface GenerationReferences {
  images: ImageReference[]
  audios: AudioReference[]
}

/** Every picture and sound clip in the params, mapped onto the library. */
export function referencesOf(params: GenerationParams, index: LibraryIndex): GenerationReferences {
  const images: ImageReference[] = []
  const describe = (path: string) => {
    const hit = index.byImagePath.get(pathKey(path))
    return hit ? { asset: hit.asset, photo: hit.photo } : {}
  }
  if (params.startImage) images.push({ role: 'start', path: params.startImage, ...describe(params.startImage) })
  if (params.endImage) images.push({ role: 'end', path: params.endImage, ...describe(params.endImage) })
  const max = maxReferenceImages(params.model)
  ;(params.referenceImages ?? []).forEach((path, i) => {
    images.push({ role: 'reference', token: `@Image${i + 1}`, path, unsent: i >= max, ...describe(path) })
  })
  const audios: AudioReference[] = (params.referenceAudios ?? []).map((a, i) => {
    const hit = index.byAudioPath.get(pathKey(a.path))
    return {
      token: `@Audio${i + 1}`,
      path: a.path,
      start: a.start ?? 0,
      length: a.length,
      asset: hit?.asset,
      number: hit?.number
    }
  })
  return { images, audios }
}

/** The library assets a generation used (pictures and sound), each once, in the order they first appear. */
export function assetsOf(g: Pick<Generation, 'params'>, index: LibraryIndex): Asset[] {
  return generationAssetIds(g, index.paths).flatMap((id) => {
    const asset = index.byId.get(id)
    return asset ? [asset] : []
  })
}

/** How many generations use each asset, for the asset filter's counts (the same matching as the filter). */
export function assetUseCounts(list: readonly Generation[], index: LibraryIndex): Map<string, number> {
  const counts = new Map<string, number>()
  for (const g of list) for (const id of generationAssetIds(g, index.paths)) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

/** "Anna · foto 2", "Egen bild", for a picture's caption. */
export function imageCaption(ref: ImageReference): string {
  if (!ref.asset) return 'Egen bild'
  return ref.asset.images.length > 1 ? `${ref.asset.name} · foto ${ref.photo ?? 1}` : ref.asset.name
}

/** "0:02–0:12": the window of a sound clip that was sent. */
export function audioWindowText(start: number, length: number | undefined): string {
  const clock = (s: number) => {
    const t = Math.max(0, Math.round(s))
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  }
  return length === undefined ? `från ${clock(start)}` : `${clock(start)}–${clock(start + length)}`
}

/** A media fragment that makes an <audio> element play only the window that was sent. */
export function audioWindowFragment(start: number, length: number | undefined): string {
  const round = (n: number) => Math.round(n * 100) / 100
  return length === undefined ? `#t=${round(start)}` : `#t=${round(start)},${round(start + length)}`
}
