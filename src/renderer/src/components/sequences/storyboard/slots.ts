// What a storyboard panel's start and end slots hold, worked out from the segment the way main generates it, and
// the wording around them. Pure functions, so the panel, the menus and the segment editor agree.

import { kindOfModelId, supportsEndImage } from '@shared/models'
import type { Asset, SegmentImageSlot, Sequence, Still } from '@shared/types'
import { ASSET_COPY } from '../../../lib/assets'
import { samePath } from '../../../lib/library'
import { stillSourceLabel } from '../../images/imageModels'
import { effectiveParams, fileName } from '../sequenceUtils'

export type SlotState =
  /** Taken from a neighbour when the take is generated: the previous clip's last or the next clip's first frame. */
  | { kind: 'auto'; fromClip: number }
  /**
   * The clip's own picture (a still, a library photo, an upload). `unsent`: why it won't be sent as the clip stands
   * (the clip was switched to text or references in the editor afterwards). `refused`: why the clip can't be
   * generated with it as it stands (an end image its model can't take: main refuses the take rather than paying
   * for one without the keyframe).
   */
  | { kind: 'image'; path: string; unsent?: string; refused?: string }
  | { kind: 'empty' }

/**
 * What a slot holds, the way main will generate the clip. Putting an image in a slot switches the clip to an
 * image-to-video model (one that takes an end image for the end slot), so every slot can always be filled.
 */
export function slotState(sequence: Sequence, index: number, slot: SegmentImageSlot): SlotState {
  const s = sequence.segments[index]
  const params = effectiveParams(s, index)
  const imageMode = kindOfModelId(params.model) === 'image-to-video'
  // Outside image-to-video the pictures aren't sent (paramsForSubmit drops them); say so rather than hide them.
  const notImageMode = imageMode ? undefined : 'Klippet genereras från text eller referenser nu, så bilden skickas inte.'
  if (slot === 'start') {
    if (s.continueFromPrevious && index > 0) return { kind: 'auto', fromClip: index }
    if (params.startImage) return { kind: 'image', path: params.startImage, unsent: notImageMode }
    return { kind: 'empty' }
  }
  if (s.endFromNext && index < sequence.segments.length - 1) return { kind: 'auto', fromClip: index + 2 }
  if (params.endImage) {
    if (notImageMode) return { kind: 'image', path: params.endImage, unsent: notImageMode }
    const refused = supportsEndImage(params.model)
      ? undefined
      : 'Modellen tar ingen slutbild, så klippet kan inte genereras med den. Välj en modell som tar slutbild, eller ta bort bilden.'
    return { kind: 'image', path: params.endImage, refused }
  }
  return { kind: 'empty' }
}

/** True when the clip is generated from pictures (its own or a neighbour's) rather than text or references. */
export function usesKeyframes(sequence: Sequence, index: number): boolean {
  const start = slotState(sequence, index, 'start').kind
  const end = slotState(sequence, index, 'end').kind
  return start === 'auto' || start === 'image' || end === 'auto' || end === 'image'
}

export interface ImageLabel {
  text: string
  title?: string
}

/** A short caption for a slot's picture: which still, library photo or frame it is. */
export function describeImage(path: string, stills: readonly Still[], assets: readonly Asset[]): ImageLabel {
  const still = stills.find((s) => samePath(s.path, path))
  if (still) return { text: stillSourceLabel(still), title: still.prompt || fileName(path) }
  for (const a of assets) {
    if (a.images.some((img) => samePath(img.path, path))) {
      return { text: a.name, title: `${a.name} (${ASSET_COPY[a.kind].singular} i biblioteket)` }
    }
  }
  if (/[/\\](frames|bildrutor)[/\\]/.test(path)) return { text: 'Bildruta', title: 'Bildruta från ett klipp' }
  return { text: fileName(path), title: path }
}

/** "Sista bildrutan från klipp 2" / "Första bildrutan från klipp 4". */
export function autoLabel(slot: SegmentImageSlot, fromClip: number): string {
  return slot === 'start' ? `Sista bildrutan från klipp ${fromClip}` : `Första bildrutan från klipp ${fromClip}`
}

/** What "Gör om mellan grannarna" will do for the clip, or undefined when it has no neighbour to work between. */
export function bridgeDescription(index: number, count: number): string | undefined {
  const before = index > 0
  const after = index < count - 1
  if (before && after) {
    return `Gör om klippet så att det börjar exakt där klipp ${index} slutar och slutar exakt där klipp ${index + 2} börjar. Grannarna rörs inte, och den gamla tagningen finns kvar.`
  }
  if (before) return `Gör om klippet så att det börjar exakt där klipp ${index} slutar. Den gamla tagningen finns kvar.`
  if (after) return `Gör om klippet så att det slutar exakt där klipp ${index + 2} börjar. Den gamla tagningen finns kvar.`
  return undefined
}

/** Width over height from "16:9"; 16:9 when missing or unreadable. */
export function aspectValue(aspect: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '')
  const w = m ? Number(m[1]) : 16
  const h = m ? Number(m[2]) : 9
  return w > 0 && h > 0 ? w / h : 16 / 9
}

/** The sequence's picture shape: its default, else the first clip's, else 16:9. */
export function sequenceAspect(sequence: Sequence): string {
  return sequence.defaults.aspectRatio ?? sequence.segments.find((s) => s.params.aspectRatio)?.params.aspectRatio ?? '16:9'
}

/** A slot's size in pixels: the aspect ratio fitted inside maxWidth × maxHeight. */
export function slotSize(aspect: string | undefined, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const ratio = aspectValue(aspect)
  const width = Math.min(maxWidth, maxHeight * ratio)
  return { width: Math.round(width), height: Math.round(width / ratio) }
}
