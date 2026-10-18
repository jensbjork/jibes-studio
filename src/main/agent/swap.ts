import { findAudioTokens, findImageTokens } from '@shared/prompt-refs'
import { swapReferenceAsset, swapReferenceImage, type SwapResult } from '@shared/reference-swap'
import type { Asset, GenerationParams, ReferenceAudio } from '@shared/types'
import { namedPositions } from './reorder'
import {
  AssetIndex,
  StillIndex,
  assetPhotoPath,
  describeAudio,
  describePicture,
  q,
  type AudioInfo,
  type PictureInfo
} from './studio'

// Swapping a reference in place (swap_reference; a click on a reference thumbnail in Studio): another picture – or
// every place of one asset, with its voice and a character's outfit – takes the same places, so no @ImageN / @AudioN number changes. The rules
// are the shared ones (shared/reference-swap.ts), which the form, the clip editor and the agents' tool all apply.
// Here: reading the place and the new picture an agent names, and saying what now shows what.

/**
 * What main sends the window for swap_reference: one place – the picture there (by path, so the window swaps that very
 * picture even if the user reordered meanwhile; its 0-based place as a hint for a picture that is there twice) and the
 * new picture – or every place of one asset taken by another.
 */
export type AgentSwapReferenceArgs =
  | { image: string; index: number; path: string }
  | { from_asset_id: string; to_asset_id: string }

/** The new picture as an agent names it. */
export type SwapWith = { asset_id: string; image_id?: string } | { still_id: string } | { upload_id: string }

export interface SwapInput {
  /** The place: its @ImageN token in the current numbering, or the image_id of the library photo there. */
  image: string
  with: SwapWith
  whole_asset: boolean
}

/**
 * A swap read against a reference list: one place and its new picture (an upload is made a still only once everything
 * else is known to be right, so its path comes later), or every place of `from` taken by `to`.
 */
export type SwapPlan =
  | { whole: false; place: number; path: string }
  | { whole: false; place: number; uploadId: string }
  | { whole: true; place: number; from: Asset; to: Asset }

/** A plan whose new picture is known. */
export type ReadySwap = Exclude<SwapPlan, { uploadId: string }>

/**
 * The swap an agent asks for, checked against `paths` (the list's pictures, @Image1 first; `where` names it for
 * messages: "the form", "clip 3"). Throws on a place that isn't there, a whole-asset swap of a loose
 * picture or to anything but an asset, and a new picture that can't be found.
 */
export async function planSwap(
  input: SwapInput,
  paths: readonly string[],
  index: AssetIndex,
  where: string
): Promise<SwapPlan> {
  const entry = input.image.trim()
  const audio = findAudioTokens(entry)
  if (audio.length === 1 && audio[0].start === 0 && audio[0].end === entry.length) {
    throw new Error(
      `${entry} is an audio clip. swap_reference swaps an image: give the place with its @ImageN token or image_id. A voice follows its asset when you swap the whole asset (whole_asset: true).`
    )
  }
  const places = namedPositions('image', [entry], paths, index, where)
  if (places.length > 1 && !input.whole_asset) {
    const name = index.get(entry)?.name ?? entry
    const tokens = places.map((i) => `@Image${i + 1}`).join(', ')
    throw new Error(
      `${q(name)} has ${places.length} images among the reference images in ${where} (${tokens}). Give the place to swap with its token or image_id – or swap them all with whole_asset: true.`
    )
  }
  const place = places[0]
  const replacement = input.with
  if (input.whole_asset) {
    const from = index.photo(paths[place])?.asset
    if (!from) {
      throw new Error(
        `@Image${place + 1} in ${where} is a loose image, not a photo of a character, environment, product, outfit or pose, so there is no asset to swap whole. Swap just that place (without whole_asset).`
      )
    }
    if (!('asset_id' in replacement)) {
      throw new Error(
        `whole_asset swaps ${q(from.name)} for another asset: with must be {asset_id}, not a loose image. To swap a single place for a loose image, leave out whole_asset.`
      )
    }
    if (replacement.image_id) {
      throw new Error(
        `whole_asset gives ${q(from.name)}'s places the new asset's photos in order – leave out image_id, or swap one place at a time without whole_asset.`
      )
    }
    const to = index.require(replacement.asset_id)
    if (!to.images.length) {
      throw new Error(`${q(to.name)} has no photos to swap to. Add images with add_asset_images first.`)
    }
    return { whole: true, place, from, to }
  }
  if ('asset_id' in replacement) {
    return { whole: false, place, path: assetPhotoPath(replacement.asset_id, replacement.image_id, index) }
  }
  if ('still_id' in replacement) {
    return { whole: false, place, path: (await StillIndex.load()).require(replacement.still_id).path }
  }
  return { whole: false, place, uploadId: replacement.upload_id }
}

const pathKey = (path: string): string => path.normalize('NFC')

/** Whether the swap would leave the list as it is: the same picture, or the asset itself. */
export function swapsNothing(plan: ReadySwap, paths: readonly string[]): boolean {
  return plan.whole ? plan.from.id === plan.to.id : pathKey(paths[plan.place]) === pathKey(plan.path)
}

/** The shared swap on `params` (whose referenceImages are the list the plan was read against). */
export function applySwap(params: GenerationParams, plan: ReadySwap, assets: readonly Asset[]): SwapResult {
  return plan.whole
    ? swapReferenceAsset(params, plan.from, plan.to, assets)
    : swapReferenceImage(params, plan.place, plan.path, assets)
}

