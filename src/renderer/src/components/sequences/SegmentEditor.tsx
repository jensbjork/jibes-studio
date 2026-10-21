import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { carriedReferences, ownReferences, type CarriedReferences } from '@shared/continuation'
import { generationTitle } from '@shared/generation-label'
import { referenceVideosOf } from '@shared/models'
import type {
  ConsentRequest,
  ContinueMode,
  Generation,
  GenerationParams,
  Segment,
  Sequence,
  VideoModel
} from '@shared/types'
import { variantsPrice, variantsText } from '@shared/variants'
import { withBudgetConfirm } from '../../lib/budget'
import { ipcErrorMessage, useDirectorAssets, useQuote } from '../../lib/hooks'
import { formatUsd } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { FILE_MANAGER, shortcut } from '../../lib/platform'
import { useVariantCount, withVariants } from '../../lib/variants'
import { useReportOpenSegment } from '../../lib/workspace'
import ConsentDialog from '../ConsentDialog'
import ParamsForm from '../ParamsForm'
import VariantPicker from '../VariantPicker'
import { workingCopyNote } from '../feed/ownClips'
import CastLine from './CastLine'
import { clipBlocked } from './clipChecks'
import ConfirmButton from './ConfirmButton'
import { CameraIcon, ChevronDownIcon, PlayIcon } from './icons'
import KeyframeBox from './KeyframeBox'
import NotesField from './NotesField'
import { withSong } from '@shared/song-send'
import SongBox, { revealWhoSings } from './song/SongBox'
import { durationText, placeOf } from './song/songText'
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
  /** Configures the clip to be redone between its neighbours ("Redo between neighbours"; free). */
  onBridge: (segmentId: string) => Promise<void>
  /** "Redo between neighbours" just configured this clip; the frames box says what to do next. */
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
  // The clip has references of its own: they replace everything the clips before would carry (also when they are only
  // a video), which is worth saying when there was something to carry.
  const replaced =
    plan?.mode === 'references' && !inherited && index > 0 && plan.carried
      ? carriedReferences(sequence.segments, index - 1)
      : undefined
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
        if (carried && sameReferences(next, view)) {
          return { ...next, referenceImages: undefined, referenceAudios: undefined, referenceVideos: undefined }
        }
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

  // Priced as it is sent: a continuation with its family's model for the way it starts, the director's style videos.
  const directors = useDirectorAssets()
  const sent = effectiveParams({ ...segment, params }, index, sequence, directors)
  const model = models.find((m) => m.id === sent.model)
  const quote = useQuote(sent, model)
  // ×1–×4 beside "Generate take" (⌘+Enter sends as many): each variant becomes a take of the clip.
  const [count, setCount] = useVariantCount('clip')
  const total = variantsPrice(quote, count)

  const [submitting, setSubmitting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string>()
  // Venice's consent request, with the clip as main had it when it asked: accepting generates only that clip, as many
  // variants as were asked for (and over the budget if that was confirmed already).
  const [consent, setConsent] = useState<{
    request: ConsentRequest
    clip: string
    count: number
    overBudgetOk: boolean
  }>()
  // The clip as main has it now (what segments:generate would send, including the frames it starts and ends on
  // from the neighbours), for comparing after the consent dialog.
  const clipNow = clipKey(sequence, index)
  const clipNowRef = useRef(clipNow)
  useEffect(() => {
    clipNowRef.current = clipNow
  })

  // Checked as main will send it: a continuation is image-to-video, where @ImageN tokens point at nothing.
  const blocked = clipBlocked({ sequence, index, params, models, modelsError, ffmpegOk })

  /** Sends `n` takes of the clip (the count chosen): the first comes back, the others arrive as updates. */
  const generate = async (n = count, overBudgetOk = false) => {
    if (blocked || submitting) return
    setSubmitting(true)
    setError(undefined)
    let confirmed = overBudgetOk
    try {
      // main generates from the stored params, so the latest edits must be saved first.
      if (!(await flush())) throw new Error("The changes couldn't be saved. Try again.")
      const take = await withBudgetConfirm((yes) => {
        confirmed ||= yes
        return window.studio.generateSegment(segmentId, { count: n, confirmOverBudget: confirmed })
      })
      // Undefined: over the budget, and the user said no – nothing was sent.
      if (take) addTake(take)
    } catch (e) {
      const message = ipcErrorMessage(e)
      const request = parseConsent(message)
      if (request) setConsent({ request, clip: clipNowRef.current, count: n, overBudgetOk: confirmed })
      else setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const acceptConsent = async () => {
    if (!consent) return
    const { request, clip, count: asked, overBudgetOk } = consent
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
      setError('The clip changed while the terms were shown. Check it and press Generate again.')
      return
    }
    await generate(asked, overBudgetOk)
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

  // "Use the cast": main gives the clip the sequence's cast as its references (its prompt's tokens follow them).
  const applyCast = async () => {
    setToggling(true)
    setError(undefined)
    try {
      if (!(await flush())) throw new Error("The changes couldn't be saved. Try again.")
      await mutate(() => window.studio.applyCastToSegment(segmentId))
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
      if (!(await flush())) throw new Error("The changes couldn't be saved. Try again.")
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
  // An own film (or a version from the Editor) as the clip's take: the clip is that film, and the form for an AI take
  // instead stays folded away until asked for. It opens by itself whenever the selected take is a generated one.
  const chosen = selectedTake(segment)
  const ownTake = chosen && isOwnTake(chosen) ? chosen : undefined
  const [aiAsked, setAiAsked] = useState(false)
  const formOpen = !ownTake || aiAsked
  // A clip of a sequence cut to a song: its place, and the duration that follows from it.
  const place = sequence.song ? placeOf(segment) : undefined
  // What a song clip sends instead of its own sound (its window of the song), for the form's legend and checks.
  const sequenceSong = sequence.song
  const sendWithSong = useCallback((p: GenerationParams) => withSong(p, sequenceSong), [sequenceSong])
  const hears = params.song?.part ?? place?.part
  const songForm = place && {
    sendAs: sendWithSong,
    audioNote:
      hears === 'vocals'
        ? `@Audio1 is the song's ${sequenceSong?.vocalsPath ? 'vocals' : 'sound (its vocals aren’t separated)'} at this clip's place – the voices here aren't sent while the clip hears the song.`
        : hears === 'mix'
          ? "@Audio1 is the song at this clip's place – the voices here aren't sent while the clip hears the song."
          : undefined,
    onNoSong: () =>
      setParams((p) => (p.song ? { ...p, song: { ...p.song, start: place.start, end: place.end, part: 'none' } } : p)),
    onChooseSinger: revealWhoSings
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {consent && (
        <ConsentDialog
          request={consent.request}
          cost={`clip ${index + 1} · ${
            consent.count > 1
              ? `${variantsText(consent.count)} · ${formatUsd(variantsPrice(quote, consent.count))}`
              : formatUsd(quote)
          }`}
          onAccept={acceptConsent}
          onCancel={() => setConsent(undefined)}
        />
      )}

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="sticky top-0 z-10 -mx-5 mb-4 flex h-11 items-center gap-2 border-b border-line bg-bg/95 px-5 backdrop-blur">
          <h2 className="font-semibold">Clip {index + 1}</h2>
          {ownTake && (
            <span className="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[11px] text-text">
              <CameraIcon size={11} />
              {ownTake.source === 'edit' ? 'Edited film' : 'Own clip'}
            </span>
          )}
          <SaveState status={draft.status} error={draft.error} />
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => onPreviewFrom(segmentId)}
              disabled={!anyReady}
              title={anyReady ? 'Preview the sequence from this clip' : 'No finished clips to play from here'}
              className={smallButton}
            >
              <PlayIcon size={10} />
              From here
            </button>
            <ConfirmButton
              question={place ? `Delete? Its place joins clip ${index > 0 ? index : 2}.` : 'Delete the clip?'}
              onConfirm={remove}
              title={
                place
                  ? `Delete the clip (the takes stay in Media); its place in the song joins clip ${index > 0 ? index : 2}'s`
                  : 'Delete the clip (the takes stay in Media)'
              }
              className={deleteButton}
            >
              Delete
            </ConfirmButton>
          </div>
        </div>

        {place && (
          <SongBox
            sequence={sequence}
            segment={segment}
            params={params}
            setParams={setParams}
            referenceImages={shown.referenceImages ?? []}
            sentModel={sent.model}
            models={models}
            take={readyTake(segment)}
            store={store}
          />
        )}

        {ownTake && <OwnClipInfo take={ownTake} />}

        <NotesField segment={segment} store={store} flushers={flushers} className="mb-4" />

        {!formOpen ? (
          <div className="rounded-lg border border-dashed border-line p-3">
            <button
              type="button"
              onClick={() => setAiAsked(true)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left transition hover:text-text"
            >
              <span>Generate an AI take instead…</span>
              <ChevronDownIcon size={12} className="shrink-0 text-muted" />
            </button>
            <p className="mt-1 px-1 text-[11px] leading-snug text-muted">
              The clip is your own film. To try an AI take in the same place, open the form – the film stays among the
              takes and you choose which one is used.
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
                Hide the form for an AI take
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

            <CastLine
              sequence={sequence}
              segment={{ ...segment, params }}
              index={index}
              busy={toggling}
              onUseCast={() => void applyCast()}
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
                    ? `+ the last frame of clip ${index} is sent after these (as @Image${plan.frameToken ?? 1}), and the prompt begins by saying the clip should start on it.${
                        inherited
                          ? ` The ${inherited.videos.length ? 'images, videos' : 'images'} and voices come from clip ${inherited.fromClip} – if you change them (adding a video too), they become this clip's own and replace all of clip ${inherited.fromClip}'s.`
                          : replaced
                            ? ` This clip's own references replace clip ${replaced.fromClip}'s – its images, videos and voices aren't carried.`
                            : ''
                      }`
                    : `Without references the clip starts exactly on the last frame of clip ${index}. Add references here (or in the clip before) and they're sent along with the frame.`
              }
              endImageRequired
              startImageNote={continuing ? `The last frame of clip ${index} is used as the start image.` : undefined}
              endImageNote={endFromNext ? `The first frame of clip ${index + 2} is used as the end image.` : undefined}
              onSubmit={() => void generate()}
              navigate={navigate}
              sequenceId={sequence.id}
              durationFixed={place ? `Automatic: ${durationText(params.duration, place)}` : undefined}
              song={songForm || undefined}
              followDirector={{ what: 'sequence', directorId: sequence.director }}
            />
          </>
        )}
      </div>

      {formOpen && (
        <div className="border-t border-line p-4">
          {error && <p className="mb-3 max-h-32 overflow-y-auto text-accent select-text">{error}</p>}
          <div className="flex items-stretch gap-2">
            <VariantPicker count={count} onChange={setCount} each={quote} />
            <button
              onClick={() => void generate()}
              disabled={!!blocked || submitting}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md bg-accent px-4 py-2.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
            >
              <span className="truncate" title={blocked}>
                {/* With variants the count says what is made: "Generate ×3" (the long label wouldn't fit beside them). */}
                {submitting
                  ? 'Sending…'
                  : (blocked ??
                    (count > 1
                      ? withVariants('Generate', count)
                      : segment.takes.length
                        ? 'Generate new take'
                        : 'Generate take'))}
              </span>
              <span className="shrink-0 text-white/80">{formatUsd(total)}</span>
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted">
            {shortcut('⌘ + Enter')} to generate{count > 1 ? ` ${variantsText(count)}` : ''}
          </p>
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
    referenceAudios: carried.audios.length ? carried.audios.map((a) => ({ ...a })) : undefined,
    referenceVideos: carried.videos.length ? carried.videos.map((v) => ({ ...v })) : undefined
  }
}

/** The same reference images, audio clips and videos (windows included), in the same order. */
function sameReferences(a: GenerationParams, b: GenerationParams): boolean {
  return (
    stableJson(a.referenceImages ?? []) === stableJson(b.referenceImages ?? []) &&
    stableJson(a.referenceAudios ?? []) === stableJson(b.referenceAudios ?? []) &&
    stableJson(referenceVideosOf(a)) === stableJson(referenceVideosOf(b))
  )
}

/** Facts about a video file for the info line, read once per file (free: ffprobe in main). */
interface FileFacts {
  fps?: number
  hasAudio?: boolean
}

/**
 * An own film's name and info line: "0:31 · 1080p · 30 fps · sound · working copy of 4K HDR". The frame rate and
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
    facts?.fps ? `${Math.round(facts.fps)} fps` : undefined,
    facts ? (facts.hasAudio ? 'sound' : 'no sound') : undefined,
    workingCopyNote(take.recipe?.import?.workingCopy)
  ].filter((p): p is string => !!p)

  return (
    <div className="mb-4 rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="truncate font-medium" title={generationTitle(take)}>
        {generationTitle(take, 80)}
      </p>
      {take.fileMissing ? (
        <p className="mt-0.5 text-[11px] leading-snug text-amber-300">
          The film is no longer where it was (moved or deleted in {FILE_MANAGER}). Add the file again or generate an AI
          take.
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
        Couldn't save
      </span>
    )
  }
  return (
    <span className="text-[11px] text-muted">{status === 'idle' ? 'Saved' : 'Saving…'}</span>
  )
}
