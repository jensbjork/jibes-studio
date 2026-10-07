import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ConsentRequest, GenerationParams, Segment, Sequence, VideoModel } from '@shared/types'
import { ipcErrorMessage, useQuote } from '../../lib/hooks'
import { formatUsd } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { useReportOpenSegment } from '../../lib/workspace'
import ConsentDialog from '../ConsentDialog'
import ParamsForm from '../ParamsForm'
import { clipBlocked } from './clipChecks'
import ConfirmButton from './ConfirmButton'
import { CloseIcon, PlayIcon } from './icons'
import KeyframeBox from './KeyframeBox'
import NotesField from './NotesField'
import { clipKey, continues, parseConsent, readyTake, stableJson } from './sequenceUtils'
import { useDraft, useRegisterFlush, type DraftStatus, type FlushRegistry } from './useDraft'
import type { SequenceStore } from './useSequence'

/** Lets the take list push an old take's prompt back into the editor. */
export interface EditorHandle {
  applyPrompt: (prompt: string, negativePrompt?: string) => void
}

interface Props {
  sequence: Sequence
  segment: Segment
  index: number
  models: VideoModel[]
  modelsError?: string
  ffmpegOk: boolean
  store: SequenceStore
  flushers: FlushRegistry
  handleRef: RefObject<EditorHandle | null>
  navigate: Navigate
  onPreviewFrom: (segmentId: string) => void
  /** Configures the clip to be redone between its neighbours ("Gör om mellan grannarna"; free). */
  onBridge: (segmentId: string) => Promise<void>
  /** "Gör om mellan grannarna" just configured this clip; the frames box says what to do next. */
  justBridged?: boolean
  /** Shows the clip's notes ("Vad händer"); the storyboard has them on its panels already. */
  showNotes?: boolean
  /** Shown as a close button in the header (the storyboard's editor column). */
  onClose?: () => void
}

const smallButton =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'
const deleteButton =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-accent'

/**
 * Params for the selected segment. Mount with `key={segment.id}`: the draft belongs to one segment and is
 * saved (debounced, and on unmount) with params-only patches, so it can't overwrite the take selection,
 * trims or continuation that main or other controls change meanwhile.
 */
