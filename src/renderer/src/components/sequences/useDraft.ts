import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { remapPromptReferences } from '@shared/prompt-remap'
import type { GenerationParams, ReferenceAudio } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { stableJson } from './sequenceUtils'

export type DraftStatus = 'idle' | 'pending' | 'saving'

export interface Draft<T> {
  value: T
  setValue: Dispatch<SetStateAction<T>>
  /** Saves a pending change now and waits for every save in flight. Resolves false if the last save failed. */
  flush: () => Promise<boolean>
  /** Drops a pending change (e.g. before deleting what it belongs to). */
  discard: () => void
  status: DraftStatus
  error?: string
}

/** Lets a parent flush every open draft before acting on the saved state (generate, export, preview). */
export type FlushRegistry = Set<() => Promise<boolean>>

/**
 * `local` with the fields someone else changed on the server (`server` differs from `base`, the value the
 * draft was last in step with) taken over, except where the draft itself changed them.
 */
function mergeFields<T extends object>(local: T, base: T, server: T): T {
  const out: Record<string, unknown> = { ...(server as Record<string, unknown>) }
  const l = local as Record<string, unknown>
  const b = base as Record<string, unknown>
  const mine = new Set<string>()
  for (const key of new Set([...Object.keys(l), ...Object.keys(b)])) {
    if (stableJson(l[key]) === stableJson(b[key])) continue
    mine.add(key)
    if (l[key] === undefined) delete out[key]
    else out[key] = l[key]
  }
  followReferences(out, mine.has('prompt') ? l : server, mine.has('negativePrompt') ? l : server)
  return out as T
}

/** A params-like value's reference lists (empty when it has none). */
function referenceLists(p: object): { images: string[]; audios: ReferenceAudio[] } {
  const { referenceImages, referenceAudios } = p as Partial<GenerationParams>
  return {
    images: Array.isArray(referenceImages) ? referenceImages : [],
    audios: Array.isArray(referenceAudios) ? referenceAudios : []
  }
}

/**
 * Keeps a merged clip's prompts on their pictures and clips. The reference lists and the prompts are merged as
 * separate fields, but a prompt's @ImageN / @AudioN tokens only mean something with the lists it was written
 * against: when an agent's reorder_references (or update_segment's references) lands while the user types, the
 * merge takes the agent's lists and the user's text. Each prompt is therefore renumbered from the lists of the
 * side it came from (`promptFrom`, `negativeFrom`) to the merged lists (remapPromptReferences), so "@Image1 hugs
 * @Image3" typed against [A, B, C] reads "@Image2 hugs @Image1" against the agent's [C, A, B] – never naming
 * whatever now holds the old number. Values without a prompt (not clip params) are left alone.
 */
function followReferences(out: Record<string, unknown>, promptFrom: object, negativeFrom: object): void {
  if (typeof out.prompt !== 'string') return
  const after = referenceLists(out)
  for (const [key, from] of [
    ['prompt', promptFrom],
    ['negativePrompt', negativeFrom]
  ] as const) {
    const text = out[key]
    if (typeof text !== 'string' || !text) continue
    const before = referenceLists(from)
    out[key] = remapPromptReferences(
      text,
      { before: before.images, after: after.images },
      { before: before.audios, after: after.audios }
    )
  }
}

/**
 * Local editing copy of a server value (an object), saved debounced.
 *
 * The draft is authoritative while the user edits: server snapshots are adopted only when nothing is
 * pending or in flight, and never when they equal a value this draft has already seen (initial or sent) —
 * such a snapshot is an echo or a stale read, and adopting it would undo newer typing.
 * Values the server produced itself (clamped trims, a converted model) are adopted once idle.
 * A change made elsewhere (an agent) while an edit waits is merged field by field when the edit is saved,
 * rather than overwritten by the whole draft; the prompts' @ImageN / @AudioN tokens follow the merged reference
 * lists (followReferences).
 * A pending change is saved on unmount, so switching segments never loses edits.
 */
