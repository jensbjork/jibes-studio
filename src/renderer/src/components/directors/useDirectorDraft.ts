import { useCallback, useEffect, useRef, useState } from 'react'
import type { Asset, Direction, ReferenceVideo } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import type { SaveState } from '../assets/useAssetDraft'

const SAVE_DELAY_MS = 500

/** What the editor writes: the name, the one line and the direction without its style videos (saved apart). */
export interface DirectorFields {
  name: string
  description: string
  direction: Omit<Direction, 'videos'>
}

type FieldKey = 'name' | 'description' | keyof Omit<Direction, 'videos'>

const DIRECTION_KEYS = [
  'editing',
  'shotSeconds',
  'continuity',
  'look',
  'camera',
  'light',
  'framing',
  'rhythm',
  'performance',
  'sound',
  'avoid',
  'defaults'
] as const satisfies readonly (keyof Omit<Direction, 'videos'>)[]

function fieldsOf(asset: Asset): DirectorFields {
  const { videos: _, ...direction } = asset.direction ?? {}
  return { name: asset.name, description: asset.description, direction }
}

/** A field's value for comparing: objects (the defaults) by their JSON, empty text as absent. */
function valueKey(value: unknown): string {
  if (value === undefined || value === '' || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function get(f: DirectorFields, key: FieldKey): unknown {
  return key === 'name' || key === 'description' ? f[key] : f.direction[key]
}

const KEYS: readonly FieldKey[] = ['name', 'description', ...DIRECTION_KEYS]

function sameFields(a: DirectorFields, b: DirectorFields): boolean {
  return KEYS.every((k) => valueKey(get(a, k)) === valueKey(get(b, k)))
}

/** The direction as saved: empty texts and empty defaults left out. */
function cleanDirection(d: Omit<Direction, 'videos'>, videos: ReferenceVideo[] | undefined): Direction {
  const out: Direction = {}
  for (const key of DIRECTION_KEYS) {
    const value = d[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && !value.trim()) continue
    if (key === 'defaults') {
      const defaults = Object.fromEntries(Object.entries(value as object).filter(([, v]) => !!v))
      if (Object.keys(defaults).length) out.defaults = defaults
      continue
    }
    ;(out as Record<string, unknown>)[key] = value
  }
  if (videos?.length) out.videos = videos
  return out
}

/**
 * A director's local draft: its name, one line and direction, autosaved after a pause in typing, on blur and when
 * the editor unmounts. Every save – and every change to the style videos (added, removed, moved, another window) –
 * goes through one queue, so they reach main in order and none of them sends an older list of videos than the last
 * one (a save sends the whole direction, and main takes off the videos it leaves out). Changes from outside (an
 * agent) are taken in field by field, unless that field has an edit of ours waiting. Mount one per asset.
 */
export function useDirectorDraft(asset: Asset, onSaved: (a: Asset) => void, onError: (message: string) => void) {
  const [fields, setFieldsState] = useState<DirectorFields>(() => fieldsOf(asset))
  const [videos, setVideosState] = useState<ReferenceVideo[]>(() => asset.direction?.videos ?? [])
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const [busy, setBusy] = useState(0)

  const draft = useRef<DirectorFields>(fieldsOf(asset))
  const saved = useRef<DirectorFields>(fieldsOf(asset))
  const videosRef = useRef<ReferenceVideo[]>(asset.direction?.videos ?? [])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const suspended = useRef(false)
  const onSavedRef = useRef(onSaved)
  const onErrorRef = useRef(onError)
  const assetRef = useRef(asset)
  useEffect(() => {
    onSavedRef.current = onSaved
    onErrorRef.current = onError
    assetRef.current = asset
  })

  /** Runs `job` after every earlier one; the editor shows Saving… while any is waiting. */
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    pending.current += 1
    setBusy((n) => n + 1)
    setState({ kind: 'saving' })
    const run = queue.current.then(job, job)
    queue.current = run.then(
      () => undefined,
      () => undefined
    )
    return run.finally(() => {
      pending.current -= 1
      setBusy((n) => n - 1)
    })
  }, [])

  /** Takes in changes from outside, field by field (see the hook's comment); not while a save of ours is waiting. */
  const reconcile = useCallback(() => {
    if (pending.current) return
    const outside = fieldsOf(assetRef.current)
    const local = draft.current
    const base = saved.current
    const pick = (key: FieldKey): unknown =>
      valueKey(get(local, key)) !== valueKey(get(base, key)) ? get(local, key) : get(outside, key)
    const direction: Omit<Direction, 'videos'> = {}
    for (const key of DIRECTION_KEYS) {
      const v = pick(key)
      if (v !== undefined) (direction as Record<string, unknown>)[key] = v
    }
    draft.current = { name: pick('name') as string, description: pick('description') as string, direction }
    saved.current = outside
    videosRef.current = assetRef.current.direction?.videos ?? []
    setFieldsState(draft.current)
    setVideosState(videosRef.current)
  }, [])

  const save = useCallback(() => {
    if (suspended.current) return
    const next: DirectorFields = { ...draft.current, name: draft.current.name.trim() || saved.current.name }
    const previous = saved.current
    saved.current = next
    void enqueue(() =>
      window.studio.saveAsset({
        id: assetRef.current.id,
        kind: 'director',
        name: next.name,
        description: next.description,
        // The videos as they are by the time this save runs (an add before it has come back by then).
        direction: cleanDirection(next.direction, videosRef.current)
      })
    ).then(
      (a) => {
        onSavedRef.current(a)
        setState({ kind: 'saved' })
      },
      (e: unknown) => {
        // Let the next edit or blur retry.
        if (saved.current === next) saved.current = previous
        setState({ kind: 'error', message: ipcErrorMessage(e) })
      }
    )
  }, [enqueue])

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (suspended.current) return
    const next: DirectorFields = { ...draft.current, name: draft.current.name.trim() || saved.current.name }
    if (sameFields(next, saved.current)) return
    save()
  }, [save])

  // Switching director or leaving the view must not lose the last keystrokes.
  useEffect(() => () => flush(), [flush])

  const directionKey = JSON.stringify(asset.direction ?? {})
  useEffect(() => reconcile(), [asset.name, asset.description, directionKey, busy, reconcile])

  useEffect(() => {
    if (state.kind !== 'saved' || busy) return
    const t = setTimeout(() => setState({ kind: 'idle' }), 2000)
    return () => clearTimeout(t)
  }, [state, busy])

  const schedule = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }

  const update = (next: DirectorFields, now = false) => {
    draft.current = next
    setFieldsState(next)
    if (now) flush()
    else schedule()
  }

  const setName = (name: string) => update({ ...draft.current, name })
  const setDescription = (description: string) => update({ ...draft.current, description })
  /** A text part, or the shot length while dragging: saved after a pause. */
  const setPart = <K extends keyof Omit<Direction, 'videos'>>(key: K, value: Direction[K], now = false) => {
    const direction = { ...draft.current.direction }
    if (value === undefined) delete direction[key]
    else direction[key] = value
    update({ ...draft.current, direction }, now)
  }

  /** The style videos in a new order, with other windows or without some: saved at once, in the queue. */
  const setVideos = (next: ReferenceVideo[]) => {
    videosRef.current = next
    setVideosState(next)
    save()
  }

  /** Copies video files into the director's folder (main gives each its window); in the queue. */
  const addVideos = async (paths: string[]) => {
    try {
      const a = await enqueue(() => window.studio.addDirectorVideos(assetRef.current.id, paths))
      videosRef.current = a.direction?.videos ?? []
      setVideosState(videosRef.current)
      onSavedRef.current(a)
      setState({ kind: 'saved' })
    } catch (e) {
      setState({ kind: 'idle' })
      onErrorRef.current(ipcErrorMessage(e))
    }
  }

  const onBlur = () => {
    const trimmed = draft.current.name.trim()
    if (!trimmed) {
      draft.current = { ...draft.current, name: saved.current.name }
      setFieldsState(draft.current)
    }
    flush()
  }

  /** Stops autosaving, e.g. while the director is being deleted. */
  const suspend = () => {
    suspended.current = true
    clearTimeout(timer.current)
    timer.current = undefined
  }
  const resume = () => {
    suspended.current = false
  }

  return {
    ...fields,
    videos,
    state,
    /** Something is being saved or copied in (Generate waits for it; flush first). */
    settling: busy > 0,
    setName,
    setDescription,
    setPart,
    setVideos,
    addVideos,
    onBlur,
    flush,
    suspend,
    resume
  }
}
