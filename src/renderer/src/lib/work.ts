import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type {
  FinishedWork,
  RunningWork,
  SeenScope,
  UnseenRef,
  WorkCounts,
  WorkSummary,
  WorkTarget,
  WorkView
} from '@shared/types'
import { showApproval } from './agent'
import { ipcErrorMessage } from './hooks'
import { mediaPathOf } from './media'
import type { Navigate } from './navigation'

// Pågår och klart: what Studio is working on and what has finished that the user hasn't looked at yet. Main builds
// the whole picture (WorkSummary, see src/main/work.ts) and pushes it on every change; this module keeps the latest
// one for the window, lets every view select the small part it shows without re-rendering on unrelated pushes, and
// owns the renderer half of the seen rule: playing a video or sound for a second, a picture or failure being on
// screen for a moment, and the user's explicit choices (markSeen).

const ZERO: WorkCounts = { running: 0, unseen: 0, failed: 0 }
/** Before main has answered (and while no library is open): nothing runs, nothing is new. */
const EMPTY: WorkSummary = { running: [], unseen: [], more: [], byView: {}, byOwner: {}, total: ZERO, revision: -1 }

/** How long a key marked seen here stays hidden at the latest while waiting for main to confirm it. */
const LOCAL_SEEN_MS = 30_000
/**
 * How long a key marked seen before main listed it is remembered: main announces a finished item a moment after the
 * window may have acted on it (a picture the dialog shows as its call returns, a clip whose drawer is open as it
 * finishes), and the mark must not be lost in between.
 */
const WANTED_MS = 10_000
/** How long the "n markerade som sedda · Ångra" toast stays. Main keeps the rows for undo as long. */
const TOAST_MS = 10_000

/** The latest summary from main (highest revision). */
let received: WorkSummary = EMPTY
/** What the window shows: `received` without the keys marked seen here and not yet confirmed by main. */
let shown: WorkSummary = EMPTY
/** Keys marked seen in this window → until when they stay hidden without main's confirmation. */
const locallySeen = new Map<string, number>()
/** Keys marked seen before they were listed → until when they are marked as soon as they are. */
const wanted = new Map<string, number>()
let unseenByKey = new Map<string, FinishedWork>()
/** The unseen items past the 200 main lists in full, by key (main sends every one of them, briefly). */
let moreByKey = new Map<string, UnseenRef>()
/** The playback rule's index: absolute media path (NFC) → the key it marks seen. Only unseen items are in it. */
let mediaIndex = new Map<string, string>()
/** The visibility rule's index for pictures: absolute picture path (NFC) → its still's key. Only unseen ones. */
let pictureIndex = new Map<string, string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function owners(w: FinishedWork): string[] {
  const ids: string[] = []
  if (w.ownerId) ids.push(w.ownerId)
  if (w.segmentId && w.segmentId !== w.ownerId) ids.push(w.segmentId)
  return ids
}

function minusOne(c: WorkCounts | undefined, w: Pick<FinishedWork, 'status'>): WorkCounts | undefined {
  if (!c) return c
  return w.status === 'failed' ? { ...c, failed: Math.max(0, c.failed - 1) } : { ...c, unseen: Math.max(0, c.unseen - 1) }
}

/** The summary as if main had already removed the given keys: the list without them, every count one less. */
function withoutKeys(s: WorkSummary, hidden: ReadonlyMap<string, number>): WorkSummary {
  const removed = s.unseen.filter((w) => hidden.has(w.key))
  const removedMore = s.more.filter((r) => hidden.has(r.key))
  if (!removed.length && !removedMore.length) return s
  let total = s.total
  const byView = { ...s.byView }
  const byOwner = { ...s.byOwner }
  for (const w of removed) {
    total = minusOne(total, w) ?? total
    byView[w.view] = minusOne(byView[w.view], w)
    for (const id of owners(w)) byOwner[id] = minusOne(byOwner[id], w) ?? ZERO
  }
  // Past the listed ones nothing says where an item counts: only the total drops here, the view's and owner's counts
  // follow with main's next summary, a moment later.
  for (const r of removedMore) total = minusOne(total, { status: r.failed ? 'failed' : 'completed' }) ?? total
  return {
    ...s,
    unseen: s.unseen.filter((w) => !hidden.has(w.key)),
    more: s.more.filter((r) => !hidden.has(r.key)),
    total,
    byView,
    byOwner
  }
}