export function useDraft<T extends object>(server: T, save: (value: T) => Promise<unknown>, delay = 600): Draft<T> {
  const [value, setValue] = useState<T>(server)
  const [status, setStatus] = useState<DraftStatus>('idle')
  const [error, setError] = useState<string>()

  const serverJson = stableJson(server)
  const valueRef = useRef(value)
  const serverRef = useRef(server)
  const savedJson = useRef(serverJson)
  /** The value the draft was last in step with the server on (adopted, or sent), for mergeFields. */
  const base = useRef(server)
  const known = useRef(new Set([serverJson]))
  const pending = useRef(false)
  const inFlight = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastSave = useRef<Promise<boolean>>(Promise.resolve(true))
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  /** Adopts the latest server value if it is new to us and we have nothing unsaved. */
  const reconcile = useCallback(() => {
    const json = stableJson(serverRef.current)
    if (json === stableJson(valueRef.current)) {
      savedJson.current = json
      // In sync and idle: main has seen everything we sent, and the store never applies a snapshot older than
      // one it already has, so earlier values can't come back as stale reads any more.
      if (!pending.current && !inFlight.current) {
        known.current = new Set([json])
        base.current = serverRef.current
      } else known.current.add(json)
      return
    }
    if (pending.current || inFlight.current || known.current.has(json)) return
    // Idle, so this is the newest state there is: forget the values seen before it. Otherwise an agent setting
    // the clip back to one of them (8s → 5s → 8s) would look like an echo and never be shown.
    known.current = new Set([json])
    savedJson.current = json
    base.current = serverRef.current
    valueRef.current = serverRef.current
    setValue(serverRef.current)
  }, [])

  // Compares with the last saved value rather than trusting `pending`, so a failed save is retried on flush.
  const commit = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current)
    pending.current = false
    let v = valueRef.current
    // Changed elsewhere while this edit waited (an agent's update_segment): keep their fields and send ours.
    // Only when nothing of ours is in flight, so the snapshot already includes what we sent before.
    const serverJson = stableJson(serverRef.current)
    if (!inFlight.current && !known.current.has(serverJson)) {
      known.current.add(serverJson)
      v = mergeFields(v, base.current, serverRef.current)
      if (stableJson(v) !== stableJson(valueRef.current)) {
        valueRef.current = v
        setValue(v)
      }
    }
    const json = stableJson(v)
    if (!inFlight.current && json === serverJson) {
      // Nothing of ours left to send: the server already has exactly this.
      savedJson.current = json
      base.current = serverRef.current
    }
    if (json === savedJson.current) {
      setStatus(inFlight.current ? 'saving' : 'idle')
      return lastSave.current
    }
    savedJson.current = json
    base.current = v
    known.current.add(json)
    inFlight.current++
    setStatus('saving')
    const p = Promise.resolve()
      .then(() => saveRef.current(v))
      .then(
        () => {
          setError(undefined)
          return true
        },
        (e: unknown) => {
          setError(ipcErrorMessage(e))
          // Compare future edits against what the server really has, so the next change is sent again.
          savedJson.current = stableJson(serverRef.current)
          return false
        }
      )
      .finally(() => {
        inFlight.current--
        if (!inFlight.current && !pending.current) setStatus('idle')
        reconcile()
      })
    lastSave.current = p
    return p
  }, [reconcile])

  // Every local change (re)starts the debounce; changes that land back on the saved value cancel it.
  useEffect(() => {
    valueRef.current = value
    if (stableJson(value) === savedJson.current) {
      if (pending.current) {
        clearTimeout(timer.current)
        pending.current = false
        setStatus(inFlight.current ? 'saving' : 'idle')
      }
      return
    }
    pending.current = true
    setStatus('pending')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void commit(), delay)
  }, [value, commit, delay])

  useEffect(() => {
    serverRef.current = server
    reconcile()
    // serverJson stands in for `server`, whose identity changes with every snapshot.
  }, [serverJson, reconcile])

  // Unmounting (e.g. selecting another segment) saves whatever hasn't been saved yet.
  useEffect(() => () => void commit(), [commit])

  const flush = useCallback(() => commit(), [commit])

  const discard = useCallback(() => {
    clearTimeout(timer.current)
    pending.current = false
    savedJson.current = stableJson(valueRef.current)
    setStatus(inFlight.current ? 'saving' : 'idle')
  }, [])

  return { value, setValue, flush, discard, status, error }
}

/** Keeps a draft's flush in the parent's registry while mounted. */
export function useRegisterFlush(registry: FlushRegistry, flush: () => Promise<boolean>): void {
  useEffect(() => {
    registry.add(flush)
    return () => {
      registry.delete(flush)
    }
  }, [registry, flush])
}
