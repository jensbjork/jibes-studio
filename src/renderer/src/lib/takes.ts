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

/** Where a take belongs, or undefined when its clip or transition is gone. */
export async function findTakeOwner(segmentId: string): Promise<TakeOwner | undefined> {
  for (const summary of await window.studio.listSequences()) {
    const sequence = await window.studio.getSequence(summary.id).catch(() => undefined)
    const index = sequence ? sequence.segments.findIndex((s) => s.id === segmentId) : -1
    if (sequence && index >= 0) return { kind: 'sequence', id: sequence.id, name: sequence.name, number: index + 1 }
  }
  for (const summary of await window.studio.listStoryboards()) {
    const storyboard = await window.studio.getStoryboard(summary.id).catch(() => undefined)
    const index = storyboard ? storyboard.transitions.findIndex((t) => t.id === segmentId) : -1
    if (storyboard && index >= 0) {
      return { kind: 'storyboard', id: storyboard.id, name: storyboard.name, number: index + 1 }
    }
  }
  return undefined
}

/** "Klipp 3 i ”Namn”" / "Övergång 2 i ”Namn”". */
export function takeOwnerLabel(owner: TakeOwner): string {
  return `${owner.kind === 'storyboard' ? 'Övergång' : 'Klipp'} ${owner.number} i ”${owner.name}”`
}

/** Shows the take where it belongs: the sequence on its clip, or the storyboard. */
export function openTakeOwner(owner: TakeOwner, segmentId: string, navigate: Navigate): void {
  if (owner.kind === 'storyboard') navigate('storyboards', { type: 'open-storyboard', storyboardId: owner.id })
  else navigate('sequences', { type: 'open-sequence', sequenceId: owner.id, segmentId })
}
