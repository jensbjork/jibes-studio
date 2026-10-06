import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ConsentRequest, Generation, GenerationParams, Segment, Sequence, VideoModel } from '@shared/types'
import { ipcErrorMessage, useQuote } from '../../lib/hooks'
import { formatUsd, mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { useReportOpenSegment } from '../../lib/workspace'
import ConsentDialog from '../ConsentDialog'
import ParamsForm, { missingInput, unavailableModel } from '../ParamsForm'
import ConfirmButton from './ConfirmButton'
import { PlayIcon } from './icons'
import {
  continuationMismatch,
  formatLength,
  parseConsent,
  readyTake,
  stableJson,
  takeDuration
} from './sequenceUtils'
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
  onPreviewFrom
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

  const previous = index > 0 ? sequence.segments[index - 1] : undefined
  const continuing = segment.continueFromPrevious && !!previous
  const prevTake = previous && readyTake(previous)
  const model = models.find((m) => m.id === params.model)
  const quote = useQuote(params, model)

  const [submitting, setSubmitting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string>()
  // Venice's consent request, with the clip as main had it when it asked: accepting generates only that clip.
  const [consent, setConsent] = useState<{ request: ConsentRequest; clip: string }>()
  // The clip as main has it now (what segments:generate would send, including the frame a continuation starts
  // from), for comparing after the consent dialog.
  const clipNow = stableJson([
    segment.params,
    continuing,
    continuing ? [previous?.id, previous?.selectedGenerationId, previous?.trimEnd] : null
  ])
  const clipNowRef = useRef(clipNow)
  useEffect(() => {
    clipNowRef.current = clipNow
  })

  const blocked =
    // Checked as main will send it: a continuation is image-to-video, where @ImageN tokens point at nothing.
    missingInput(params, continuing) ??
    (continuing && !ffmpegOk ? 'ffmpeg krävs för att fortsätta' : undefined) ??
    (continuing && !prevTake ? `Klipp ${index} saknar färdig tagning` : undefined) ??
    (!model
      ? models.length
        ? 'Välj en tillgänglig modell'
        : modelsError
          ? 'Modellerna kunde inte laddas'
          : 'Laddar modeller…'
      : unavailableModel(model))

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
          </div>
        </div>

        <ContinueToggle
          segment={segment}
          index={index}
          previousTrimEnd={previous?.trimEnd ?? 0}
          prevTake={prevTake}
          ffmpegOk={ffmpegOk}
          busy={toggling}
          mismatch={continuationMismatch(segment, previous)}
          onChange={toggleContinue}
        />

        <ParamsForm
          models={models}
          modelsError={modelsError}
          params={params}
          setParams={setParams}
          kinds={continuing ? ['image-to-video'] : undefined}
          continuing={continuing}
          startImageNote={continuing ? `Sista bildrutan från klipp ${index} används som startbild.` : undefined}
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

function ContinueToggle({
  segment,
  index,
  previousTrimEnd,
  prevTake,
  ffmpegOk,
  busy,
  mismatch,
  onChange
}: {
  segment: Segment
  index: number
  previousTrimEnd: number
  prevTake?: Generation
  ffmpegOk: boolean
  busy: boolean
  mismatch: boolean
  onChange: (on: boolean) => void
}) {
  const on = segment.continueFromPrevious && index > 0
  const first = index === 0
  // Turning it off must stay possible without ffmpeg; turning it on needs ffmpeg for the frame grab.
  const disabled = first || busy || (!on && !ffmpegOk)
  const frameTime = prevTake ? Math.max(0, takeDuration(prevTake) - previousTrimEnd) : undefined

  const description = first
    ? 'Det första klippet startar från din prompt och dina egna bilder.'
    : !ffmpegOk && !on
      ? 'Kräver ffmpeg (brew install ffmpeg).'
      : on
        ? `Startbilden hämtas från slutet av klipp ${index}${previousTrimEnd > 0 ? ' (efter trim)' : ''} när tagningen genereras, så övergången blir sömlös.`
        : `Använd sista bildrutan i klipp ${index} som startbild för en sömlös övergång.`

  return (
    <div className="mb-5 rounded-lg border border-line bg-panel p-3">
      <div
        className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
        onClick={() => !disabled && onChange(!on)}
      >
        <button
          role="switch"
          aria-checked={on}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            onChange(!on)
          }}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${on ? 'left-[18px]' : 'left-0.5'}`}
          />
        </button>
        <span className="min-w-0">
          <span className="block">Fortsätt från föregående klipp</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">{description}</span>
        </span>
      </div>

      {on && prevTake?.filePath && frameTime !== undefined && (
        <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
          {/* The media fragment makes the browser show the exact frame the continuation will start from. */}
          <video
            key={`${prevTake.id}-${frameTime}`}
            src={`${mediaUrl(prevTake.filePath)}#t=${Math.max(0, frameTime - 0.05).toFixed(2)}`}
            preload="auto"
            muted
            className="pointer-events-none aspect-video w-28 shrink-0 rounded bg-black object-cover"
          />
          <p className="text-[11px] leading-snug text-muted">
            Startbild: klipp {index}
            {previousTrimEnd > 0 ? ` vid ${formatLength(frameTime)}` : ', sista bildrutan'}
          </p>
        </div>
      )}

      {on && !prevTake && (
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-snug text-muted">
          Klipp {index} behöver en färdig vald tagning innan det här klippet kan genereras.
        </p>
      )}

      {mismatch && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-300">
          Den valda tagningen gjordes från en annan slutbild än den klipp {index} har nu. Generera en ny tagning för en
          sömlös övergång.
        </p>
      )}
    </div>
  )
}
