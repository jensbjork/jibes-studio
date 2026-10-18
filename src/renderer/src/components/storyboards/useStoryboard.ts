import { useCallback, useEffect, useRef, useState } from 'react'
import type { Generation, Storyboard, StoryboardSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { applyGenerationUpdate, freshestTake } from './storyboardUtils'

export interface StoryboardStore {
  /** Undefined while loading (or when nothing is open). */
  storyboard?: Storyboard
  error?: string
  /** Re-reads the storyboard from main; concurrent calls are coalesced. */
  refresh: () => void
  /** Runs a change resolving with the updated storyboard, and shows it unless a newer snapshot already landed. */
  mutate: (fn: () => Promise<Storyboard>) => Promise<Storyboard>
  /** Optimistic local edit. Snapshots requested before it are discarded, so they can't undo it. */
  update: (fn: (s: Storyboard) => Storyboard) => void
  /** Shows a just-queued take right away instead of waiting for the change notification. */
  addTake: (g: Generation) => void
}

interface State {
  id?: string
  storyboard?: Storyboard
  error?: string
}

/**
 * The open storyboard, kept live: refetched when main reports a change to it (its boards, transitions or their
 * takes, its stills, the library's photos it uses) and patched with per-poll generation updates, which main
 * doesn't announce as storyboard changes.
 *
 * Every snapshot from main (a fetch or a change's answer) carries the order it was asked for in, and an older
 * one never replaces a newer one: IPC replies can arrive out of order when handlers are async.
 */
export function useStoryboard(id: string | undefined, onMissing: (id: string) => void): StoryboardStore {
  const [state, setState] = useState<State>({ id })
  const idRef = useRef(id)
  const issued = useRef(0)
  const applied = useRef(0)
  // Latest live update per generation, merged into fetched snapshots that may predate it.
  const live = useRef(new Map<string, Generation>())
  const fetching = useRef(false)
  const fetchAgain = useRef(false)
  const onMissingRef = useRef(onMissing)
  useEffect(() => {
    onMissingRef.current = onMissing
  })

  const apply = useCallback((n: number, s: Storyboard) => {
    if (s.id !== idRef.current || n <= applied.current) return
    applied.current = n
    const merged: Storyboard = {
      ...s,
      transitions: s.transitions.map((t) => ({
        ...t,
        takes: t.takes.map((take) => {
          const l = live.current.get(take.id)
          if (!l) return take
          const fresh = freshestTake(take, l)
          // The snapshot caught up with the live state; no need to remember it any longer.
          if (fresh === take) live.current.delete(take.id)
          return fresh
        })
      }))
    }
    setState({ id: s.id, storyboard: merged })
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
      .getStoryboard(target)
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
    // Anything still in flight belongs to the storyboard opened before.
    applied.current = issued.current
    fetchAgain.current = false
    setState({ id })
    refresh()
  }, [id, refresh])

  // The transitions' takes, by id, as last shown: a take reaching an end state is refetched for, since main
  // selects a finished take by itself and may not announce that as a storyboard change.
  const shown = useRef(new Map<string, Generation['status']>())
  useEffect(() => {
    shown.current = new Map(state.storyboard?.transitions.flatMap((t) => t.takes.map((g) => [g.id, g.status] as const)))
  }, [state.storyboard])

  useEffect(() => {
    const mine = (changed: string | undefined) => !changed || changed === idRef.current
    const offStoryboard = window.studio.onStoryboardChange((changed) => mine(changed) && refresh())
    // A storyboard is a sequence underneath: changes main makes through the sequence machinery may be announced
    // under the same id as sequence changes.
    const offSequence = window.studio.onSequenceChange((changed) => changed === idRef.current && refresh())
    // A still moved or deleted (and paths with it), or a library photo used on a board moved with its asset.
    const offStills = window.studio.onStillsChange((changed) => mine(changed) && refresh())
    const offLibrary = window.studio.onLibraryChange(() => refresh())
    const offGeneration = window.studio.onGenerationUpdate((g) => {
      live.current.set(g.id, g)
      setState((s) => {
        if (!s.storyboard) return s
        const storyboard = applyGenerationUpdate(s.storyboard, g)
        return storyboard === s.storyboard ? s : { ...s, storyboard }
      })
      const before = shown.current.get(g.id)
      if (before && before !== g.status && (g.status === 'completed' || g.status === 'failed')) refresh()
    })
    const offDelete = window.studio.onGenerationDelete((deleted) => shown.current.has(deleted) && refresh())
    return () => {
      offStoryboard()
      offSequence()
      offStills()
      offLibrary()
      offGeneration()
      offDelete()
    }
  }, [refresh])

  const mutate = useCallback(
    async (fn: () => Promise<Storyboard>) => {
      const n = ++issued.current
      const s = await fn()
      apply(n, s)
      return s
    },
    [apply]
  )

  const update = useCallback((fn: (s: Storyboard) => Storyboard) => {
    applied.current = issued.current
    setState((s) => (s.storyboard ? { ...s, storyboard: fn(s.storyboard) } : s))
  }, [])

  const addTake = useCallback((g: Generation) => {
    live.current.set(g.id, g)
    setState((s) => {
      if (!s.storyboard) return s
      const storyboard = applyGenerationUpdate(s.storyboard, g)
      return storyboard === s.storyboard ? s : { ...s, storyboard }
    })
  }, [])

  const current = state.id === id ? state : {}
  return { storyboard: current.storyboard, error: current.error, refresh, mutate, update, addTake }
}

/** The storyboards for the list, refreshed (coalesced) whenever one of them changes. */
export function useStoryboardList(): { storyboards?: StoryboardSummary[]; reload: () => Promise<void> } {
  const [storyboards, setStoryboards] = useState<StoryboardSummary[]>()
  const latest = useRef(0)

  const reload = useCallback(async () => {
    const n = ++latest.current
    try {
      const list = await window.studio.listStoryboards()
      if (n === latest.current) setStoryboards(list)
    } catch {
      if (n === latest.current) setStoryboards((prev) => prev ?? [])
    }
  }, [])

  useEffect(() => {
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 150)
    }
    const offStoryboard = window.studio.onStoryboardChange(soon)
    // Covers follow board images, which move with their stills.
    const offStills = window.studio.onStillsChange(soon)
    // "Done" counts change when a take finishes.
    const offGeneration = window.studio.onGenerationUpdate((g) => {
      if (g.segmentId && (g.status === 'completed' || g.status === 'failed')) soon()
    })
    return () => {
      clearTimeout(timer)
      offStoryboard()
      offStills()
      offGeneration()
    }
  }, [reload])

  return { storyboards, reload }
}