function recompute(): void {
  const now = Date.now()
  for (const [key, until] of locallySeen) if (until <= now) locallySeen.delete(key)
  shown = locallySeen.size ? withoutKeys(received, locallySeen) : received
  unseenByKey = new Map(shown.unseen.map((w) => [w.key, w]))
  moreByKey = new Map(shown.more.map((r) => [r.key, r]))
  mediaIndex = new Map()
  pictureIndex = new Map()
  for (const w of shown.unseen) {
    if (w.mediaPath) mediaIndex.set(w.mediaPath.normalize('NFC'), w.key)
    if (w.kind === 'still' && w.thumbPath) pictureIndex.set(w.thumbPath.normalize('NFC'), w.key)
  }
  for (const r of shown.more) {
    if (r.mediaPath) mediaIndex.set(r.mediaPath.normalize('NFC'), r.key)
    if (r.picturePath) pictureIndex.set(r.picturePath.normalize('NFC'), r.key)
  }
  emit()
}

/** Whether the key is unseen right now, listed in full or not. */
function known(key: string): boolean {
  return unseenByKey.has(key) || moreByKey.has(key)
}

function receive(summary: WorkSummary): void {
  // Replies and pushes can cross; an older summary never replaces a newer one.
  if (summary.revision <= received.revision) return
  // A main from before the references were sent (or a malformed push) still gives a usable summary.
  received = Array.isArray(summary.more) ? summary : { ...summary, more: [] }
  // A key main no longer lists has been marked seen there (or its item is gone): stop hiding it locally.
  if (locallySeen.size) {
    const listed = new Set([...received.unseen.map((w) => w.key), ...received.more.map((r) => r.key)])
    for (const key of locallySeen.keys()) if (!listed.has(key)) locallySeen.delete(key)
  }
  recompute()
  // Marks that came before the item was listed are carried out now that it is.
  if (wanted.size) {
    const now = Date.now()
    const due: string[] = []
    for (const [key, until] of wanted) {
      if (until <= now) wanted.delete(key)
      else if (known(key)) {
        wanted.delete(key)
        due.push(key)
      }
    }
    if (due.length) markSeen(due)
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The current summary, for event handlers (hooks below re-render; this doesn't). */
export function getWork(): WorkSummary {
  return shown
}

/** The whole summary; re-renders on every change. For the panel and the sidebar's Pågår och klart row. */
export function useWork(): WorkSummary {
  return useSyncExternalStore(subscribe, getWork)
}

/**
 * Selects part of the summary and keeps returning the previous value while `equal` says nothing changed, so a
 * once-a-second progress push only re-renders the components whose own numbers moved.
 */
function useSelected<T>(select: (s: WorkSummary) => T, equal: (a: T, b: T) => boolean): T {
  const cache = useRef<{ from: WorkSummary; select: (s: WorkSummary) => T; value: T } | undefined>(undefined)
  const get = (): T => {
    const c = cache.current
    if (c && c.from === shown && c.select === select) return c.value
    const value = select(shown)
    const kept = c && equal(c.value, value) ? c.value : value
    cache.current = { from: shown, select, value: kept }
    return kept
  }
  return useSyncExternalStore(subscribe, get)
}

export function sameCounts(a: WorkCounts, b: WorkCounts): boolean {
  return a.running === b.running && a.unseen === b.unseen && a.failed === b.failed
}

function sameFinished(a: readonly FinishedWork[], b: readonly FinishedWork[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.key !== y.key ||
      x.status !== y.status ||
      x.label !== y.label ||
      x.error !== y.error ||
      x.thumbPath !== y.thumbPath ||
      x.via !== y.via ||
      x.ownerId !== y.ownerId ||
      x.segmentId !== y.segmentId
    )
      return false
  }
  return true
}

function sameRunning(a: readonly RunningWork[], b: readonly RunningWork[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.key !== y.key ||
      x.progress !== y.progress ||
      x.detail !== y.detail ||
      x.label !== y.label ||
      x.remainingMs !== y.remainingMs ||
      x.typicalMs !== y.typicalMs ||
      x.thumbPath !== y.thumbPath ||
      x.via !== y.via ||
      x.segmentId !== y.segmentId
    )
      return false
  }
  return true
}

/** Counts of one sidebar view: running, new, failed. */
export function useViewWork(view: WorkView): WorkCounts {
  return useSelected((s) => s.byView[view] ?? ZERO, sameCounts)
}

/** Counts of one sequence, storyboard, clip or transition, edit or asset (zero for undefined). */
export function useOwnerWork(ownerId: string | undefined): WorkCounts {
  return useSelected((s) => (ownerId ? (s.byOwner[ownerId] ?? ZERO) : ZERO), sameCounts)
}

/** True while the item (a workKey) has finished – or failed – and the user hasn't seen it. */
export function useIsUnseen(key: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => key !== undefined && known(key))
}

