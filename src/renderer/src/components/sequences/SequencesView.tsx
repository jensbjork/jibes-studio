import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supportsEndImage } from '@shared/models'
import { songClipProblem } from '@shared/song-send'
import {
  workKey,
  type ConsentRequest,
  type FfmpegStatus,
  type FinishedWork,
  type Generation,
  type GenerationParams,
  type RunningWork,
  type Segment,
  type Sequence,
  type SongImportOptions
} from '@shared/types'
import { withBudgetConfirm } from '../../lib/budget'
import { ASSET_VIEW } from '../../lib/assets'
import { isModalOpen, isTextTarget } from '../../lib/dialogs'
import { focusedWithKeyboard, trackFocusOrigin } from '../../lib/focusOrigin'
import { ipcErrorMessage, NO_API_KEY, useDirectorAssets, useHasApiKey, useModels } from '../../lib/hooks'
import { LAST_SEQUENCE_KEY } from '../../lib/library'
import { formatUsd } from '../../lib/media'
import type { Intent, Navigate } from '../../lib/navigation'
import { FFMPEG_INSTALL, FILE_MANAGER, isMac } from '../../lib/platform'
import { markSeen, useRunning, useSeenWhenVisible, useUnseen } from '../../lib/work'
import ConsentDialog from '../ConsentDialog'
import GenerationPickerDialog from '../feed/GenerationPickerDialog'
import { useImportCards, useImportFlow, type ImportOutcome } from '../feed/ownClips'
import { SETTINGS_SECTION, showSettingsSection } from '../settings/SettingsLayout'
import { aspectValue } from '../storyboards/storyboardUtils'
import { isPlayable } from '../takes/takeText'
import TakeStrip, { type PickedBy, type TakeBadge } from '../takes/TakeStrip'
import { KEY_SELECT_DELAY, useTakeSelection } from '../takes/useTakeSelection'
import { Banner } from '../ui/Banner'
import { buttonClass } from '../ui/button'
import EmptyState from '../ui/EmptyState'
import { ownEndImageRefused, sendInputProblem } from './clipChecks'
import { FilmIcon } from './icons'
import PreviewPlayer from './PreviewPlayer'
import SegmentEditor, { type EditorHandle } from './SegmentEditor'
import type { CastPatch } from './CastPanel'
import SequenceHeader from './SequenceHeader'
import SequenceList from './SequenceList'
import SongImportDialog, { type SongImportMode } from './song/SongImportDialog'
import SongStrip from './song/SongStrip'
import { offsetText, placeOf } from './song/songText'
import Timeline, { type ClipSource } from './Timeline'
import TrimControls, { type PlayRequest, type TakePlayerHandle } from './TrimControls'
import {
  clipKey,
  continues,
  effectiveParams,
  isPending,
  isUntouchedClip,
  needsTake,
  parseConsent,
  pendingTake,
  isOwnTake,
  readyTake,
  selectedTake,
  sequenceAspect,
  takePromptsFor,
  totalLength
} from './sequenceUtils'
import type { FlushRegistry } from './useDraft'
import { useExportStatus } from './useExportStatus'
import { useSequence, useSequenceList } from './useSequence'
import { useTotalQuote } from './useTotalQuote'

function loadLastOpen(): string | undefined {
  try {
    return localStorage.getItem(LAST_SEQUENCE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

// Sequences used to have a Timeline / Storyboard switch remembered per sequence under these keys. Storyboards are
// their own view now; the leftovers are cleared once so they don't sit in the window's storage forever.
const RETIRED_KEYS = ['sequences:viewMode:v1', 'sequences:lastViewMode:v1']
let retiredKeysCleared = false
function clearRetiredKeys(): void {
  if (retiredKeysCleared) return
  retiredKeysCleared = true
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable; the keys are harmless.
  }
}

/** "Clip 2", "Clips 2 and 4", "Clips 1, 3 and 4". */
function clipList(numbers: number[]): string {
  if (numbers.length === 1) return `Clip ${numbers[0]}`
  return `Clips ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

/**
 * What "Generate missing" would pay for, one key per clip: what its take sends and the frames it starts or ends
 * on from its neighbours. Compared after the consent dialog, so accepting it can't pay for clips that changed
 * while the terms were shown.
 */
function runPlanKeys(sequence: Sequence): string[] {
  return sequence.segments.flatMap((s, i) => (!needsTake(s) || pendingTake(s) ? [] : [clipKey(sequence, i)]))
}

/** What a run that can't start is priced at: nothing (no quotes are asked for). */
const NO_RUN: GenerationParams[] = []

/** The first segment "Generate missing" would have to generate but can't, so it can be pointed out up front. */
function findRunProblem(sequence: Sequence, ffmpegOk: boolean): { segmentId: string; message: string } | undefined {
  for (const [i, s] of sequence.segments.entries()) {
    if (!needsTake(s) || pendingTake(s)) continue
    const continuing = continues(s, i)
    // The run waits for a neighbour that is generated in the same run, so only what can never work is checked here.
    const endFromNext = s.endFromNext && i < sequence.segments.length - 1
    const params = effectiveParams(s, i, sequence)
    // The prompt and its references as the take is sent (a continuation in reference mode with what it carries).
    const input = sendInputProblem(sequence, i)
    // An own film that went missing isn't a clip waiting for a prompt: say what happened to it (as main does).
    const chosen = selectedTake(s)
    if (isOwnTake(chosen) && chosen?.fileMissing && input) {
      return {
        segmentId: s.id,
        message: `Clip ${i + 1}'s own video is missing (moved or deleted in ${FILE_MANAGER}). Add the file again or generate an AI take.`
      }
    }
    // A song clip that can't hear its window of the song says so before its references do (after a missing prompt).
    const song = s.params.prompt.trim() ? songClipProblem(params, sequence.song)?.replace(/\.\s*$/, '') : undefined
    const reason =
      song ??
      input ??
      (continuing && !ffmpegOk ? 'ffmpeg is needed to continue from the previous clip' : undefined) ??
      (endFromNext && !ffmpegOk ? 'ffmpeg is needed to take the end image from the next clip' : undefined) ??
      (endFromNext && !supportsEndImage(params.model) ? "the model can't take an end image – pick another" : undefined) ??
      (ownEndImageRefused(params, endFromNext)
        ? "the model can't take an end image – pick another or remove the image"
        : undefined)
    if (reason) return { segmentId: s.id, message: `Clip ${i + 1}: ${reason}` }
  }
  return undefined
}

