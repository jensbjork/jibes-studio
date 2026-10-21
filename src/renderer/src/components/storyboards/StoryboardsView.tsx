import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  BoardImageSource,
  ConsentRequest,
  FfmpegStatus,
  FinishedWork,
  Generation,
  RunningWork,
  Still,
  Storyboard
} from '@shared/types'
import { variantsPrice, variantsText } from '@shared/variants'
import { ASSET_VIEW } from '../../lib/assets'
import { withBudgetConfirm } from '../../lib/budget'
import { ipcErrorMessage, useAssets, useModels } from '../../lib/hooks'
import { LAST_STORYBOARD_KEY } from '../../lib/library'
import { formatUsd } from '../../lib/media'
import type { Intent, Navigate } from '../../lib/navigation'
import { FFMPEG_INSTALL, FILE_MANAGER, isMac } from '../../lib/platform'
import { markSeen, useRunning, useSeenWhenVisible, useUnseen } from '../../lib/work'
import ConsentDialog from '../ConsentDialog'
import CreateImageDialog from '../images/CreateImageDialog'
import FramePickerDialog from '../images/FramePickerDialog'
import StillViewer from '../images/StillViewer'
import { useStills } from '../images/imageModels'
import PreviewPlayer from '../sequences/PreviewPlayer'
import type { FlushRegistry } from '../sequences/useDraft'
import { useExportStatus } from '../sequences/useExportStatus'
import { useClipQuote, useTotalQuote } from '../sequences/useTotalQuote'
import { newsBySegment } from '../takes/takeText'
import BoardRow from './BoardRow'
import CreateStoryboardForm from './CreateStoryboardForm'
import { StoryboardIcon } from './icons'
import StoryboardHeader from './StoryboardHeader'
import StoryboardList from './StoryboardList'
import {
  asPreviewSequence,
  boardNumber,
  exportBlocked as exportBlockedReason,
  lostTransitionsText,
  moveBoardLocally,
  orderWithNewBoard,
  parseConsent,
  patchTransitionLocally,
  clipCountLabel,
  readyTake,
  runKeys,
  runPlan,
  totalSeconds,
  transitionInMessage,
  transitionKey,
  transitionLabel,
  transitionsLost,
  withoutTake
} from './storyboardUtils'
import TransitionEditor, { EDITOR_WIDTH } from './TransitionEditor'
import { Banner, ConfirmDialog } from './ui'
import { useStoryboard, useStoryboardList } from './useStoryboard'

function loadLastOpen(): string | undefined {
  try {
    return localStorage.getItem(LAST_STORYBOARD_KEY) ?? undefined
  } catch {
    return undefined
  }
}

interface Notice {
  text: string
  /** Only shown while this storyboard is open; everywhere when unset. */
  storyboardId?: string
}

/** A change to the boards' order waiting for the user's yes, since it would remove transitions with work in them. */
interface PendingChange {
  title: string
  text: string
  confirmLabel: string
  run: () => void
}

/** Stands in for a board that doesn't exist yet when the order after adding it is worked out. */
const NEW_BOARD = '(new board)'

/** Below this much room for the boards beside it, the transition editor lies over them instead. */
const MIN_ROW_WIDTH = 440

const UNSAVED = 'The changes couldn’t be saved. Try again.'

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

/**
 * Storyboards: plan a film as its milestones – one picture per board, made with Create image or taken from the
 * library, a file or a frame of a clip – and generate the clips between them, each going from one board's picture
 * to the next one's. A storyboard can then be previewed, exported as one film, or turned into a sequence to keep
 * editing in Sequences.
 */
