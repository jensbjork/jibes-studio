import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supportsEndImage } from '@shared/models'
import type { ConsentRequest, FfmpegStatus, Generation, GenerationParams, Segment, Sequence } from '@shared/types'
import { ipcErrorMessage, useModels } from '../../lib/hooks'
import { LAST_SEQUENCE_KEY } from '../../lib/library'
import { formatUsd } from '../../lib/media'
import type { Intent, Navigate } from '../../lib/navigation'
import ConsentDialog from '../ConsentDialog'
import { missingInput } from '../ParamsForm'
import { ownEndImageRefused } from './clipChecks'
import { CloseIcon, FilmIcon } from './icons'
import PreviewPlayer from './PreviewPlayer'
import SegmentEditor, { type EditorHandle } from './SegmentEditor'
import SequenceHeader, { type ExportState } from './SequenceHeader'
import SequenceList from './SequenceList'
import TakeList from './TakeList'
import Timeline from './Timeline'
import TrimControls from './TrimControls'
import {
  clipKey,
  continues,
  effectiveParams,
  fileName,
  isPending,
  needsTake,
  parseConsent,
  pendingTake,
  readyTake,
  totalLength
} from './sequenceUtils'
import type { FlushRegistry } from './useDraft'
import { useSequence, useSequenceList } from './useSequence'
import { useTotalQuote } from './useTotalQuote'

