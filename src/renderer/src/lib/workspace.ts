import { useEffect } from 'react'
import { LAST_SEQUENCE_KEY } from './library'

// Where the user is in the sequence editor, so an agent asking "what are they looking at" gets the open
// sequence and clip (see agentBridge's get_form). The segment editor reports itself while it is mounted.

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
