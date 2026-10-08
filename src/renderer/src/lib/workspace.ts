import { useEffect } from 'react'
import { LAST_EDIT_KEY, LAST_SEQUENCE_KEY, LAST_STORYBOARD_KEY } from './library'

// Where the user is in the sequence editor (and in Storyboards and Redigera), so an agent asking "what are they
// looking at" gets the open sequence and clip, the open storyboard, or the open edit and the version on screen (see
// agentBridge's get_form). The segment editor and the edit workspace report themselves while they are mounted; the
// Storyboards and Redigera views remember what they show.

interface OpenSegment {
  sequenceId: string
  segmentId: string
}

let openSegment: OpenSegment | undefined

/** Records the segment shown in the sequence editor while the calling component is mounted. */
export function useReportOpenSegment(sequenceId: string, segmentId: string): void {
  useEffect(() => {
    const entry: OpenSegment = { sequenceId, segmentId }
    openSegment = entry
    return () => {
      if (openSegment === entry) openSegment = undefined
    }
  }, [sequenceId, segmentId])
}

/** The sequence and clip open in the sequence editor; just the sequence while it has no clip selected. */
export function openInSequenceEditor(): { sequenceId?: string; segmentId?: string } {
  if (openSegment) return { ...openSegment }
  try {
    return { sequenceId: localStorage.getItem(LAST_SEQUENCE_KEY) ?? undefined }
  } catch {
    return {}
  }
}

/** The storyboard open in Storyboards (the one it shows when the view is open). */
export function openStoryboard(): string | undefined {
  try {
    return localStorage.getItem(LAST_STORYBOARD_KEY) ?? undefined
  } catch {
    return undefined
  }
}

interface OpenEdit {
  editId: string
  /** The version in the player (the current one, or another one being compared with it). */
  versionId?: string
}

let openEdit: OpenEdit | undefined

/** Records the edit (and the version in its player) shown in Redigera while the calling component is mounted. */
export function useReportOpenEdit(editId: string, versionId: string | undefined): void {
  useEffect(() => {
    const entry: OpenEdit = { editId, versionId }
    openEdit = entry
    return () => {
      if (openEdit === entry) openEdit = undefined
    }
  }, [editId, versionId])
}

/**
 * The edit open in Redigera and the version its player shows; the remembered edit (without a version) while the
 * view isn't mounted; nothing while Redigera shows its list.
 */
export function openEditInEditor(): { editId?: string; versionId?: string } {
  if (openEdit) return { ...openEdit }
  try {
    return { editId: localStorage.getItem(LAST_EDIT_KEY) ?? undefined }
  } catch {
    return {}
  }
}
