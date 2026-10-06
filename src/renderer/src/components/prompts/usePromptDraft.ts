import { useEffect, useRef, useState } from 'react'
import type { SavedPrompt } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { titleFromBody } from './prompt-utils'

export interface Draft {
  /** Stable identity of the editing session: the prompt id, or a temporary key until the first save. */
  key: string
  /** Set once the prompt exists in the database. */
  id?: string
  title: string
  body: string
  negativePrompt: string
  tags: string[]
  favorite: boolean
}

export type DraftFields = Partial<Pick<Draft, 'title' | 'body' | 'negativePrompt' | 'tags' | 'favorite'>>

export type SaveState = 'pending' | 'saving' | 'saved' | 'invalid' | 'error'

export interface SaveStatus {
  key: string
  state: SaveState
  error?: string
}

const SAVE_DELAY = 600
let newDraftCounter = 0

export function draftFromPrompt(p: SavedPrompt): Draft {
  return {
    key: p.id,
    id: p.id,
    title: p.title,
    body: p.body,
    negativePrompt: p.negativePrompt ?? '',
    tags: p.tags,
    favorite: p.favorite
  }
}

/** A title alone means nothing to the video model, so an empty body is never stored. */
export const canSave = (d: Draft): boolean => d.body.trim() !== ''

/**
 * The prompt being edited, autosaved (debounced, flushed on blur/selection change/unmount).
 * All writes go through one promise chain so a new prompt is created exactly once and later
 * edits, favourite toggles and deletes land in the order they were made.
 */