/** What swap_reference sends the window for a plan. */
export function swapArgs(plan: ReadySwap, paths: readonly string[]): AgentSwapReferenceArgs {
  return plan.whole
    ? { from_asset_id: plan.from.id, to_asset_id: plan.to.id }
    : { image: paths[plan.place], index: plan.place, path: plan.path }
}

/** A token that shows another picture or clip after a swap: what it showed, and what it shows now. */
export interface SwappedToken {
  token: string
  was: PictureInfo | AudioInfo
  now: PictureInfo | AudioInfo
}

export interface Swapped {
  images: SwappedToken[]
  audios: SwappedToken[]
}

/** Which tokens show another picture or clip, place by place (matched by path, so it describes what the list became). */
export function swappedTokens(
  before: { images: readonly string[]; audios: readonly ReferenceAudio[] },
  after: { images: readonly string[]; audios: readonly ReferenceAudio[] },
  index: AssetIndex
): Swapped {
  const images = before.images.flatMap((path, i): SwappedToken[] => {
    const now = after.images[i]
    if (now === undefined || pathKey(now) === pathKey(path)) return []
    return [{ token: `@Image${i + 1}`, was: describePicture(path, index), now: describePicture(now, index) }]
  })
  const audios = before.audios.flatMap((clip, i): SwappedToken[] => {
    const now = after.audios[i]
    if (!now || pathKey(now.path) === pathKey(clip.path)) return []
    return [{ token: `@Audio${i + 1}`, was: describeAudio(clip, index), now: describeAudio(now, index) }]
  })
  return { images, audios }
}

/** `swapped` in the answer: only the lists that have something. */
export function swappedInfo(swapped: Swapped): Record<string, unknown> {
  return {
    swapped: {
      ...(swapped.images.length ? { images: swapped.images } : {}),
      ...(swapped.audios.length ? { audios: swapped.audios } : {})
    }
  }
}

const nameOf = (info: PictureInfo | AudioInfo): string => info.asset_name ?? info.file ?? 'an image'

/**
 * The activity log's words for a swap: "swapped @Image2 among the references (Anna → Bo)" or "swapped “Anna” for “Bo”
 * among the references (@Image1, @Image2, @Audio1)"; `where` is put after "references" (" in clip 3 in “Sommar”").
 */
export function swapSummary(plan: ReadySwap, swapped: Swapped, where = ''): string {
  const all = [...swapped.images, ...swapped.audios]
  if (plan.whole) {
    const tokens = all.map((s) => s.token)
    const list = tokens.length ? ` (${tokens.slice(0, 6).join(', ')}${tokens.length > 6 ? ' …' : ''})` : ''
    return `swapped ${q(plan.from.name)} for ${q(plan.to.name)} among the references${where}${list}`
  }
  const one = swapped.images[0]
  return one
    ? `swapped ${one.token} among the references${where} (${nameOf(one.was)} → ${nameOf(one.now)})`
    : `swapped a reference image${where}`
}

/**
 * Notes about what the swap did to the prompt and the list: the name that followed, a prompt that didn't
 * follow where the swapped token is written, and a new picture that now is in the list twice.
 */
export function swapNotes(
  before: GenerationParams,
  after: GenerationParams,
  plan: ReadySwap,
  swapped: Swapped,
  index: AssetIndex
): string[] {
  const notes: string[] = []
  const followed =
    after.prompt !== before.prompt || (after.negativePrompt ?? '') !== (before.negativePrompt ?? '')
  const tokens = [...swapped.images, ...swapped.audios].map((s) => s.token)
  if (followed && plan.whole) {
    // By the asset each token shows now: a character's outfit may have followed it under a name of its own.
    const groups = new Map<string, string[]>()
    for (const s of [...swapped.images, ...swapped.audios]) {
      const name = nameOf(s.now)
      groups.set(name, [...(groups.get(name) ?? []), s.token])
    }
    const named = [...groups].map(([name, list]) => `${list.join(', ')} is now ${q(name)}`)
    notes.push(`The prompt followed: the name in front of ${named.join(' and in front of ')} – no numbers changed.`)
  } else if (followed) {
    const to = swapped.images[0] ? nameOf(swapped.images[0].now) : undefined
    notes.push(
      `The prompt followed: the name in front of ${tokens.join(', ')} is now ${to ? q(to) : 'the new one'} – no numbers changed.`
    )
  } else if (!plan.whole && swapped.images.length) {
    // A place of an asset that has more pictures there, or a loose picture: the name in front of it stays.
    const one = swapped.images[0]
    const mentioned = [before.prompt, before.negativePrompt ?? ''].some((text) =>
      findImageTokens(text).some((t) => `@Image${t.index}` === one.token)
    )
    if (mentioned && nameOf(one.was) !== nameOf(one.now)) {
      notes.push(
        `The prompt wasn't changed (no numbers change in a swap): make sure the text around ${one.token} matches the new image.`
      )
    }
  }
  const images = after.referenceImages ?? []
  const swappedPlaces = new Set(swapped.images.map((s) => Number(s.token.slice('@Image'.length)) - 1))
  for (const i of swappedPlaces) {
    const twin = images.findIndex((p, j) => j !== i && !swappedPlaces.has(j) && pathKey(p) === pathKey(images[i]))
    if (twin !== -1) {
      notes.push(`The image at @Image${i + 1} is also @Image${twin + 1}, so it is sent twice.`)
    }
  }
  return notes
}

/** The answer when the swap would change nothing. */
export function unchangedNote(plan: ReadySwap): string {
  return plan.whole
    ? `@Image${plan.place + 1} is already ${q(plan.from.name)} – nothing changed.`
    : `@Image${plan.place + 1} already shows that image – nothing changed.`
}
