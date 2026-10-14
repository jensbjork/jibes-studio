// Swapping a reference in place (a click on a reference thumbnail, or swap_reference): another picture – or every
// place of one asset, with its voice and, for a character, its outfit – takes the same places, so no @ImageN /
// @AudioN number changes and the prompt keeps every token.
// The name written in front of the swapped tokens follows ("Anna (@Image1)" → "Bo (@Image1)"), and so do the
// description switch and who wears which outfit. Pure and shared: the form, the clip editor and the agents' tools
// swap by the same rules.

import { pathKey } from './generation-filter'
import { sanitizeReferenceAudios } from './models'
import { resolveOutfitWearers, withOutfitWearer } from './outfits'
import { renameReferenceNames } from './prompt-remap'
import type { Asset, AssetAudio, GenerationParams, ReferenceAudio } from './types'

export interface SwapResult {
  params: GenerationParams
  /** What the swap left as it was and why (Swedish), e.g. a voice the new asset has no counterpart for. */
  notes: string[]
}

/** A library clip as a reference: its own window (as the form adds it). */
function referenceAudioOf(audio: AssetAudio): ReferenceAudio {
  const round = (n: number): number => Math.round(n * 1000) / 1000
  return { path: audio.path, start: round(audio.clipStart), length: round(audio.clipLength) }
}

/** The asset a picture or clip belongs to (the first one claiming the file). */
function ownerOf(assets: readonly Asset[], path: string, kind: 'image' | 'audio'): Asset | undefined {
  const key = pathKey(path)
  return assets.find((a) =>
    kind === 'image' ? a.images.some((i) => pathKey(i.path) === key) : (a.audio ?? []).some((c) => pathKey(c.path) === key)
  )
}

/** The prompt and negative prompt with the name in front of the swapped tokens changed. */
function renamed(
  params: GenerationParams,
  from: Asset | undefined,
  to: Asset | undefined,
  images: ReadonlySet<number>,
  audios: ReadonlySet<number>
): Pick<GenerationParams, 'prompt' | 'negativePrompt'> {
  if (!from || !to || from.id === to.id) return { prompt: params.prompt, negativePrompt: params.negativePrompt }
  const owns = (ref: 'image' | 'audio', n: number): boolean => (ref === 'image' ? images : audios).has(n)
  return {
    prompt: renameReferenceNames(params.prompt ?? '', from.name, to.name, owns),
    ...(params.negativePrompt !== undefined
      ? { negativePrompt: renameReferenceNames(params.negativePrompt, from.name, to.name, owns) }
      : {})
  }
}

/** The description switch and the wearers follow the asset whose places the other one took. */
function carried(params: GenerationParams, from: Asset, to: Asset): Partial<GenerationParams> {
  const out: Partial<GenerationParams> = {}
  const excluded = params.excludedDescriptionAssetIds
  if (excluded?.includes(from.id)) {
    out.excludedDescriptionAssetIds = [...new Set(excluded.map((id) => (id === from.id ? to.id : id)))]
  }
  const wearers = params.outfitWearers
  if (wearers) {
    const next: Record<string, string | null> = {}
    for (const [outfit, wearer] of Object.entries(wearers)) {
      next[outfit === from.id ? to.id : outfit] = wearer === from.id ? to.id : wearer
    }
    out.outfitWearers = next
  }
  return out
}

/**
 * The picture at `index` (0-based, @Image{index + 1}) replaced by `path`, in the same place. When the place was the
 * only one its asset had there and the new picture is another asset's, the name in front of its token follows
 * ("Anna (@Image1)" → "Bo (@Image1)").
 */
export function swapReferenceImage(
  params: GenerationParams,
  index: number,
  path: string,
  assets: readonly Asset[]
): SwapResult {
  const images = [...(params.referenceImages ?? [])]
  if (!Number.isInteger(index) || index < 0 || index >= images.length) throw new Error('Bilden finns inte bland referenserna.')
  if (!path) throw new Error('Välj en bild.')
  const old = images[index]
  if (pathKey(old) === pathKey(path)) return { params, notes: [] }
  images[index] = path
  const from = ownerOf(assets, old, 'image')
  const to = ownerOf(assets, path, 'image')
  // Only a place that was its asset's only one: "Anna (@Image1, @Image2)" with one of two swapped is still Anna.
  const alone = from && !images.some((p, i) => i !== index && from.images.some((img) => pathKey(img.path) === pathKey(p)))
  const names = alone ? renamed(params, from, to, new Set([index + 1]), new Set()) : {}
  const settings = alone && from && to && from.id !== to.id ? carried(params, from, to) : {}
  return { params: { ...params, ...names, ...settings, referenceImages: images }, notes: [] }
}

