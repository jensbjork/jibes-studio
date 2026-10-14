// A clip that inherits its references (continuing in reference mode with none of its own) names them by the numbers
// they have in the clip it carries them from. When a picture or clip there is swapped in place – a click on its
// thumbnail in the clip editor, swap_reference for an agent – no number changes, so its tokens stay as they are
// (renumbering would take a swapped picture's token out as if it were removed); only the name written right before a
// group of tokens that all changed follows, by the rule the clip's own prompt follows (shared/reference-swap.ts).

import type { InheritedTokens } from '@shared/continuation'
import { pathKey } from '@shared/generation-filter'
import { renameReferenceNames } from '@shared/prompt-remap'
import type { Asset } from '@shared/types'

/** The places (0-based) whose picture or clip was swapped. */
export interface SwappedPlaces {
  images: number[]
  audios: number[]
}

/** The places of `before` whose path changed, when that is all: same length, and every changed one gone from `after`. */
function placesSwapped(before: readonly string[], after: readonly string[]): number[] | undefined {
  if (before.length !== after.length) return undefined
  const left = new Set(after.map(pathKey))
  const changed = before.flatMap((p, i) => (pathKey(p) === pathKey(after[i]) ? [] : [i]))
  return changed.every((i) => !left.has(pathKey(before[i]))) ? changed : undefined
}

/**
 * The places swapped in place between two carried lists, when nothing else changed: as many pictures and clips as
 * before, and every one that changed gone from its list (a reorder, or a picture added or removed, is no swap).
 * Undefined otherwise.
 */
export function swappedInPlace(was: InheritedTokens, now: InheritedTokens): SwappedPlaces | undefined {
  const images = placesSwapped(was.images, now.images)
  const audios = placesSwapped(
    was.audios.map((a) => a.path),
    now.audios.map((a) => a.path)
  )
  return images && audios && (images.length || audios.length) ? { images, audios } : undefined
}

/**
 * The prompt after a swap in place: every token as it was, and the name in front of a group of swapped tokens changed
 * where every place an asset had among the carried pictures now shows one other asset ("Anna (@Image1)" →
 * "Bo (@Image1)"; "Anna (@Image1, voice @Audio1)" only when the voice was swapped too).
 */
export function followSwap(
  prompt: string,
  was: InheritedTokens,
  now: InheritedTokens,
  swapped: SwappedPlaces,
  assets: readonly Asset[]
): string {
  if (!prompt || !swapped.images.length) return prompt
  // The asset a picture or clip belongs to: the first one claiming the file, as the shared swap reads it.
  const photos = new Map<string, Asset>()
  const clips = new Map<string, Asset>()
  for (const asset of assets) {
    for (const image of asset.images) if (!photos.has(pathKey(image.path))) photos.set(pathKey(image.path), asset)
    for (const clip of asset.audio ?? []) if (!clips.has(pathKey(clip.path))) clips.set(pathKey(clip.path), asset)
  }
  const photoOf = (path: string | undefined): Asset | undefined => (path ? photos.get(pathKey(path)) : undefined)
  const clipOf = (path: string | undefined): Asset | undefined => (path ? clips.get(pathKey(path)) : undefined)
  let out = prompt
  const fromIds = new Set(swapped.images.flatMap((i) => photoOf(was.images[i])?.id ?? []))
  for (const fromId of fromIds) {
    // Still among the pictures elsewhere: "Anna (@Image1, @Image2)" with one of two swapped is still Anna.
    if (now.images.some((p) => photoOf(p)?.id === fromId)) continue
    const places = swapped.images.filter((i) => photoOf(was.images[i])?.id === fromId)
    const toIds = new Set(places.map((i) => photoOf(now.images[i])?.id))
    const from = assets.find((a) => a.id === fromId)
    const to = toIds.size === 1 ? assets.find((a) => a.id === [...toIds][0]) : undefined
    if (!from || !to || to.id === from.id) continue
    const images = new Set(places.map((i) => i + 1))
    const audios = new Set(
      swapped.audios
        .filter((i) => clipOf(was.audios[i]?.path)?.id === from.id && clipOf(now.audios[i]?.path)?.id === to.id)
        .map((i) => i + 1)
    )
    out = renameReferenceNames(out, from.name, to.name, (ref, n) => (ref === 'image' ? images : audios).has(n))
  }
  return out
}