/** Generations finished (not failed) and not seen yet, listed in full or not: the clip feed's "Nya". */
function freshGenerationIds(s: WorkSummary): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const w of s.unseen) if (w.status === 'completed' && w.generationId) ids.add(w.generationId)
  for (const r of s.more) if (!r.failed && r.key.startsWith('gen:')) ids.add(r.key.slice(4))
  return ids
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** The ids of every finished generation the user hasn't looked at yet (failures left out). */
export function useFreshGenerationIds(): ReadonlySet<string> {
  return useSelected(freshGenerationIds, sameSet)
}

/** The unseen item itself (to tell a new result from a new failure), or undefined. */
export function useUnseenItem(key: string | undefined): FinishedWork | undefined {
  return useSelected(
    () => (key ? unseenByKey.get(key) : undefined),
    (a, b) => a === b || (!!a && !!b && sameFinished([a], [b]))
  )
}

/** Unseen items matching the filter, newest first. */
export function useUnseen(filter: (w: FinishedWork) => boolean): FinishedWork[] {
  return useSelected((s) => s.unseen.filter(filter), sameFinished)
}

/** Running work, optionally filtered, in main's order. */
export function useRunning(filter?: (w: RunningWork) => boolean): RunningWork[] {
  return useSelected((s) => (filter ? s.running.filter(filter) : s.running), sameRunning)
}

/** Whether a key is unseen right now (for handlers; components use useIsUnseen). */
export function isUnseen(key: string | undefined): boolean {
  return key !== undefined && known(key)
}

// ── Marking seen ─────────────────────────────────────────────────────────────

/** Every unseen key is known here (listed in full or as a reference); a summary that says otherwise is checked by main. */
function listIsComplete(): boolean {
  return shown.unseen.length + shown.more.length >= shown.total.unseen + shown.total.failed
}

/**
 * Marks items seen (the user's explicit choices, the playback and visibility rules). Optimistic: they disappear
 * from every badge at once and main is told; if main refuses, they come back. A key that isn't listed as unseen
 * sends nothing: callers can mark on every open. It is remembered for a few seconds instead, in case main lists it
 * a moment later (it finished just as the user looked at it).
 */
export function markSeen(keys: string[]): void {
  const complete = listIsComplete()
  const fresh = [...new Set(keys)].filter((k) => !locallySeen.has(k))
  const send = fresh.filter((k) => known(k) || !complete)
  if (complete) {
    const until = Date.now() + WANTED_MS
    for (const k of fresh) if (!known(k)) wanted.set(k, until)
  }
  if (!send.length) return
  const until = Date.now() + LOCAL_SEEN_MS
  const listed = send.filter(known)
  for (const key of listed) locallySeen.set(key, until)
  if (listed.length) recompute()
  window.studio.markSeen(send).catch((e: unknown) => {
    console.warn('Kunde inte markera som sett', e)
    for (const key of listed) locallySeen.delete(key)
    recompute()
  })
}

