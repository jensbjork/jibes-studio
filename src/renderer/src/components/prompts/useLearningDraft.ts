import { useEffect, useRef, useState } from 'react'
import { titleFromBody } from '@shared/prompts'
import type { Learning } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'

export interface LearningDraft {
  /** Stable identity of the editing session: the learning's id, or a temporary key until the first save. */
  key: string
  /** Set once the learning exists in the database. */
  id?: string
  title: string
  insight: string
  /** A model id; undefined for every model. */
  model?: string
  tags: string[]
  /** Generation ids the learning is based on. */
  evidence: string[]
  pinned: boolean
  /** 'user' or the agent that wrote it. */
  author: string
  createdAt?: number
  updatedAt?: number
}

export type LearningDraftFields = Partial<Pick<LearningDraft, 'title' | 'insight' | 'model' | 'tags' | 'evidence' | 'pinned'>>

type LearningField = keyof LearningDraftFields

export type LearningSaveState = 'pending' | 'saving' | 'saved' | 'invalid' | 'error'

export interface LearningSaveStatus {
  key: string
  state: LearningSaveState
  error?: string
}

const SAVE_DELAY = 600
let newDraftCounter = 0

/**
 * The title as the editor holds it: empty while it is the one main makes from the insight, so it keeps following
 * the insight as that is edited (a title saved during a pause in typing would otherwise stick half-written).
 */
function ownTitle(l: Pick<Learning, 'title' | 'insight'>): string {
  return l.title === titleFromBody(l.insight) ? '' : l.title
}

export function draftFromLearning(l: Learning): LearningDraft {
  return {
    key: l.id,
    id: l.id,
    title: ownTitle(l),
    insight: l.insight,
    model: l.model,
    tags: l.tags,
    evidence: l.evidence,
    pinned: l.pinned,
    author: l.author,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt
  }
}

/** Main makes the title from the insight when it is left empty, but an insight it needs. */
export const canSaveLearning = (d: Pick<LearningDraft, 'insight'>): boolean => d.insight.trim() !== ''

/**
 * A stored version replaces the draft's fields, except where they only differ in surrounding whitespace: main
 * stores text trimmed, and the space just typed before the next word must not vanish under the user's cursor.
 */
export function mergeStored(draft: LearningDraft, stored: Learning): LearningDraft {
  const keep = (local: string, remote: string) => (local.trim() === remote.trim() ? local : remote)
  return {
    ...draftFromLearning(stored),
    key: draft.key,
    title: keep(draft.title, ownTitle(stored)),
    insight: keep(draft.insight, stored.insight)
  }
}

/**
 * The learning being edited, autosaved like a prompt (debounced, flushed on blur, selection change and unmount).
 * Writes go through one promise chain, so a new learning is created exactly once and later edits land in order.
 */
