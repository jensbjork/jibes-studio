import { useEffect, useState } from 'react'
import type { Segment, SegmentFramePreview, Sequence } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { effectiveParams, selectedTake, stableJson } from './sequenceUtils'

export interface FramePreviewState {
  /** The last answer; kept while a newer one loads so the pictures don't flicker. */
  preview?: SegmentFramePreview
  loading: boolean
  error?: string
}

// Main extracts a neighbour's frame with ffmpeg the first time and caches the file, so asking twice is cheap,
// but clicking through the clips asks again for each one: keep a short memory of answers and only a couple of
// extractions running at a time.
const MAX_RUNNING = 2
const MAX_CACHED = 200
const cache = new Map<string, Promise<SegmentFramePreview>>()
const waiting: (() => void)[] = []
let running = 0

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++
      task()
        .then(resolve, reject)
        .finally(() => {
          running--
          waiting.shift()?.()
        })
    }
    if (running < MAX_RUNNING) start()
    else waiting.push(start)
  })
}

function fetchPreview(segmentId: string, key: string): Promise<SegmentFramePreview> {
  const cacheKey = `${segmentId}|${key}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const request = schedule(() => window.studio.previewSegmentFrames(segmentId))
  cache.set(cacheKey, request)
  // A failure (a take being moved, ffmpeg busy) is worth asking again for next time.
  request.catch(() => cache.delete(cacheKey))
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
  return request
}

/** What of a neighbour decides the frame taken from it. */
function neighbourKey(s: Segment | undefined, trim: number | undefined): unknown {
  if (!s) return null
  const take = selectedTake(s)
  return [s.id, take?.id, take?.status, take?.filePath, !!take?.fileMissing, take?.videoDuration, trim]
}

/**
 * Everything the preview of a segment's start and end frames depends on: its flags and params (the problems
 * include what is wrong with the prompt too – for a continuation in reference mode against the references it carries
 * from the clips before, so those count as well), and the selected take and trim of the neighbour each automatic
 * frame comes from. Clip numbers appear in the problems' wording, so the position counts as well.
 */
export function framePreviewKey(sequence: Sequence, index: number): string {
  const s = sequence.segments[index]
  if (!s) return ''
  const previous = index > 0 ? sequence.segments[index - 1] : undefined
  const next = sequence.segments[index + 1]
  return stableJson([
    index,
    s.continueFromPrevious,
    s.continueMode,
    s.endFromNext,
    s.params,
    s.continueFromPrevious ? effectiveParams(s, index, sequence) : null,
    s.continueFromPrevious ? neighbourKey(previous, previous?.trimEnd) : null,
    s.endFromNext ? neighbourKey(next, next?.trimStart) : null
  ])
}

/** Whether a segment has anything automatic for main to work out (a neighbour's frame). */
export function hasAutomaticFrames(segment: Segment, index: number, count: number): boolean {
  return (segment.continueFromPrevious && index > 0) || (segment.endFromNext && index < count - 1)
}

/**
 * The start and end frames a new take of the clip would be made from, as main works them out
 * (previewSegmentFrames): the previous clip's last frame, the next clip's first frame, or the clip's own images,
 * plus what stands in the way, in Swedish. Re-asked whenever something it depends on changes.
 */
export function useFramePreview(sequence: Sequence | undefined, index: number, enabled = true): FramePreviewState {
  const segmentId = sequence?.segments[index]?.id
  const key = sequence && segmentId && enabled ? framePreviewKey(sequence, index) : ''
  const [state, setState] = useState<FramePreviewState & { for?: string }>({ loading: false })

  useEffect(() => {
    if (!key || !segmentId) {
      setState({ loading: false })
      return
    }
    let cancelled = false
    // A different clip's preview must not stand in for this one's while it loads.
    setState((s) => ({ ...(s.for === segmentId ? s : {}), for: segmentId, loading: true, error: undefined }))
    // Short delay: dragging a trim, flipping takes or typing a prompt changes the key many times in a row.
    const t = setTimeout(() => {
      fetchPreview(segmentId, key).then(
        (preview) => !cancelled && setState({ for: segmentId, preview, loading: false }),
        (e: unknown) => !cancelled && setState({ for: segmentId, loading: false, error: ipcErrorMessage(e) })
      )
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [key, segmentId])

  if (!key || state.for !== segmentId) return { loading: !!key }
  return { preview: state.preview, loading: state.loading, error: state.error }
}