function inScope(w: FinishedWork, scope: SeenScope | undefined): boolean {
  if (!scope) return true
  if (scope.view && w.view !== scope.view) return false
  if (scope.ownerId && w.ownerId !== scope.ownerId && w.segmentId !== scope.ownerId) return false
  return true
}

// The toast that follows "Markera alla som sedda": "7 markerade som sedda · Ångra" for ten seconds.

export interface SeenToast {
  id: number
  text: string
  /** Present while the marks can still be undone. */
  undo?: () => Promise<void>
  error?: boolean
}

let toast: SeenToast | undefined
let toastTimer: number | undefined
let toastIds = 0
const toastListeners = new Set<() => void>()

function setToast(next: SeenToast | undefined): void {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = undefined
  toast = next
  if (next) {
    toastTimer = window.setTimeout(() => {
      if (toast?.id === next.id) setToast(undefined)
    }, TOAST_MS)
  }
  for (const listener of [...toastListeners]) listener()
}

export function useSeenToast(): SeenToast | undefined {
  return useSyncExternalStore(
    (l) => {
      toastListeners.add(l)
      return () => {
        toastListeners.delete(l)
      }
    },
    () => toast
  )
}

export function dismissSeenToast(): void {
  setToast(undefined)
}

function seenCountText(n: number): string {
  return n === 1 ? '1 markerad som sedd' : `${n} markerade som sedda`
}

/**
 * "Markera alla som sedda", for everything or one view or owner (a sequence, storyboard, edit …). Hidden at once
 * here; main removes the rows and keeps them ten seconds for Ångra, which the toast offers.
 */
export async function markAllSeen(scope?: SeenScope): Promise<void> {
  // Past the listed ones nothing says where an item belongs: those go everywhere only with everything.
  const keys = [
    ...shown.unseen.filter((w) => inScope(w, scope)).map((w) => w.key),
    ...(scope ? [] : shown.more.map((r) => r.key))
  ]
  const until = Date.now() + LOCAL_SEEN_MS
  for (const key of keys) locallySeen.set(key, until)
  if (keys.length) recompute()
  try {
    const { count, undoToken } = await window.studio.markAllSeen(scope)
    if (count <= 0) return
    const id = ++toastIds
    setToast({
      id,
      text: seenCountText(count),
      undo: undoToken
        ? async () => {
            setToast(undefined)
            for (const key of keys) locallySeen.delete(key)
            recompute()
            try {
              await window.studio.undoMarkAllSeen(undoToken)
            } catch (e) {
              setToast({ id: ++toastIds, text: `Kunde inte ångra: ${ipcErrorMessage(e)}`, error: true })
            }
          }
        : undefined
    })
  } catch (e) {
    for (const key of keys) locallySeen.delete(key)
    recompute()
    setToast({ id: ++toastIds, text: `Kunde inte markera som sedda: ${ipcErrorMessage(e)}`, error: true })
  }
}

/** True when anything in the scope is new or failed and unseen (for showing "Markera alla som sedda"). */
export function useHasUnseen(scope?: SeenScope): boolean {
  const view = scope?.view
  const ownerId = scope?.ownerId
  return useSelected(
    (s) => {
      const c = ownerId ? s.byOwner[ownerId] : view ? s.byView[view] : s.total
      return !!c && c.unseen + c.failed > 0
    },
    (a, b) => a === b
  )
}

// ── The playback rule ────────────────────────────────────────────────────────

/** The path behind each element's current source, decoded once per source rather than on every timeupdate. */
const decoded = new WeakMap<HTMLMediaElement, { src: string; path?: string }>()

function pathOf(el: HTMLMediaElement): string | undefined {
  const src = el.currentSrc || el.src
  const cached = decoded.get(el)
  if (cached?.src === src) return cached.path
  const path = mediaPathOf(src)
  decoded.set(el, { src, path })
  return path
}

