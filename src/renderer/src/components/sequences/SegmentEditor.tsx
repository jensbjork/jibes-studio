import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { ownReferences, type CarriedReferences } from '@shared/continuation'
import { generationTitle } from '@shared/generation-label'
import type {
  ConsentRequest,
  ContinueMode,
  Generation,
  GenerationParams,
  Segment,
  Sequence,
  VideoModel
} from '@shared/types'
import { ipcErrorMessage, useQuote } from '../../lib/hooks'
import { formatUsd } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { useReportOpenSegment } from '../../lib/workspace'
import ConsentDialog from '../ConsentDialog'
import ParamsForm from '../ParamsForm'
import { workingCopyNote } from '../feed/ownClips'
import { clipBlocked } from './clipChecks'
import ConfirmButton from './ConfirmButton'
import { CameraIcon, ChevronDownIcon, PlayIcon } from './icons'
import KeyframeBox from './KeyframeBox'
import NotesField from './NotesField'
import {
  clipKey,
  continuationOf,
  continues,
  effectiveParams,
  formatClock,
  isOwnTake,
  parseConsent,
  readyTake,
  selectedTake,
  stableJson,
  takePromptsFor
} from './sequenceUtils'
import { useDraft, useRegisterFlush, type DraftStatus, type FlushRegistry } from './useDraft'
import type { SequenceStore } from './useSequence'

/** Lets the take list push an old take's prompt back into the editor. */
export interface EditorHandle {
  /** The take's prompts, their @ImageN / @AudioN tokens renumbered to the clip's references (takePromptsFor). */
  applyPrompt: (take: GenerationParams) => void
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
  justBridged = false
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

  const continuing = continues(segment, index)
  const endFromNext = segment.endFromNext && index < sequence.segments.length - 1
  // How the clip continues from the previous one, as its draft says: in reference mode with the references it carries
  // (its own, or the clip's it continues from) and the previous clip's last frame after them; or exactly.
  const plan = continuing ? continuationOf({ ...segment, params }, index, sequence) : undefined
  const referenceForm = plan?.form === 'reference-to-video'
  // Without references of its own, the clip shows the ones it carries from the clip before as if they were its own:
  // they can be used in the prompt, and changing them (adding, removing, reordering) makes them the clip's own, which
  // then override the inherited ones. Left as they are, nothing is saved and the clip keeps carrying them.
  const inherited = plan?.mode === 'references' && plan.carried?.inherited ? plan.carried : undefined
  const inheritedRef = useRef<CarriedReferences | undefined>(inherited)
  inheritedRef.current = inherited
  const shown = inherited ? withReferences(params, inherited) : params
  const setShown = useCallback<Dispatch<SetStateAction<GenerationParams>>>(
    (update) =>
      setParams((p) => {
        const carried = inheritedRef.current && !ownReferences(p) ? inheritedRef.current : undefined
        const view = carried ? withReferences(p, carried) : p
        const next = typeof update === 'function' ? update(view) : update
        // The inherited references untouched: they stay the clip before's, not copied into this clip (whatever the
        // draft held instead was no reference it sends: left over from another mode, which main drops too).
        if (carried && sameReferences(next, view)) return { ...next, referenceImages: undefined, referenceAudios: undefined }
        return next
      }),
    [setParams]
  )

  useEffect(() => {
    const handle: EditorHandle = {
      // Against the references in the editor as they are now, so a reorder since the take doesn't move its words.
      applyPrompt: (take) => setShown((p) => ({ ...p, ...takePromptsFor(take, p) }))
    }
    handleRef.current = handle
    return () => {
      if (handleRef.current === handle) handleRef.current = null
    }
  }, [handleRef, setShown])

  // Priced as it is sent: a continuation with its family's model for the way it starts.
  const sent = effectiveParams({ ...segment, params }, index, sequence)
  const model = models.find((m) => m.id === sent.model)
  const quote = useQuote(sent, model)

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

