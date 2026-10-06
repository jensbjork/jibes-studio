import { useCallback, useEffect, useRef, useState } from 'react'
import type { Generation, SegmentPatch, Sequence, SequenceSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { applyGenerationUpdate, freshestTake, moveSegmentLocally, patchSegmentLocally } from './sequenceUtils'

export interface SequenceStore {
  /** Undefined while loading (or when nothing is open). */
  sequence?: Sequence
  error?: string
  /** Re-reads the sequence from main; concurrent calls are coalesced. */
  refresh: () => void
  /** Runs a mutation resolving with the updated sequence, and applies it unless a newer snapshot already landed. */
  mutate: (fn: () => Promise<Sequence>) => Promise<Sequence>
  /** Optimistic local edit. Snapshots requested before it are discarded so they can't undo it. */
  update: (fn: (s: Sequence) => Sequence) => void
  /** Optimistic segment patch + updateSegment; refetches if main rejects it. */
  patchSegment: (segmentId: string, patch: SegmentPatch) => Promise<Sequence>
  moveSegment: (segmentId: string, toIndex: number) => Promise<Sequence>
  /** Shows a just-queued take right away instead of waiting for the change notification. */
  addTake: (g: Generation) => void
}

interface State {
  id?: string
  sequence?: Sequence
  error?: string
}

/** Generation updates for other sequences (or the generate feed) leave the state untouched. */
function withGeneration(state: State, g: Generation): State {
  if (!state.sequence) return state
  const sequence = applyGenerationUpdate(state.sequence, g)
  return sequence === state.sequence ? state : { ...state, sequence }
}

/**
 * The open sequence, kept live: refetched on sequence-change notifications and patched with
 * per-poll generation updates (which main doesn't broadcast as sequence changes).
 *
 * Every snapshot from main (fetch or mutation result) carries the order it was requested in, and older
 * snapshots never replace newer ones — IPC replies can arrive out of order when handlers are async.
 */
export function useSequence(id: string | undefined, onMissing: (id: string) => void): SequenceStore {
  const [state, setState] = useState<State>({ id })
  const idRef = useRef(id)
  const issued = useRef(0)
  const applied = useRef(0)
  // Latest live update per generation; merged into fetched snapshots that may predate it.
  const live = useRef(new Map<string, Generation>())
  const fetching = useRef(false)
  const fetchAgain = useRef(false)
  const onMissingRef = useRef(onMissing)
  useEffect(() => {
    onMissingRef.current = onMissing
  })

  const apply = useCallback((n: number, s: Sequence) => {
    if (s.id !== idRef.current || n <= applied.current) return
    applied.current = n
    const merged: Sequence = {
      ...s,
      segments: s.segments.map((seg) => ({
        ...seg,
        takes: seg.takes.map((t) => {
          const l = live.current.get(t.id)
          if (!l) return t
          const fresh = freshestTake(t, l)
          // The snapshot caught up with the live state; no need to remember it any longer.
          if (fresh === t) live.current.delete(t.id)
          return fresh
        })
      }))
    }
    setState({ id: s.id, sequence: merged })
  }, [])

  const refresh = useCallback(() => {
    const target = idRef.current
    if (!target) return
    if (fetching.current) {
      fetchAgain.current = true
      return
    }
    fetching.current = true
    const n = ++issued.current
    window.studio
      .getSequence(target)
      .then(
        (s) => apply(n, s),
        (e: unknown) => {
          if (target !== idRef.current) return
          setState({ id: target, error: ipcErrorMessage(e) })
          onMissingRef.current(target)
        }
      )
      .finally(() => {
        fetching.current = false
        if (fetchAgain.current) {
          fetchAgain.current = false
          refresh()
        }
      })
  }, [apply])

  useEffect(() => {
    idRef.current = id
    live.current.clear()
    // Anything still in flight belongs to the previous sequence.
    applied.current = issued.current
    fetchAgain.current = false
    setState({ id })
    refresh()
  }, [id, refresh])

  useEffect(() => {
    const offSequence = window.studio.onSequenceChange((changed) => {
      if (changed === idRef.current) refresh()
    })
    const offGeneration = window.studio.onGenerationUpdate((g) => {
      live.current.set(g.id, g)
      setState((s) => withGeneration(s, g))
    })
    return () => {
      offSequence()
      offGeneration()
    }
  }, [refresh])

  const mutate = useCallback(
    async (fn: () => Promise<Sequence>) => {
      const n = ++issued.current
      const s = await fn()
      apply(n, s)
      return s
    },
    [apply]
  )

  const update = useCallback((fn: (s: Sequence) => Sequence) => {
    applied.current = issued.current
    setState((s) => (s.sequence ? { ...s, sequence: fn(s.sequence) } : s))
  }, [])

  const patchSegment = useCallback(
    async (segmentId: string, patch: SegmentPatch) => {
      update((s) => patchSegmentLocally(s, segmentId, patch))
      try {
        return await mutate(() => window.studio.updateSegment(segmentId, patch))
      } catch (e) {
        refresh()
        throw e
      }
    },
    [update, mutate, refresh]
  )

  const moveSegment = useCallback(
    async (segmentId: string, toIndex: number) => {
      update((s) => moveSegmentLocally(s, segmentId, toIndex))
      try {
        return await mutate(() => window.studio.moveSegment(segmentId, toIndex))
      } catch (e) {
        refresh()
        throw e
      }
    },
    [update, mutate, refresh]
  )

  const addTake = useCallback((g: Generation) => {
    live.current.set(g.id, g)
    setState((s) => withGeneration(s, g))
  }, [])

  const current = state.id === id ? state : {}
  return {
    sequence: current.sequence,
    error: current.error,
    refresh,
    mutate,
    update,
    patchSegment,
    moveSegment,
    addTake
  }
}

/** Sequence summaries for the list, refreshed (coalesced) on every sequence change. */
export function useSequenceList(): { sequences?: SequenceSummary[]; reload: () => Promise<void> } {
  const [sequences, setSequences] = useState<SequenceSummary[]>()
  const latest = useRef(0)

  const reload = useCallback(async () => {
    const n = ++latest.current
    try {
      const list = await window.studio.listSequences()
      if (n === latest.current) setSequences(list)
    } catch {
      if (n === latest.current) setSequences((prev) => prev ?? [])
    }
  }, [])

  useEffect(() => {
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.studio.onSequenceChange(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 150)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [reload])

  return { sequences, reload }
}