/** Seconds actually played: seeking (hover scrubbing, dragging the playhead) adds nothing. */
function playedSeconds(el: HTMLMediaElement): number {
  let sum = 0
  for (let i = 0; i < el.played.length; i++) sum += el.played.end(i) - el.played.start(i)
  return sum
}

/** Marks the element's media seen once at least a second of it (or half of a shorter clip) has played. */
function checkPlayed(el: HTMLMediaElement): void {
  if (!mediaIndex.size) return
  const path = pathOf(el)
  if (!path) return
  const key = mediaIndex.get(path)
  if (!key) return
  const duration = el.duration
  const needed = Number.isFinite(duration) && duration > 0 ? Math.min(1, duration / 2) : 1
  if (playedSeconds(el) + 0.001 >= needed) markSeen([key])
}

function onMediaEvent(e: Event): void {
  if (e.target instanceof HTMLMediaElement) checkPlayed(e.target)
}

/**
 * The playback rule for an element that isn't in the document (a shared `new Audio()`), whose events never reach
 * the document's capture listener. Returns a function that stops watching it.
 */
export function watchMediaElement(el: HTMLMediaElement): () => void {
  const handler = (): void => checkPlayed(el)
  el.addEventListener('timeupdate', handler)
  el.addEventListener('ended', handler)
  return () => {
    el.removeEventListener('timeupdate', handler)
    el.removeEventListener('ended', handler)
  }
}

// ── The visibility rule ──────────────────────────────────────────────────────

/** Share of the element (or of the window's height, for an element taller than that) that counts as "on screen". */
const VISIBLE_SHARE = 0.6

/**
 * Marks `key` seen once the element has been on screen (≥ 60 %) for `dwellMs` while the window has focus: pictures,
 * failures, the run-error banner. Does nothing while the key isn't unseen.
 */
export function useSeenWhenVisible(
  ref: RefObject<Element | null>,
  key: string | undefined,
  dwellMs = 1500,
  /** Told just before the key is marked seen (the panel keeps such rows listed until it closes). */
  onSeen?: (key: string) => void
): void {
  const unseen = useIsUnseen(key)
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  useEffect(() => {
    const el = ref.current
    if (!key || !unseen || !el || typeof IntersectionObserver === 'undefined') return
    let visible = false
    let timer: number | undefined
    const stop = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }
    const start = (): void => {
      if (timer !== undefined || !visible || !document.hasFocus() || document.visibilityState !== 'visible') return
      timer = window.setTimeout(() => {
        timer = undefined
        onSeenRef.current?.(key)
        markSeen([key])
      }, dwellMs)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        const rootHeight = entry.rootBounds?.height ?? window.innerHeight
        visible =
          entry.isIntersecting &&
          (entry.intersectionRatio >= VISIBLE_SHARE || entry.intersectionRect.height >= rootHeight * VISIBLE_SHARE)
        if (visible) start()
        else stop()
      },
      { threshold: [0, 0.25, 0.5, VISIBLE_SHARE, 0.8, 1] }
    )
    observer.observe(el)
    const onVisibility = (): void => (document.visibilityState === 'visible' ? start() : stop())
    window.addEventListener('focus', start)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      observer.disconnect()
      stop()
      window.removeEventListener('focus', start)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ref, key, unseen, dwellMs])
}

/**
 * The visibility rule for a picture shown by its file (a clip's start or end image, a form's image): when it is a
 * still the user hasn't seen yet (a picture an agent made for the clip, say), being on screen a moment marks it seen.
 */
export function useSeenPictureWhenVisible(ref: RefObject<Element | null>, path: string | undefined): void {
  const key = useSyncExternalStore(subscribe, () => (path ? pictureIndex.get(path.normalize('NFC')) : undefined))
  useSeenWhenVisible(ref, key)
}

// ── Going there ──────────────────────────────────────────────────────────────

/** A picture opened on its own from Pågår och klart (see jumpTo), with the sequence or storyboard it belongs to. */
export interface ShownStill {
  stillId: string
  sequenceId?: string
}

let shownStill: ShownStill | undefined
const shownStillListeners = new Set<() => void>()