function loadLastOpen(): string | undefined {
  try {
    return localStorage.getItem(LAST_SEQUENCE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

// Sequences used to have a Tidslinje / Storyboard switch remembered per sequence under these keys. Storyboards are
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

/** "Klipp 2", "Klipp 2 och 4", "Klipp 1, 3 och 4". */
function clipList(numbers: number[]): string {
  if (numbers.length === 1) return `Klipp ${numbers[0]}`
  return `Klipp ${numbers.slice(0, -1).join(', ')} och ${numbers[numbers.length - 1]}`
}

/**
 * What "Generera saknade" would pay for, one key per clip: what its take sends and the frames it starts or ends
 * on from its neighbours. Compared after the consent dialog, so accepting it can't pay for clips that changed
 * while the terms were shown.
 */
function runPlanKeys(sequence: Sequence): string[] {
  return sequence.segments.flatMap((s, i) => (!needsTake(s) || pendingTake(s) ? [] : [clipKey(sequence, i)]))
}

/** The first segment "Generera saknade" would have to generate but can't, so it can be pointed out up front. */
function findRunProblem(sequence: Sequence, ffmpegOk: boolean): { segmentId: string; message: string } | undefined {
  for (const [i, s] of sequence.segments.entries()) {
    if (!needsTake(s) || pendingTake(s)) continue
    const continuing = continues(s, i)
    // The run waits for a neighbour that is generated in the same run, so only what can never work is checked here.
    const endFromNext = s.endFromNext && i < sequence.segments.length - 1
    const params = effectiveParams(s, i)
    const reason =
      missingInput(params, continuing) ??
      (continuing && !ffmpegOk ? 'ffmpeg krävs för att fortsätta från föregående klipp' : undefined) ??
      (endFromNext && !ffmpegOk ? 'ffmpeg krävs för att ta slutbilden från nästa klipp' : undefined) ??
      (endFromNext && !supportsEndImage(params.model) ? 'modellen tar ingen slutbild – välj en annan' : undefined) ??
      (ownEndImageRefused(params, endFromNext)
        ? 'modellen tar ingen slutbild – välj en annan eller ta bort bilden'
        : undefined)
    if (reason) return { segmentId: s.id, message: `Klipp ${i + 1}: ${reason}` }
  }
  return undefined
}

interface Notice {
  text: string
  /** Only shown while this sequence is open; global when unset. */
  sequenceId?: string
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
      void reload()
    },
    [reload]
  )
  const store = useSequence(selectedId, onMissing)
  const { sequence } = store
  const sequenceId = sequence?.id

  const [segmentChoice, setSegmentChoice] = useState<Record<string, string>>({})
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>()
  const [exports, setExports] = useState<Record<string, ExportState>>({})
  const [notice, setNotice] = useState<Notice>()
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [focusNameFor, setFocusNameFor] = useState<string>()
  const [preview, setPreview] = useState<{ startSegmentId?: string }>()
  // Open with the clips the run would pay for when it was opened (see runPlanKeys).
  const [runConsentOpen, setRunConsentOpen] = useState<ReadonlySet<string>>()
  const [dismissedRunError, setDismissedRunError] = useState<string>()
  const [exportDismissed, setExportDismissed] = useState<Record<string, boolean>>({})
  // The clip "Gör om mellan grannarna" was just used on, so its editor says what to do next.
  const [bridgedId, setBridgedId] = useState<string>()

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

  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem(LAST_SEQUENCE_KEY, selectedId)
    } catch {
      // Remembering the open sequence is only a convenience.
    }
  }, [selectedId])

  useEffect(() => {
    if (intent?.type !== 'open-sequence') return
    gone.current.delete(intent.sequenceId)
    if (intent.segmentId) {
      // A given clip (an agent's open_in_studio): select it. One that no longer exists falls back as usual.
      const { sequenceId, segmentId } = intent
      pickNewestFor.current = undefined
      setSegmentChoice((m) => ({ ...m, [sequenceId]: segmentId }))
    } else {
      // Opened from "Lägg i sekvens": show the clip that was just added.
      pickNewestFor.current = intent.sequenceId
    }
    setSelectedId(intent.sequenceId)
    onIntentHandled()
  }, [intent])

  const chosenId = sequenceId ? segmentChoice[sequenceId] : undefined
  const segmentIndex = sequence ? sequence.segments.findIndex((s) => s.id === chosenId) : -1
  const segment: Segment | undefined = sequence && segmentIndex !== -1 ? sequence.segments[segmentIndex] : undefined

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

  // ── Live state from main ───────────────────────────────────────────────────

  useEffect(() => {
    window.studio.ffmpegStatus().then(setFfmpeg, (e: unknown) => setFfmpeg({ ok: false, message: ipcErrorMessage(e) }))
  }, [])

  useEffect(
    () =>
      window.studio.onExportProgress((p) =>
        setExports((m) => {
          if (p.done) {
            if (p.error) return { ...m, [p.sequenceId]: { status: 'error', error: p.error } }
            if (p.path) return { ...m, [p.sequenceId]: { status: 'done', path: p.path } }
            return m
          }
          // A straggling progress event must not reopen a finished export.
          const prev = m[p.sequenceId]
          if (prev && prev.status !== 'running') return m
          return { ...m, [p.sequenceId]: { status: 'running', progress: p.progress } }
        })
      ),
    []
  )

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

  const deleteSequence = async (id: string) => {
    try {
      await window.studio.deleteSequence(id)
      gone.current.add(id)
      if (id === selectedId) setSelectedId(undefined)
      try {
        if (loadLastOpen() === id) localStorage.removeItem(LAST_SEQUENCE_KEY)
      } catch {
        // Ignore unavailable storage.
      }
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e) })
    }
    void reload()
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
      setNotice({ text: 'Ändringarna kunde inte sparas. Försök igen.', sequenceId })
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
        text: 'Klippen ändrades medan villkoren visades. Kontrollera dem och tryck ”Generera saknade” igen – knappen visar priset.',
        sequenceId
      })
      return
    }
    setDismissedRunError(undefined)
    store.update((s) => ({ ...s, running: true, runError: undefined }))
    try {
      await window.studio.generateAllSegments(sequenceId)
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
      setNotice({ text: 'Ändringarna kunde inte sparas. Försök igen.', sequenceId })
      return
    }
    setExportDismissed((m) => ({ ...m, [sequenceId]: false }))
    setExports((m) => ({ ...m, [sequenceId]: { status: 'running', progress: 0 } }))
    try {
      const path = await window.studio.exportSequence(sequenceId)
      setExports((m) => ({ ...m, [sequenceId]: { status: 'done', path } }))
    } catch (e) {
      setExports((m) => ({ ...m, [sequenceId]: { status: 'error', error: ipcErrorMessage(e) } }))
    }
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

  const moveSegment = (id: string, toIndex: number) => {
    store.moveSegment(id, toIndex).catch((e: unknown) => setNotice({ text: ipcErrorMessage(e), sequenceId }))
  }

  const selectTake = (take: Generation) => {
    if (!segment) return
    store
      .patchSegment(segment.id, { selectedGenerationId: take.id })
      .catch((e: unknown) => setNotice({ text: ipcErrorMessage(e), sequenceId }))
  }

  const deleteTake = async (take: Generation) => {
    store.update((s) => ({
      ...s,
      segments: s.segments.map((seg) => ({
        ...seg,
        takes: seg.takes.filter((t) => t.id !== take.id),
        selectedGenerationId: seg.selectedGenerationId === take.id ? undefined : seg.selectedGenerationId
      }))
    }))
    try {
      await window.studio.deleteGeneration(take.id)
    } catch (e) {
      setNotice({ text: ipcErrorMessage(e), sequenceId })
    }
    store.refresh()
  }

  const reusePrompt = (take: Generation) => editorHandle.current?.applyPrompt(take.params)

  /**
   * "Gör om mellan grannarna": main sets the clip to start on the previous clip's last frame and end on the next
   * clip's first frame with a model that takes both (free). The editor then shows the frames and the price;
   * generating is the user's own click.
   */
  const bridge = async (segmentId: string) => {
    if (!sequenceId) return
    setNotice(undefined)
    if (!(await flushAll())) {
      setNotice({ text: 'Ändringarna kunde inte sparas. Försök igen.', sequenceId })
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

  const runPlan = useMemo(() => {
    const toGenerate: GenerationParams[] = []
    let generating = 0
    sequence?.segments.forEach((s, i) => {
      if (!needsTake(s)) return
      if (pendingTake(s)) generating++
      else toGenerate.push(effectiveParams(s, i))
    })
    return { toGenerate, generating }
  }, [sequence])
  const runQuote = useTotalQuote(runPlan.toGenerate)

  const notReady = sequence ? sequence.segments.flatMap((s, i) => (readyTake(s) ? [] : [i + 1])) : []
  const readyCount = (sequence?.segments.length ?? 0) - notReady.length
  const exportBlocked = !ffmpegOk
    ? 'ffmpeg saknas – installera med brew install ffmpeg'
    : !sequence?.segments.length
      ? 'Lägg till klipp först'
      : notReady.length
        ? `${clipList(notReady)} saknar färdig vald tagning`
        : undefined
  const previewDisabled = readyCount === 0 ? 'Inga klipp har en färdig vald tagning ännu' : undefined

  const exportState = sequenceId ? exports[sequenceId] : undefined
  const runError = sequence?.runError
  const runConsent = parseConsent(runError)
  // Run errors are prefixed "Klipp N: …"; offer a jump to that clip.
  const runErrorClip = Number(/^Klipp (\d+)/.exec(runError ?? '')?.[1])
  const runErrorSegment = runErrorClip ? sequence?.segments[runErrorClip - 1] : undefined
  const visibleNotice = notice && (!notice.sequenceId || notice.sequenceId === sequenceId) ? notice : undefined
  const ready = segment && readyTake(segment)
  const nextSegment = sequence && segmentIndex !== -1 ? sequence.segments[segmentIndex + 1] : undefined
  const previousSegment = sequence && segmentIndex > 0 ? sequence.segments[segmentIndex - 1] : undefined

  // The bridge note belongs to the clip it was given for, until another clip is opened.
  useEffect(() => {
    if (bridgedId && segment?.id !== bridgedId) setBridgedId(undefined)
  }, [segment?.id, bridgedId])

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

  // ── Render ─────────────────────────────────────────────────────────────────

  const banners = (
    <>
      {ffmpeg && !ffmpeg.ok && (
        <Banner tone="warning">
          <span className="font-medium">ffmpeg saknas</span> – export och ”Fortsätt från föregående klipp” är avstängda.{' '}
          {/* The status message usually says how to install already; don't repeat it. */}
          {ffmpeg.message && !ffmpeg.message.includes('brew install') && (
            <span className="opacity-80">{ffmpeg.message} </span>
          )}
          Installera med <code className="rounded bg-black/30 px-1 py-px font-mono">brew install ffmpeg</code> och
          starta om Studio.
        </Banner>
      )}
      {visibleNotice && (
        <Banner tone="error" onDismiss={() => setNotice(undefined)}>
          {visibleNotice.text}
        </Banner>
      )}
      {runError && runError !== dismissedRunError && !sequence?.running && (
        <Banner tone="error" onDismiss={() => setDismissedRunError(runError)}>
          {runConsent ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              Generera saknade stoppades: modellen kräver att du godkänner leverantörens villkor.
              <button
                onClick={() => sequence && setRunConsentOpen(new Set(runPlanKeys(sequence)))}
                className="rounded bg-accent px-2 py-0.5 font-medium text-white hover:bg-accent-hover"
              >
                Granska och fortsätt
              </button>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Generera saknade stoppades – {runError}</span>
              {runErrorSegment && runErrorSegment.id !== segment?.id && (
                <button
                  onClick={() => selectSegment(runErrorSegment.id)}
                  className="rounded border border-accent/40 px-2 py-0.5 font-medium hover:bg-accent/10"
                >
                  Visa klipp {runErrorClip}
                </button>
              )}
            </span>
          )}
        </Banner>
      )}
      {exportState?.status === 'done' && sequenceId && !exportDismissed[sequenceId] && (
        <Banner tone="success" onDismiss={() => setExportDismissed((m) => ({ ...m, [sequenceId]: true }))}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Exporterad: <span className="font-mono">{fileName(exportState.path)}</span>
            </span>
            <button
              onClick={() => window.studio.revealFile(exportState.path)}
              className="rounded border border-emerald-400/40 px-2 py-0.5 font-medium hover:bg-emerald-400/10"
            >
              Visa i Finder
            </button>
          </span>
        </Banner>
      )}
      {exportState?.status === 'error' && sequenceId && !exportDismissed[sequenceId] && (
        <Banner tone="error" onDismiss={() => setExportDismissed((m) => ({ ...m, [sequenceId]: true }))}>
          {/* main's messages often already say so ("Exporten misslyckades: …", "Exporten avbröts.") */}
          {exportState.error.startsWith('Exporten') ? exportState.error : `Exporten misslyckades: ${exportState.error}`}
        </Banner>
      )}
    </>
  )

  return (
    <div className="flex h-full">
      <SequenceList
        sequences={sequences}
        selectedId={selectedId}
        runningId={sequence?.running ? sequence.id : undefined}
        creating={creating}
        onSelect={(id) => {
          gone.current.delete(id)
          setSelectedId(id)
        }}
        onCreate={() => void createSequence()}
        onDelete={(id) => void deleteSequence(id)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {sequence ? (
          <>
            <SequenceHeader
              key={sequence.id}
              sequence={sequence}
              totalSeconds={totalLength(sequence)}
              readyCount={readyCount}
              toGenerate={runPlan.toGenerate.length}
              generating={runPlan.generating}
              runQuote={runQuote}
              stopping={stopping}
              previewDisabled={previewDisabled}
              exportState={exportState}
              exportBlocked={exportBlocked}
              autoFocusName={focusNameFor === sequence.id}
              onAutoFocused={() => setFocusNameFor(undefined)}
              onRename={rename}
              onGenerateAll={() => void generateAll()}
              onStop={() => void stopAll()}
              onPreview={() => void openPreview(sequence.segments.find((s) => readyTake(s))?.id)}
              onExport={() => void exportSequence()}
              onError={(text) => setNotice({ text, sequenceId: sequence.id })}
            />
            {banners}
            <Timeline
              sequence={sequence}
              selectedId={segment?.id}
              adding={adding}
              onSelect={selectSegment}
              onAdd={(after) => void addSegment(after)}
              onMove={moveSegment}
              onBridge={(id) => void bridge(id)}
            />

            {segment ? (
              <div className="flex min-h-0 flex-1">
                <section className="flex w-[360px] shrink-0 flex-col border-r border-line">{editor}</section>
                <section className="min-w-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-4xl space-y-8 p-5">
                    {ready ? (
                      <TrimControls
                        key={`${segment.id}:${ready.id}`}
                        segment={segment}
                        take={ready}
                        number={segmentIndex + 1}
                        nextContinues={!!nextSegment?.continueFromPrevious}
                        previousEndsHere={!!previousSegment?.endFromNext}
                        patchSegment={store.patchSegment}
                        flushers={flushers}
                      />
                    ) : (
                      <SelectionHint segment={segment} />
                    )}
                    <TakeList
                      segment={segment}
                      number={segmentIndex + 1}
                      models={models}
                      currentPrompt={segment.params.prompt}
                      onSelect={selectTake}
                      onDelete={(take) => void deleteTake(take)}
                      onUsePrompt={reusePrompt}
                    />
                  </div>
                </section>
              </div>
            ) : (
              sequence.segments.length === 0 && (
                <div className="flex flex-1 items-center justify-center p-8">
                  <p className="max-w-sm text-center leading-relaxed text-muted">
                    Lägg till ett första klipp ovan. Varje klipp är en egen generering, och nästa klipp kan
                    fortsätta från det förras sista bildruta så att övergången blir sömlös.
                  </p>
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
              <EmptyState creating={creating} onCreate={() => void createSequence()} navigate={navigate} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted">
                {selectedId && !store.error ? 'Laddar sekvens…' : ''}
              </div>
            )}
          </>
        )}
      </div>

      {preview && sequence && (
        <PreviewPlayer sequence={sequence} startSegmentId={preview.startSegmentId} onClose={() => setPreview(undefined)} />
      )}
      {runConsentOpen && runConsent && (
        <ConsentDialog
          request={runConsent}
          cost={`Generera saknade, ${runPlan.toGenerate.length} klipp · ${formatUsd(runQuote)}`}
          onAccept={() => void acceptRunConsent(runConsent, runConsentOpen)}
          onCancel={() => setRunConsentOpen(undefined)}
        />
      )}
    </div>
  )
}

function Banner({
  tone,
  children,
  onDismiss
}: {
  tone: 'error' | 'warning' | 'success'
  children: ReactNode
  onDismiss?: () => void
}) {
  const tones = {
    error: 'border-accent/30 bg-accent/10 text-[#ffb3b5]',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
  }
  return (
    <div
      className={`mx-4 mt-3 flex shrink-0 items-start gap-3 rounded-lg border px-3.5 py-2.5 text-[12px] leading-relaxed ${tones[tone]}`}
    >
      <div className="min-w-0 flex-1 select-text">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} title="Stäng" className="mt-0.5 shrink-0 opacity-60 transition hover:opacity-100">
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  )
}

/** Shown above the take list while the segment has no usable selected take. */
function SelectionHint({ segment }: { segment: Segment }) {
  const pending = segment.takes.some(isPending)
  const completed = segment.takes.some((t) => t.status === 'completed')
  if (!pending && !completed) return null
  return (
    <div className="rounded-lg border border-dashed border-line px-5 py-6 text-center text-muted">
      {pending && !completed
        ? 'Tagningen genereras. Den väljs automatiskt till sekvensen när den är klar.'
        : 'Ingen tagning är vald. Klicka på Välj på den tagning du vill använda i sekvensen.'}
    </div>
  )
}

function EmptyState({
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
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <FilmIcon size={30} className="mx-auto mb-4 text-muted" />
        <h2 className="mb-2 text-base font-semibold">Bygg längre videor av flera klipp</h2>
        <p className="mb-5 leading-relaxed text-muted">
          En generering blir som mest runt 15 sekunder. I en sekvens lägger du klipp efter varandra, låter varje klipp
          fortsätta från det förras sista bildruta, väljer de bästa tagningarna, trimmar och exporterar allt som en film.
        </p>
        <button
          onClick={onCreate}
          disabled={creating}
          className="rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
        >
          Skapa en sekvens
        </button>
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          Vill du hellre börja med bilder? I{' '}
          <button onClick={() => navigate('storyboards')} className={link}>
            Storyboards
          </button>{' '}
          gör du en bild för varje viktigt ögonblick och genererar klippen mellan dem. Befintliga videor kan du lägga i
          en sekvens direkt från{' '}
          <button onClick={() => navigate('generate')} className={link}>
            Generera
          </button>
          .
        </p>
      </div>
    </div>
  )
}