export function usePromptDraft(prompts: SavedPrompt[]) {
  const [draft, setDraft] = useState<Draft>()
  const [status, setStatus] = useState<SaveStatus>()
  const [error, setError] = useState<string>()

  const draftRef = useRef<Draft | undefined>(undefined)
  const pending = useRef<Draft | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const chain = useRef<Promise<void>>(Promise.resolve())
  /** Draft key → id assigned by the first save. */
  const ids = useRef(new Map<string, string>())
  /** Freshest known stored version per id (save results can be newer than the list). */
  const known = useRef(new Map<string, SavedPrompt>())
  /** Ids that have appeared in the list, to tell "deleted elsewhere" from "not listed yet". */
  const seen = useRef(new Set<string>())
  /** Draft keys whose latest save failed. */
  const failed = useRef(new Set<string>())

  const idOf = (d: Draft): string | undefined => d.id ?? ids.current.get(d.key)

  const show = (next: Draft | undefined) => {
    void flush()
    draftRef.current = next
    setDraft(next)
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain.current = chain.current.then(task, task)
    return chain.current
  }

  const persist = async (d: Draft) => {
    setStatus({ key: d.key, state: 'saving' })
    try {
      const saved = await window.studio.savePrompt({
        id: idOf(d),
        title: d.title.trim(),
        body: d.body.trim(),
        negativePrompt: d.negativePrompt.trim() || undefined,
        tags: d.tags,
        favorite: d.favorite
      })
      ids.current.set(d.key, saved.id)
      known.current.set(saved.id, saved)
      failed.current.delete(d.key)
      const current = draftRef.current
      if (current?.key === d.key && !current.id) {
        const withId = { ...current, id: saved.id }
        draftRef.current = withId
        setDraft(withId)
      }
      setStatus({ key: d.key, state: pending.current?.key === d.key ? 'pending' : 'saved' })
    } catch (e) {
      failed.current.add(d.key)
      setStatus({ key: d.key, state: 'error', error: ipcErrorMessage(e) })
    }
  }

  /** Saves pending edits now; resolves once every queued write has finished. */
  function flush(): Promise<void> {
    clearTimeout(timer.current)
    const d = pending.current
    pending.current = null
    if (d && canSave(d)) return enqueue(() => persist(d))
    return chain.current
  }

  const update = (patch: DraftFields) => {
    const current = draftRef.current
    if (!current) return
    const next = { ...current, ...patch }
    draftRef.current = next
    setDraft(next)
    pending.current = next
    setStatus({ key: next.key, state: canSave(next) ? 'pending' : 'invalid' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY)
  }

  const select = (p: SavedPrompt | undefined) => {
    if (p && draftRef.current?.id === p.id) return
    show(p && draftFromPrompt(known.current.get(p.id) ?? p))
  }

  const create = (tags: string[] = [], favorite = false) => {
    show({ key: `new:${Date.now()}:${++newDraftCounter}`, title: '', body: '', negativePrompt: '', tags, favorite })
  }

  /** Saves the draft and returns its id, or undefined if it can't be stored. */
  const commit = async (): Promise<string | undefined> => {
    await flush()
    const d = draftRef.current
    if (!d || failed.current.has(d.key)) return undefined
    return idOf(d)
  }

  /** Deletes (or discards, if never saved) the current draft and opens `next`. */
  const remove = async (next?: SavedPrompt) => {
    const d = draftRef.current
    if (!d) return
    clearTimeout(timer.current)
    pending.current = null
    await chain.current
    const id = idOf(d)
    try {
      if (id) await window.studio.deletePrompt(id)
    } catch (e) {
      setStatus({ key: d.key, state: 'error', error: ipcErrorMessage(e) })
      return
    }
    // The list refresh may already have cleared the draft; the neighbour is still the right pick.
    if (!draftRef.current || draftRef.current.key === d.key) {
      draftRef.current = undefined
      show(next && draftFromPrompt(known.current.get(next.id) ?? next))
    }
  }

  const duplicate = async () => {
    const id = await commit()
    const d = draftRef.current
    if (!d || !id) return
    const title = `${d.title.trim() || known.current.get(id)?.title || titleFromBody(d.body)} (kopia)`
    try {
      const saved = await window.studio.savePrompt({
        title,
        body: d.body.trim(),
        negativePrompt: d.negativePrompt.trim() || undefined,
        tags: d.tags,
        favorite: false
      })
      known.current.set(saved.id, saved)
      show(draftFromPrompt(saved))
    } catch (e) {
      setStatus({ key: d.key, state: 'error', error: ipcErrorMessage(e) })
    }
  }

  const toggleFavorite = (id: string) => {
    const current = draftRef.current
    if (current && idOf(current) === id) {
      update({ favorite: !current.favorite })
      void flush()
      return
    }
    // Saving is a full replace, so build the input from the freshest stored version, inside the chain.
    void enqueue(async () => {
      const p = known.current.get(id)
      if (!p) return
      try {
        const saved = await window.studio.savePrompt({
          id,
          title: p.title,
          body: p.body,
          negativePrompt: p.negativePrompt,
          tags: p.tags,
          favorite: !p.favorite
        })
        known.current.set(id, saved)
      } catch (e) {
        setError(ipcErrorMessage(e))
      }
    })
  }

  useEffect(() => {
    for (const p of prompts) {
      const k = known.current.get(p.id)
      if (!k || k.updatedAt <= p.updatedAt) known.current.set(p.id, p)
      seen.current.add(p.id)
    }
    // Deleted somewhere else: drop the editor rather than resurrect the prompt on the next save.
    const d = draftRef.current
    const id = d && idOf(d)
    if (id && seen.current.has(id) && !prompts.some((p) => p.id === id)) {
      clearTimeout(timer.current)
      pending.current = null
      draftRef.current = undefined
      setDraft(undefined)
    }
  }, [prompts])

  // Don't lose the last keystrokes when leaving the view or the app.
  useEffect(() => {
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      void flush()
    }
  }, [])

  return {
    draft,
    /** Save status of the current draft only. */
    status: draft && status?.key === draft.key ? status : undefined,
    /** Errors from actions on prompts other than the open one. */
    error,
    clearError: () => setError(undefined),
    update,
    flush,
    select,
    create,
    commit,
    remove,
    duplicate,
    toggleFavorite
  }
}