export default function StoryboardsView({ intent, onIntentHandled, navigate }: Props) {
  const { models, error: modelsError } = useModels()
  const { storyboards, reload } = useStoryboardList()
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    intent?.type === 'open-storyboard' ? intent.storyboardId : loadLastOpen()
  )
  // Ids that failed to load or were deleted, so choosing one by itself never picks them from a stale list.
  const gone = useRef(new Set<string>())
  const onMissing = useCallback(
    (id: string) => {
      gone.current.add(id)
      setSelectedId((cur) => (cur === id ? undefined : cur))
      void reload()
    },
    [reload]
  )
  const store = useStoryboard(selectedId, onMissing)
  const { storyboard } = store
  const storyboardId = storyboard?.id
  const assets = useAssets()
  const { stills } = useStills(storyboardId)

  // ── Activity for the open storyboard (also what an agent or an earlier visit started) ───────────────────────
  const exportStatus = useExportStatus(storyboardId)
  const ownerUnseenFilter = useCallback(
    (w: FinishedWork) => !!storyboardId && w.ownerId === storyboardId,
    [storyboardId]
  )
  const ownerRunningFilter = useCallback(
    (w: RunningWork) => !!storyboardId && w.ownerId === storyboardId,
    [storyboardId]
  )
  const ownerUnseen = useUnseen(ownerUnseenFilter)
  const ownerRunning = useRunning(ownerRunningFilter)
  const news = useMemo(() => newsBySegment(ownerUnseen), [ownerUnseen])
  // A "Generate missing" that stopped on a problem: main keeps its error with the storyboard while the app runs,
  // and as a failure in Activity (also after a restart) until it has been seen.
  const runFailure = ownerUnseen
    .filter((w) => w.failureOf === 'run')
    .sort((a, b) => b.finishedAt - a.finishedAt)[0]
  const runWork = ownerRunning.find((w) => w.kind === 'run')

  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>()
  const [notice, setNotice] = useState<Notice>()
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [converting, setConverting] = useState(false)
  const [focusNameFor, setFocusNameFor] = useState<string>()
  const [preview, setPreview] = useState(false)
  // Open with the transitions the run would pay for when it was opened (see runKeys).
  const [runConsentOpen, setRunConsentOpen] = useState<ReadonlySet<string>>()
  const [dismissedRunError, setDismissedRunError] = useState<string>()
  // The transition open in the editor beside the boards.
  const [editorId, setEditorId] = useState<string>()
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [busyBoards, setBusyBoards] = useState<Record<string, boolean>>({})
  // Venice's terms for a model, with the transition as it was when it asked: accepting generates only that one – as
  // many variants as were asked for, and over the budget if that was confirmed already.
  const [consent, setConsent] = useState<{
    request: ConsentRequest
    transitionId: string
    key: string
    count: number
    overBudgetOk: boolean
  }>()
  const [createImageFor, setCreateImageFor] = useState<string>()
  const [framePickerFor, setFramePickerFor] = useState<string>()
  // One of the storyboard's pictures full size, opened from a board's menu: it can be put in that board or deleted.
  const [viewingStill, setViewingStill] = useState<{ still: Still; boardId: string }>()
  const [reveal, setReveal] = useState<string>()
  // A board pointed out by a link (Activity: its picture failed or is new): it lights up briefly.
  const [flash, setFlash] = useState<{ boardId: string; n: number }>()
  const flashCount = useRef(0)
  const [pendingChange, setPendingChange] = useState<PendingChange>()

  const ffmpegOk = ffmpeg?.ok !== false
  const flushers = useMemo<FlushRegistry>(() => new Set(), [])
  /** Saves every open draft (notes, the transition being edited), so main acts on what is on screen. */
  const flushAll = useCallback(
    async () => (await Promise.all([...flushers].map((flush) => flush()))).every(Boolean),
    [flushers]
  )

  // The latest storyboard, for comparing a transition after the consent dialog.
  const latest = useRef(storyboard)
  useEffect(() => {
    latest.current = storyboard
  })

  // ── Selection ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (selectedId || !storyboards) return
    const first = storyboards.find((s) => !gone.current.has(s.id))
    if (first) setSelectedId(first.id)
  }, [selectedId, storyboards])

  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem(LAST_STORYBOARD_KEY, selectedId)
    } catch {
      // Remembering the open storyboard is only a convenience.
    }
  }, [selectedId])

  // A transition or a board to show once the storyboard is open (a link to it, or an agent's open_in_studio). Showing
  // a place marks nothing seen by itself (D4): pictures and failures count once they have been on screen a moment.
  const [target, setTarget] = useState<{ storyboardId: string; transitionId?: string; boardId?: string }>()

  useEffect(() => {
    if (intent?.type !== 'open-storyboard') return
    gone.current.delete(intent.storyboardId)
    setSelectedId(intent.storyboardId)
    const { storyboardId: id, transitionId, boardId } = intent
    setTarget(transitionId || boardId ? { storyboardId: id, transitionId, boardId } : undefined)
    onIntentHandled()
  }, [intent])

  // A transition's editor, errors and dialogs belong to the storyboard they were opened in.
  useEffect(() => {
    setEditorId(undefined)
    setCreateImageFor(undefined)
    setFramePickerFor(undefined)
    setViewingStill(undefined)
    setPreview(false)
    setPendingChange(undefined)
  }, [storyboardId])

  // The intent's transition opens in the editor and its board lights up, once the storyboard has loaded (after the
  // reset above, which runs first for a storyboard that was just opened).
  useEffect(() => {
    if (!storyboard || !target || target.storyboardId !== storyboard.id) return
    setTarget(undefined)
    if (target.transitionId && storyboard.transitions.some((t) => t.id === target.transitionId)) {
      setEditorId(target.transitionId)
      setReveal(target.transitionId)
    }
    if (target.boardId && storyboard.boards.some((b) => b.id === target.boardId)) {
      setReveal(target.boardId)
      setFlash({ boardId: target.boardId, n: ++flashCount.current })
    }
  }, [storyboard, target])

  const editorTransition = editorId ? storyboard?.transitions.find((t) => t.id === editorId) : undefined
  // Its boards were moved apart or one was deleted: the transition is gone, and so is its editor.
  useEffect(() => {
    if (storyboard && editorId && !editorTransition) setEditorId(undefined)
  }, [storyboard, editorId, editorTransition])

  // ── Live state from main ───────────────────────────────────────────────────

  useEffect(() => {
    window.studio.ffmpegStatus().then(setFfmpeg, (e: unknown) => setFfmpeg({ ok: false, message: ipcErrorMessage(e) }))
  }, [])

  useEffect(() => {
    if (!storyboard?.running) setStopping(false)
  }, [storyboard?.running])

  // ── Storyboards ────────────────────────────────────────────────────────────

  const createStoryboard = async (name: string, aspectRatio: string): Promise<boolean> => {
    setCreating(true)
    setNotice(undefined)
    try {
      const created = await window.studio.createStoryboard(name, aspectRatio)
      gone.current.delete(created.id)
      // Without a name main gave it one; put the cursor there so it can be named right away.
      if (!name) setFocusNameFor(created.id)
      setSelectedId(created.id)
      void reload()
      return true
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e) })
      return false
    } finally {
      setCreating(false)
    }
  }

  /**
   * The list's ✕ (after its question in the row) and ⋯ → Delete storyboard…; throws, so the row can show the error.
   * The open one is let go of first (as in Sequences) and gives way to its neighbour in the list.
   */
  const removeStoryboard = async (id: string, nextId?: string) => {
    const wasOpen = id === selectedId
    const rest = (storyboards ?? []).filter((s) => s.id === id || !gone.current.has(s.id))
    const at = rest.findIndex((s) => s.id === id)
    const neighbor = nextId ?? (at === -1 ? undefined : (rest[at + 1] ?? rest[at - 1])?.id)
    gone.current.add(id)
    if (wasOpen) setSelectedId(neighbor)
    try {
      await window.studio.deleteStoryboard(id)
      try {
        if (loadLastOpen() === id) localStorage.removeItem(LAST_STORYBOARD_KEY)
      } catch {
        // Ignore unavailable storage.
      }
    } catch (e) {
      gone.current.delete(id)
      if (wasOpen) setSelectedId(id)
      throw e
    } finally {
      void reload()
    }
  }

  const deleteStoryboard = (id: string) =>
    removeStoryboard(id).catch((e: unknown) => setNotice({ text: ipcErrorMessage(e) }))

  const rename = (name: string) => {
    if (!storyboardId) return
    store.update((s) => ({ ...s, name }))
    store.mutate(() => window.studio.updateStoryboard(storyboardId, { name })).catch((e: unknown) => {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
      store.refresh()
    })
  }

  /** The storyboard's director (null: none): pending edits first; a refusal goes back to the Director panel. */
  const changeDirector = async (director: string | null): Promise<void> => {
    if (!storyboardId) return
    await flushAll()
    await store.mutate(() => window.studio.updateStoryboard(storyboardId, { director }))
  }

  const setAspectRatio = (aspectRatio: string) => {
    if (!storyboardId) return
    store.update((s) => ({ ...s, aspectRatio }))
    store.mutate(() => window.studio.updateStoryboard(storyboardId, { aspectRatio })).catch((e: unknown) => {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
      store.refresh()
    })
  }

  // ── Boards ─────────────────────────────────────────────────────────────────

  /**
   * Runs a change to the boards' order at once, or – when the order would remove transitions that have a prompt or
   * takes (main keeps one transition per two neighbouring boards) – once the user has said yes. True when it ran.
   */
  const confirmIfLost = (order: string[], ask: Pick<PendingChange, 'title' | 'confirmLabel'>, run: () => void) => {
    const lost = storyboard ? transitionsLost(storyboard, order) : []
    if (!storyboard || !lost.length) {
      run()
      return true
    }
    setPendingChange({ ...ask, text: lostTransitionsText(storyboard, lost), run })
    return false
  }

  const addBoard = (init: { afterBoardId?: string; beforeBoardId?: string; image?: BoardImageSource }) => {
    if (!storyboard) return
    confirmIfLost(
      orderWithNewBoard(storyboard, init, NEW_BOARD),
      { title: 'Add a board here?', confirmLabel: 'Add anyway' },
      () => void insertBoard(init)
    )
  }

  const insertBoard = async (init: { afterBoardId?: string; beforeBoardId?: string; image?: BoardImageSource }) => {
    // The storyboard as it is now: this may run from the confirmation, rendered a while ago.
    const current = latest.current
    if (!current) return
    const id = current.id
    const before = new Set(current.boards.map((b) => b.id))
    setAdding(true)
    try {
      const updated = await store.mutate(() => window.studio.addBoard(id, init))
      const added = updated.boards.find((b) => !before.has(b.id))
      if (added) setReveal(added.id)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId: id })
    } finally {
      setAdding(false)
    }
  }

  /** Pictures dropped on "New board": one new board each, in the order they were dropped. */
  const addFiles = async (paths: string[]) => {
    if (!storyboard) return
    const id = storyboard.id
    const known = new Set(storyboard.boards.map((b) => b.id))
    let last: string | undefined
    setAdding(true)
    try {
      // One at a time: each is added at the end, after the one before.
      for (const path of paths) {
        const updated = await store.mutate(() => window.studio.addBoard(id, { image: { kind: 'file', path } }))
        const added = updated.boards.find((b) => !known.has(b.id))
        if (added) {
          known.add(added.id)
          last = added.id
        }
      }
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId: id })
    } finally {
      setAdding(false)
      if (last) setReveal(last)
    }
  }

  const setBoardImage = async (boardId: string, source: BoardImageSource | null) => {
    setBusyBoards((m) => ({ ...m, [boardId]: true }))
    try {
      await store.mutate(() => window.studio.updateBoard(boardId, { image: source }))
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
      store.refresh()
    } finally {
      setBusyBoards((m) => ({ ...m, [boardId]: false }))
    }
  }

  /** True when the board moved now; false when the user is asked first (or there is no storyboard). */
  const moveBoard = (boardId: string, toIndex: number): boolean => {
    if (!storyboard) return false
    const order = moveBoardLocally(storyboard, boardId, toIndex).boards.map((b) => b.id)
    return confirmIfLost(order, { title: 'Move the board?', confirmLabel: 'Move anyway' }, () => {
      store.update((s) => moveBoardLocally(s, boardId, toIndex))
      // An edit waiting to be saved may belong to a transition the move removes: saved first, it isn't lost.
      void flushAll()
        .then(() => store.mutate(() => window.studio.moveBoard(boardId, toIndex)))
        .catch((e: unknown) => {
          setNotice({ text: ipcErrorMessage(e), storyboardId })
          store.refresh()
        })
    })
  }

  const deleteBoard = async (boardId: string) => {
    await flushAll()
    try {
      await store.mutate(() => window.studio.deleteBoard(boardId))
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
    }
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  // A paid call: guarded by a ref too, since two quick clicks (or ⌘+Enter) can both run before the disabled
  // button has rendered. `count`: the variants the editor asked for (the card's own Generate sends one).
  const inFlight = useRef(new Set<string>())
  const generate = async (transitionId: string, count = 1, overBudgetOk = false) => {
    if (inFlight.current.has(transitionId)) return
    inFlight.current.add(transitionId)
    setSubmitting((m) => ({ ...m, [transitionId]: true }))
    setErrors((m) => ({ ...m, [transitionId]: undefined }))
    let confirmed = overBudgetOk
    try {
      // main generates from the stored transition, so what is typed in the editor must be saved first.
      if (!(await flushAll())) throw new Error(UNSAVED)
      const take = await withBudgetConfirm((yes) => {
        confirmed ||= yes
        return window.studio.generateTransition(transitionId, { count, confirmOverBudget: confirmed })
      })
      // Undefined: over the budget, and the user said no – nothing was sent.
      if (take) store.addTake(take)
    } catch (e) {
      const message = ipcErrorMessage(e)
      const request = parseConsent(message)
      const t = latest.current?.transitions.find((x) => x.id === transitionId)
      if (request && t) {
        setConsent({ request, transitionId, key: transitionKey(t), count, overBudgetOk: confirmed })
      } else {
        setErrors((m) => ({ ...m, [transitionId]: message }))
        // The editor is where a transition's errors are shown.
        setEditorId(transitionId)
      }
    } finally {
      inFlight.current.delete(transitionId)
      setSubmitting((m) => ({ ...m, [transitionId]: false }))
    }
  }

  const acceptConsent = async () => {
    if (!consent) return
    const { request, transitionId, key, count, overBudgetOk } = consent
    setConsent(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      setErrors((m) => ({ ...m, [transitionId]: ipcErrorMessage(e) }))
      setEditorId(transitionId)
      return
    }
    // The transition may have changed while the terms were shown (an agent can edit it, a board can get another
    // picture): then nothing is sent until the user has looked again and pressed Generate, which shows the price.
    const t = latest.current?.transitions.find((x) => x.id === transitionId)
    if (!t || transitionKey(t) !== key) {
      setErrors((m) => ({
        ...m,
        [transitionId]: 'The transition changed while the terms were shown. Check it and press Generate again.'
      }))
      setEditorId(transitionId)
      return
    }
    await generate(transitionId, count, overBudgetOk)
  }
  const consentTransition = consent ? storyboard?.transitions.find((t) => t.id === consent.transitionId) : undefined
  const consentQuote = useClipQuote(consentTransition?.params)

  /** A take becomes the transition's (the editor's strip shows it at once and calls this when main should know). */
  const { update: updateStore, mutate: mutateStore, refresh: refreshStore } = store
  const commitTake = useCallback(
    async (transitionId: string, takeId: string) => {
      updateStore((s) => patchTransitionLocally(s, transitionId, { selectedGenerationId: takeId }))
      try {
        await mutateStore(() => window.studio.updateTransition(transitionId, { selectedGenerationId: takeId }))
      } catch (e) {
        refreshStore()
        throw e
      }
    },
    [updateStore, mutateStore, refreshStore]
  )

  const deleteTake = async (transitionId: string, take: Generation) => {
    store.update((s) => withoutTake(s, take.id))
    try {
      // A take the Editor keeps (an edit started from it) is only taken off the transition, as in a sequence's take list.
      await window.studio.deleteGeneration(take.id, { segmentId: transitionId, release: take.keptByEdit === true })
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
    }
    store.refresh()
  }

  const openTransition = (transitionId: string) => {
    setEditorId((cur) => (cur === transitionId ? undefined : transitionId))
  }

  const showTransition = (transitionId: string) => {
    setEditorId(transitionId)
    setReveal(transitionId)
  }

  // ── Storyboard-wide actions ────────────────────────────────────────────────

  const plan = useMemo(() => (storyboard ? runPlan(storyboard) : undefined), [storyboard])
  // Priced only when the run could start: while one of them can't be made, nothing would be paid for.
  const runParams = useMemo(() => (plan && !plan.blocked ? plan.toGenerate.map((t) => t.params) : []), [plan])
  const runQuote = useTotalQuote(runParams)

  /** `expected`: only start when every transition it would pay for is among these (see runKeys). */
  const startRun = async (expected?: ReadonlySet<string>) => {
    if (!storyboardId) return
    setNotice(undefined)
    if (!(await flushAll())) {
      setNotice({ text: UNSAVED, storyboardId })
      return
    }
    let fresh: Storyboard
    try {
      fresh = await store.mutate(() => window.studio.getStoryboard(storyboardId))
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
      return
    }
    const next = runPlan(fresh)
    // Pointed out up front rather than paying for some and stopping at the first that can't be made.
    if (next.blocked) {
      showTransition(next.blocked.transitionId)
      setNotice({ text: next.blocked.message, storyboardId })
      return
    }
    if (!next.toGenerate.length) return
    if (expected && runKeys(fresh).some((k) => !expected.has(k))) {
      setNotice({
        text:
          'The transitions changed while the terms were shown. Check them and press “Generate missing” again – ' +
          'the button shows the price.',
        storyboardId
      })
      return
    }
    setDismissedRunError(undefined)
    // Starting again is acting on the last run's problem: it has been seen.
    if (runFailure) markSeen([runFailure.key])
    store.update((s) => ({ ...s, running: true, runError: undefined }))
    try {
      // Checked against the budget once, with the run's total: past it the user is asked first (no starts nothing).
      await withBudgetConfirm((confirmed) =>
        window.studio.generateStoryboard(storyboardId, confirmed ? { confirmOverBudget: true } : undefined)
      )
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
    }
    store.refresh()
  }

  const stopRun = async () => {
    if (!storyboardId) return
    setStopping(true)
    try {
      await window.studio.stopStoryboard(storyboardId)
    } catch (e) {
      setStopping(false)
      setNotice({ text: ipcErrorMessage(e), storyboardId })
    }
  }

  const acceptRunConsent = async (request: ConsentRequest, expected: ReadonlySet<string>) => {
    setRunConsentOpen(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
      return
    }
    // Exactly what the dialog was opened for; anything changed since goes back to the button with the price.
    await startRun(expected)
  }

  const exportFilm = async () => {
    if (!storyboardId) return
    if (!(await flushAll())) {
      setNotice({ text: UNSAVED, storyboardId })
      return
    }
    await exportStatus.run(() => window.studio.exportStoryboard(storyboardId))
  }

  const openPreview = async () => {
    await flushAll()
    setPreview(true)
  }

  const convert = async () => {
    if (!storyboardId || converting) return
    setConverting(true)
    setNotice(undefined)
    try {
      if (!(await flushAll())) throw new Error(UNSAVED)
      const { sequenceId } = await window.studio.convertStoryboardToSequence(storyboardId)
      navigate('sequences', { type: 'open-sequence', sequenceId })
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), storyboardId })
    } finally {
      setConverting(false)
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const exportBlocked = storyboard ? exportBlockedReason(storyboard, ffmpegOk) : undefined
  const doneCount = storyboard ? storyboard.transitions.filter((t) => readyTake(t)).length : 0
  const previewDisabled = doneCount === 0 ? 'No transition has a finished clip yet' : undefined
  // While the app runs, main keeps the run's error with the storyboard; after a restart only Activity has it.
  const runError = storyboard?.runError ?? runFailure?.error
  const runConsent = parseConsent(runError)
  const runErrorTransition = storyboard && runError ? transitionInMessage(storyboard, runError) : undefined
  const visibleNotice = notice && (!notice.storyboardId || notice.storyboardId === storyboardId) ? notice : undefined
  const noImages = !!storyboard && storyboard.boards.length > 0 && storyboard.boards.every((b) => !b.imagePath)

  const createBoardIndex =
    createImageFor && storyboard ? storyboard.boards.findIndex((b) => b.id === createImageFor) : -1
  const createBoard = createBoardIndex === -1 ? undefined : storyboard?.boards[createBoardIndex]
  const previousImagePath = createBoardIndex > 0 ? storyboard?.boards[createBoardIndex - 1].imagePath : undefined

  // A frame for a board is most often one of the clips that meet it: the last frame of the one arriving there,
  // else the first frame of the one leaving it.
  const frameStart = useMemo(() => {
    if (!framePickerFor || !storyboard) return undefined
    const arriving = storyboard.transitions.find((t) => t.toBoardId === framePickerFor)
    const arrivingTake = arriving && readyTake(arriving)
    if (arrivingTake) return { generationId: arrivingTake.id, at: 'end' as const }
    const leaving = storyboard.transitions.find((t) => t.fromBoardId === framePickerFor)
    const leavingTake = leaving && readyTake(leaving)
    return leavingTake ? { generationId: leavingTake.id, at: 'start' as const } : undefined
  }, [framePickerFor, storyboard])

  // The shared player plays a sequence's clips: the transitions are those, in cut order.
  const previewSequence = useMemo(
    () => (preview && storyboard ? asPreviewSequence(storyboard) : undefined),
    [preview, storyboard]
  )

  // ── Layout: the editor beside the boards, or over them in a narrow window ─

  const area = useRef<HTMLDivElement>(null)
  const [areaWidth, setAreaWidth] = useState(0)
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const measure = () => setAreaWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [storyboardId])
  const editorOverlays = areaWidth > 0 && areaWidth - EDITOR_WIDTH < MIN_ROW_WIDTH

  // ── Render ─────────────────────────────────────────────────────────────────

  const banners = (
    <>
      {ffmpeg && !ffmpeg.ok && (
        <Banner tone="warning">
          <span className="font-medium">ffmpeg is missing</span> – export and frames from clips are turned off.{' '}
          {isMac ? (
            <>
              Install it with <code className="rounded bg-black/30 px-1 py-px font-mono">brew install ffmpeg</code> and
              restart Studio.
            </>
          ) : (
            `It comes with Studio: ${FFMPEG_INSTALL}.`
          )}
        </Banner>
      )}
      {visibleNotice && (
        <Banner tone="error" onDismiss={() => setNotice(undefined)}>
          {visibleNotice.text}
        </Banner>
      )}
      {runError && runError !== dismissedRunError && !storyboard?.running && (
        <SeenWhenVisible seenKey={runFailure?.key}>
          <Banner
            tone="error"
            onDismiss={() => {
              setDismissedRunError(runError)
              if (runFailure) markSeen([runFailure.key])
            }}
          >
            {runConsent ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                Generate missing stopped: the model needs you to accept the provider’s terms.
                <button
                  onClick={() => storyboard && setRunConsentOpen(new Set(runKeys(storyboard)))}
                  className="rounded bg-accent px-2 py-0.5 font-medium text-white hover:bg-accent-hover"
                >
                  Review and continue
                </button>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Generate missing stopped – {runError}</span>
                {runErrorTransition && runErrorTransition.id !== editorId && storyboard && (
                  <button
                    onClick={() => showTransition(runErrorTransition.id)}
                    className="rounded border border-accent/40 px-2 py-0.5 font-medium hover:bg-accent/10"
                  >
                    Show {transitionLabel(storyboard, runErrorTransition).toLowerCase()}
                  </button>
                )}
              </span>
            )}
          </Banner>
        </SeenWhenVisible>
      )}
      {exportStatus.done && (
        <Banner tone="success" onDismiss={exportStatus.dismissDone}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span title={exportStatus.done.mediaPath}>The film is ready</span>
            <button
              onClick={() => void exportStatus.reveal()}
              className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
            >
              Show in {FILE_MANAGER}
            </button>
            {exportStatus.done.exportId && (
              <button
                onClick={() => exportStatus.edit(navigate)}
                title="Change the finished film with AI in the Editor. The storyboard stays as it is."
                className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
              >
                Edit
              </button>
            )}
          </span>
        </Banner>
      )}
      {exportStatus.failure && (
        <Banner tone="error" onDismiss={exportStatus.dismissFailure}>
          {exportStatus.failure}
        </Banner>
      )}
    </>
  )

  return (
    <div className="flex h-full">
      <StoryboardList
        storyboards={storyboards}
        selectedId={selectedId}
        creating={creating}
        onSelect={(id) => {
          gone.current.delete(id)
          setSelectedId(id)
        }}
        onCreate={createStoryboard}
        onDelete={removeStoryboard}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {storyboard ? (
          <>
            <StoryboardHeader
              key={storyboard.id}
              storyboard={storyboard}
              totalSeconds={totalSeconds(storyboard)}
              doneCount={doneCount}
              toGenerate={plan?.toGenerate.length ?? 0}
              generating={plan?.generating ?? 0}
              runBlocked={plan?.blocked?.message}
              runQuote={runQuote}
              stopping={stopping}
              runDetail={runWork?.detail}
              previewDisabled={previewDisabled}
              exportProgress={exportStatus.progress}
              exportBlocked={exportBlocked}
              converting={converting}
              autoFocusName={focusNameFor === storyboard.id}
              onAutoFocused={() => setFocusNameFor(undefined)}
              onRename={rename}
              onAspectRatio={setAspectRatio}
              onGenerateAll={() => void startRun()}
              onStop={() => void stopRun()}
              onPreview={() => void openPreview()}
              onExport={() => void exportFilm()}
              onConvert={() => void convert()}
              onDelete={() => void deleteStoryboard(storyboard.id)}
              onEditExport={(exportId) => navigate('editor', { type: 'open-editor', exportId })}
              onError={(text) => setNotice({ text, storyboardId: storyboard.id })}
              onDirectorChange={changeDirector}
              onOpenDirector={(id) => navigate('directors', id ? { type: 'open-asset', assetId: id } : undefined)}
            />
            {banners}
            <div ref={area} className="relative flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {noImages && (
                  <p className="mx-auto mt-5 max-w-xl shrink-0 px-6 text-center text-[12px] leading-relaxed text-muted">
                    Add an image to each board – the film’s key moments, in order. The clips between the boards are
                    then generated from image to image.
                  </p>
                )}
                <BoardRow
                  // Per storyboard: drags, drafts and measurements of one never carry over to another.
                  key={storyboard.id}
                  storyboard={storyboard}
                  store={store}
                  flushers={flushers}
                  stills={stills}
                  assets={assets}
                  busyBoards={busyBoards}
                  ffmpegOk={ffmpegOk}
                  editorId={editorTransition?.id}
                  submitting={submitting}
                  news={news}
                  unseen={ownerUnseen}
                  running={ownerRunning}
                  flash={flash}
                  adding={adding}
                  fitWidth={areaWidth}
                  reveal={reveal}
                  onRevealed={() => setReveal(undefined)}
                  onSetImage={(boardId, source) => void setBoardImage(boardId, source)}
                  onCreateImage={setCreateImageFor}
                  onPickFrame={setFramePickerFor}
                  onViewStill={(boardId, still) => setViewingStill({ boardId, still })}
                  onDeleteBoard={(boardId) => void deleteBoard(boardId)}
                  onMoveBoard={moveBoard}
                  onAddBoard={addBoard}
                  onAddFiles={(paths) => void addFiles(paths)}
                  onOpenTransition={openTransition}
                  onGenerate={(id) => void generate(id)}
                  onManage={(kind) => navigate(ASSET_VIEW[kind])}
                  onError={(text) => setNotice({ text, storyboardId: storyboard.id })}
                />
              </div>

              {editorTransition && (
                <section
                  aria-label={transitionLabel(storyboard, editorTransition)}
                  className={`flex shrink-0 flex-col border-l border-line bg-bg ${
                    editorOverlays ? 'absolute inset-y-0 right-0 z-20 shadow-2xl shadow-black/60' : ''
                  }`}
                  style={{ width: EDITOR_WIDTH }}
                >
                  <TransitionEditor
                    key={editorTransition.id}
                    storyboard={storyboard}
                    transition={editorTransition}
                    models={models}
                    modelsError={modelsError}
                    store={store}
                    flushers={flushers}
                    submitting={!!submitting[editorTransition.id]}
                    error={errors[editorTransition.id]}
                    onDismissError={() => setErrors((m) => ({ ...m, [editorTransition.id]: undefined }))}
                    onGenerate={(count) => void generate(editorTransition.id, count)}
                    onCommitTake={commitTake}
                    onDeleteTake={(take) => void deleteTake(editorTransition.id, take)}
                    onEditTake={(take) => navigate('editor', { type: 'open-editor', generationId: take.id })}
                    onError={(text) => setNotice({ text, storyboardId: storyboard.id })}
                    onClose={() => setEditorId(undefined)}
                    onOpenDirector={(id) => navigate('directors', { type: 'open-asset', assetId: id })}
                  />
                </section>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="drag h-12 shrink-0" />
            {visibleNotice && (
              <Banner tone="error" onDismiss={() => setNotice(undefined)}>
                {visibleNotice.text}
              </Banner>
            )}
            {storyboards?.length === 0 && !selectedId ? (
              <EmptyState creating={creating} onCreate={(name, aspect) => void createStoryboard(name, aspect)} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted">
                {selectedId && !store.error ? 'Loading storyboard…' : ''}
              </div>
            )}
          </>
        )}
      </div>

      {previewSequence && (
        <PreviewPlayer
          sequence={previewSequence}
          startSegmentId={previewSequence.segments.find((s) => readyTake(s))?.id}
          onClose={() => setPreview(false)}
        />
      )}
      {storyboard && (
        <CreateImageDialog
          open={!!createBoard}
          sequenceId={storyboard.id}
          initialPrompt={createBoard?.note.trim() || undefined}
          previousImagePath={previousImagePath}
          assign={createBoard ? { boardId: createBoard.id } : undefined}
          onClose={() => setCreateImageFor(undefined)}
          onBoardAssigned={(updated) => void store.mutate(() => Promise.resolve(updated))}
          navigate={navigate}
        />
      )}
      {storyboard && (
        <FramePickerDialog
          open={!!framePickerFor}
          sequenceId={storyboard.id}
          anyGeneration
          generationId={frameStart?.generationId}
          at={frameStart?.at}
          onClose={() => setFramePickerFor(undefined)}
          onPicked={(still) => {
            const boardId = framePickerFor
            setFramePickerFor(undefined)
            if (boardId) void setBoardImage(boardId, { kind: 'still', stillId: still.id })
          }}
        />
      )}
      {storyboard && (
        <StillViewer
          still={viewingStill?.still}
          stills={stills}
          deletable
          onClose={() => setViewingStill(undefined)}
          actions={(still) => {
            const number = viewingStill ? boardNumber(storyboard, viewingStill.boardId) : 0
            return (
              number > 0 && (
                <button
                  onClick={() => {
                    const boardId = viewingStill!.boardId
                    setViewingStill(undefined)
                    void setBoardImage(boardId, { kind: 'still', stillId: still.id })
                  }}
                  className="rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover"
                >
                  Use on board {number}
                </button>
              )
            )
          }}
        />
      )}
      {consent && storyboard && (
        <ConsentDialog
          request={consent.request}
          cost={`${
            consentTransition ? transitionLabel(storyboard, consentTransition).toLowerCase() : 'the transition'
          } · ${
            consent.count > 1
              ? `${variantsText(consent.count)} · ${formatUsd(variantsPrice(consentQuote, consent.count))}`
              : formatUsd(consentQuote)
          }`}
          onAccept={() => void acceptConsent()}
          onCancel={() => setConsent(undefined)}
        />
      )}
      {pendingChange && (
        <ConfirmDialog
          title={pendingChange.title}
          confirmLabel={pendingChange.confirmLabel}
          onConfirm={() => {
            setPendingChange(undefined)
            pendingChange.run()
          }}
          onCancel={() => setPendingChange(undefined)}
        >
          {pendingChange.text}
        </ConfirmDialog>
      )}
      {runConsentOpen && runConsent && (
        <ConsentDialog
          request={runConsent}
          cost={`Generate missing, ${clipCountLabel(plan?.toGenerate.length ?? 0)} · ${formatUsd(runQuote)}`}
          onAccept={() => void acceptRunConsent(runConsent, runConsentOpen)}
          onCancel={() => setRunConsentOpen(undefined)}
        />
      )}
    </div>
  )
}

/** Marks `seenKey` seen once its content has been on screen for a moment with the window focused (D4). */
function SeenWhenVisible({ seenKey, children }: { seenKey?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(ref, seenKey)
  return <div ref={ref}>{children}</div>
}

function EmptyState({
  creating,
  onCreate
}: {
  creating: boolean
  onCreate: (name: string, aspectRatio: string) => void
}) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <StoryboardIcon className="mx-auto mb-4 text-[30px] text-muted" />
          <h2 className="mb-2 text-base font-semibold">Plan the film image by image</h2>
          <p className="leading-relaxed text-muted">
            Lay out the film’s key moments as images – create them, or use images you already have. Studio then
            generates the clips between the images, so the film goes from one to the next.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-panel p-5">
          <CreateStoryboardForm creating={creating} onCreate={onCreate} />
        </div>
      </div>
    </div>
  )
}
