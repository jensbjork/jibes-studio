import type { WorkSummary } from '@shared/types'
import type { Navigate } from './navigation'

// A generation with a segmentId is a take: of a sequence's clip, or of a storyboard's transition (a storyboard's
// transitions are segments too). The two live in separate lists and views, so the clip feed asks here which one a
// take belongs to before it offers to open it.

/** The sequence clip or storyboard transition a take belongs to. */
export interface TakeOwner {
  kind: 'sequence' | 'storyboard'
  id: string
  name: string
  /** 1-based: "Klipp 3", "Övergång 2". */
  number: number
}

/**
 * The sequence or storyboard Pågår och klart already knows the clip or transition by (main joined the owner for
 * everything running or new), so only that one is read instead of every sequence and storyboard.
 */
function ownerFromSummary(
  summary: WorkSummary,
  segmentId: string
): { kind: TakeOwner['kind']; id: string } | undefined {
  for (const w of [...summary.running, ...summary.unseen]) {
    if (w.segmentId !== segmentId || !w.ownerId) continue
    if (w.view === 'sequences') return { kind: 'sequence', id: w.ownerId }
    if (w.view === 'storyboards') return { kind: 'storyboard', id: w.ownerId }
  }
  return undefined
}

/** The take's place in that one sequence or storyboard, or undefined when it isn't there (any more). */
async function lookIn(kind: TakeOwner['kind'], id: string, segmentId: string): Promise<TakeOwner | undefined> {
  if (kind === 'sequence') {
    const sequence = await window.studio.getSequence(id).catch(() => undefined)
    const index = sequence ? sequence.segments.findIndex((s) => s.id === segmentId) : -1
    return sequence && index >= 0 ? { kind, id: sequence.id, name: sequence.name, number: index + 1 } : undefined
  }
  const storyboard = await window.studio.getStoryboard(id).catch(() => undefined)
  const index = storyboard ? storyboard.transitions.findIndex((t) => t.id === segmentId) : -1
  return storyboard && index >= 0 ? { kind, id: storyboard.id, name: storyboard.name, number: index + 1 } : undefined
}

/** Where a take belongs, or undefined when its clip or transition is gone. */
export async function findTakeOwner(segmentId: string): Promise<TakeOwner | undefined> {
  const summary = await window.studio.getWorkSummary().catch(() => undefined)
  const known = summary && ownerFromSummary(summary, segmentId)
  if (known) {
    const found = await lookIn(known.kind, known.id, segmentId)
    if (found) return found
  }
  // Nothing running or new there: look through them all (a click on a badge; a linear scan is fine).
  for (const summary of await window.studio.listSequences()) {
    if (known?.id === summary.id) continue
    const found = await lookIn('sequence', summary.id, segmentId)
    if (found) return found
  }
  for (const summary of await window.studio.listStoryboards()) {
    if (known?.id === summary.id) continue
    const found = await lookIn('storyboard', summary.id, segmentId)
    if (found) return found
  }
  return undefined
}

/** "Klipp 3 i ”Namn”" / "Övergång 2 i ”Namn”". */
export function takeOwnerLabel(owner: TakeOwner): string {
  return `${owner.kind === 'storyboard' ? 'Övergång' : 'Klipp'} ${owner.number} i ”${owner.name}”`
}

/**
 * Shows the take where it belongs: the sequence on its clip (with the take focused in the strip when `generationId`
 * is given), or the storyboard with the transition open in its editor.
 */
export function openTakeOwner(owner: TakeOwner, segmentId: string, navigate: Navigate, generationId?: string): void {
  if (owner.kind === 'storyboard') {
    navigate('storyboards', { type: 'open-storyboard', storyboardId: owner.id, transitionId: segmentId })
  } else {
    navigate('sequences', {
      type: 'open-sequence',
      sequenceId: owner.id,
      segmentId,
      ...(generationId ? { generationId } : {})
    })
  }
}