export function useLearningDraft(learnings: Learning[]) {
  const [draft, setDraft] = useState<LearningDraft>()
  const [status, setStatus] = useState<LearningSaveStatus>()
  const [error, setError] = useState<string>()

  const draftRef = useRef<LearningDraft | undefined>(undefined)
  const pending = useRef<LearningDraft | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const chain = useRef<Promise<void>>(Promise.resolve())
  /** Draft key → id assigned by the first save. */
  const ids = useRef(new Map<string, string>())
  /** Ids that have appeared in the list, to tell "deleted elsewhere" from "not listed yet". */
  const seen = useRef(new Set<string>())
  /**
   * The fields the user has changed in the draft with this key since its last save. A save sends only those (and
   * the text, which main requires): an agent may have added evidence or tags meanwhile, and the stale copies in
   * the draft must not overwrite them.
   */
  const dirty = useRef<{ key: string; fields: Set<LearningField> } | null>(null)

  const markDirty = (key: string, fields: Iterable<LearningField>) => {
    if (dirty.current?.key !== key) dirty.current = { key, fields: new Set() }
    for (const f of fields) dirty.current.fields.add(f)
  }

  /** The changed fields of the draft with this key, now being saved. */
  const takeDirty = (key: string): Set<LearningField> => {
    const taken = dirty.current?.key === key ? dirty.current.fields : new Set<LearningField>()
    if (dirty.current?.key === key) dirty.current = null
    return taken
  }

  const idOf = (d: LearningDraft): string | undefined => d.id ?? ids.current.get(d.key)

  const show = (next: LearningDraft | undefined) => {
    void flush()
    dirty.current = null
    draftRef.current = next
    setDraft(next)
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain.current = chain.current.then(task, task)
    return chain.current
  }

  const persist = async (d: LearningDraft, fields: ReadonlySet<LearningField>) => {
    setStatus({ key: d.key, state: 'saving' })
    const id = idOf(d)
    // A new learning is saved whole; an existing one only with what the user changed (main keeps the rest).
    const send = (field: LearningField): boolean => !id || fields.has(field)
    try {
      const saved = await window.studio.saveLearning({
        id,
        title: d.title.trim(),
        insight: d.insight.trim(),
        ...(send('model') ? { model: d.model ?? null } : {}),
        ...(send('tags') ? { tags: d.tags } : {}),
        ...(send('evidence') ? { evidence: d.evidence } : {}),
        ...(send('pinned') ? { pinned: d.pinned } : {})
      })
      ids.current.set(d.key, saved.id)
      const current = draftRef.current
      if (current?.key === d.key) {
        // The first save gives the draft its id; later edits may already be waiting, so only the stored
        // metadata is taken over when they are.
        const next =
          pending.current?.key === d.key
            ? { ...current, id: saved.id, author: saved.author, createdAt: saved.createdAt, updatedAt: saved.updatedAt }
            : mergeStored(current, saved)
        draftRef.current = next
        setDraft(next)
      }
      setStatus({ key: d.key, state: pending.current?.key === d.key ? 'pending' : 'saved' })
    } catch (e) {
      // Sent again with the next save of this draft.
      if (draftRef.current?.key === d.key) markDirty(d.key, fields)
      setStatus({ key: d.key, state: 'error', error: ipcErrorMessage(e) })
    }
  }

  /** Saves pending edits now; resolves once every queued write has finished. */
  function flush(): Promise<void> {
    clearTimeout(timer.current)
    const d = pending.current
    pending.current = null
    if (d && canSaveLearning(d)) {
      const fields = takeDirty(d.key)
      return enqueue(() => persist(d, fields))
    }
    return chain.current
  }

  const update = (patch: LearningDraftFields) => {
    const current = draftRef.current
    if (!current) return
    const next = { ...current, ...patch }
    draftRef.current = next
    setDraft(next)
    pending.current = next
    markDirty(next.key, Object.keys(patch) as LearningField[])
    setStatus({ key: next.key, state: canSaveLearning(next) ? 'pending' : 'invalid' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY)
  }

  const select = (l: Learning | undefined) => {
    if (l && draftRef.current && idOf(draftRef.current) === l.id) return
    show(l && draftFromLearning(l))
  }

  const create = (init: Partial<Pick<LearningDraft, 'model' | 'tags' | 'pinned'>> = {}) => {
    show({
      key: `new:${Date.now()}:${++newDraftCounter}`,
      title: '',
      insight: '',
      tags: [],
      evidence: [],
      pinned: false,
      author: 'user',
      ...init
    })
  }

  /** Deletes (or discards, if never saved) the current draft and opens `next`. */
  const remove = async (next?: Learning) => {
    const d = draftRef.current
    if (!d) return
    clearTimeout(timer.current)
    pending.current = null
    await chain.current
    const id = idOf(d)
    try {
      if (id) await window.studio.deleteLearning(id)
    } catch (e) {
      setStatus({ key: d.key, state: 'error', error: ipcErrorMessage(e) })
      return
    }
    if (!draftRef.current || draftRef.current.key === d.key) {
      draftRef.current = undefined
      show(next && draftFromLearning(next))
    }
  }

  /** Pins or unpins a learning from the list; the open one goes through its draft. */
  const togglePin = (l: Learning) => {
    const current = draftRef.current
    if (current && idOf(current) === l.id) {
      update({ pinned: !current.pinned })
      void flush()
      return
    }
    void enqueue(async () => {
      try {
        // Only the pin: main leaves the fields that aren't given as they are.
        await window.studio.saveLearning({ id: l.id, title: l.title, insight: l.insight, pinned: !l.pinned })
      } catch (e) {
        setError(ipcErrorMessage(e))
      }
    })
  }

  useEffect(() => {
    for (const l of learnings) seen.current.add(l.id)
    const d = draftRef.current
    const id = d && idOf(d)
    if (!d || !id) return
    const stored = learnings.find((l) => l.id === id)
    if (!stored) {
      // Deleted somewhere else (an agent, another window): drop the editor rather than resurrect it on save.
      if (seen.current.has(id)) {
        clearTimeout(timer.current)
        pending.current = null
        draftRef.current = undefined
        setDraft(undefined)
      }
      return
    }
    // Changed somewhere else (an agent adding evidence, say): show it, unless the user is editing right now.
    if (pending.current?.key !== d.key && stored.updatedAt !== d.updatedAt) {
      const next = mergeStored(d, stored)
      draftRef.current = next
      setDraft(next)
    }
  }, [learnings])

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
    /** Errors from actions on learnings other than the open one. */
    error,
    clearError: () => setError(undefined),
    update,
    flush,
    select,
    create,
    remove,
    togglePin
  }
}
