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

// Swapping a reference in place (swap_reference; "Byt bilden…" and "Byt hela …" in Studio): another picture – or
// every place of one asset, with its voice – takes the same places, so no @ImageN / @AudioN number changes. The rules
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
 * messages: "formuläret", "klipp 3"). Throws (in Swedish) on a place that isn't there, a whole-asset swap of a loose
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
      `${entry} är ett ljudklipp. swap_reference byter en bild: ange platsen med dess @ImageN-token eller image_id. En röst följer med sin tillgång när du byter hela tillgången (whole_asset: true).`
    )
  }
  const places = namedPositions('image', [entry], paths, index, where)
  if (places.length > 1 && !input.whole_asset) {
    const name = index.get(entry)?.name ?? entry
    const tokens = places.map((i) => `@Image${i + 1}`).join(', ')
    throw new Error(
      `${q(name)} har ${places.length} bilder bland referensbilderna i ${where} (${tokens}). Ange vilken plats som ska bytas med dess token eller image_id – eller byt alla med whole_asset: true.`
    )
  }
  const place = places[0]
  const replacement = input.with
  if (input.whole_asset) {
    const from = index.photo(paths[place])?.asset
    if (!from) {
      throw new Error(
        `@Image${place + 1} i ${where} är en lös bild, inte ett foto av en karaktär, miljö, produkt, klädsel eller pose, så det finns ingen tillgång att byta helt. Byt bara den platsen (utan whole_asset).`
      )
    }
    if (!('asset_id' in replacement)) {
      throw new Error(
        `whole_asset byter ${q(from.name)} mot en annan tillgång: with ska vara {asset_id}, inte en lös bild. För att byta en enda plats mot en lös bild, utelämna whole_asset.`
      )
    }
    if (replacement.image_id) {
      throw new Error(
        `whole_asset ger ${q(from.name)}s platser den nya tillgångens foton i ordning – utelämna image_id, eller byt en plats i taget utan whole_asset.`
      )
    }
    const to = index.require(replacement.asset_id)
    if (!to.images.length) {
      throw new Error(`${q(to.name)} har inga foton att byta till. Lägg till bilder med add_asset_images först.`)
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
    ? swapReferenceAsset(params, plan.from, plan.to)
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

const nameOf = (info: PictureInfo | AudioInfo): string => info.asset_name ?? info.file ?? 'en bild'

/**
 * The activity log's words for a swap: "bytte @Image2 bland referenserna (Anna → Bo)" or "bytte ”Anna” mot ”Bo”
 * bland referenserna (@Image1, @Image2, @Audio1)"; `where` is put after "referenserna" (" i klipp 3 i ”Sommar”").
 */
export function swapSummary(plan: ReadySwap, swapped: Swapped, where = ''): string {
  const all = [...swapped.images, ...swapped.audios]
  if (plan.whole) {
    const tokens = all.map((s) => s.token)
    const list = tokens.length ? ` (${tokens.slice(0, 6).join(', ')}${tokens.length > 6 ? ' …' : ''})` : ''
    return `bytte ${q(plan.from.name)} mot ${q(plan.to.name)} bland referenserna${where}${list}`
  }
  const one = swapped.images[0]
  return one
    ? `bytte ${one.token} bland referenserna${where} (${nameOf(one.was)} → ${nameOf(one.now)})`
    : `bytte en referensbild${where}`
}

/**
 * Notes (Swedish) about what the swap did to the prompt and the list: the name that followed, a prompt that didn't
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
  if (followed) {
    const to = plan.whole ? plan.to.name : swapped.images[0] ? nameOf(swapped.images[0].now) : undefined
    notes.push(
      `Prompten följde med: namnet framför ${tokens.join(', ')} är nu ${to ? q(to) : 'det nya'} – inga nummer ändrades.`
    )
  } else if (!plan.whole && swapped.images.length) {
    // A place of an asset that has more pictures there, or a loose picture: the name in front of it stays.
    const one = swapped.images[0]
    const mentioned = [before.prompt, before.negativePrompt ?? ''].some((text) =>
      findImageTokens(text).some((t) => `@Image${t.index}` === one.token)
    )
    if (mentioned && nameOf(one.was) !== nameOf(one.now)) {
      notes.push(
        `Prompten ändrades inte (inga nummer ändras vid ett byte): se till att texten kring ${one.token} stämmer med den nya bilden.`
      )
    }
  }
  const images = after.referenceImages ?? []
  const swappedPlaces = new Set(swapped.images.map((s) => Number(s.token.slice('@Image'.length)) - 1))
  for (const i of swappedPlaces) {
    const twin = images.findIndex((p, j) => j !== i && !swappedPlaces.has(j) && pathKey(p) === pathKey(images[i]))
    if (twin !== -1) {
      notes.push(`Bilden på @Image${i + 1} finns också som @Image${twin + 1}, så den skickas två gånger.`)
    }
  }
  return notes
}

/** The answer when the swap would change nothing. */
export function unchangedNote(plan: ReadySwap): string {
  return plan.whole
    ? `@Image${plan.place + 1} är redan ${q(plan.from.name)} – inget ändrades.`
    : `@Image${plan.place + 1} visar redan den bilden – inget ändrades.`
}