interface Notice {
  text: string
  /** Only shown while this sequence is open; global when unset. */
  sequenceId?: string
  /** Something worth knowing rather than a failure (e.g. a file imported before, used again). */
  info?: boolean
}

/** The song's dialog: for a new sequence, or another (or a first) song for the open one. */
interface SongImport {
  path: string
  mode: SongImportMode
  /** The sequence it goes on ('replace' / 'add'). */
  sequenceId?: string
}

/** "From Media…" / "From the Editor…": a clip picked from the library, to add after a clip (or at the end). */
interface PickRequest {
  source: Exclude<ClipSource, 'file'>
  afterSegmentId?: string
}

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

export default function SequencesView({ intent, onIntentHandled, navigate }: Props) {
  const { models, error: modelsError } = useModels()
  const { sequences, reload } = useSequenceList()
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    intent?.type === 'open-sequence' ? intent.sequenceId : loadLastOpen()
  )
  // Ids that failed to load or were deleted, so auto-selection doesn't pick them from a stale list.
  const gone = useRef(new Set<string>())

  const onMissing = useCallback(
    (id: string) => {
      gone.current.add(id)
      setSelectedId((cur) => (cur === id ? undefined : cur))
      // Not opened again next time (a remembered id of a sequence deleted elsewhere, or an old link to one).
      try {
        if (loadLastOpen() === id) localStorage.removeItem(LAST_SEQUENCE_KEY)
      } catch {
        // Ignore unavailable storage.
      }
      void reload()
    },
    [reload]
  )
  const store = useSequence(selectedId, onMissing)
  const { sequence } = store
  const sequenceId = sequence?.id

  // ── Activity for the open sequence (also what an agent or an earlier visit started) ────────────────────────
  const exportStatus = useExportStatus(sequenceId)
  const ownerUnseenFilter = useCallback((w: FinishedWork) => !!sequenceId && w.ownerId === sequenceId, [sequenceId])
  const ownerRunningFilter = useCallback((w: RunningWork) => !!sequenceId && w.ownerId === sequenceId, [sequenceId])
  const ownerUnseen = useUnseen(ownerUnseenFilter)
  const ownerRunning = useRunning(ownerRunningFilter)
  // A "Generate missing" run that stopped on a problem: main keeps its error with the sequence while the app runs,
  // and as a failure in Activity (also after a restart) until it has been seen.
  const runFailure = ownerUnseen
    .filter((w) => w.failureOf === 'run')
    .sort((a, b) => b.finishedAt - a.finishedAt)[0]
  const runWork = ownerRunning.find((w) => w.kind === 'run')

  const [segmentChoice, setSegmentChoice] = useState<Record<string, string>>({})
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>()
  const [notice, setNotice] = useState<Notice>()
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [focusNameFor, setFocusNameFor] = useState<string>()
  const [preview, setPreview] = useState<{ startSegmentId?: string }>()
  // A take shown in the player without being chosen (⌥-click), for the clip it belongs to.
  const [takePreview, setTakePreview] = useState<{ segmentId: string; takeId: string }>()
  // A click on a take plays it once the player has it (see TrimControls).
  const [playRequest, setPlayRequest] = useState<PlayRequest>()
  const playCount = useRef(0)
  // A take to focus in the strip (a link to it: Activity, an agent's open_in_studio).
  const [takeFocus, setTakeFocus] = useState<{ sequenceId: string; segmentId?: string; id: string; n: number }>()
  const focusCount = useRef(0)
  const player = useRef<TakePlayerHandle>(null)
  // Open with the clips the run would pay for when it was opened (see runPlanKeys).
  const [runConsentOpen, setRunConsentOpen] = useState<ReadonlySet<string>>()
  const [dismissedRunError, setDismissedRunError] = useState<string>()
  // The clip "Redo between neighbours" was just used on, so its editor says what to do next.
  const [bridgedId, setBridgedId] = useState<string>()
  const [picking, setPicking] = useState<PickRequest>()
  const [songImport, setSongImport] = useState<SongImport>()
  // Own films: inspected, asked about when there is something to decide, imported (cards show the progress).
  const importFlow = useImportFlow()
  const importCards = useImportCards()

  const flushers = useMemo<FlushRegistry>(() => new Set(), [])
  const editorHandle = useRef<EditorHandle | null>(null)
  const pickNewestFor = useRef<string | undefined>(undefined)
  const lastIndex = useRef<{ sequenceId?: string; index: number }>({ index: 0 })

  const ffmpegOk = ffmpeg?.ok !== false

  /** Saves every open draft (params, trims) so main acts on what's on screen. */
  const flushAll = useCallback(
    async () => (await Promise.all([...flushers].map((flush) => flush()))).every(Boolean),
    [flushers]
  )

  useEffect(clearRetiredKeys, [])

  // ── Selection ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (selectedId || !sequences) return
    const first = sequences.find((s) => !gone.current.has(s.id))
    if (first) setSelectedId(first.id)
  }, [selectedId, sequences])

  // Remembered once it has loaded: an id that turns out to be gone is never written back.
  useEffect(() => {
    try {
      if (sequenceId) localStorage.setItem(LAST_SEQUENCE_KEY, sequenceId)
    } catch {
      // Remembering the open sequence is only a convenience.
    }
  }, [sequenceId])

  useEffect(() => {
    if (intent?.type !== 'new-sequence-from-song') return
    onIntentHandled()
    void startFromSong()
  }, [intent])

  useEffect(() => {
    if (intent?.type !== 'open-sequence') return
    gone.current.delete(intent.sequenceId)
    const { sequenceId, segmentId, generationId } = intent
    if (segmentId) {
      // A given clip (an agent's open_in_studio, Activity): select it. One that no longer exists falls back
      // as usual.
      pickNewestFor.current = undefined
      setSegmentChoice((m) => ({ ...m, [sequenceId]: segmentId }))
    } else if (!generationId) {
      // Opened from "Add to sequence": show the clip that was just added.
      pickNewestFor.current = sequenceId
    }
    // A given take is focused in the strip – never chosen, and never counted as seen by being shown this way (D4):
    // only playing it or clicking it is looking at it, whoever opened the place (a link, or an agent: source 'agent').
    if (generationId) setTakeFocus({ sequenceId, segmentId, id: generationId, n: ++focusCount.current })
    setSelectedId(sequenceId)
    onIntentHandled()
  }, [intent])

  const chosenId = sequenceId ? segmentChoice[sequenceId] : undefined
  const segmentIndex = sequence ? sequence.segments.findIndex((s) => s.id === chosenId) : -1
  const segment: Segment | undefined = sequence && segmentIndex !== -1 ? sequence.segments[segmentIndex] : undefined

  // The chosen take as the strip shows it (optimistic). Before main hears of another take, the trims being edited
  // are saved: they belong to the take before, and main remembers them with it (take_trims).
  const commitTake = useCallback(
    async (segmentId: string, takeId: string) => {
      await flushAll()
      await store.patchSegment(segmentId, { selectedGenerationId: takeId })
    },
    [flushAll, store.patchSegment]
  )
  const selection = useTakeSelection(segment?.id, segment?.selectedGenerationId, commitTake)

  const selectSegment = useCallback(
    (id: string) => {
      if (sequenceId) setSegmentChoice((m) => ({ ...m, [sequenceId]: id }))
    },
    [sequenceId]
  )

  // Keep a valid segment selected: the newest after an intent, a neighbour after a delete, else the first.
  useEffect(() => {
    if (!sequence) return
    const segments = sequence.segments
    if (pickNewestFor.current === sequence.id) {
      pickNewestFor.current = undefined
      const newest = segments.reduce<Segment | undefined>((a, s) => (!a || s.createdAt >= a.createdAt ? s : a), undefined)
      if (newest) {
        setSegmentChoice((m) => ({ ...m, [sequence.id]: newest.id }))
        return
      }
    }
    if (segmentIndex !== -1) {
      lastIndex.current = { sequenceId: sequence.id, index: segmentIndex }
      return
    }
    if (!segments.length) return
    const i = lastIndex.current.sequenceId === sequence.id ? Math.min(lastIndex.current.index, segments.length - 1) : 0
    setSegmentChoice((m) => ({ ...m, [sequence.id]: segments[i].id }))
  }, [sequence, segmentIndex])

  // A take to focus that came without its clip: open the clip it is a take of, once the sequence has loaded.
  useEffect(() => {
    if (!sequence || !takeFocus || takeFocus.segmentId || takeFocus.sequenceId !== sequence.id) return
    const owner = sequence.segments.find((s) => s.takes.some((t) => t.id === takeFocus.id))
    if (!owner) return
    setTakeFocus({ ...takeFocus, segmentId: owner.id })
    setSegmentChoice((m) => ({ ...m, [sequence.id]: owner.id }))
  }, [sequence, takeFocus])

  // The focus request is for one visit: once another clip is opened, coming back doesn't move the focus again.
  useEffect(() => {
    if (!takeFocus?.segmentId || sequence?.id !== takeFocus.sequenceId || !segment) return
    if (segment.id !== takeFocus.segmentId) setTakeFocus(undefined)
  }, [segment?.id, sequence?.id, takeFocus])

  // ── Live state from main ───────────────────────────────────────────────────

  useEffect(() => {
    window.studio.ffmpegStatus().then(setFfmpeg, (e: unknown) => setFfmpeg({ ok: false, message: ipcErrorMessage(e) }))
  }, [])

  useEffect(() => {
    if (!sequence?.running) setStopping(false)
  }, [sequence?.running])

  // ── Sequence actions ───────────────────────────────────────────────────────

  const createSequence = async () => {
    setCreating(true)
    setNotice(undefined)
    try {
      const created = await window.studio.createSequence('')
      // Start with one empty clip so the editor is ready right away.
      await window.studio.addSegment(created.id).catch(() => undefined)
      gone.current.delete(created.id)
      setFocusNameFor(created.id)
      setSelectedId(created.id)
      void reload()
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e) })
    } finally {
      setCreating(false)
    }
  }

  // ── Songs ──────────────────────────────────────────────────────────────────

  /** An audio file from the file dialog; undefined when it was cancelled (or failed, which is said). */
  const pickSongFile = async (): Promise<string | undefined> => {
    try {
      return (await window.studio.pickAudio(false))[0]
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e) })
      return undefined
    }
  }

  /** "New sequence from a song…" (the list's menu, ⌘K, a song dropped on the list). */
  const startFromSong = async (path?: string) => {
    const file = path ?? (await pickSongFile())
    if (file) setSongImport({ path: file, mode: { kind: 'create' } })
  }

  /** "Replace the song…" (the header's Song) and "Add a song…" (⋯) on the open sequence. */
  const pickSong = async () => {
    if (!sequence) return
    const file = await pickSongFile()
    if (!file) return
    // Clips nobody has done anything with yet (a new sequence's empty Clip 1, a song's places still empty) don't
    // count: while there are only such clips, main splits the song afresh (at the length chosen in the dialog).
    const kept = sequence.segments.filter((s) => !isUntouchedClip(s, sequence.cast)).length
    setSongImport({
      path: file,
      sequenceId: sequence.id,
      mode: { kind: sequence.song ? 'replace' : 'add', sequenceName: sequence.name, clipCount: kept }
    })
  }

  /**
   * The dialog's choices: a new sequence opens at once (the vocals, lyrics and clips follow in its song strip), or the
   * song goes on the open one. Transcribing is paid, so past the budget the user is asked first; false when they said
   * no (the dialog stays).
   */
  const importSong = async (request: SongImport, opts: SongImportOptions): Promise<boolean> => {
    const confirmed = (yes: boolean): SongImportOptions => (yes ? { ...opts, confirmOverBudget: true } : opts)
    if (request.mode.kind === 'create') {
      const created = await withBudgetConfirm((yes) => window.studio.createSequenceFromSong(request.path, confirmed(yes)))
      if (!created) return false
      gone.current.delete(created.id)
      setSelectedId(created.id)
      setSongImport(undefined)
      void reload()
      return true
    }
    const id = request.sequenceId
    if (!id) return false
    if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
    const updated = await withBudgetConfirm((yes) =>
      store.mutate(() => window.studio.setSequenceSong(id, request.path, confirmed(yes)))
    )
    if (!updated) return false
    setSongImport(undefined)
    return true
  }

  /** "Remove the song": the clips stay, as ordinary clips; rejects with main's refusal (shown in the Song panel). */
  const removeSong = async () => {
    if (!sequenceId) return
    if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
    await store.mutate(() => window.studio.setSequenceSong(sequenceId, null))
  }

  /** The list's ✕ (after its question in the row) and ⋯ → Delete sequence…; throws, so the row can show the error. */
  const removeSequence = async (id: string, nextId?: string) => {
    // Let go of it first: main announces the change before it answers, and the open sequence would otherwise be
    // fetched again in between and found gone ("The sequence no longer exists" in the log on every delete). The open
    // one gives way to its neighbour in the list.
    const wasOpen = id === selectedId
    const rest = (sequences ?? []).filter((s) => s.id === id || !gone.current.has(s.id))
    const at = rest.findIndex((s) => s.id === id)
    const neighbor = nextId ?? (at === -1 ? undefined : (rest[at + 1] ?? rest[at - 1])?.id)
    gone.current.add(id)
    if (wasOpen) setSelectedId(neighbor)
    try {
      await window.studio.deleteSequence(id)
      try {
        if (loadLastOpen() === id) localStorage.removeItem(LAST_SEQUENCE_KEY)
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

  const deleteSequence = (id: string) =>
    removeSequence(id).catch((e: unknown) => setNotice({ text: ipcErrorMessage(e) }))

  /**
   * A change to the cast: the clip editor's edits are saved first, since main rewrites the clips that follow the cast
   * in the same step. A refusal goes back to the Cast panel, which shows it.
   */
  const changeCast = async (patch: CastPatch): Promise<void> => {
    if (!sequenceId) return
    if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
    await store.mutate(() => window.studio.updateSequence(sequenceId, patch))
  }

  /** The sequence's director (null: none): the clip editor's edits first, as for the cast. */
  const changeDirector = async (director: string | null): Promise<void> => {
    if (!sequenceId) return
    if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
    await store.mutate(() => window.studio.updateSequence(sequenceId, { director }))
  }

  const rename = (name: string) => {
    if (!sequenceId) return
    store.update((s) => ({ ...s, name }))
    store.mutate(() => window.studio.updateSequence(sequenceId, { name })).catch((e: unknown) => {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
      store.refresh()
    })
  }

  /** `expected`: only start when every clip it would pay for is among these (see runPlanKeys). */
  const startRun = async (expected?: ReadonlySet<string>) => {
    if (!sequenceId) return
    setNotice(undefined)
    if (!(await flushAll())) {
      setNotice({ text: "The changes couldn't be saved. Try again.", sequenceId })
      return
    }
    let fresh: Sequence
    try {
      fresh = await store.mutate(() => window.studio.getSequence(sequenceId))
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
      return
    }
    const problem = findRunProblem(fresh, ffmpegOk)
    if (problem) {
      setSegmentChoice((m) => ({ ...m, [sequenceId]: problem.segmentId }))
      setNotice({ text: problem.message, sequenceId })
      return
    }
    if (expected && runPlanKeys(fresh).some((k) => !expected.has(k))) {
      setNotice({
        text: 'The clips changed while the terms were shown. Check them and press “Generate missing” again – the button shows the price.',
        sequenceId
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
        window.studio.generateAllSegments(sequenceId, confirmed ? { confirmOverBudget: true } : undefined)
      )
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
    }
    store.refresh()
  }
  const generateAll = () => startRun()

  const stopAll = async () => {
    if (!sequenceId) return
    setStopping(true)
    try {
      await window.studio.stopGenerateAll(sequenceId)
    } catch (e) {
      setStopping(false)
      setNotice({ text: ipcErrorMessage(e), sequenceId })
    }
  }

  const acceptRunConsent = async (request: ConsentRequest, plan: ReadonlySet<string>) => {
    setRunConsentOpen(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
      return
    }
    // Exactly what the dialog was opened for; anything changed since goes back to the button with the price.
    await startRun(plan)
  }

  const exportSequence = async () => {
    if (!sequenceId) return
    if (!(await flushAll())) {
      setNotice({ text: "The changes couldn't be saved. Try again.", sequenceId })
      return
    }
    await exportStatus.run(() => window.studio.exportSequence(sequenceId))
  }

  const openPreview = async (startSegmentId?: string) => {
    await flushAll()
    setPreview({ startSegmentId })
  }

  // ── Segment and take actions ───────────────────────────────────────────────

  const addSegment = async (afterSegmentId?: string) => {
    if (!sequence) return
    const id = sequence.id
    const before = new Set(sequence.segments.map((s) => s.id))
    setAdding(true)
    try {
      // A new segment copies the previous one's settings, so save edits first.
      await flushAll()
      const updated = await store.mutate(() =>
        window.studio.addSegment(id, afterSegmentId ? { afterSegmentId } : undefined)
      )
      const added = updated.segments.find((s) => !before.has(s.id))
      if (added) setSegmentChoice((m) => ({ ...m, [id]: added.id }))
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId: id })
    } finally {
      setAdding(false)
    }
  }

  /** Says what an import of own clips came to: what failed (an error) and what was reused (a note). */
  const reportImport = (outcome: ImportOutcome, id: string) => {
    if (outcome.errors.length) setNotice({ text: outcome.errors.join('\n'), sequenceId: id })
    else if (outcome.notes.length) setNotice({ text: outcome.notes.join('\n'), sequenceId: id, info: true })
  }

  /**
   * Own films into the sequence, one clip per file in name order, after `afterSegmentId` (default: at the end). With
   * `toStart` they go first: main adds them at the end, and they are moved to the front in order.
   */
  const importClips = async (paths: string[], afterSegmentId?: string, toStart = false) => {
    if (!sequence || !paths.length) return
    const id = sequence.id
    setNotice(undefined)
    // A new clip takes the previous clip's settings as its template, so save edits first.
    await flushAll()
    // A sequence with nothing in it yet (the empty Clip 1 of a new sequence): the films take the empty clip's place,
    // and there is no shape to ask about – the first film gives the sequence its shape.
    // Not in a sequence cut to a song: its empty clips are the song's places, waiting for their prompts.
    const placeholders =
      !sequence.song && sequence.segments.every((s) => isUntouchedClip(s, sequence.cast))
        ? sequence.segments.map((s) => s.id)
        : []
    const outcome = await importFlow.begin(
      paths,
      { kind: 'sequence', sequenceId: id, afterSegmentId },
      { sequenceAspect: placeholders.length ? undefined : sequenceAspect(sequence) }
    )
    reportImport(outcome, id)
    const added = outcome.result?.segmentIds ?? []
    try {
      if (toStart) {
        for (const [i, segmentId] of added.entries()) await store.mutate(() => window.studio.moveSegment(segmentId, i))
      }
      if (added.length && placeholders.length) {
        // The import may have taken minutes: what the clip editor holds is saved first, and main deletes the empty
        // clip only if nothing has been put in it meanwhile (by the user or an agent).
        await flushAll()
        const present = new Set((await window.studio.getSequence(id)).segments.map((s) => s.id))
        for (const segmentId of placeholders.filter((x) => present.has(x))) {
          await store.mutate(() => window.studio.deleteSegment(segmentId, { onlyIfUntouched: true }))
        }
      }
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId: id })
    }
    if (added.length) setSegmentChoice((m) => ({ ...m, [id]: added[0] }))
    store.refresh()
  }

  /** Own films dropped on the timeline at gap `gap` (before clip `gap`). */
  const dropFiles = (paths: string[], gap: number) => {
    if (!sequence) return
    const segments = sequence.segments
    const after = gap > 0 ? segments[Math.min(gap, segments.length) - 1]?.id : undefined
    // A song's clips keep the song's order (main refuses moves): there the films go after the clip they were dropped
    // behind, or after the first.
    if (sequence.song) void importClips(paths, after ?? segments[0]?.id)
    else void importClips(paths, after, gap === 0 && segments.length > 0)
  }

  const addFrom = async (source: ClipSource, afterSegmentId?: string) => {
    if (!sequence) return
    if (source !== 'file') {
      setPicking({ source, afterSegmentId })
      return
    }
    try {
      const paths = await window.studio.pickVideos(true)
      if (paths.length) await importClips(paths, afterSegmentId)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId: sequence.id })
    }
  }

  /** A clip picked from the feed or the Editor becomes a new clip (its selected take), after the chosen one. */
  const addPicked = async (generationId: string, request: PickRequest) => {
    setPicking(undefined)
    if (!sequence) return
    const id = sequence.id
    const before = new Set(sequence.segments.map((s) => s.id))
    setAdding(true)
    try {
      await flushAll()
      const updated = await store.mutate(() =>
        window.studio.addSegment(id, {
          fromGenerationId: generationId,
          ...(request.afterSegmentId ? { afterSegmentId: request.afterSegmentId } : {})
        })
      )
      const added = updated.segments.find((s) => !before.has(s.id))
      if (added) setSegmentChoice((m) => ({ ...m, [id]: added.id }))
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId: id })
    } finally {
      setAdding(false)
    }
  }

  /** Own films as takes of the open clip (the last one selected). */
  const importTakes = async (paths: string[]) => {
    if (!sequence || !segment || !paths.length) return
    const id = sequence.id
    setNotice(undefined)
    const outcome = await importFlow.begin(
      paths,
      { kind: 'segment', segmentId: segment.id },
      { sequenceAspect: sequenceAspect(sequence) }
    )
    reportImport(outcome, id)
    store.refresh()
  }

  /** "Export format": the film's height, or null for Automatic (the first clip's own size). */
  const setExportHeight = (exportHeight: number | null) => {
    if (!sequenceId) return
    store.update((s) => ({ ...s, exportHeight }))
    store.mutate(() => window.studio.updateSequence(sequenceId, { exportHeight })).catch((e: unknown) => {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
      store.refresh()
    })
  }

  const moveSegment = (id: string, toIndex: number) => {
    store.moveSegment(id, toIndex).catch((e: unknown) => setNotice({ text: ipcErrorMessage(e), sequenceId }))
  }

  // ── The take in use: a click chooses it and plays it, the keyboard chooses without playing ────────────────

  const requestPlay = (takeId: string) => setPlayRequest({ takeId, n: ++playCount.current })

  const chooseTake = (take: Generation, by: PickedBy) => {
    if (!segment) return
    setTakePreview(undefined)
    if (take.id === selection.activeId) {
      // The chosen one again: a click starts it over from where it starts in the sequence; an arrow only leaves a
      // preview.
      if (by === 'click') requestPlay(take.id)
      return
    }
    selection.choose(take.id, by === 'click' ? 0 : KEY_SELECT_DELAY).then(
      () => {
        if (by === 'click') requestPlay(take.id)
      },
      (e: unknown) => setNotice({ text: ipcErrorMessage(e), sequenceId })
    )
  }

  const previewTake = (take: Generation, by: PickedBy) => {
    if (!segment) return
    if (take.id === selection.activeId) {
      setTakePreview(undefined)
      return
    }
    setTakePreview({ segmentId: segment.id, takeId: take.id })
    if (by === 'click') requestPlay(take.id)
  }

  /** "Use this take" under a previewed take: it becomes the clip's take (already watched, so it isn't started over). */
  const choosePreviewed = (take: Generation) => {
    setTakePreview(undefined)
    markSeen([workKey.generation(take.id)])
    selection.choose(take.id, 0).catch((e: unknown) => setNotice({ text: ipcErrorMessage(e), sequenceId }))
  }

  const deleteTake = async (take: Generation) => {
    setTakePreview((p) => (p?.takeId === take.id ? undefined : p))
    store.update((s) => ({
      ...s,
      segments: s.segments.map((seg) => ({
        ...seg,
        takes: seg.takes.filter((t) => t.id !== take.id),
        selectedGenerationId: seg.selectedGenerationId === take.id ? undefined : seg.selectedGenerationId
      }))
    }))
    try {
      // A version or an edit's original is only taken off this clip (the Editor keeps it): what the list's "Remove"
      // said (release), and what main does for anything the Editor keeps by now.
      const segmentId = segment?.id ?? take.segmentId
      await window.studio.deleteGeneration(
        take.id,
        segmentId ? { segmentId, release: take.keptByEdit === true } : undefined
      )
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
    }
    store.refresh()
  }

  const reusePrompt = (take: Generation) => editorHandle.current?.applyPrompt(take.params)

  /** "From file…" above the take strip. */
  const pickTakeFiles = async () => {
    try {
      const paths = await window.studio.pickVideos(true)
      if (paths.length) await importTakes(paths)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
    }
  }

  /**
   * "Redo between neighbours": main sets the clip to start on the previous clip's last frame and end on the next
   * clip's first frame with a model that takes both (free). The editor then shows the frames and the price;
   * generating is the user's own click.
   */
  const bridge = async (segmentId: string) => {
    if (!sequenceId) return
    setNotice(undefined)
    if (!(await flushAll())) {
      setNotice({ text: "The changes couldn't be saved. Try again.", sequenceId })
      return
    }
    try {
      await store.mutate(() => window.studio.bridgeSegment(segmentId))
      // The editor beside the timeline then shows the frames and the price.
      setSegmentChoice((m) => ({ ...m, [sequenceId]: segmentId }))
      setBridgedId(segmentId)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  // Priced as sent: a director's style videos raise the price (its own, or the library's as they change).
  const directors = useDirectorAssets()
  const runPlan = useMemo(() => {
    const toGenerate: GenerationParams[] = []
    let generating = 0
    sequence?.segments.forEach((s, i) => {
      if (!needsTake(s)) return
      if (pendingTake(s)) generating++
      else toGenerate.push(effectiveParams(s, i, sequence, directors))
    })
    return { toGenerate, generating }
  }, [sequence, directors])
  // What stands in the way of "Generate missing", checked up front as Storyboards does: the API key first, then the
  // first clip that can't be generated. A run that can't start is neither priced nor in the accent colour, and a
  // click shows the clip (startRun checks again with fresh data) or opens Settings for the key.
  const hasKey = useHasApiKey()
  const runBlocked = useMemo(() => {
    if (!hasKey) return NO_API_KEY
    if (!sequence || sequence.running) return undefined
    return findRunProblem(sequence, ffmpegOk)?.message.replace(/\.\s*$/, '')
  }, [hasKey, sequence, ffmpegOk])
  const runQuote = useTotalQuote(runBlocked ? NO_RUN : runPlan.toGenerate)

  /** Where a missing key is added: Settings → Service. */
  const openServiceSettings = () => {
    showSettingsSection(SETTINGS_SECTION.service)
    navigate('settings')
  }

  const notReady = sequence ? sequence.segments.flatMap((s, i) => (readyTake(s) ? [] : [i + 1])) : []
  const readyCount = (sequence?.segments.length ?? 0) - notReady.length
  const exportBlocked = !ffmpegOk
    ? `ffmpeg is missing – ${isMac ? 'install it with ' : ''}${FFMPEG_INSTALL}`
    : !sequence?.segments.length
      ? 'Add clips first'
      : notReady.length
        ? notReady.length === 1
          ? `${clipList(notReady)} has no finished selected take`
          : `${clipList(notReady)} have no finished selected takes`
        : undefined
  const previewDisabled = readyCount === 0 ? 'No clip has a finished selected take yet' : undefined

  // While the app runs, main keeps the run's error with the sequence; after a restart only Activity has it.
  const runError = sequence?.runError ?? runFailure?.error
  const runConsent = parseConsent(runError)
  // Run errors are prefixed "Clip N: …" ("Klipp N: …" in failures saved before the app was in English); offer a jump
  // to that clip.
  const runErrorClip = Number(/^(?:Clip|Klipp) (\d+)/.exec(runError ?? '')?.[1])
  const runErrorSegment = runErrorClip ? sequence?.segments[runErrorClip - 1] : undefined
  const visibleNotice = notice && (!notice.sequenceId || notice.sequenceId === sequenceId) ? notice : undefined
  // The right pane shows the take chosen in the strip, also before main has confirmed it.
  const shownSegment = useMemo(
    () => (segment ? { ...segment, selectedGenerationId: selection.activeId } : undefined),
    [segment, selection.activeId]
  )
  const ready = shownSegment && readyTake(shownSegment)
  const hintText = shownSegment && !ready ? selectionHintText(shownSegment) : undefined
  const previewed =
    segment && takePreview?.segmentId === segment.id
      ? segment.takes.find((t) => t.id === takePreview.takeId && isPlayable(t))
      : undefined
  // A clip of a sequence cut to a song: the cut keeps its place's length of the take, from where its singing starts.
  const songPlace = sequence?.song && segment ? placeOf(segment) : undefined
  const readySync = songPlace && ready ? segment?.songSyncs?.[ready.id] : undefined
  const trimSong = songPlace
    ? {
        length: songPlace.end - songPlace.start,
        syncOffset: readySync?.measured === 'vocals' && readySync.matched ? readySync.offset : undefined
      }
    : undefined
  /** In the take strip: whether each take of a singing clip sings in step with the song. */
  const syncBadge = (take: Generation): TakeBadge | undefined => {
    const sync = songPlace && segment?.songSyncs?.[take.id]
    if (!sync || sync.measured !== 'vocals') return undefined
    return sync.matched
      ? { text: offsetText(sync.offset), tone: 'good', title: `In sync with the song (${offsetText(sync.offset)})` }
      : { text: 'No singing', tone: 'warning', title: 'No singing found – check the lips' }
  }
  const nextSegment = sequence && segmentIndex !== -1 ? sequence.segments[segmentIndex + 1] : undefined
  const previousSegment = sequence && segmentIndex > 0 ? sequence.segments[segmentIndex - 1] : undefined

  // The bridge note belongs to the clip it was given for, until another clip is opened.
  useEffect(() => {
    if (bridgedId && segment?.id !== bridgedId) setBridgedId(undefined)
  }, [segment?.id, bridgedId])

  // The player's keys anywhere in the view, as in the Editor: Space plays and pauses the clip, I and O set where it
  // starts and ends at the playhead. Left alone: a key something else handled (a take tile, a clip card, the song
  // strip), with a modifier, in a field, menu, dialog or open question, on the native player (Space is its own), on
  // a button or disclosure reached with the keyboard (Space presses it), and while the preview – it has keys of its
  // own – or a dialog is open.
  useEffect(() => {
    if (preview) return
    trackFocusOrigin()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const key = e.key === ' ' ? 'Space' : e.key.toLowerCase()
      if (key !== 'Space' && key !== 'i' && key !== 'o') return
      const target = e.target
      if (isTextTarget(target) || isModalOpen()) return
      if (target instanceof Element) {
        if (target.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [data-confirm], video')) return
        const pressable = target.closest('button, a[href], summary, [role="button"], [role="tab"]')
        if (pressable && focusedWithKeyboard(target)) return
      }
      const handle = player.current
      if (!handle) return
      e.preventDefault()
      if (key === 'Space') handle.toggle()
      else if (key === 'i') handle.markIn()
      else handle.markOut()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [preview])

  const editor =
    segment &&
    sequence && (
      <SegmentEditor
        key={segment.id}
        sequence={sequence}
        segment={segment}
        index={segmentIndex}
        models={models}
        modelsError={modelsError}
        ffmpegOk={ffmpegOk}
        store={store}
        flushers={flushers}
        handleRef={editorHandle}
        navigate={navigate}
        onPreviewFrom={(id) => void openPreview(id)}
        onBridge={bridge}
        justBridged={bridgedId === segment.id}
      />
    )
  const sequenceImports = sequenceId
    ? importCards.filter((c) => c.target === 'sequence' && c.sequenceId === sequenceId)
    : []
  const takeImports = segment ? importCards.filter((c) => c.target === 'segment' && c.segmentId === segment.id) : []

  const strip = segment && sequence && (
    <TakeStrip
      key={segment.id}
      owner="sequence"
      takes={segment.takes}
      activeId={selection.activeId}
      previewId={previewed?.id}
      focusRequest={takeFocus && takeFocus.segmentId === segment.id ? takeFocus : undefined}
      aspect={aspectValue(sequenceAspect(sequence))}
      models={models}
      // main chooses a finished take by itself only while the clip has no usable chosen take (autoSelect).
      autoSelects={autoSelects(segment)}
      importing={takeImports}
      // Read with the clip's references now: a take whose prompt differs only by a reorder's renumbering has
      // nothing to bring back.
      promptDiffers={(take) =>
        takePromptsFor(take.params, segment.params).prompt.trim() !== segment.params.prompt.trim()
      }
      badge={songPlace ? syncBadge : undefined}
      onChoose={chooseTake}
      onPreview={previewTake}
      onLeavePreview={() => setTakePreview(undefined)}
      onTogglePlay={() => player.current?.toggle()}
      onPlayFromStart={() => player.current?.playFromStart()}
      onDelete={(take) => void deleteTake(take)}
      onUsePrompt={reusePrompt}
      onEdit={(take) => navigate('editor', { type: 'open-editor', generationId: take.id })}
      onImport={(paths) => void importTakes(paths)}
      onPickFile={() => void pickTakeFiles()}
    />
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  const banners = (
    <>
      {ffmpeg && !ffmpeg.ok && (
        <Banner tone="warning">
          <span className="font-medium">ffmpeg is missing</span> – export and “Start on the previous clip's last
          frame” are turned off.{' '}
          {/* The status message usually says how to install already; don't repeat it. */}
          {ffmpeg.message && !ffmpeg.message.includes('brew install') && (
            <span className="opacity-80">{ffmpeg.message} </span>
          )}
          {/* On Windows ffmpeg comes with Studio, and the message says how to get it back. */}
          {isMac && (
            <>
              Install it with <code className="rounded bg-black/30 px-1 py-px font-mono">brew install ffmpeg</code>{' '}
              and restart Studio.
            </>
          )}
        </Banner>
      )}
      {visibleNotice && (
        <Banner tone={visibleNotice.info ? 'info' : 'error'} onDismiss={() => setNotice(undefined)}>
          <span className="whitespace-pre-line">{visibleNotice.text}</span>
        </Banner>
      )}
      {importFlow.inspecting && <Banner tone="info">Reading the files…</Banner>}
      {runError && runError !== dismissedRunError && !sequence?.running && (
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
                Generate missing stopped: the model needs you to accept the provider's terms.
                <button
                  type="button"
                  onClick={() => sequence && setRunConsentOpen(new Set(runPlanKeys(sequence)))}
                  className={buttonClass('primary', 'inline')}
                >
                  Review and continue
                </button>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Generate missing stopped – {runError}</span>
                {runErrorSegment && runErrorSegment.id !== segment?.id && (
                  <button
                    onClick={() => selectSegment(runErrorSegment.id)}
                    className="rounded border border-accent/40 px-2 py-0.5 font-medium hover:bg-accent/10"
                  >
                    Show clip {runErrorClip}
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
                title="Change the finished film with AI in the Editor. The sequence isn't touched."
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
      <SequenceList
        sequences={sequences}
        selectedId={selectedId}
        creating={creating}
        onSelect={(id) => {
          gone.current.delete(id)
          setSelectedId(id)
        }}
        onCreate={() => void createSequence()}
        onCreateFromSong={() => void startFromSong()}
        onDropSong={(path) => void startFromSong(path)}
        onDropProblem={(text) => setNotice({ text, info: true })}
        onDelete={removeSequence}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {sequence ? (
          <>
            <SequenceHeader
              key={sequence.id}
              sequence={sequence}
              totalSeconds={sequence.song?.duration ?? totalLength(sequence)}
              readyCount={readyCount}
              toGenerate={runPlan.toGenerate.length}
              generating={runPlan.generating}
              runBlocked={runBlocked}
              runQuote={runQuote}
              stopping={stopping}
              previewDisabled={previewDisabled}
              runDetail={runWork?.detail}
              exportProgress={exportStatus.progress}
              exportBlocked={exportBlocked}
              autoFocusName={focusNameFor === sequence.id}
              onAutoFocused={() => setFocusNameFor(undefined)}
              onRename={rename}
              onGenerateAll={() => (hasKey ? void generateAll() : openServiceSettings())}
              onStop={() => void stopAll()}
              // A song plays from its start, whatever clips have takes yet; otherwise from the first clip with one.
              onPreview={() => void openPreview(sequence.song ? undefined : sequence.segments.find((s) => readyTake(s))?.id)}
              onExport={() => void exportSequence()}
              onExportHeight={setExportHeight}
              onEditExport={(exportId) => navigate('editor', { type: 'open-editor', exportId })}
              onError={(text) => setNotice({ text, sequenceId: sequence.id })}
              onDelete={() => void deleteSequence(sequence.id)}
              onCastChange={changeCast}
              onManageAssets={(kind) => navigate(ASSET_VIEW[kind])}
              onDirectorChange={changeDirector}
              onOpenDirector={(id) => navigate('directors', id ? { type: 'open-asset', assetId: id } : undefined)}
              onPickSong={() => void pickSong()}
              onRemoveSong={removeSong}
              onSeparateSong={() => store.mutate(() => window.studio.separateSongVocals(sequence.id))}
              onTranscribeSong={(opts) => store.mutate(() => window.studio.transcribeSong(sequence.id, opts))}
            />
            {banners}
            {sequence.song && (
              <SongStrip
                key={`song:${sequence.id}`}
                sequence={sequence}
                selectedId={segment?.id}
                onSelect={selectSegment}
                store={store}
                flushAll={flushAll}
              />
            )}
            <Timeline
              sequence={sequence}
              selectedId={segment?.id}
              adding={adding}
              onSelect={selectSegment}
              onAdd={(after) => void addSegment(after)}
              onAddFrom={(source, after) => void addFrom(source, after)}
              onDropFiles={dropFiles}
              importing={sequenceImports}
              unseen={ownerUnseen}
              running={ownerRunning}
              onMove={moveSegment}
            />

            {segment && shownSegment ? (
              <div className="flex min-h-0 flex-1">
                {/* Narrower in a narrow window, where the sequence list beside it leaves the player little room. */}
                <section className="flex w-[320px] shrink-0 flex-col border-r border-line @min-[75rem]/main:w-[360px]">
                  {editor}
                </section>
                <section
                  className="min-w-0 flex-1 overflow-y-auto"
                  onKeyDown={(e) => {
                    // Esc anywhere in the player's pane goes back from a preview to the chosen take.
                    if (e.key !== 'Escape' || !previewed || e.defaultPrevented) return
                    e.preventDefault()
                    setTakePreview(undefined)
                  }}
                >
                  <div className="mx-auto max-w-4xl space-y-8 p-5">
                    <TrimControls
                      key={segment.id}
                      segment={shownSegment}
                      take={ready}
                      preview={previewed}
                      hint={hintText && <SelectionHint text={hintText} />}
                      number={segmentIndex + 1}
                      nextContinues={!!nextSegment?.continueFromPrevious}
                      previousEndsHere={!!previousSegment?.endFromNext}
                      patchSegment={store.patchSegment}
                      flushers={flushers}
                      selecting={selection.pending}
                      song={trimSong}
                      playRequest={playRequest}
                      playerRef={player}
                      onChoosePreview={() => previewed && choosePreviewed(previewed)}
                      onLeavePreview={() => setTakePreview(undefined)}
                    >
                      {strip}
                    </TrimControls>
                  </div>
                </section>
              </div>
            ) : (
              sequence.segments.length === 0 && (
                <div className="flex flex-1 items-center justify-center p-8">
                  {sequence.song ? (
                    <p className="max-w-sm text-center leading-relaxed text-muted">
                      While the song is being prepared, set the <span className="text-text">Cast</span> – the singer,
                      the outfit, the stage: every clip of the song starts with it.
                    </p>
                  ) : (
                    <p className="max-w-sm text-center leading-relaxed text-muted">
                      Add a first clip above. Each clip is a generation of its own – or a film of your own – and the
                      next clip can continue from the last frame of the one before, so the transition is seamless.
                    </p>
                  )}
                </div>
              )
            )}
          </>
        ) : (
          <>
            <div className="drag h-12 shrink-0" />
            {visibleNotice && (
              <Banner tone="error" onDismiss={() => setNotice(undefined)}>
                {visibleNotice.text}
              </Banner>
            )}
            {sequences?.length === 0 && !selectedId ? (
              <SequencesEmptyState creating={creating} onCreate={() => void createSequence()} navigate={navigate} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted">
                {selectedId && !store.error ? 'Loading sequence…' : ''}
              </div>
            )}
          </>
        )}
      </div>

      {preview && sequence && (
        <PreviewPlayer sequence={sequence} startSegmentId={preview.startSegmentId} onClose={() => setPreview(undefined)} />
      )}
      {importFlow.dialog}
      {songImport && (
        <SongImportDialog
          key={songImport.path}
          path={songImport.path}
          mode={songImport.mode}
          onCancel={() => setSongImport(undefined)}
          onSubmit={(opts) => importSong(songImport, opts)}
        />
      )}
      <GenerationPickerDialog
        open={!!picking}
        title={picking?.source === 'edit' ? 'Add a version from the Editor' : 'Add a clip from Media'}
        sources={picking?.source === 'edit' ? ['edit'] : ['generated', 'import', 'edit']}
        onClose={() => setPicking(undefined)}
        onPicked={(g) => picking && void addPicked(g.id, picking)}
      />
      {runConsentOpen && runConsent && (
        <ConsentDialog
          request={runConsent}
          cost={`Generate missing, ${runPlan.toGenerate.length} ${runPlan.toGenerate.length === 1 ? 'clip' : 'clips'} · ${formatUsd(runQuote)}`}
          onAccept={() => void acceptRunConsent(runConsent, runConsentOpen)}
          onCancel={() => setRunConsentOpen(undefined)}
        />
      )}
    </div>
  )
}

/** Whether main will choose a take of the clip by itself when it is done: only while none usable is chosen. */
function autoSelects(segment: Segment): boolean {
  const chosen = selectedTake(segment)
  return !readyTake(segment) && !(chosen && isPending(chosen))
}

/** Why the clip has no take in the player, or undefined when there is nothing to say (no takes yet). */
function selectionHintText(segment: Segment): string | undefined {
  const pending = segment.takes.some(isPending)
  const completed = segment.takes.some(isPlayable)
  if (!pending && !completed) return undefined
  if (selectedTake(segment)?.fileMissing && completed) {
    return (
      "The selected take's video file no longer exists. Click another take to use it in the sequence."
    )
  }
  return pending && !completed
    ? "The take is being generated. It's selected automatically when it's done."
    : 'No take is selected. Click a take to use it in the sequence.'
}

/** Shown in the player's place while the clip has no usable chosen take. */
function SelectionHint({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-line px-5 py-6 text-center text-muted">{text}</div>
}

/** Marks `seenKey` seen once its content has been on screen for a moment with the window focused (D4). */
function SeenWhenVisible({ seenKey, children }: { seenKey?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(ref, seenKey)
  return <div ref={ref}>{children}</div>
}

/** No sequence yet: what a sequence is, one way in, and the other places to start from. */
function SequencesEmptyState({
  creating,
  onCreate,
  navigate
}: {
  creating: boolean
  onCreate: () => void
  navigate: Navigate
}) {
  const link = 'underline decoration-muted/50 underline-offset-2 hover:text-text'
  return (
    <EmptyState
      icon={<FilmIcon size={24} />}
      title="Build longer videos from several clips"
      text="A generation is at most around 15 seconds. In a sequence you put clips one after another, let each clip continue from the last frame of the one before, pick the best takes, trim, and export it all as one film."
      action={{ label: 'Create a sequence', onClick: onCreate, disabled: creating }}
      footnote={
        <>
          Rather start with images? In{' '}
          <button type="button" onClick={() => navigate('storyboards')} className={link}>
            Storyboards
          </button>{' '}
          you make an image for every key moment and generate the clips between them. Videos you already have go into
          a sequence straight from{' '}
          <button type="button" onClick={() => navigate('generate')} className={link}>
            Generate
          </button>
          .
        </>
      }
    />
  )
}
