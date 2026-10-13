// The list arithmetic behind reordering references by drag and drop (and ⌥← / ⌥→): pure functions, so the
// image strip and the audio chips move things the same way. (Renumbering the prompt's tokens after a move is
// src/shared/prompt-remap.ts, shared with main and the agent bridge.)
//
// A drop lands in a *gap*: gap g sits before item g, and gap n (the length) after the last item. Moving an item
// into the gap right before or after itself changes nothing.

/** The list with the item at `from` moved to index `to` (both 0-based; `to` is clamped into the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const target = Math.max(0, Math.min(out.length - 1, to))
  if (target === from) return out
  const [item] = out.splice(from, 1)
  out.splice(target, 0, item)
  return out
}

/** Where the item at `from` ends up when dropped into `gap`. */
export function indexForGap(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap
}

/** Whether dropping the item at `from` into `gap` would move it at all. */
export function gapMoves(from: number, gap: number): boolean {
  return gap !== from && gap !== from + 1
}

/**
 * Where every item would be if the one at `from` were dropped into `gap`: result[i] is item i's new index. The
 * strip shows these numbers while dragging, so the new @ImageN names (and what falls past the model's limit)
 * are visible before letting go.
 */
export function previewPositions(count: number, from: number, gap: number | undefined): number[] {
  const identity = Array.from({ length: count }, (_, i) => i)
  if (gap === undefined || from < 0 || from >= count || !gapMoves(from, gap)) return identity
  const order = moveItem(identity, from, indexForGap(from, gap))
  const positions = new Array<number>(count)
  order.forEach((item, at) => (positions[item] = at))
  return positions
}

/** An item's box on screen, as getBoundingClientRect gives it. */
export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * The gap nearest the pointer, for items that wrap onto several rows: beside the closest item of the row the
 * pointer is level with (the nearest row when it is between rows), on the side of the item's middle the pointer
 * is on – so past the end of a short last row means "after its last item", not "after the row above".
 * `boxes[i]` is item i's box (undefined for one not on screen); undefined when none is.
 */
export function nearestGap(
  boxes: readonly (Box | undefined)[],
  x: number,
  y: number
): { gap: number; at: number; side: 'before' | 'after' } | undefined {
  let best: { i: number; dx: number; dy: number; box: Box } | undefined
  boxes.forEach((box, i) => {
    if (!box) return
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
    if (!best || dy < best.dy || (dy === best.dy && dx < best.dx)) best = { i, dx, dy, box }
  })
  if (!best) return undefined
  const after = x > (best.box.left + best.box.right) / 2
  return { gap: after ? best.i + 1 : best.i, at: best.i, side: after ? 'after' : 'before' }
}

