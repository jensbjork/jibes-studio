import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import { overBudgetFor, overBudgetText } from '@shared/budget'
import { effectiveDirectorId, resolveDirector, withDirection } from '@shared/direction'
import {
  KINDS,
  kindOfModelId,
  maxReferenceImages,
  paramsForSubmit,
  referenceVideoLimits,
  referenceVideosOf,
  referenceVideoWindow,
  videosAreReferences
} from '@shared/models'
import {
  composeOptionsFor,
  composePrompt,
  describedAssets,
  explainedReferences,
  type ComposedPrompt
} from '@shared/prompt-compose'
import { canonicalizeParams, type ValidateOptions } from '@shared/prompt-refs'
import type {
  ApprovalImageRequest,
  ApprovalRequest,
  Asset,
  ConsentRequest,
  GenerationParams,
  OverBudget,
  PromptLanguage,
  Segment,
  SegmentFramePreview,
  Sequence,
  VideoModel
} from '@shared/types'
import {
  APPROVAL_TTL_MS,
  approvalQueue,
  deferApproval,
  refreshApprovals,
  resolveApproval,
  useAgentState
} from '../../lib/agent'
import { SERVICE_NAME, ipcErrorMessage, safeModeEffect, useAssetsState, useModels } from '../../lib/hooks'
import { fileName } from '../../lib/library'
import { formatUsd, mediaUrl } from '../../lib/media'
import { blockingPromptIssue, promptIssuesOf } from '../../lib/promptIssues'
import { BudgetMeter } from '../BudgetDialog'
import ConsentDialog from '../ConsentDialog'
import { KIND_TONE } from '../pickers/assetKinds'
import AudioPlayButton from '../pickers/AudioPlayButton'
import {
  audioLabel,
  audioLabelParts,
  audioSourcesByPath,
  clipsOf as audioClipsOf,
  formAudios,
  windowLabel,
  type AudioSource,
  type FormAudio
} from '../pickers/audioRefs'
import Modal from '../pickers/Modal'
import { useVideoFacts } from '../pickers/videoFacts'
import { videoCount, videoLabelParts } from '../pickers/videoRefs'
import { markKey } from '../prompt/promptText'
import { effectiveParams, needsTake, parseConsent, pendingTake } from '../sequences/sequenceUtils'
import { noticeTones } from '../ui/Banner'
import { buttonClass } from '../ui/button'
import {
  agentInSentence,
  approvalHeading,
  approvalOutcome,
  approvalPriceText,
  approvalTitle,
  approveLabel,
  expiresText,
  slotName,
  variantCount
} from './agentText'
import { ImageTile, VideoTile, type Photo } from './ApprovalPictures'
import { DeleteSummary, useDeleteCheck } from './DeleteApproval'
import { EditSummary, ResumeSummary, VoiceDesignSummary, useEditApproval } from './EditApproval'
import PromptText, { type TokenTarget } from './PromptText'
import { SongLyricsSummary } from './SongLyricsApproval'
import {
  BoardTargetSummary,
  TransitionSummary,
  boardTargetNow,
  storyboardTransitions,
  useStoryboard,
  type BoardTarget
} from './StoryboardApproval'

/**
 * What an agent asks for that needs the user's OK waits here: paid generations (videos, pictures, the Editor's paid
 * operations, voices, a song's lyrics) and removals. Shown above every view; several requests queue up and are shown one at a time.
 * Nothing is sent to Venice until "Approve and generate" ("Approve and create" for a picture), and nothing is removed
 * until "Approve and delete".
 */
export default function ApprovalDialog() {
  const agent = useAgentState()
  const queue = approvalQueue(agent)
  // The request on screen stays there until the user acts on it (approves, declines, closes or puts it off),
  // also when it is sent, fails, lapses or is replaced by a newer one meanwhile: the dialog never swaps in
  // another request under their cursor. A replaced one says so, and they move on to the next themselves.
  const [shownId, setShownId] = useState<string>()
  const shown = shownId ? agent.approvals.find((a) => a.id === shownId) : undefined
  // Opening a request from the Agent panel is the user's own choice, so that one may take the screen.
  const focused = agent.focused ? queue.find((a) => a.id === agent.focused) : undefined
  const current = (focused && focused.id !== shownId ? focused : undefined) ?? shown ?? queue[0]
  const currentId = current?.id
  useEffect(() => {
    if (currentId && currentId !== shownId) setShownId(currentId)
  }, [currentId, shownId])
  if (!current) return null
  const id = current.id
  const index = queue.findIndex((a) => a.id === id)
  return (
    <ApprovalPanel
      key={id}
      approval={current}
      position={index === -1 ? undefined : { index: index + 1, total: queue.length }}
      othersWaiting={queue.some((a) => a.id !== id)}
      // Releasing only ever releases this request, so a reply that arrives late can't free the next one.
      hold={(on) => setShownId((cur) => (on ? id : cur === id ? undefined : cur))}
    />
  )
}

/**
 * done: an image request was approved and its picture is made, or a removal was carried out but not all of it went
 * (shown until the user closes the dialog).
 * confirming: an edit or a voice design above BIG_PRICE_USD, with an unknown price or a part without one asks "This
 * costs … Continue?" once more before it is approved (the Editor's own rule for a paid click); a removal of a
 * container (an asset, a sequence, a storyboard, an edit) or of more than 5 things asks its own question.
 */
type Phase = 'review' | 'confirming' | 'declining' | 'submitting' | 'failed' | 'done'

/** The Editor's rule for every paid click (D5): above this price a second step asks once more. */
const BIG_PRICE_USD = 5

interface PanelProps {
  approval: ApprovalRequest
  position?: { index: number; total: number }
  /** Other requests are waiting after this one. */
  othersWaiting: boolean
  /** Keeps this request on screen (true) or lets the dialog move on (false). */
  hold: (on: boolean) => void
}

/**
 * How long a request has to be on screen, unchanged, before it can be approved. A click meant for what was
 * there a moment ago (the second click of a double-click, a request that just popped up or changed) must not
 * pay for something the user hasn't seen.
 */
const ARM_MS = 900

/** True once `key` (what the panel shows) has stayed the same for ARM_MS. */
function useArmed(key: string): boolean {
  const [armed, setArmed] = useState<string>()
  useEffect(() => {
    const t = setTimeout(() => setArmed(key), ARM_MS)
    return () => clearTimeout(t)
  }, [key])
  return armed === key
}

// The dialog's buttons; a disabled Approve turns neutral (its tooltip says why), never a faded red.
const primary = buttonClass('primary')
const secondary = buttonClass('secondary')