export default function SegmentEditor({
  sequence,
  segment,
  index,
  models,
  modelsError,
  ffmpegOk,
  store,
  flushers,
  handleRef,
  navigate,
  onPreviewFrom,
  onBridge,
  justBridged = false,
  showNotes = true,
  onClose
}: Props) {
  const { mutate, patchSegment, addTake } = store
  const segmentId = segment.id
  // Lets a connected agent know which clip the user is looking at.
  useReportOpenSegment(sequence.id, segmentId)
  const saveParams = useCallback(
    (params: GenerationParams) => mutate(() => window.studio.updateSegment(segmentId, { params })),
    [mutate, segmentId]
  )
  const draft = useDraft(segment.params, saveParams)
  const { value: params, setValue: setParams, flush, discard } = draft
  useRegisterFlush(flushers, flush)

  useEffect(() => {
    const handle: EditorHandle = {
      applyPrompt: (prompt, negativePrompt) => setParams((p) => ({ ...p, prompt, negativePrompt }))
    }
    handleRef.current = handle
    return () => {
      if (handleRef.current === handle) handleRef.current = null
    }
  }, [handleRef, setParams])

  const continuing = continues(segment, index)
  const endFromNext = segment.endFromNext && index < sequence.segments.length - 1
  const model = models.find((m) => m.id === params.model)
  const quote = useQuote(params, model)

  const [submitting, setSubmitting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string>()
  // Venice's consent request, with the clip as main had it when it asked: accepting generates only that clip.
  const [consent, setConsent] = useState<{ request: ConsentRequest; clip: string }>()
  // The clip as main has it now (what segments:generate would send, including the frames it starts and ends on
  // from the neighbours), for comparing after the consent dialog.
  const clipNow = clipKey(sequence, index)
  const clipNowRef = useRef(clipNow)
  useEffect(() => {
    clipNowRef.current = clipNow
  })

  // Checked as main will send it: a continuation is image-to-video, where @ImageN tokens point at nothing.
  const blocked = clipBlocked({ sequence, index, params, models, modelsError, ffmpegOk })

  const generate = async () => {
    if (blocked || submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      // main generates from the stored params, so the latest edits must be saved first.
      if (!(await flush())) throw new Error('Ändringarna kunde inte sparas. Försök igen.')
      addTake(await window.studio.generateSegment(segmentId))
    } catch (e) {
      const message = ipcErrorMessage(e)
      const request = parseConsent(message)
      if (request) setConsent({ request, clip: clipNowRef.current })
      else setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const acceptConsent = async () => {
    if (!consent) return
    const { request, clip } = consent
    setConsent(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      setError(ipcErrorMessage(e))
      return
    }
    // The clip may have changed while the terms were shown (an agent can edit it): then nothing is sent until
    // the user has looked at it and pressed the button again, which shows the price.
    if (clipNowRef.current !== clip || stableJson(params) !== stableJson(segment.params)) {
      setError('Klippet ändrades medan villkoren visades. Kontrollera det och tryck Generera igen.')
      return
    }
    await generate()
  }

  const toggleContinue = async (on: boolean) => {
    setToggling(true)
    setError(undefined)
    try {
      await flush()
      await patchSegment(segmentId, { continueFromPrevious: on })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setToggling(false)
    }
  }

  const toggleEndFromNext = async (on: boolean) => {
    setToggling(true)
    setError(undefined)
    try {
      // Main switches the clip to a model that takes an end image when it is turned on, keeping these params.
      await flush()
      await patchSegment(segmentId, { endFromNext: on })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setToggling(false)
    }
  }

  const bridge = async () => {
    setToggling(true)
    setError(undefined)
    try {
      // The bridge keeps prompt, duration and sound, so the latest typing must be saved first.
      if (!(await flush())) throw new Error('Ändringarna kunde inte sparas. Försök igen.')
      await onBridge(segmentId)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setToggling(false)
    }
  }

  const remove = async () => {
    discard()
    try {
      await mutate(() => window.studio.deleteSegment(segmentId))
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  const anyReady = sequence.segments.slice(index).some((s) => readyTake(s))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {consent && (
        <ConsentDialog
          request={consent.request}
          cost={`klipp ${index + 1} · ${formatUsd(quote)}`}
          onAccept={acceptConsent}
          onCancel={() => setConsent(undefined)}
        />
      )}

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="sticky top-0 z-10 -mx-5 mb-4 flex h-11 items-center gap-2 border-b border-line bg-bg/95 px-5 backdrop-blur">
          <h2 className="font-semibold">Klipp {index + 1}</h2>
          <SaveState status={draft.status} error={draft.error} />
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => onPreviewFrom(segmentId)}
              disabled={!anyReady}
              title={anyReady ? 'Förhandsvisa sekvensen från det här klippet' : 'Inga färdiga klipp att spela härifrån'}
              className={smallButton}
            >
              <PlayIcon size={10} />
              Härifrån
            </button>
            <ConfirmButton
              question="Radera klippet?"
              onConfirm={remove}
              title="Radera klippet (tagningarna finns kvar under Generera)"
              className={deleteButton}
            >
              Radera
            </ConfirmButton>
            {onClose && (
              <button onClick={onClose} title="Stäng redigeraren" aria-label="Stäng redigeraren" className={smallButton}>
                <CloseIcon size={11} />
              </button>
            )}
          </div>
        </div>

        {showNotes && <NotesField segment={segment} store={store} flushers={flushers} className="mb-4" />}

        <KeyframeBox
          sequence={sequence}
          segment={segment}
          index={index}
          models={models}
          model={params.model}
          ffmpegOk={ffmpegOk}
          busy={toggling}
          justBridged={justBridged}
          onContinue={(on) => void toggleContinue(on)}
          onEndFromNext={(on) => void toggleEndFromNext(on)}
          onBridge={() => void bridge()}
        />

        <ParamsForm
          models={models}
          modelsError={modelsError}
          params={params}
          setParams={setParams}
          // A frame from a neighbour makes the clip image-to-video.
          kinds={continuing || endFromNext ? ['image-to-video'] : undefined}
          continuing={continuing}
          endImageRequired
          startImageNote={continuing ? `Sista bildrutan från klipp ${index} används som startbild.` : undefined}
          endImageNote={endFromNext ? `Första bildrutan från klipp ${index + 2} används som slutbild.` : undefined}
          onSubmit={() => void generate()}
          navigate={navigate}
        />
      </div>

      <div className="border-t border-line p-4">
        {error && <p className="mb-3 max-h-32 overflow-y-auto text-accent select-text">{error}</p>}
        <button
          onClick={() => void generate()}
          disabled={!!blocked || submitting}
          className="flex w-full items-center justify-between gap-3 rounded-md bg-accent px-4 py-2.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
        >
          <span className="truncate" title={blocked}>
            {submitting ? 'Skickar…' : (blocked ?? (segment.takes.length ? 'Generera ny tagning' : 'Generera tagning'))}
          </span>
          <span className="shrink-0 text-white/80">{formatUsd(quote)}</span>
        </button>
        <p className="mt-2 text-center text-[11px] text-muted">⌘ + Enter för att generera</p>
      </div>
    </div>
  )
}

function SaveState({ status, error }: { status: DraftStatus; error?: string }) {
  if (error) {
    return (
      <span className="truncate text-[11px] text-accent" title={error}>
        Kunde inte spara
      </span>
    )
  }
  return (
    <span className="text-[11px] text-muted">{status === 'idle' ? 'Sparat' : 'Sparar…'}</span>
  )
}