/**
 * Every place of `from` among the references taken by `to`: its pictures in order (reused from the start when it has
 * fewer, so every place keeps a picture; the first ones when it has more) and – in reference mode with audio – its
 * voice or sound clips the same way. No number changes. `from`'s clips stay when `to` has none (a note says so).
 *
 * One character for another, given the `library`: what `from` wore follows too – the outfit it wears among the
 * references (shared/outfits.ts) gives its places to `to`'s default outfit, or, when `to` has none, stays and is worn
 * by `to` from now on.
 */
export function swapReferenceAsset(
  params: GenerationParams,
  from: Asset,
  to: Asset,
  library?: readonly Asset[]
): SwapResult {
  const swapped = swapAsset(params, from, to)
  if (!library || from.kind !== 'character' || to.kind !== 'character' || from.id === to.id) return swapped
  return followOutfits(params, swapped, from, to, library)
}

/** The outfits `from` wore among `before`'s references, handed to `to` in `after` (see swapReferenceAsset). */
function followOutfits(
  before: GenerationParams,
  after: SwapResult,
  from: Asset,
  to: Asset,
  library: readonly Asset[]
): SwapResult {
  const present: Asset[] = []
  for (const path of before.referenceImages ?? []) {
    const owner = ownerOf(library, path, 'image')
    if (owner && !present.some((a) => a.id === owner.id)) present.push(owner)
  }
  const worn = present.filter(
    (a) => a.kind === 'outfit' && resolveOutfitWearers(present, before.outfitWearers).get(a.id) === from.id
  )
  if (!worn.length) return after
  const own = library.find((a) => a.id === to.defaultOutfitId && a.kind === 'outfit' && a.images.length > 0)
  let result = after
  worn.forEach((outfit, i) => {
    if (i === 0 && own && own.id !== outfit.id) {
      const next = swapAsset(result.params, outfit, own)
      result = {
        params: { ...next.params, outfitWearers: withOutfitWearer(next.params.outfitWearers, own.id, to.id) },
        notes: [...result.notes, ...next.notes, `${outfit.name} byttes mot ${to.name}s kläder, ${own.name}.`]
      }
      return
    }
    result = {
      params: { ...result.params, outfitWearers: withOutfitWearer(result.params.outfitWearers, outfit.id, to.id) },
      notes: [
        ...result.notes,
        own?.id === outfit.id
          ? `${to.name} har samma förvalda kläder, ${outfit.name}.`
          : `${to.name} har inga förvalda kläder, så ${outfit.name} ligger kvar och bärs nu av ${to.name}.`
      ]
    }
  })
  return result
}

/** Every place of `from` given to `to` (pictures, then clips), with the name before its tokens and its switches. */
function swapAsset(params: GenerationParams, from: Asset, to: Asset): SwapResult {
  if (from.id === to.id) return { params, notes: [] }
  const images = [...(params.referenceImages ?? [])]
  const fromImages = new Set(from.images.map((i) => pathKey(i.path)))
  const places = images.flatMap((p, i) => (fromImages.has(pathKey(p)) ? [i] : []))
  if (!places.length) throw new Error(`${from.name} finns inte bland referensbilderna.`)
  if (!to.images.length) throw new Error(`${to.name} har inga foton att byta till.`)
  places.forEach((at, k) => (images[at] = to.images[k % to.images.length].path))

  const notes: string[] = []
  const audios = sanitizeReferenceAudios(params.referenceAudios) ?? []
  const fromClips = new Set((from.audio ?? []).map((c) => pathKey(c.path)))
  const audioPlaces = audios.flatMap((a, i) => (fromClips.has(pathKey(a.path)) ? [i] : []))
  const toClips = to.audio ?? []
  let swappedAudio: number[] = []
  if (audioPlaces.length && toClips.length) {
    audioPlaces.forEach((at, k) => (audios[at] = referenceAudioOf(toClips[k % toClips.length])))
    swappedAudio = audioPlaces
  } else if (audioPlaces.length) {
    notes.push(
      `${to.name} har ${from.kind === 'character' ? 'ingen röst' : 'inget ljud'}, så ${from.name}s ${
        audioPlaces.length === 1 ? `@Audio${audioPlaces[0] + 1} är kvar` : 'ljudklipp är kvar'
      } – byt eller ta bort ${audioPlaces.length === 1 ? 'det' : 'dem'} om ${to.name} inte ska låta så.`
    )
  }
  if (places.length > to.images.length) {
    notes.push(
      `${to.name} har ${to.images.length === 1 ? 'ett foto' : `${to.images.length} foton`} men ${from.name} hade ${
        places.length
      } platser – samma foto används på flera platser så att inget nummer ändras.`
    )
  }
  const names = renamed(params, from, to, new Set(places.map((i) => i + 1)), new Set(swappedAudio.map((i) => i + 1)))
  return {
    params: {
      ...params,
      ...names,
      ...carried(params, from, to),
      referenceImages: images,
      ...(params.referenceAudios ? { referenceAudios: audios } : {})
    },
    notes
  }
}