function ApprovalPanel({ approval: a, position, othersWaiting, hold }: PanelProps) {
  const { models } = useModels()
  const { assets, loaded: assetsLoaded } = useAssetsState()
  const photos = useMemo(() => photoIndex(assets), [assets])
  const voices = useMemo(() => audioSourcesByPath(assets), [assets])
  // A request about a storyboard (one transition, its missing transitions, or a board's picture) reads the
  // storyboard; the sequence handlers don't know storyboards.
  const storyboardId = a.sequenceKind === 'storyboard' ? a.sequenceId : undefined
  const { sequence, error: sequenceError } = useSequence(storyboardId ? undefined : a.sequenceId)
  const { storyboard, error: storyboardError } = useStoryboard(storyboardId)
  const now = useNow(15_000)
  const language = usePromptLanguageSetting()
  // Composes a prompt the way main sends it, from the library as it is now; undefined until everything it
  // depends on (the assets, the prompt language, the models' prompt limits) has been read.
  const composer = useMemo(
    () => (assetsLoaded && language && models.length ? makeComposer(assets, language, models) : undefined),
    [assets, assetsLoaded, language, models]
  )
  // The library changed (files moved by "Tidy up" or a renamed asset come as new assets): main lists the request
  // with its params following the moves, so its pictures and legend are read from the files as they are now – a
  // move is not taken for an edited description.
  const pendingNow = a.status === 'pending'
  useEffect(() => {
    if (pendingNow) void refreshApprovals()
  }, [assets, pendingNow])

  const [phase, setPhase] = useState<Phase>('review')
  const [error, setError] = useState<string>()
  const [consent, setConsent] = useState<ConsentRequest>()
  const [reason, setReason] = useState('')
  // A decline on its way: the buttons then say so, not the approve button's "Deleting…" or "Sending…".
  const [declineSending, setDeclineSending] = useState(false)
  /** The still an approved image request made. */
  const [madeStill, setMadeStill] = useState<string>()
  // The Editor's requests: an operation on an edit's version, or a new voice for a character.
  const editRequest = a.kind === 'edit' || a.kind === 'voice-design' ? (a.edit ?? null) : undefined
  const editState = useEditApproval(a)
  // A removal: what goes, checked again while it is on screen for review.
  const removal = a.kind === 'delete' ? (a.delete ?? null) : undefined
  // A song's lyrics to transcribe.
  const songRequest = a.kind === 'song-lyrics' ? (a.song ?? null) : undefined
  const deleteCheck = useDeleteCheck(a, removal !== undefined && (phase === 'review' || phase === 'confirming'))
  /** "I have the right to use this voice", ticked in this dialog (a cloned voice needs it). */
  const [cloneConsent, setCloneConsent] = useState(false)
  const consentClip = a.kind === 'edit' ? a.edit?.needsCloneConsent : undefined
  const consentGiven =
    !!consentClip && assets.some((asset) => asset.audio?.some((x) => x.id === consentClip.audioId && x.cloneConsent))
  const consentMissing = !!consentClip && !consentGiven && !cloneConsent
  // The Editor's requests (an edit, a voice design) ask once more, as the Editor's own buttons and the voice design dialog
  // do, when the price is above $5, unknown, or leaves a part out.
  const redigera = a.kind === 'edit' || a.kind === 'voice-design'
  const partialPrice = redigera && !!a.edit?.partialPrice
  const bigPrice = redigera && (a.priceUsd === undefined || partialPrice || a.priceUsd > BIG_PRICE_USD)
  /** "$0.51", "≈ $0.45 +" (a part without a price). */
  const priceShown = (usd: number): string => (partialPrice ? `≈ ${formatUsd(usd)} +` : formatUsd(usd))

  const expiresAt = a.expiresAt ?? a.createdAt + APPROVAL_TTL_MS
  const pending = a.status === 'pending'
  // Main lapses it at expiresAt; don't offer to approve what it would refuse.
  const expired = pending && now > expiresAt
  // Past the user's budget: said here, since approving is their yes to it (main doesn't ask again).
  const overBudget = useOverBudget(a.priceUsd, pending && a.kind !== 'delete')
  // A still for a storyboard (an image model) rather than a video.
  const image = a.kind === 'image' ? (a.image ?? null) : undefined
  const clips = useMemo(
    () => (storyboardId ? [] : withDescriptions(clipsOf(a, sequence), a, composer, sequence)),
    [a, sequence, composer, storyboardId]
  )
  // The transitions it generates: the two board pictures each goes between, with the prompt and settings.
  const transitionState = useMemo(
    () => (storyboardId && a.kind !== 'image' ? storyboardTransitions(a, storyboard) : undefined),
    [a, storyboard, storyboardId]
  )
  const transitions = transitionState?.transitions ?? []
  // The automatic start and end frames of the one clip a 'segment' request generates, as they are right now.
  const frameClip = a.kind === 'segment' && clips.length === 1 ? clips[0] : undefined
  const needsFrames = !!frameClip && !!(frameClip.continuesFrom || frameClip.endsAt)
  const { preview: frames, loading: framesLoading } = useFramePreview(
    needsFrames ? a.segmentIds?.[0] : undefined,
    a.sequenceId
  )
  // The clip number an image request's picture goes to, as the sequence is now (the request has it as it was).
  const imageTarget = imageTargetNow(image?.assignTo, sequence)
  // Or the board it becomes, as the storyboard is now.
  const boardTarget = boardTargetNow(image?.assignToBoard, storyboard)
  const armed = useArmed(
    JSON.stringify([
      a.id,
      a.status,
      a.priceUsd,
      image?.params,
      imageTarget,
      boardTarget,
      clips.map((c) => [c.key, c.title, c.params, c.continuesFrom, c.endsAt, c.legend, c.descriptionsChanged]),
      transitions.map((t) => [t.key, t.number, t.params, t.problem]),
      // An edit: what it does, and the plan as it would run now (another plan is something else to approve).
      editRequest && { ...editRequest, jobId: undefined, resultId: undefined },
      editState.plan?.fingerprint,
      editState.job?.resumePriceUsd,
      editState.blocking,
      // A removal: the items, and the live check's answer (a problem that clears arms the button again, after a while).
      removal?.items.map((i) => [i.kind, i.id, i.segmentId, i.toIndex, i.label, i.effects]),
      removal?.confirm,
      songRequest,
      deleteCheck.checked,
      deleteCheck.problem,
      // A neighbour's other take (or trim) is another frame: the user must see it before it is paid for. While a
      // new answer is on its way the old frame may be stale, so the request arms again only once it has come.
      framesLoading,
      frames?.start?.path,
      frames?.end?.path
    ])
  )
  // The first clip that can't be generated, named when the request covers several.
  const blockingClip = clips.find((c) => c.blocking)
  // Main refuses a request whose composed prompt is no longer the one it was made with; say so before the click.
  const changedClip = clips.find((c) => c.descriptionsChanged)
  const descriptionsChanged =
    changedClip &&
    (clips.length > 1 && changedClip.title ? `${changedClip.title}: ${DESCRIPTIONS_CHANGED}` : DESCRIPTIONS_CHANGED)
  const blocking =
    (blockingClip && clips.length > 1 && blockingClip.title
      ? `${blockingClip.title}: ${blockingClip.blocking}`
      : blockingClip?.blocking) ??
    descriptionsChanged ??
    // What stands in the way of the clip's start and end frames (a neighbour without a finished take …).
    frames?.problems[0] ??
    (image === null ? 'The request doesn’t say anything about the image' : undefined) ??
    imageTarget?.problem ??
    transitionState?.blocking ??
    boardTarget?.problem ??
    (editRequest === null ? 'The request doesn’t say anything about the change' : undefined) ??
    editState.blocking ??
    (removal === null ? 'The request doesn’t say what should be deleted' : undefined) ??
    (removal ? deleteCheck.problem : undefined) ??
    (songRequest === null ? 'The request doesn’t say which song' : undefined)
  // Changed since the agent asked (rather than something the agent can fix): the agent has to ask again.
  const askAgain =
    !!blocking &&
    (blocking === descriptionsChanged ||
      (!!transitionState?.lapsed && blocking === transitionState.blocking) ||
      blocking === boardTarget?.problem ||
      blocking === editState.blocking ||
      blocking === deleteCheck.problem)
  // The frames shown must be the ones that will be sent: no approving while they are being fetched (again).
  const framesPending = needsFrames && pending && framesLoading
  // An edit is approved once its plan as it would run now is on screen (its warnings, a price that moved) – or, for a
  // stopped job to continue, the job as it is now.
  const editPlanPending = a.kind === 'edit' && pending && !editState.ready && !editState.blocking
  // A removal is approved once main has checked it again since it was shown.
  const deleteCheckPending = !!removal && pending && !deleteCheck.checked

  const fail = (message: string) => {
    const request = parseConsent(message)
    if (request) {
      setConsent(request)
      setPhase('review')
    } else {
      setError(message)
      setPhase('failed')
    }
  }

  const approve = async () => {
    setPhase('submitting')
    setError(undefined)
    hold(true)
    try {
      // The user's own consent to clone the voice, given here before main checks for it (an agent can't give it).
      if (consentClip && !consentGiven) await window.studio.setVoiceCloneConsent(consentClip.audioId, true)
      const result = await resolveApproval(a.id, true)
      if (result.status === 'approved') {
        // The picture is made by now: show it before moving on, so the user sees what they paid for.
        const stillId = result.stillId
        if (image !== undefined && stillId) {
          setMadeStill(stillId)
          setPhase('done')
          return
        }
        // A removal where something didn't go: the list says what, before the dialog moves on.
        if (result.delete?.items.some((i) => i.outcome && i.outcome.status !== 'deleted')) {
          setPhase('done')
          return
        }
        hold(false)
        return
      }
      fail(result.error ?? approvalOutcome(result))
    } catch (e) {
      fail(ipcErrorMessage(e))
    }
  }

  const decline = async () => {
    setPhase('submitting')
    setDeclineSending(true)
    setError(undefined)
    try {
      await resolveApproval(a.id, false, reason.trim() || undefined)
      hold(false)
    } catch (e) {
      setError(ipcErrorMessage(e))
      setPhase('failed')
    } finally {
      setDeclineSending(false)
    }
  }

  const acceptConsent = async (request: ConsentRequest) => {
    setConsent(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      fail(ipcErrorMessage(e))
      return
    }
    await approve()
  }

  const close = () => {
    if (phase === 'submitting') return
    if (phase === 'declining' || phase === 'confirming') return setPhase('review')
    if (phase === 'failed' || phase === 'done' || !pending) {
      hold(false)
      setPhase('review')
      return
    }
    hold(false)
    deferApproval(a.id)
  }

  if (consent) {
    return (
      <ConsentDialog
        request={consent}
        onAccept={() => void acceptConsent(consent)}
        onCancel={() => {
          setConsent(undefined)
          hold(false)
        }}
      />
    )
  }

  const ownerName = storyboard?.name ?? sequence?.name ?? a.sequenceName
  /** "Can't be generated" a video, "Can't be done" an edit or a voice, "Can't be deleted" a removal. */
  const cannot =
    removal !== undefined ? 'Can’t be deleted' : editRequest !== undefined ? 'Can’t be done' : 'Can’t be generated'
  const subtitle = [
    approvalTitle(a, ownerName),
    pending ? expiresText(expiresAt, now) : undefined,
    position && position.total > 1 ? `${position.index} of ${position.total} waiting` : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  const footer =
    phase === 'confirming' && removal ? (
      <>
        <span className="mr-auto text-[13px]">{removal.confirm ?? 'Continue?'}</span>
        <button onClick={() => setPhase('review')} className={secondary}>
          Back
        </button>
        <button
          autoFocus
          onClick={() => void approve()}
          disabled={!!blocking || !pending || expired || !armed || deleteCheckPending}
          title={blocking ? `${cannot}: ${blocking}` : undefined}
          className={primary}
        >
          Yes, delete
        </button>
      </>
    ) : phase === 'confirming' ? (
      <>
        <span className="mr-auto text-[13px]">
          {a.priceUsd === undefined
            ? 'There’s no price for this in advance. Continue?'
            : partialPrice
              ? `It costs at least ${formatUsd(a.priceUsd)} – part of it has no price in advance. Continue?`
              : `This costs ${formatUsd(a.priceUsd)}. Continue?`}
        </span>
        <button onClick={() => setPhase('review')} className={secondary}>
          Back
        </button>
        <button
          autoFocus
          onClick={() => void approve()}
          disabled={!!blocking || !pending || expired || consentMissing || !armed}
          className={primary}
        >
          Yes, continue
        </button>
      </>
    ) : phase === 'declining' ? (
      <>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void decline()}
          placeholder="Why? (optional – the agent gets to see it)"
          className="min-w-0 flex-1 rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted"
        />
        <button onClick={() => setPhase('review')} className={secondary}>
          Back
        </button>
        <button onClick={() => void decline()} className={secondary}>
          Decline
        </button>
      </>
    ) : phase === 'done' ? (
      <button onClick={close} className={secondary}>
        {othersWaiting ? 'Show the next request' : 'Close'}
      </button>
    ) : !pending && phase === 'review' ? (
      // Lapsed or replaced while it was on screen: nothing to approve here; the next one is opened on purpose.
      <button onClick={close} className={secondary}>
        {othersWaiting ? 'Show the next request' : 'Close'}
      </button>
    ) : phase === 'failed' ? (
      <>
        <button onClick={close} className={pending ? `mr-auto ${secondary}` : secondary}>
          Close
        </button>
        {pending && (
          <button
            onClick={() => void approve()}
            disabled={!!blocking || !armed || framesPending || consentMissing}
            className={primary}
          >
            Try again
          </button>
        )}
      </>
    ) : (
      <>
        <button
          onClick={close}
          disabled={phase === 'submitting'}
          title="Let the request wait – you’ll find it under Agent in the sidebar"
          className="mr-auto text-[12px] text-muted transition hover:text-text disabled:opacity-40"
        >
          Later
        </button>
        <button onClick={() => setPhase('declining')} disabled={phase === 'submitting'} className={secondary}>
          {declineSending ? 'Declining…' : 'Decline'}
        </button>
        <button
          onClick={() => (bigPrice || removal?.confirm ? setPhase('confirming') : void approve())}
          disabled={
            phase === 'submitting' ||
            !!blocking ||
            !pending ||
            expired ||
            !armed ||
            framesPending ||
            editPlanPending ||
            deleteCheckPending ||
            consentMissing
          }
          title={
            blocking
              ? `${cannot}: ${blocking}`
              : expired
                ? 'The request has expired – ask the agent to ask again'
                : framesPending
                  ? 'Fetching the start and end images…'
                  : editPlanPending
                    ? 'Reading the edit…'
                    : deleteCheckPending
                      ? 'Checking that nothing has changed…'
                      : consentMissing
                        ? 'Tick that you have the right to use the voice first'
                        : !armed
                          ? 'Read through the request first'
                          : undefined
          }
          className={primary}
        >
          <span>
            {phase === 'submitting' && !declineSending
              ? image !== undefined
                ? 'Creating the image…'
                : removal !== undefined
                  ? 'Deleting…'
                  : a.kind === 'edit' || a.kind === 'song-lyrics'
                    ? 'Starting…'
                    : 'Sending…'
              : approveLabel(a)}
          </span>
          {(phase !== 'submitting' || declineSending) && a.priceUsd !== undefined && (
            <span className="text-white/80">{approvalPriceText(a, priceShown)}</span>
          )}
        </button>
      </>
    )

  return (
    <Modal
      title={`${agentDisplayName(a.client)} ${approvalHeading(a)}`}
      subtitle={subtitle}
      onClose={close}
      footer={footer}
      maxWidth={620}
    >
      <div className="space-y-5">
        {error && (
          <p
            role="alert"
            className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed select-text ${noticeTones.error}`}
          >
            {error}
          </p>
        )}
        {!pending && phase !== 'failed' && phase !== 'submitting' && (
          <p className="rounded-md border border-line bg-raised px-3 py-2 text-[12px] text-muted">{approvalOutcome(a)}</p>
        )}
        {phase === 'done' && madeStill && (
          <MadeStill stillId={madeStill} sequenceId={a.sequenceId} inStoryboard={!!storyboardId} />
        )}

        {a.note && (
          <div className="rounded-md border border-line bg-raised/60 px-3 py-2.5">
            <p className="mb-1 text-[11px] text-muted">{agentDisplayName(a.client)} writes:</p>
            <p className="whitespace-pre-wrap leading-relaxed select-text">{a.note}</p>
          </div>
        )}

        {sequenceError && a.sequenceId && !storyboardId && (
          <p className="text-[12px] text-danger">The sequence couldn’t be read: {sequenceError}</p>
        )}
        {storyboardError && storyboardId && (
          <p className="text-[12px] text-danger">The storyboard couldn’t be read: {storyboardError}</p>
        )}

        {image && (
          <ImageSummary
            image={image}
            sequenceName={ownerName}
            hasSequence={!!a.sequenceId}
            inStoryboard={!!storyboardId}
            clipNumber={imageTarget?.clipNumber}
            boardTarget={
              image.assignToBoard
                ? (boardTarget ?? { number: image.assignToBoard.boardNumber })
                : undefined
            }
          />
        )}
        {image === null && <p className="text-danger">The request doesn’t say anything about the image.</p>}

        {editRequest && a.kind === 'edit' && editRequest.resumeJobId && (
          <ResumeSummary approval={a} request={editRequest} state={editState} />
        )}
        {editRequest && a.kind === 'edit' && !editRequest.resumeJobId && (
          <EditSummary
            approval={a}
            request={editRequest}
            state={editState}
            assets={assets}
            consent={cloneConsent}
            onConsent={setCloneConsent}
          />
        )}
        {editRequest && a.kind === 'voice-design' && <VoiceDesignSummary request={editRequest} />}
        {editRequest === null && <p className="text-danger">The request doesn’t say anything about the change.</p>}

        {removal && <DeleteSummary approval={a} request={removal} check={deleteCheck} />}
        {removal === null && <p className="text-danger">The request doesn’t say what should be deleted.</p>}

        {songRequest && <SongLyricsSummary request={songRequest} />}
        {songRequest === null && <p className="text-danger">The request doesn’t say which song.</p>}

        {clips.map((clip) => (
          <ClipSummary
            key={clip.key}
            clip={clip}
            models={models}
            photos={photos}
            voices={voices}
            compact={clips.length > 1}
            frames={clip === frameClip ? frames : undefined}
          />
        ))}
        {transitions.map((view) => (
          <TransitionSummary
            key={view.key}
            view={view}
            models={models}
            aspectRatio={storyboard?.aspectRatio}
            compact={transitions.length > 1}
          />
        ))}
        {a.kind === 'generate-all' && sequence && !clips.length && (
          <p className="text-muted">Every clip in the sequence already has a finished take.</p>
        )}
        {a.kind === 'generate-all' && storyboard && !transitions.length && (
          <p className="text-muted">Every transition in the storyboard already has a finished take.</p>
        )}
        {a.kind !== 'generation' &&
          image === undefined &&
          editRequest === undefined &&
          removal === undefined &&
          songRequest === undefined &&
          !storyboardId &&
          !sequence &&
          !sequenceError &&
          !clips.length && <p className="text-muted">Reading the sequence…</p>}
        {storyboardId && a.kind === 'generate-all' && !storyboard && !storyboardError && (
          <p className="text-muted">Reading the storyboard…</p>
        )}

        {/* A removal costs nothing; its panel ends with what happens to the files instead. */}
        {removal === undefined && (
          <div className="flex items-baseline justify-between gap-4 border-t border-line pt-4">
            <span className="text-muted">
              {clips.length > 1
                ? `Total for ${clips.length} clips`
                : transitions.length > 1
                  ? `Total for ${transitions.length} transitions`
                  : variantCount(a) > 1
                    ? 'Total'
                    : 'Cost'}
              <span className="ml-1.5 text-[11px]">(charged to your {SERVICE_NAME} account)</span>
            </span>
            {/* "3 variants · $3.09": each variant is its own generation at the full price. */}
            <span className="shrink-0 whitespace-nowrap text-lg font-semibold tabular-nums">
              {approvalPriceText(a, priceShown)}
            </span>
          </div>
        )}
        {overBudget && removal === undefined && (
          <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2.5 text-[12px] leading-relaxed">
            <p className="text-danger">
              <span className="font-medium">Over your {overBudget.period === 'day' ? 'daily' : 'monthly'} budget.</span>{' '}
              {overBudgetText(overBudget, 'This takes')} Approving sends it anyway.
            </p>
            <BudgetMeter
              className="mt-2"
              label={overBudget.period === 'day' ? 'Today' : 'This month'}
              spentUsd={overBudget.spentUsd}
              pendingUsd={overBudget.pendingUsd}
              amountUsd={overBudget.amountUsd}
              capUsd={overBudget.budgetUsd}
            />
          </div>
        )}
        {phase === 'submitting' && image !== undefined && (
          <p className="text-[12px] text-muted">{SERVICE_NAME} is creating the image – it usually takes 10–30 seconds.</p>
        )}
        {/* A removal says what changed at the top of its list (DeleteSummary). */}
        {blocking && removal === undefined && (
          <p className="text-[12px] text-danger">
            {cannot} as it looks now: {blocking.replace(/\.$/, '')}. Ask {agentInSentence(a.client)} to{' '}
            {askAgain ? 'ask again' : 'fix it'}, or decline.
          </p>
        )}
      </div>
    </Modal>
  )
}

/**
 * Where approving a request that costs `priceUsd` would take the spending past the user's budget, read when the request
 * is shown (and again when its price changes); undefined within the budget, without one, or while `active` is false.
 */
function useOverBudget(priceUsd: number | undefined, active: boolean): OverBudget | undefined {
  const [over, setOver] = useState<OverBudget>()
  useEffect(() => {
    setOver(undefined)
    if (!active) return
    let alive = true
    window.studio.getSpending().then(
      (s) => {
        if (alive) setOver(overBudgetFor(priceUsd, s, s.budget))
      },
      () => {
        // Only a warning: without the spending the request is shown as it is.
      }
    )
    return () => {
      alive = false
    }
  }, [priceUsd, active])
  return over
}

// ── What will be generated ──────────────────────────────────────────────────

function photoIndex(assets: readonly Asset[]): Map<string, Photo> {
  const map = new Map<string, Photo>()
  for (const asset of assets) asset.images.forEach((img, i) => map.set(img.path, { asset, number: i + 1 }))
  return map
}

interface Clip {
  key: string
  /** "Clip 3"; undefined for the Generate form. */
  title?: string
  /** What will be sent (inputs the mode doesn't use are dropped). */
  params: GenerationParams
  /** The params as checked (before inputs were dropped), for the warnings once the legend is known. */
  checked: GenerationParams
  /** The start frame comes from the previous clip's end, so there is no start image yet. */
  continuesFrom?: number
  /** The end frame comes from this (next) clip's first frame ("End on the next clip's first frame"). */
  endsAt?: number
  blocking?: string
  warnings: string[]
  /**
   * What Studio appends to the prompt when it is sent: the References legend of the referenced assets'
   * descriptions (without the blank line before it). For a request that captured its prompt ('generation',
   * 'segment'), the legend it was made with; otherwise the one the library gives now.
   */
  legend?: string
  /** Characters of the prompt as it is sent (prompt plus legend). */
  sentLength?: number
  /** The model's prompt limit, which the legend was fitted into. */
  limit?: number
  /** The library now gives another legend than the request was made with (a description changed meanwhile). */
  descriptionsChanged?: boolean
}

/** Why a request with a composed prompt can't be approved once a description has changed. */
const DESCRIPTIONS_CHANGED =
  'A description that is added to the prompt has changed since the agent asked, so what would be sent is no longer what you see here'

interface Composer {
  /**
   * The prompt as main sends it (src/shared/prompt-compose.ts): canonical tokens, the inputs the model takes, the
   * params' own description switches, the prompt language and the model's prompt limit.
   */
  compose: (params: GenerationParams, ownerDirector?: string, continuationFrame?: boolean) => ComposedPrompt
  /** The model's prompt limit (prompt_character_limit), when it has one. */
  limitOf: (modelId: string) => number | undefined
}

function makeComposer(assets: readonly Asset[], language: PromptLanguage, models: readonly VideoModel[]): Composer {
  const described = describedAssets(assets)
  const limits = new Map(models.map((m) => [m.id, m.promptCharacterLimit]))
  const limitOf = (modelId: string): number | undefined => limits.get(modelId) || undefined
  return {
    limitOf,
    compose: (params, ownerDirector, continuationFrame) => {
      // Directed as main composes it: its style frames and videos among the references (withDirection is idempotent,
      // so params a request or a clip's effectiveParams directed already stay as they are), its Direction section after
      // the legend.
      const director = resolveDirector(effectiveDirectorId(params.director, ownerDirector), assets)
      const sent = paramsForSubmit(canonicalizeParams(withDirection(params, director, { continuationFrame })))
      return composePrompt(sent, described, {
        ...composeOptionsFor(sent, language, limitOf(sent.model)),
        ...(director ? { director } : {})
      })
    }
  }
}

/** The legend as the dialog shows it: the text after the user's prompt, without the blank line in front. */
const shownLegend = (legend: string | undefined): string | undefined => legend?.replace(/^\s+/, '') || undefined

/**
 * The clips with what is appended to their prompts. A request that captured its prompt shows the legend it was
 * made with and is marked when the library would now compose another one (main would refuse it); the clips of
 * "generate all" are read live, so they show today's legend, marked when it isn't the one the request was made
 * with (main refuses that too).
 */
function withDescriptions(
  clips: Clip[],
  a: ApprovalRequest,
  composer: Composer | undefined,
  sequence?: Sequence
): Clip[] {
  const captured = (a.kind === 'generation' || a.kind === 'segment') && !!a.params
  const legends = a.kind === 'generate-all' ? a.clipLegends : undefined
  // A sequence's clips follow its director unless they choose their own (Generate's form has none to follow).
  const owner = a.kind === 'generation' ? undefined : sequence?.director
  return clips.map((asked) => {
    // A clip continuing in reference mode keeps the previous clip's frame last: no style frames (as main sends it).
    const framed = asked.continuesFrom !== undefined && kindOfModelId(asked.params.model) === 'reference-to-video'
    const live = composer?.compose(asked.params, owner, framed)
    const limit = composer?.limitOf(asked.params.model)
    // A reference the legend explains (its description, or who wears an outfit) isn't warned about as unmentioned.
    const clip = live ? { ...asked, warnings: warningsOf(asked.checked, explainedReferences(live)) } : asked
    if (captured) {
      const legend = shownLegend(a.descriptionLegend)
      return {
        ...clip,
        legend,
        sentLength: (a.composedPrompt ?? clip.params.prompt).length,
        ...(limit ? { limit } : {}),
        // Legends compared rather than whole prompts: the request's prompt is canonical, the clip's may not be.
        descriptionsChanged: !!live && shownLegend(live.legend) !== legend
      }
    }
    if (!live) return clip
    const legend = shownLegend(live.legend)
    const then = legends?.[clip.key]
    return {
      ...clip,
      legend,
      sentLength: live.prompt.length,
      ...(limit ? { limit } : {}),
      ...(then !== undefined ? { descriptionsChanged: legend !== shownLegend(then) } : {})
    }
  })
}

/** The prompt checks' advice (not blocking) for params, as the dialog lists it. */
function warningsOf(params: GenerationParams, explained?: ValidateOptions['explained']): string[] {
  return promptIssuesOf(params, explained)
    .filter((i) => i.severity === 'warning')
    .map((i) => i.message)
}

function clipOf(
  key: string,
  params: GenerationParams,
  title?: string,
  continuesFrom?: number,
  endsAt?: number
): Clip {
  return {
    key,
    title,
    params: paramsForSubmit(params),
    checked: params,
    continuesFrom,
    endsAt,
    blocking: blockingPromptIssue(params),
    warnings: warningsOf(params)
  }
}

/** The number of the clip whose first frame the segment ends on, when it takes its end image from the next clip. */
function endsAtClip(segment: Segment, index: number, count: number): number | undefined {
  return segment.endFromNext && index < count - 1 ? index + 2 : undefined
}

function segmentClip(segment: Segment, index: number, sequence: Sequence): Clip {
  const count = sequence.segments.length
  const continuing = segment.continueFromPrevious && index > 0
  const endsAt = endsAtClip(segment, index, count)
  // The last clip has no next one to end on, so main generates it as it is (its model, its references).
  const own = endsAt === undefined && segment.endFromNext ? { ...segment, endFromNext: false } : segment
  // With the sequence, a continuation shows as main sends it: in reference mode with the references it carries.
  return clipOf(
    segment.id,
    effectiveParams(own, index, sequence),
    `Clip ${index + 1}`,
    continuing ? index : undefined,
    endsAt
  )
}

/** The clips a request would generate, in order (none for an image request, an edit, a voice or a removal). */
function clipsOf(a: ApprovalRequest, sequence: Sequence | undefined): Clip[] {
  if (a.kind === 'image' || a.kind === 'edit' || a.kind === 'voice-design' || a.kind === 'delete') return []
  if (a.kind === 'song-lyrics') return []
  if (a.kind === 'generation') return a.params ? [clipOf(a.id, a.params)] : []
  const count = sequence?.segments.length ?? 0
  const indexed = sequence?.segments.map((segment, index) => ({ segment, index })) ?? []
  if (a.kind === 'segment') {
    const hit = indexed.find(({ segment }) => segment.id === a.segmentIds?.[0])
    const number = hit ? hit.index + 1 : a.clipNumbers?.[0]
    const continuesFrom = hit && hit.segment.continueFromPrevious && hit.index > 0 ? hit.index : undefined
    const endsAt = hit ? endsAtClip(hit.segment, hit.index, count) : undefined
    // Main submits exactly the settings in the request (and refuses if the clip has changed since).
    if (a.params) return [clipOf(a.id, a.params, number ? `Clip ${number}` : undefined, continuesFrom, endsAt)]
    return hit && sequence ? [segmentClip(hit.segment, hit.index, sequence)] : []
  }
  if (!sequence) return []
  const ids = a.segmentIds
  const chosen = ids?.length
    ? indexed.filter(({ segment }) => ids.includes(segment.id))
    : indexed.filter(({ segment }) => needsTake(segment) && !pendingTake(segment))
  return chosen.map(({ segment, index }) => segmentClip(segment, index, sequence))
}

function ClipSummary({
  clip,
  models,
  photos,
  voices,
  compact,
  frames
}: {
  clip: Clip
  models: VideoModel[]
  photos: ReadonlyMap<string, Photo>
  /** Library audio clips by path, to name the voices and soundscapes that are sent. */
  voices: ReadonlyMap<string, AudioSource>
  compact: boolean
  /** The automatic start and end frames as they are now (one clip's request). */
  frames?: SegmentFramePreview
}) {
  const p = clip.params
  const model = models.find((m) => m.id === p.model)
  const kind = kindOfModelId(p.model)
  const mode = KINDS.find((k) => k.id === kind)?.label
  // The picture or clip ("image:2", "audio:1") hovered among the tiles or in the texts: its tokens and tile light up.
  const [lit, setLit] = useState<string>()
  const light = (key: string | undefined) => (on: boolean) => setLit((cur) => (on ? key : cur === key ? undefined : cur))
  const refs = p.referenceImages ?? []
  // The reference images as asked for: those past the model's limit aren't sent (paramsForSubmit cut them off), but
  // a token naming one still shows which picture it is, and why it isn't sent.
  const listed = kind === 'reference-to-video' ? (clip.checked.referenceImages ?? refs) : refs
  const unsent = `Not sent – the model takes at most ${maxReferenceImages(p.model)} images`
  const targets: TokenTarget[] = listed.map((path, i) => {
    const photo = photos.get(path)
    return {
      kind: photo?.asset.kind,
      label: photo ? `${photo.asset.name} (photo ${photo.number})` : fileName(path),
      path,
      name: photo?.asset.name,
      number: photo?.number,
      count: photo?.asset.images.length,
      ...(i >= refs.length ? { unsent } : {})
    }
  })
  // Only what is sent: paramsForSubmit already dropped audio the model doesn't take (and past its limit).
  const audios = formAudios(p.referenceAudios ?? [], voices, Infinity, true)
  const audioTargets: TokenTarget[] = audios.map((a) => ({
    kind: a.source?.asset.kind,
    label: audioLabel(a),
    path: a.path,
    name: a.source?.asset.name,
    number: a.source?.clip,
    count: a.source ? audioClipsOf(a.source.asset).length : undefined,
    window: { start: a.start, length: a.length }
  }))
  // The reference videos as asked for (the Editor's video to edit is no reference): those past the family's count
  // aren't sent (paramsForSubmit cut them off), but a token naming one still shows which video it is, and why.
  const askedVideos =
    kind === 'reference-to-video' && videosAreReferences(clip.checked) ? referenceVideosOf(clip.checked) : []
  const sentVideos = referenceVideosOf(p).length
  const videoLimits = referenceVideoLimits(p.model)
  const videoFacts = useVideoFacts(askedVideos.map((v) => v.path))
  const videos = askedVideos.map((v, i) => {
    const w = referenceVideoWindow(v, videoFacts.get(v.path)?.duration)
    const { name, detail } = videoLabelParts({ path: v.path, facts: videoFacts.get(v.path) })
    const unsent =
      i >= sentVideos
        ? videoLimits
          ? `Not sent – ${videoLimits.family} takes at most ${videoCount(videoLimits.maxVideos)}`
          : 'Not sent – the model takes no reference videos'
        : undefined
    return { index: i + 1, path: v.path, ...w, name, detail, unsent }
  })
  const videoTargets: TokenTarget[] = videos.map((v) => ({
    label: `${v.name} · ${v.detail}`,
    path: v.path,
    name: v.name,
    detail: v.detail,
    window: { start: v.start, length: v.length },
    ...(v.unsent ? { unsent: v.unsent } : {})
  }))
  // The neighbours' frames, when the start or end image is taken from them.
  const startFrame = frames?.start?.source === 'previous' ? frames.start.path : undefined
  const endFrame = frames?.end?.source === 'next' ? frames.end.path : undefined
  const settings = [
    model?.name ?? p.model,
    mode,
    p.duration,
    p.resolution,
    p.aspectRatio,
    p.audio === undefined ? undefined : p.audio ? 'with sound' : 'without sound'
  ].filter(Boolean)

  return (
    <section className={compact ? 'rounded-lg border border-line p-3' : ''}>
      {clip.title && <h3 className="mb-1.5 font-medium">{clip.title}</h3>}
      <p className="mb-3 text-[12px] text-muted">{settings.join(' · ')}</p>

      <Label>Prompt</Label>
      {p.prompt.trim() ? (
        <PromptText
          prompt={p.prompt}
          targets={targets}
          audioTargets={audioTargets}
          videoTargets={videoTargets}
          highlighted={lit}
          onHighlight={setLit}
          className={`overflow-y-auto rounded-md border border-line bg-raised px-3 py-2 ${compact ? 'max-h-32' : 'max-h-60'}`}
        />
      ) : (
        <p className="text-danger">The prompt is empty.</p>
      )}

      {clip.legend && (
        <DescriptionLegend
          legend={clip.legend}
          targets={targets}
          audioTargets={audioTargets}
          videoTargets={videoTargets}
          highlighted={lit}
          onHighlight={setLit}
          sentLength={clip.sentLength}
          limit={clip.limit}
          changed={clip.descriptionsChanged}
          compact={compact}
        />
      )}

      {p.negativePrompt && (
        <>
          <Label className="mt-3">Negative prompt</Label>
          <p className="whitespace-pre-wrap text-muted select-text">{p.negativePrompt}</p>
        </>
      )}

      {kind === 'reference-to-video' && refs.length > 0 && (
        <>
          <Label className="mt-3">Reference images</Label>
          <div className="flex flex-wrap gap-2">
            {refs.map((path, i) => {
              const key = markKey('image', i + 1)
              return (
                <ImageTile
                  key={path}
                  path={path}
                  badge={`@Image${i + 1}`}
                  photo={photos.get(path)}
                  lit={lit === key}
                  onLight={light(key)}
                />
              )
            })}
          </div>
        </>
      )}

      {videos.length > 0 && (
        <>
          <Label className="mt-3">Reference videos</Label>
          <div className="flex flex-wrap gap-2">
            {videos.map((v) => {
              const key = markKey('video', v.index)
              return (
                <VideoTile
                  key={`${v.path}:${v.start}:${v.length}`}
                  path={v.path}
                  badge={`@Video${v.index}`}
                  start={v.start}
                  length={v.length}
                  caption={v.name}
                  windowText={windowLabel(v)}
                  unsent={v.unsent}
                  lit={lit === key}
                  onLight={light(key)}
                />
              )
            })}
          </div>
        </>
      )}

      {kind === 'reference-to-video' && audios.length > 0 && (
        <>
          <Label className="mt-3">Voices & sound</Label>
          <ul className="space-y-1">
            {audios.map((a) => {
              const key = markKey('audio', a.index)
              return (
                <AudioRow
                  key={`${a.path}:${a.start}:${a.length}`}
                  audio={a}
                  lit={lit === key}
                  onLight={light(key)}
                />
              )
            })}
          </ul>
        </>
      )}

      {kind === 'image-to-video' && (
        <>
          <Label className="mt-3">Start image{p.endImage || clip.endsAt ? ' and end image' : ''}</Label>
          <div className="flex flex-wrap items-start gap-3">
            {clip.continuesFrom ? (
              <AutoFrame
                badge="Start"
                preview={!!frames}
                path={startFrame}
                text={`The last frame of clip ${clip.continuesFrom}${frameTime(frames?.start?.time)}`}
              />
            ) : p.startImage ? (
              <ImageTile path={p.startImage} badge="Start" photo={photos.get(p.startImage)} />
            ) : (
              <p className="text-[12px] text-danger">No start image.</p>
            )}
            {clip.endsAt ? (
              <AutoFrame
                badge="End"
                preview={!!frames}
                path={endFrame}
                text={`The first frame of clip ${clip.endsAt}${frameTime(frames?.end?.time)}`}
              />
            ) : (
              p.endImage && <ImageTile path={p.endImage} badge="End" photo={photos.get(p.endImage)} />
            )}
          </div>
        </>
      )}

      {(clip.blocking || clip.warnings.length > 0 || (frames?.problems.length ?? 0) > 0) && (
        <ul className="mt-3 space-y-1 text-[12px]">
          {clip.blocking && <li className="text-danger">{clip.blocking}</li>}
          {frames?.problems
            .filter((problem) => problem !== clip.blocking)
            .map((problem) => (
              <li key={problem} className="text-danger">
                {problem}
              </li>
            ))}
          {clip.warnings.map((w) => (
            <li key={w} className="text-warning">
              {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * What Studio appends to the prompt when it is sent – the descriptions of the referenced assets as a References
 * legend – set apart from the agent's prompt above it (a dashed box of its own), with its tokens coloured like
 * the prompt's and the length that is sent.
 */
function DescriptionLegend({
  legend,
  targets,
  audioTargets,
  videoTargets,
  highlighted,
  onHighlight,
  sentLength,
  limit,
  changed,
  compact
}: {
  legend: string
  targets: TokenTarget[]
  audioTargets: TokenTarget[]
  videoTargets: TokenTarget[]
  /** As for PromptText: the tokens lit with the prompt's and the tiles'. */
  highlighted?: string
  onHighlight: (key: string | undefined) => void
  sentLength?: number
  limit?: number
  /** The library gives another legend by now (a description was edited after the request). */
  changed?: boolean
  compact: boolean
}) {
  const count = (n: number): string => n.toLocaleString('en-GB')
  return (
    <div className={`mt-2 rounded-md border border-dashed px-3 py-2 ${changed ? 'border-accent/60' : 'border-line'}`}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span>
          Added to the prompt ·{' '}
          {/^(References|Referenser):/.test(legend)
            ? /\n(Direction|Regi)\b[^\n]*:\n/.test(legend)
              ? 'the References legend and the direction'
              : 'the References legend'
            : /^(Direction|Regi)\b/.test(legend)
              ? 'the direction'
              : 'the References legend'}
        </span>
        {sentLength !== undefined && (
          <span
            className="ml-auto tabular-nums"
            title="This many characters are sent: the prompt and the descriptions together"
          >
            {limit ? `${count(sentLength)} of ${count(limit)} characters` : `${count(sentLength)} characters`}
          </span>
        )}
      </div>
      <PromptText
        prompt={legend}
        targets={targets}
        audioTargets={audioTargets}
        videoTargets={videoTargets}
        highlighted={highlighted}
        onHighlight={onHighlight}
        className={`overflow-y-auto text-[12px] text-muted ${compact ? 'max-h-24' : 'max-h-40'}`}
      />
      {changed && (
        <p className="mt-1.5 text-[11px] leading-snug text-warning">
          A description has changed since the agent asked – this is what would have been sent then.
        </p>
      )}
    </div>
  )
}

function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mb-1.5 text-[11px] text-muted ${className}`}>{children}</p>
}

/** " (0:07.5)": where in the neighbour's take an automatic frame is taken, when main said. */
function frameTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = (seconds - m * 60).toFixed(1).padStart(4, '0')
  return ` (${m}:${s})`
}

/** The picture an approved image request made, as it was saved among the sequence's stills. */
function MadeStill({ stillId, sequenceId, inStoryboard }: { stillId: string; sequenceId?: string; inStoryboard: boolean }) {
  const [path, setPath] = useState<string | null>()
  useEffect(() => {
    let active = true
    window.studio.listStills(sequenceId).then(
      (stills) => active && setPath(stills.find((s) => s.id === stillId)?.path ?? null),
      () => active && setPath(null)
    )
    return () => {
      active = false
    }
  }, [stillId, sequenceId])
  if (path === undefined) return null
  if (path === null) {
    return (
      <p className="text-[12px] text-muted">
        {sequenceId
          ? inStoryboard
            ? 'The image is saved among the storyboard’s images.'
            : 'The image is saved among the sequence’s images.'
          : 'The image is saved in “Reference images”.'}
      </p>
    )
  }
  return (
    <div>
      <Label>The new image</Label>
      <img
        src={mediaUrl(path)}
        alt=""
        draggable={false}
        className="max-h-72 w-full rounded-md border border-line bg-raised object-contain"
      />
    </div>
  )
}

/** A start or end frame taken from a neighbouring clip when the take is generated: its preview, or what it is. */
function AutoFrame({
  badge,
  path,
  text,
  preview
}: {
  badge: string
  path?: string
  text: string
  /** The frame can be previewed (one clip's request); otherwise the neighbour's take is still to be made. */
  preview: boolean
}) {
  if (!preview) return <p className="text-[12px] text-muted">{text}.</p>
  return (
    <div className="w-40 space-y-1">
      {path ? (
        <ImageTile path={path} badge={badge} caption="Preview" title={text} large />
      ) : (
        <div className="flex h-24 w-40 items-center justify-center rounded border border-dashed border-line px-2 text-center text-[11px] text-muted">
          No preview yet
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted">{text}</p>
    </div>
  )
}

/**
 * Where an image request's picture goes, as the loaded sequence has the clip now: its number, and why the request
 * no longer applies when the clip is gone or has moved (main refuses it then too). Undefined without a target, or
 * while the sequence is being read.
 */
function imageTargetNow(
  target: ApprovalImageRequest['assignTo'],
  sequence: Sequence | undefined
): { clipNumber?: number; problem?: string } | undefined {
  if (!target || !sequence) return undefined
  const index = sequence.segments.findIndex((s) => s.id === target.segmentId)
  if (index === -1) return { problem: 'The clip the image was meant for is gone' }
  if (index + 1 !== target.clipNumber) {
    return {
      clipNumber: index + 1,
      problem: `The clip has moved since the agent asked (it was clip ${target.clipNumber}, now clip ${index + 1})`
    }
  }
  return { clipNumber: index + 1 }
}

/** What an image request makes: prompt, references (the first is the base picture), model, format and target. */
function ImageSummary({
  image,
  sequenceName,
  hasSequence,
  inStoryboard,
  clipNumber,
  boardTarget
}: {
  image: ApprovalImageRequest
  sequenceName?: string
  /** The picture is saved with a sequence or storyboard (else among the stills of none, in Reference images). */
  hasSequence: boolean
  /** It is saved with a storyboard. */
  inStoryboard: boolean
  /** The target clip's number as the sequence is now. */
  clipNumber?: number
  /** The board it becomes, as the storyboard is now. */
  boardTarget?: BoardTarget
}) {
  const p = image.params
  const safeMode = useImageSafeMode()
  const references = image.references
  const settings = [
    image.modelName ?? p.model,
    references.length ? `image from ${references.length === 1 ? '1 reference' : `${references.length} references`}` : 'image from text',
    p.aspectRatio,
    p.resolution,
    p.quality ? `quality ${p.quality}` : undefined
  ].filter(Boolean)
  const target = image.assignTo
  const where = sequenceName ? ` in “${sequenceName}”` : ''

  return (
    <section>
      <p className="mb-3 text-[12px] text-muted">{settings.join(' · ')}</p>

      <Label>Prompt</Label>
      {p.prompt.trim() ? (
        <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 leading-relaxed select-text">
          {p.prompt}
        </p>
      ) : (
        <p className="text-danger">The prompt is empty.</p>
      )}

      {p.negativePrompt && (
        <>
          <Label className="mt-3">Negative prompt</Label>
          <p className="whitespace-pre-wrap text-muted select-text">{p.negativePrompt}</p>
        </>
      )}

      {references.length > 0 && (
        <>
          <Label className="mt-3">Reference images (the first is the base the image is built on)</Label>
          <div className="flex flex-wrap gap-2">
            {references.map((ref, i) => (
              <ImageTile
                key={`${ref.path}:${i}`}
                path={ref.path}
                badge={i === 0 ? '1 · base' : String(i + 1)}
                caption={ref.name ?? ref.label}
                title={ref.label}
                captionTone={ref.kind && ref.kind !== 'still' ? KIND_TONE[ref.kind].caption : undefined}
                kind={ref.kind && ref.kind !== 'still' ? ref.kind : undefined}
              />
            ))}
          </div>
        </>
      )}

      {boardTarget && <BoardTargetSummary target={boardTarget} storyboardName={sequenceName} />}

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        {[
          // A board's place is said next to its picture above.
          boardTarget
            ? undefined
            : target
              ? `The image is saved among the sequence’s images and becomes the ${slotName(target.slot)} of clip ${clipNumber ?? target.clipNumber}${where}.`
              : hasSequence
                ? inStoryboard
                  ? `The image is saved among the storyboard’s images${where}.`
                  : `The image is saved among the sequence’s images${where}.`
                : 'The image belongs to no sequence or storyboard and is saved in “Reference images”, among all images.',
          safeMode === undefined
            ? undefined
            : safeMode
              ? `Safe mode is on: ${safeModeEffect(true)}.`
              : `Safe mode is off: ${safeModeEffect(false)}.`
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
    </section>
  )
}

/**
 * One reference audio clip that will be sent: its token, whose voice or sound it is, the window, a play button.
 * `lit` while a token naming it is hovered; `onLight` while it is hovered itself.
 */
function AudioRow({ audio, lit, onLight }: { audio: FormAudio; lit?: boolean; onLight?: (on: boolean) => void }) {
  const token = `@Audio${audio.index}`
  const { name, detail } = audioLabelParts(audio)
  const tone = audio.source ? KIND_TONE[audio.source.asset.kind].text : 'text-text'
  return (
    <li
      onMouseEnter={() => onLight?.(true)}
      onMouseLeave={() => onLight?.(false)}
      onFocus={() => onLight?.(true)}
      onBlur={() => onLight?.(false)}
      className={`flex items-center gap-2 rounded-md border bg-raised px-2 py-1.5 text-[12px] transition-colors ${
        lit ? 'border-white/50' : 'border-line'
      }`}
    >
      <AudioPlayButton path={audio.path} start={audio.start} length={audio.length} label={`${token} (${name})`} />
      <span className="rounded bg-black/40 px-1 text-[10px]">{token}</span>
      <span className={`truncate font-medium ${tone}`} title={audio.path}>
        {name}
      </span>
      <span className="truncate text-muted">{detail}</span>
      <span className="ml-auto shrink-0 tabular-nums text-muted">{windowLabel(audio)}</span>
    </li>
  )
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/**
 * "Prompt language" from Settings (the legend's words: "References" or "Referenser"); undefined until read, so a
 * legend is never compared in the wrong language. Read again when the window comes back to the front.
 */
function usePromptLanguageSetting(): PromptLanguage | undefined {
  const [language, setLanguage] = useState<PromptLanguage>()
  useEffect(() => {
    let active = true
    const read = () =>
      window.studio.getSettings().then(
        (s) => active && setLanguage(s.promptLanguage === 'sv' ? 'sv' : 'en'),
        () => {}
      )
    void read()
    window.addEventListener('focus', read)
    return () => {
      active = false
      window.removeEventListener('focus', read)
    }
  }, [])
  return language
}

/** "Safe mode for images" from Settings; undefined until read. */
function useImageSafeMode(): boolean | undefined {
  const [on, setOn] = useState<boolean>()
  useEffect(() => {
    let active = true
    const read = () =>
      window.studio.getSettings().then(
        (s) => active && setOn(s.imageSafeMode !== false),
        () => {}
      )
    void read()
    // Switched in Settings or the image dialog while the request is on screen.
    const off = window.studio.onSettingsChange(() => void read())
    return () => {
      active = false
      off()
    }
  }, [])
  return on
}

/**
 * The automatic start and end frames of a clip (from its neighbours' selected takes), kept up to date while the
 * sequence changes. `preview` is undefined while unknown or when there is no clip to preview; `loading` while an
 * answer is on its way (the first one, or a new one after the sequence changed: until then the frame shown may
 * be a neighbour's previous take).
 */
function useFramePreview(
  segmentId: string | undefined,
  sequenceId: string | undefined
): { preview?: SegmentFramePreview; loading: boolean } {
  const [state, setState] = useState<{ id?: string; preview?: SegmentFramePreview; loading: boolean }>({
    loading: false
  })
  useEffect(() => {
    if (!segmentId) return
    let active = true
    let seq = 0
    const load = () => {
      const mine = ++seq
      setState((s) => (s.id === segmentId ? { ...s, loading: true } : { id: segmentId, loading: true }))
      window.studio.previewSegmentFrames(segmentId).then(
        (preview) => active && mine === seq && setState({ id: segmentId, preview, loading: false }),
        // Only a preview: the dialog says what the frame is either way.
        () => active && mine === seq && setState({ id: segmentId, loading: false })
      )
    }
    load()
    const off = window.studio.onSequenceChange((changed) => {
      if (!sequenceId || changed === sequenceId) load()
    })
    return () => {
      active = false
      off()
    }
  }, [segmentId, sequenceId])
  if (!segmentId || state.id !== segmentId) return { loading: !!segmentId }
  return { preview: state.preview, loading: state.loading }
}

function useSequence(id: string | undefined): { sequence?: Sequence; error?: string } {
  const [state, setState] = useState<{ id?: string; sequence?: Sequence; error?: string }>({})
  useEffect(() => {
    if (!id) return
    let active = true
    const load = () =>
      window.studio.getSequence(id).then(
        (sequence) => active && setState({ id, sequence }),
        (e: unknown) => active && setState({ id, error: ipcErrorMessage(e) })
      )
    void load()
    const off = window.studio.onSequenceChange((changed) => {
      if (changed === id) void load()
    })
    return () => {
      active = false
      off()
    }
  }, [id])
  return state.id === id ? state : {}
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
