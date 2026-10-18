import { useCallback, useEffect, useRef, useState } from 'react'
import type { Edit, EditProgress, EditTimeline, Transcript } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'

// The edit view's data from main, live: the edit (versions, jobs, media), the current version's timeline and
// transcript, and the progress of what is being made. Main announces changes with edit:change (the edit) and
// edit:progress (renders and jobs); takes being generated for picture operations come as generation updates.

/** Main's wording when an edit no longer exists (deleted elsewhere, or the library was switched). */
function isMissing(message: string): boolean {
  return /no longer exists|does not exist|not found/i.test(message)
}

export function useEdit(editId: string, onMissing: (id: string) => void) {
  const [edit, setEdit] = useState<Edit>()
  const [error, setError] = useState<string>()
  // Progress per job, and under 'render' for a free operation rendering right now (it has no job).
  const [progress, setProgress] = useState<Record<string, EditProgress>>({})
  const latest = useRef(0)
  const loaded = useRef(false)
  const editRef = useRef<Edit>(undefined)
  editRef.current = edit
  const missingRef = useRef(onMissing)
  missingRef.current = onMissing

  const refresh = useCallback(async (): Promise<Edit | undefined> => {
    // Only the newest request may land, so a slow older reply can't bring back an older state.
    const n = ++latest.current
    try {
      const next = await window.studio.getEdit(editId)
      if (n === latest.current) {
        setEdit(next)
        setError(undefined)
        loaded.current = true
      }
      return next
    } catch (e) {
      const message = ipcErrorMessage(e)
      if (n !== latest.current) return undefined
      if (isMissing(message) || !loaded.current) missingRef.current(editId)
      else setError(message)
      return undefined
    }
  }, [editId])

  useEffect(() => {
    loaded.current = false
    setEdit(undefined)
    setProgress({})
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Bursts of events (a job's steps, several takes) are fetched once.
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 120)
    }
    const offChange = window.studio.onEditChange((id) => {
      if (id === editId) soon()
    })
    const belongs = (id: string) => !!editRef.current?.generationIds.includes(id)
    const offUpdate = window.studio.onGenerationUpdate((g) => {
      if (g.editId === editId || belongs(g.id)) soon()
    })
    const offDelete = window.studio.onGenerationDelete((id) => {
      if (belongs(id)) soon()
    })
    const offProgress = window.studio.onEditProgress((p) => {
      if (p.editId !== editId) return
      const key = p.jobId ?? 'render'
      setProgress((m) => {
        if (p.done) {
          if (!(key in m)) return m
          const next = { ...m }
          delete next[key]
          return next
        }
        return { ...m, [key]: p }
      })
      if (p.done) soon()
    })
    return () => {
      clearTimeout(timer)
      offChange()
      offUpdate()
      offDelete()
      offProgress()
    }
  }, [editId, refresh])

  return { edit, error, progress, refresh, setEdit }
}

// Timelines are per version, and a version never changes once made: keep a few, so ⌘Z and Compare are instant.
const timelineCache = new Map<string, EditTimeline>()
const TIMELINE_CACHE_SIZE = 8

/** The filmstrip, waveform, cuts, layers and mutes of a version (free; main caches the heavy parts). */
export function useTimeline(generationId: string | undefined): {
  timeline?: EditTimeline
  loading: boolean
  error?: string
} {
  const [state, setState] = useState<{ id?: string; timeline?: EditTimeline; error?: string }>({})
  useEffect(() => {
    if (!generationId) return
    const cached = timelineCache.get(generationId)
    if (cached) {
      setState({ id: generationId, timeline: cached })
      return
    }
    let active = true
    // Keep the previous version's lanes until the new ones come (a new version is usually the same length).
    setState((s) => ({ ...s, error: undefined }))
    window.studio.editTimeline(generationId).then(
      (timeline) => {
        timelineCache.set(generationId, timeline)
        while (timelineCache.size > TIMELINE_CACHE_SIZE) timelineCache.delete(timelineCache.keys().next().value!)
        if (active) setState({ id: generationId, timeline })
      },
      (e: unknown) => active && setState({ id: generationId, error: ipcErrorMessage(e) })
    )
    return () => {
      active = false
    }
  }, [generationId])
  const fresh = state.id === generationId
  return {
    timeline: state.timeline,
    loading: !!generationId && !fresh,
    error: fresh ? state.error : undefined
  }
}

/**
 * The version's transcript (inherited from an ancestor with the same timing), fetched again whenever the edit
 * changes: a transcription finishing, a line edited here or by an agent.
 */
export function useTranscript(
  generationId: string | undefined,
  changed: number | undefined
): { transcript: Transcript | null | undefined; setTranscript: (t: Transcript | null) => void } {
  const [state, setState] = useState<{ id?: string; transcript?: Transcript | null }>({})
  useEffect(() => {
    if (!generationId) return
    let active = true
    window.studio.getTranscript(generationId).then(
      (transcript) => active && setState({ id: generationId, transcript }),
      () => active && setState((s) => (s.id === generationId ? s : { id: generationId, transcript: null }))
    )
    return () => {
      active = false
    }
  }, [generationId, changed])
  const setTranscript = useCallback(
    (transcript: Transcript | null) => setState({ id: generationId, transcript }),
    [generationId]
  )
  return { transcript: state.id === generationId ? state.transcript : undefined, setTranscript }
}