/** Opens (or with undefined closes) the window's viewer for a picture that has no board or clip to be shown in. */
export function showWorkStill(still: ShownStill | undefined): void {
  shownStill = still
  for (const listener of [...shownStillListeners]) listener()
}

export function useShownWorkStill(): ShownStill | undefined {
  return useSyncExternalStore(
    (l) => {
      shownStillListeners.add(l)
      return () => {
        shownStillListeners.delete(l)
      }
    },
    () => shownStill
  )
}

/**
 * Opens the place a piece of work belongs to: the clip drawer in Generera, the clip or take in Sekvenser, the
 * transition or board in Storyboards, the edit (and version) in Redigera, the asset (and voice) in its view; an
 * agent request being carried out opens in the approval dialog. A picture with no board or clip to be seen in (one
 * made for a sequence as a whole, or for nothing) also opens on its own, over its view. Going there doesn't mark
 * anything seen by itself.
 */
export function jumpTo(target: WorkTarget, navigate: Navigate): void {
  if (target.approvalId) {
    showApproval(target.approvalId)
    return
  }
  if (target.stillId && !target.boardId && !target.segmentId && !target.transitionId) {
    showWorkStill({ stillId: target.stillId, sequenceId: target.sequenceId ?? target.storyboardId })
  }
  switch (target.view) {
    case 'generate':
      if (target.generationId) navigate('generate', { type: 'open-generation', generationId: target.generationId })
      else navigate('generate')
      return
    case 'sequences': {
      const sequenceId = target.sequenceId ?? target.storyboardId
      if (sequenceId)
        navigate('sequences', {
          type: 'open-sequence',
          sequenceId,
          segmentId: target.segmentId,
          generationId: target.generationId
        })
      else navigate('sequences')
      return
    }
    case 'storyboards': {
      const storyboardId = target.storyboardId ?? target.sequenceId
      if (storyboardId)
        navigate('storyboards', {
          type: 'open-storyboard',
          storyboardId,
          transitionId: target.transitionId ?? (target.boardId ? undefined : target.segmentId),
          boardId: target.boardId
        })
      else navigate('storyboards')
      return
    }
    case 'editor':
      // Never with exportId alone: that intent makes a new edit, and going somewhere must not create anything.
      if (target.editId) navigate('editor', { type: 'open-editor', editId: target.editId, versionId: target.versionId })
      else navigate('editor')
      return
    default:
      // The asset views (Karaktärer … Poser): a designed voice opens its character with the clip in view, a failed
      // design with its error.
      if (target.assetId) {
        navigate(target.view, {
          type: 'open-asset',
          assetId: target.assetId,
          audioId: target.audioId,
          ...(target.jobId ? { jobId: target.jobId } : {})
        })
      }
      else navigate(target.view)
  }
}

/**
 * A key for work the window starts and wants to recognise in the summary later (StillParams.workToken: a picture's
 * result or failure after its dialog closed). Only unique, never secret.
 */
export function newWorkToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** The current time, ticking every second while `active` (estimates count down between pushes). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

// ── Subscription ─────────────────────────────────────────────────────────────

let users = 0
let stopFeed: (() => void) | undefined

/**
 * Starts following main's work summary and installs the playback rule (one capture-phase listener on the
 * document: media events don't bubble, but they do pass the capture phase). Returns a function that stops it;
 * callers share one subscription.
 */
export function startWorkFeed(): () => void {
  users++
  if (users === 1) {
    const off = window.studio.onWorkChange(receive)
    document.addEventListener('timeupdate', onMediaEvent, true)
    document.addEventListener('ended', onMediaEvent, true)
    stopFeed = () => {
      off()
      document.removeEventListener('timeupdate', onMediaEvent, true)
      document.removeEventListener('ended', onMediaEvent, true)
    }
    window.studio.getWorkSummary().then(receive, (e: unknown) => console.warn('Kunde inte läsa vad som pågår', e))
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    users--
    if (users === 0) {
      stopFeed?.()
      stopFeed = undefined
    }
  }
}