  const chooseContinueMode = async (mode: ContinueMode) => {
    setToggling(true)
    setError(undefined)
    try {
      // Main switches the clip to its family's reference-to-video or image-to-video model, keeping these params.
      await flush()
      await patchSegment(segmentId, { continueMode: mode })
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
  // An own film (or a version from Redigera) as the clip's take: the clip is that film, and the form for an AI take
  // instead stays folded away until asked for. It opens by itself whenever the selected take is a generated one.
  const chosen = selectedTake(segment)
  const ownTake = chosen && isOwnTake(chosen) ? chosen : undefined
  const [aiAsked, setAiAsked] = useState(false)
  const formOpen = !ownTake || aiAsked

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
          {ownTake && (
            <span className="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[11px] text-text">
              <CameraIcon size={11} />
              {ownTake.source === 'edit' ? 'Redigerad film' : 'Eget klipp'}
            </span>
          )}
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

        {ownTake && <OwnClipInfo take={ownTake} />}

        <NotesField segment={segment} store={store} flushers={flushers} className="mb-4" />

        {!formOpen ? (
          <div className="rounded-lg border border-dashed border-line p-3">
            <button
              type="button"
              onClick={() => setAiAsked(true)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left transition hover:text-text"
            >
              <span>Generera en AI-tagning i stället…</span>
              <ChevronDownIcon size={12} className="shrink-0 text-muted" />
            </button>
            <p className="mt-1 px-1 text-[11px] leading-snug text-muted">
              Klippet är din egen film. Vill du prova en AI-tagning på samma plats öppnar du formuläret – filmen finns
              kvar bland tagningarna och du väljer själv vilken som används.
            </p>
          </div>
        ) : (
          <>
            {ownTake && (
              <button
                type="button"
                onClick={() => setAiAsked(false)}
                className="mb-3 flex items-center gap-1 text-[12px] text-muted transition hover:text-text"
              >
                <ChevronDownIcon size={11} className="rotate-180" />
                Dölj formuläret för en AI-tagning
              </button>
            )}
            <KeyframeBox
              sequence={sequence}
              segment={segment}
              index={index}
              models={models}
              model={params.model}
              ffmpegOk={ffmpegOk}
              busy={toggling}
              justBridged={justBridged}
              plan={plan}
              onContinue={(on) => void toggleContinue(on)}
              onContinueMode={(mode) => void chooseContinueMode(mode)}
              onEndFromNext={(on) => void toggleEndFromNext(on)}
              onBridge={() => void bridge()}
            />

            <ParamsForm
              models={models}
              modelsError={modelsError}
              params={shown}
              setParams={setShown}
              // A frame from a neighbour makes the clip image-to-video, except a continuation in reference mode.
              kinds={referenceForm ? ['reference-to-video'] : continuing || endFromNext ? ['image-to-video'] : undefined}
              continuing={continuing && !referenceForm}
              continuationFrame={
                !referenceForm
                  ? undefined
                  : plan?.mode === 'references'
                    ? `+ sista bildrutan i klipp ${index} skickas efter dessa (som @Image${plan.frameToken ?? 1}), och prompten börjar med att klippet ska starta på den.${
                        inherited
                          ? ` Bilderna och rösterna kommer från klipp ${inherited.fromClip} – ändrar du dem blir de klippets egna.`
                          : ''
                      }`
                    : `Utan referenser börjar klippet exakt på sista bildrutan i klipp ${index}. Lägg till referenser här (eller i klippet före), så skickas de med tillsammans med bildrutan.`
              }
              endImageRequired
              startImageNote={continuing ? `Sista bildrutan från klipp ${index} används som startbild.` : undefined}
              endImageNote={endFromNext ? `Första bildrutan från klipp ${index + 2} används som slutbild.` : undefined}
              onSubmit={() => void generate()}
              navigate={navigate}
            />
          </>
        )}
      </div>

      {formOpen && (
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
      )}
    </div>
  )
}

/** The params with these references in place of their own (a continuation showing what it carries). */
function withReferences(params: GenerationParams, carried: CarriedReferences): GenerationParams {
  return {
    ...params,
    referenceImages: carried.images.length ? [...carried.images] : undefined,
    referenceAudios: carried.audios.length ? carried.audios.map((a) => ({ ...a })) : undefined
  }
}

/** The same reference images and audio clips (windows included), in the same order. */
function sameReferences(a: GenerationParams, b: GenerationParams): boolean {
  return (
    stableJson(a.referenceImages ?? []) === stableJson(b.referenceImages ?? []) &&
    stableJson(a.referenceAudios ?? []) === stableJson(b.referenceAudios ?? [])
  )
}

/** Facts about a video file for the info line, read once per file (free: ffprobe in main). */
interface FileFacts {
  fps?: number
  hasAudio?: boolean
}

/**
 * An own film's name and info line: "0:31 · 1080p · 30 bilder/s · ljud · arbetskopia av 4K HDR". The frame rate and
 * the sound are read from the file itself; the working copy's reasons from the import.
 */
function OwnClipInfo({ take }: { take: Generation }) {
  const [facts, setFacts] = useState<FileFacts>()
  const path = take.filePath
  useEffect(() => {
    if (!path || take.fileMissing) return
    let current = true
    setFacts(undefined)
    window.studio.inspectVideoFiles([path]).then(
      ([info]) => current && info?.ok && setFacts({ fps: info.fps, hasAudio: info.hasAudio }),
      // Only the info line misses the frame rate and the sound then.
      () => undefined
    )
    return () => {
      current = false
    }
  }, [path, take.fileMissing])

  const parts = [
    take.videoDuration !== undefined ? formatClock(take.videoDuration) : undefined,
    take.params.resolution,
    facts?.fps ? `${Math.round(facts.fps)} bilder/s` : undefined,
    facts ? (facts.hasAudio ? 'ljud' : 'utan ljud') : undefined,
    workingCopyNote(take.recipe?.import?.workingCopy)
  ].filter((p): p is string => !!p)

  return (
    <div className="mb-4 rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="truncate font-medium" title={generationTitle(take)}>
        {generationTitle(take, 80)}
      </p>
      {take.fileMissing ? (
        <p className="mt-0.5 text-[11px] leading-snug text-amber-300">
          Filmen finns inte längre där den låg (flyttad eller raderad i Finder). Lägg till filen igen eller generera en
          AI-tagning.
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] text-muted tabular-nums">{parts.join(' · ')}</p>
      )}
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
