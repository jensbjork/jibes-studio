import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { KINDS, kindOfModelId, paramsForSubmit } from '@shared/models'
import { composeOptionsFor, composePrompt, describedAssets, type ComposedPrompt } from '@shared/prompt-compose'
import { canonicalizeParams } from '@shared/prompt-refs'
import type {
  ApprovalImageRequest,
  ApprovalRequest,
  Asset,
  ConsentRequest,
  GenerationParams,
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
import { ipcErrorMessage, useAssetsState, useModels } from '../../lib/hooks'
import { formatUsd, mediaUrl } from '../../lib/media'
import { blockingPromptIssue, promptIssuesOf } from '../../lib/promptIssues'
import ConsentDialog from '../ConsentDialog'
import { KIND_TONE } from '../pickers/assetKinds'
import AudioPlayButton from '../pickers/AudioPlayButton'
import {
  audioLabel,
  audioLabelParts,
  audioSourcesByPath,
  formAudios,
  windowLabel,
  type AudioSource,
  type FormAudio
} from '../pickers/audioRefs'
import Modal from '../pickers/Modal'
import { effectiveParams, needsTake, parseConsent, pendingTake } from '../sequences/sequenceUtils'
import { approvalHeading, approvalOutcome, approvalTitle, approveLabel, expiresText, slotName } from './agentText'
import { DeleteSummary, useDeleteCheck } from './DeleteApproval'
import { EditSummary, ResumeSummary, VoiceDesignSummary, useEditApproval } from './EditApproval'
import PromptText, { type TokenTarget } from './PromptText'
import {
  BoardTargetSummary,
  TransitionSummary,
  boardTargetNow,
  storyboardTransitions,
  useStoryboard,
  type BoardTarget
} from './StoryboardApproval'

/**
 * What an agent asks for that needs the user's OK waits here: paid generations (videos, pictures, Redigera's paid
 * operations, voices) and removals. Shown above every view; several requests queue up and are shown one at a time.
 * Nothing is sent to Venice until "Godkänn och generera" ("Godkänn och skapa" for a picture), and nothing is removed
 * until "Godkänn och ta bort".
 */
export default function ApprovalDialog() {
  const agent = useAgentState()
  const queue = approvalQueue(agent)
  // The request on screen stays there until the user acts on it (approves, declines, closes or puts it off),
  // also when it is sent, fails, lapses or is replaced by a newer one meanwhile: the dialog never swaps in
  // another request under their cursor. A replaced one says so, and they move on to the next themselves.
  const [shownId, setShownId] = useState<string>()
  const shown = shownId ? agent.approvals.find((a) => a.id === shownId) : undefined
  // Opening a request from the activity drawer is the user's own choice, so that one may take the screen.
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
 * confirming: an edit or a voice design above BIG_PRICE_USD, with an unknown price or a part without one asks "Det
 * här kostar … Fortsätt?" once more before it is approved (Redigera's own rule for a paid click); a removal of a
 * container (an asset, a sequence, a storyboard, an edit) or of more than 5 things asks its own question.
 */
type Phase = 'review' | 'confirming' | 'declining' | 'submitting' | 'failed' | 'done'

/** Redigera's rule for every paid click (D5): above this price a second step asks once more. */
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

const primary =
  'rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40'
const secondary = 'rounded-md border border-line px-4 py-2 transition hover:bg-raised disabled:opacity-40'

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
  // The library changed (files moved by "Städa upp" or a renamed asset come as new assets): main lists the request
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
  // A decline on its way: the buttons then say so, not the approve button's "Tar bort…" or "Skickar…".
  const [declineSending, setDeclineSending] = useState(false)
  /** The still an approved image request made. */
  const [madeStill, setMadeStill] = useState<string>()
  // Redigera's requests: an operation on an edit's version, or a new voice for a character.
  const editRequest = a.kind === 'edit' || a.kind === 'voice-design' ? (a.edit ?? null) : undefined
  const editState = useEditApproval(a)
  // A removal: what goes, checked again while it is on screen for review.
  const removal = a.kind === 'delete' ? (a.delete ?? null) : undefined
  const deleteCheck = useDeleteCheck(a, removal !== undefined && (phase === 'review' || phase === 'confirming'))
  /** "Jag har rätt att använda den här rösten", ticked in this dialog (a cloned voice needs it). */
  const [cloneConsent, setCloneConsent] = useState(false)
  const consentClip = a.kind === 'edit' ? a.edit?.needsCloneConsent : undefined
  const consentGiven =
    !!consentClip && assets.some((asset) => asset.audio?.some((x) => x.id === consentClip.audioId && x.cloneConsent))
  const consentMissing = !!consentClip && !consentGiven && !cloneConsent
  // Redigera's requests (an edit, a voice design) ask once more, as Redigera's own buttons and the voice design dialog
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
  // A still for a storyboard (Venice's image models) rather than a video.
  const image = a.kind === 'image' ? (a.image ?? null) : undefined
  const clips = useMemo(
    () => (storyboardId ? [] : withDescriptions(clipsOf(a, sequence), a, composer)),
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
    (image === null ? 'Förfrågan saknar uppgifter om bilden' : undefined) ??
    imageTarget?.problem ??
    transitionState?.blocking ??
    boardTarget?.problem ??
    (editRequest === null ? 'Förfrågan saknar uppgifter om ändringen' : undefined) ??
    editState.blocking ??
    (removal === null ? 'Förfrågan saknar uppgifter om vad som ska tas bort' : undefined) ??
    (removal ? deleteCheck.problem : undefined)
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
  /** "Kan inte genereras" a video, "Kan inte göras" an edit or a voice, "Kan inte tas bort" a removal. */
  const cannot =
    removal !== undefined ? 'Kan inte tas bort' : editRequest !== undefined ? 'Kan inte göras' : 'Kan inte genereras'
  const subtitle = [
    approvalTitle(a, ownerName),
    pending ? expiresText(expiresAt, now) : undefined,
    position && position.total > 1 ? `${position.index} av ${position.total} som väntar` : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  const footer =
    phase === 'confirming' && removal ? (
      <>
        <span className="mr-auto text-[13px]">{removal.confirm ?? 'Fortsätt?'}</span>
        <button onClick={() => setPhase('review')} className={secondary}>
          Tillbaka
        </button>
        <button
          autoFocus
          onClick={() => void approve()}
          disabled={!!blocking || !pending || expired || !armed || deleteCheckPending}
          title={blocking ? `${cannot}: ${blocking}` : undefined}
          className={primary}
        >
          Ja, ta bort
        </button>
      </>
    ) : phase === 'confirming' ? (
      <>
        <span className="mr-auto text-[13px]">
          {a.priceUsd === undefined
            ? 'Venice anger inget pris för det här i förväg. Fortsätt?'
            : partialPrice
              ? `Det kostar minst ${formatUsd(a.priceUsd)} – en del anger Venice inget pris för. Fortsätt?`
              : `Det här kostar ${formatUsd(a.priceUsd)}. Fortsätt?`}
        </span>
        <button onClick={() => setPhase('review')} className={secondary}>
          Tillbaka
        </button>
        <button
          autoFocus
          onClick={() => void approve()}
          disabled={!!blocking || !pending || expired || consentMissing || !armed}
          className={primary}
        >
          Ja, fortsätt
        </button>
      </>
    ) : phase === 'declining' ? (
      <>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void decline()}
          placeholder="Varför? (valfritt – agenten får se det)"
          className="min-w-0 flex-1 rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted"
        />
        <button onClick={() => setPhase('review')} className={secondary}>
          Tillbaka
        </button>
        <button onClick={() => void decline()} className={secondary}>
          Avböj
        </button>
      </>
    ) : phase === 'done' ? (
      <button onClick={close} className={secondary}>
        {othersWaiting ? 'Visa nästa förfrågan' : 'Stäng'}
      </button>
    ) : !pending && phase === 'review' ? (
      // Lapsed or replaced while it was on screen: nothing to approve here; the next one is opened on purpose.
      <button onClick={close} className={secondary}>
        {othersWaiting ? 'Visa nästa förfrågan' : 'Stäng'}
      </button>
    ) : phase === 'failed' ? (
      <>
        <button onClick={close} className={pending ? `mr-auto ${secondary}` : secondary}>
          Stäng
        </button>
        {pending && (
          <button
            onClick={() => void approve()}
            disabled={!!blocking || !armed || framesPending || consentMissing}
            className={primary}
          >
            Försök igen
          </button>
        )}
      </>
    ) : (
      <>
        <button
          onClick={close}
          disabled={phase === 'submitting'}
          title="Låt begäran vänta – du hittar den under Agent i sidofältet"
          className="mr-auto text-[12px] text-muted transition hover:text-text disabled:opacity-40"
        >
          Senare
        </button>
        <button onClick={() => setPhase('declining')} disabled={phase === 'submitting'} className={secondary}>
          {declineSending ? 'Avböjer…' : 'Avböj'}
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
                ? 'Begäran har gått ut – be agenten fråga igen'
                : framesPending
                  ? 'Hämtar start- och slutbilden…'
                  : editPlanPending
                    ? 'Läser redigeringen…'
                    : deleteCheckPending
                      ? 'Kontrollerar att inget har ändrats…'
                      : consentMissing
                        ? 'Bocka i att du har rätt att använda rösten först'
                        : !armed
                          ? 'Läs igenom förfrågan först'
                          : undefined
          }
          className={`flex items-center gap-2 ${primary}`}
        >
          <span>
            {phase === 'submitting' && !declineSending
              ? image !== undefined
                ? 'Skapar bilden…'
                : removal !== undefined
                  ? 'Tar bort…'
                  : a.kind === 'edit'
                    ? 'Startar…'
                    : 'Skickar…'
              : approveLabel(a)}
          </span>
          {(phase !== 'submitting' || declineSending) && a.priceUsd !== undefined && (
            <span className="text-white/80">{priceShown(a.priceUsd)}</span>
          )}
        </button>
      </>
    )

  return (
    <Modal
      title={`${a.client} ${approvalHeading(a)}`}
      subtitle={subtitle}
      onClose={close}
      footer={footer}
      maxWidth={620}
    >
      <div className="space-y-5">
        {error && (
          <p className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] leading-relaxed text-[#ffb3b5] select-text">
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
            <p className="mb-1 text-[11px] text-muted">{a.client} skriver:</p>
            <p className="whitespace-pre-wrap leading-relaxed select-text">{a.note}</p>
          </div>
        )}

        {sequenceError && a.sequenceId && !storyboardId && (
          <p className="text-[12px] text-accent">Sekvensen kunde inte läsas: {sequenceError}</p>
        )}
        {storyboardError && storyboardId && (
          <p className="text-[12px] text-accent">Storyboarden kunde inte läsas: {storyboardError}</p>
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
        {image === null && <p className="text-accent">Förfrågan saknar uppgifter om bilden.</p>}

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
        {editRequest === null && <p className="text-accent">Förfrågan saknar uppgifter om ändringen.</p>}

        {removal && <DeleteSummary approval={a} request={removal} check={deleteCheck} />}
        {removal === null && <p className="text-accent">Förfrågan saknar uppgifter om vad som ska tas bort.</p>}

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
          <p className="text-muted">Alla klipp i sekvensen har redan en färdig tagning.</p>
        )}
        {a.kind === 'generate-all' && storyboard && !transitions.length && (
          <p className="text-muted">Alla övergångar i storyboarden har redan en färdig tagning.</p>
        )}
        {a.kind !== 'generation' &&
          image === undefined &&
          editRequest === undefined &&
          removal === undefined &&
          !storyboardId &&
          !sequence &&
          !sequenceError &&
          !clips.length && <p className="text-muted">Läser sekvensen…</p>}
        {storyboardId && a.kind === 'generate-all' && !storyboard && !storyboardError && (
          <p className="text-muted">Läser storyboarden…</p>
        )}

        {/* A removal costs nothing; its panel ends with what happens to the files instead. */}
        {removal === undefined && (
          <div className="flex items-baseline justify-between gap-4 border-t border-line pt-4">
            <span className="text-muted">
              {clips.length > 1
                ? `Totalt för ${clips.length} klipp`
                : transitions.length > 1
                  ? `Totalt för ${transitions.length} övergångar`
                  : 'Kostnad'}
              <span className="ml-1.5 text-[11px]">(dras från ditt Venice-konto)</span>
            </span>
            <span className="text-lg font-semibold tabular-nums">
              {a.priceUsd !== undefined ? priceShown(a.priceUsd) : 'Okänt pris'}
            </span>
          </div>
        )}
        {phase === 'submitting' && image !== undefined && (
          <p className="text-[12px] text-muted">Venice skapar bilden – det brukar ta 10–30 sekunder.</p>
        )}
        {/* A removal says what changed at the top of its list (DeleteSummary). */}
        {blocking && removal === undefined && (
          <p className="text-[12px] text-accent">
            {cannot} som det ser ut nu: {blocking.replace(/\.$/, '')}. Be {a.client}{' '}
            {askAgain ? 'fråga igen' : 'rätta det'}, eller avböj.
          </p>
        )}
      </div>
    </Modal>
  )
}

// ── What will be generated ──────────────────────────────────────────────────

interface Photo {
  asset: Asset
  /** 1-based among the asset's photos. */
  number: number
}

function photoIndex(assets: readonly Asset[]): Map<string, Photo> {
  const map = new Map<string, Photo>()
  for (const asset of assets) asset.images.forEach((img, i) => map.set(img.path, { asset, number: i + 1 }))
  return map
}

interface Clip {
  key: string
  /** "Klipp 3"; undefined for the Generate form. */
  title?: string
  /** What will be sent (inputs the mode doesn't use are dropped). */
  params: GenerationParams
  /** The start frame comes from the previous clip's end, so there is no start image yet. */
  continuesFrom?: number
  /** The end frame comes from this (next) clip's first frame ("Slutbild från nästa klipp"). */
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
  'En beskrivning som läggs till i prompten har ändrats sedan agenten frågade, så det som skulle skickas är inte längre det du ser här'

interface Composer {
  /**
   * The prompt as main sends it (src/shared/prompt-compose.ts): canonical tokens, the inputs the model takes, the
   * params' own description switches, the prompt language and the model's prompt limit.
   */
  compose: (params: GenerationParams) => ComposedPrompt
  /** The model's prompt limit (prompt_character_limit), when it has one. */
  limitOf: (modelId: string) => number | undefined
}

function makeComposer(assets: readonly Asset[], language: PromptLanguage, models: readonly VideoModel[]): Composer {
  const described = describedAssets(assets)
  const limits = new Map(models.map((m) => [m.id, m.promptCharacterLimit]))
  const limitOf = (modelId: string): number | undefined => limits.get(modelId) || undefined
  return {
    limitOf,
    compose: (params) => {
      const sent = paramsForSubmit(canonicalizeParams(params))
      return composePrompt(sent, described, composeOptionsFor(sent, language, limitOf(sent.model)))
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
function withDescriptions(clips: Clip[], a: ApprovalRequest, composer: Composer | undefined): Clip[] {
  const captured = (a.kind === 'generation' || a.kind === 'segment') && !!a.params
  const legends = a.kind === 'generate-all' ? a.clipLegends : undefined
  return clips.map((clip) => {
    const live = composer?.compose(clip.params)
    const limit = composer?.limitOf(clip.params.model)
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
    continuesFrom,
    endsAt,
    blocking: blockingPromptIssue(params),
    warnings: promptIssuesOf(params)
      .filter((i) => i.severity === 'warning')
      .map((i) => i.message)
  }
}

/** The number of the clip whose first frame the segment ends on, when it takes its end image from the next clip. */
function endsAtClip(segment: Segment, index: number, count: number): number | undefined {
  return segment.endFromNext && index < count - 1 ? index + 2 : undefined
}

function segmentClip(segment: Segment, index: number, count: number): Clip {
  const continuing = segment.continueFromPrevious && index > 0
  const endsAt = endsAtClip(segment, index, count)
  // The last clip has no next one to end on, so main generates it as it is (its model, its references).
  const own = endsAt === undefined && segment.endFromNext ? { ...segment, endFromNext: false } : segment
  return clipOf(segment.id, effectiveParams(own, index), `Klipp ${index + 1}`, continuing ? index : undefined, endsAt)
}

/** The clips a request would generate, in order (none for an image request, an edit, a voice or a removal). */
function clipsOf(a: ApprovalRequest, sequence: Sequence | undefined): Clip[] {
  if (a.kind === 'image' || a.kind === 'edit' || a.kind === 'voice-design' || a.kind === 'delete') return []
  if (a.kind === 'generation') return a.params ? [clipOf(a.id, a.params)] : []
  const count = sequence?.segments.length ?? 0
  const indexed = sequence?.segments.map((segment, index) => ({ segment, index })) ?? []
  if (a.kind === 'segment') {
    const hit = indexed.find(({ segment }) => segment.id === a.segmentIds?.[0])
    const number = hit ? hit.index + 1 : a.clipNumbers?.[0]
    const continuesFrom = hit && hit.segment.continueFromPrevious && hit.index > 0 ? hit.index : undefined
    const endsAt = hit ? endsAtClip(hit.segment, hit.index, count) : undefined
    // Main submits exactly the settings in the request (and refuses if the clip has changed since).
    if (a.params) return [clipOf(a.id, a.params, number ? `Klipp ${number}` : undefined, continuesFrom, endsAt)]
    return hit ? [segmentClip(hit.segment, hit.index, count)] : []
  }
  if (!sequence) return []
  const ids = a.segmentIds
  const chosen = ids?.length
    ? indexed.filter(({ segment }) => ids.includes(segment.id))
    : indexed.filter(({ segment }) => needsTake(segment) && !pendingTake(segment))
  return chosen.map(({ segment, index }) => segmentClip(segment, index, count))
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
  const refs = p.referenceImages ?? []
  const targets: TokenTarget[] = refs.map((path) => {
    const photo = photos.get(path)
    return {
      kind: photo?.asset.kind,
      label: photo ? `${photo.asset.name} (foto ${photo.number})` : (path.split('/').pop() ?? path)
    }
  })
  // Only what is sent: paramsForSubmit already dropped audio the model doesn't take (and past its limit).
  const audios = formAudios(p.referenceAudios ?? [], voices, Infinity, true)
  const audioTargets: TokenTarget[] = audios.map((a) => ({ kind: a.source?.asset.kind, label: audioLabel(a) }))
  const settings = [
    model?.name ?? p.model,
    mode,
    p.duration,
    p.resolution,
    p.aspectRatio,
    p.audio === undefined ? undefined : p.audio ? 'med ljud' : 'utan ljud'
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
          className={`overflow-y-auto rounded-md border border-line bg-raised px-3 py-2 ${compact ? 'max-h-32' : 'max-h-60'}`}
        />
      ) : (
        <p className="text-accent">Prompten är tom.</p>
      )}

      {clip.legend && (
        <DescriptionLegend
          legend={clip.legend}
          targets={targets}
          audioTargets={audioTargets}
          sentLength={clip.sentLength}
          limit={clip.limit}
          changed={clip.descriptionsChanged}
          compact={compact}
        />
      )}

      {p.negativePrompt && (
        <>
          <Label className="mt-3">Negativ prompt</Label>
          <p className="whitespace-pre-wrap text-muted select-text">{p.negativePrompt}</p>
        </>
      )}

      {kind === 'reference-to-video' && refs.length > 0 && (
        <>
          <Label className="mt-3">Referensbilder</Label>
          <div className="flex flex-wrap gap-2">
            {refs.map((path, i) => (
              <ImageTile key={path} path={path} badge={`@Image${i + 1}`} photo={photos.get(path)} />
            ))}
          </div>
        </>
      )}

      {kind === 'reference-to-video' && audios.length > 0 && (
        <>
          <Label className="mt-3">Röster och ljud</Label>
          <ul className="space-y-1">
            {audios.map((a) => (
              <AudioRow key={`${a.path}:${a.start}:${a.length}`} audio={a} />
            ))}
          </ul>
        </>
      )}

      {kind === 'image-to-video' && (
        <>
          <Label className="mt-3">Startbild{p.endImage || clip.endsAt ? ' och slutbild' : ''}</Label>
          <div className="flex flex-wrap items-start gap-3">
            {clip.continuesFrom ? (
              <AutoFrame
                badge="Start"
                preview={!!frames}
                path={frames?.start?.source === 'previous' ? frames.start.path : undefined}
                text={`Sista bildrutan från klipp ${clip.continuesFrom}${frameTime(frames?.start?.time)}`}
              />
            ) : p.startImage ? (
              <ImageTile path={p.startImage} badge="Start" photo={photos.get(p.startImage)} />
            ) : (
              <p className="text-[12px] text-accent">Ingen startbild.</p>
            )}
            {clip.endsAt ? (
              <AutoFrame
                badge="Slut"
                preview={!!frames}
                path={frames?.end?.source === 'next' ? frames.end.path : undefined}
                text={`Första bildrutan från klipp ${clip.endsAt}${frameTime(frames?.end?.time)}`}
              />
            ) : (
              p.endImage && <ImageTile path={p.endImage} badge="Slut" photo={photos.get(p.endImage)} />
            )}
          </div>
        </>
      )}

      {(clip.blocking || clip.warnings.length > 0 || (frames?.problems.length ?? 0) > 0) && (
        <ul className="mt-3 space-y-1 text-[12px]">
          {clip.blocking && <li className="text-accent">{clip.blocking}</li>}
          {frames?.problems
            .filter((problem) => problem !== clip.blocking)
            .map((problem) => (
              <li key={problem} className="text-accent">
                {problem}
              </li>
            ))}
          {clip.warnings.map((w) => (
            <li key={w} className="text-amber-300">
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
  sentLength,
  limit,
  changed,
  compact
}: {
  legend: string
  targets: TokenTarget[]
  audioTargets: TokenTarget[]
  sentLength?: number
  limit?: number
  /** The library gives another legend by now (a description was edited after the request). */
  changed?: boolean
  compact: boolean
}) {
  const count = (n: number): string => n.toLocaleString('sv-SE')
  return (
    <div className={`mt-2 rounded-md border border-dashed px-3 py-2 ${changed ? 'border-accent/60' : 'border-line'}`}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span>Läggs till i prompten · beskrivningarna av referenserna</span>
        {sentLength !== undefined && (
          <span
            className="ml-auto tabular-nums"
            title="Så många tecken skickas till Venice: prompten och beskrivningarna tillsammans"
          >
            {limit ? `${count(sentLength)} av ${count(limit)} tecken` : `${count(sentLength)} tecken`}
          </span>
        )}
      </div>
      <PromptText
        prompt={legend}
        targets={targets}
        audioTargets={audioTargets}
        className={`overflow-y-auto text-[12px] text-muted ${compact ? 'max-h-24' : 'max-h-40'}`}
      />
      {changed && (
        <p className="mt-1.5 text-[11px] leading-snug text-accent">
          En beskrivning har ändrats sedan agenten frågade – det här är vad som skulle ha skickats då.
        </p>
      )}
    </div>
  )
}

function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mb-1.5 text-[11px] text-muted ${className}`}>{children}</p>
}

function ImageTile({
  path,
  badge,
  photo,
  caption,
  captionTone,
  large,
  title
}: {
  path: string
  badge: string
  photo?: Photo
  /** Shown along the bottom instead of the photo's asset name. */
  caption?: string
  captionTone?: string
  /** A bigger, wide tile (frames and stills rather than reference photos). */
  large?: boolean
  /** The hover text's name when it says more than the caption. */
  title?: string
}) {
  const [missing, setMissing] = useState(false)
  const name =
    title ?? caption ?? (photo ? `${photo.asset.name} (foto ${photo.number})` : (path.split('/').pop() ?? path))
  return (
    <div
      title={missing ? `Filen saknas: ${path}` : `${badge} · ${name}`}
      className={`relative shrink-0 overflow-hidden rounded bg-raised ${large ? 'h-24 w-40' : 'h-16 w-16'} ${missing ? 'ring-1 ring-accent' : ''}`}
    >
      {missing ? (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
          Filen saknas
        </span>
      ) : (
        <img
          src={mediaUrl(path)}
          draggable={false}
          onError={() => setMissing(true)}
          className="h-full w-full object-cover"
        />
      )}
      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">{badge}</span>
      {caption ? (
        <span
          className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${captionTone ?? 'bg-black/60'}`}
        >
          {caption}
        </span>
      ) : (
        photo && (
          <span
            className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${KIND_TONE[photo.asset.kind].caption}`}
          >
            {photo.asset.name}
          </span>
        )
      )}
    </div>
  )
}

/** " (0:07,5)": where in the neighbour's take an automatic frame is taken, when main said. */
function frameTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = (seconds - m * 60).toFixed(1).replace('.', ',').padStart(4, '0')
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
            ? 'Bilden är sparad bland storyboardens bilder.'
            : 'Bilden är sparad bland sekvensens bilder.'
          : 'Bilden är sparad i Referensbilder.'}
      </p>
    )
  }
  return (
    <div>
      <Label>Den nya bilden</Label>
      <img
        src={mediaUrl(path)}
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
        <ImageTile path={path} badge={badge} caption="Förhandsvisning" large />
      ) : (
        <div className="flex h-24 w-40 items-center justify-center rounded border border-dashed border-line px-2 text-center text-[11px] text-muted">
          Ingen förhandsvisning än
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
  if (index === -1) return { problem: 'Klippet som bilden skulle sättas i finns inte längre' }
  if (index + 1 !== target.clipNumber) {
    return {
      clipNumber: index + 1,
      problem: `Klippet har flyttats sedan agenten frågade (det var klipp ${target.clipNumber}, nu klipp ${index + 1})`
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
  /** The picture is saved with a sequence or storyboard (else among the stills of none, in Referensbilder). */
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
    references.length ? `bild från ${references.length === 1 ? '1 referens' : `${references.length} referenser`}` : 'bild från text',
    p.aspectRatio,
    p.resolution,
    p.quality ? `kvalitet ${p.quality}` : undefined
  ].filter(Boolean)
  const target = image.assignTo
  const where = sequenceName ? ` i ”${sequenceName}”` : ''

  return (
    <section>
      <p className="mb-3 text-[12px] text-muted">{settings.join(' · ')}</p>

      <Label>Prompt</Label>
      {p.prompt.trim() ? (
        <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 leading-relaxed select-text">
          {p.prompt}
        </p>
      ) : (
        <p className="text-accent">Prompten är tom.</p>
      )}

      {p.negativePrompt && (
        <>
          <Label className="mt-3">Negativ prompt</Label>
          <p className="whitespace-pre-wrap text-muted select-text">{p.negativePrompt}</p>
        </>
      )}

      {references.length > 0 && (
        <>
          <Label className="mt-3">Referensbilder (den första är grunden som bilden byggs på)</Label>
          <div className="flex flex-wrap gap-2">
            {references.map((ref, i) => (
              <ImageTile
                key={`${ref.path}:${i}`}
                path={ref.path}
                badge={i === 0 ? '1 · grund' : String(i + 1)}
                caption={ref.name ?? ref.label}
                title={ref.label}
                captionTone={ref.kind && ref.kind !== 'still' ? KIND_TONE[ref.kind].caption : undefined}
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
              ? `Bilden sparas bland sekvensens bilder och blir ${slotName(target.slot)} för klipp ${clipNumber ?? target.clipNumber}${where}.`
              : hasSequence
                ? inStoryboard
                  ? `Bilden sparas bland storyboardens bilder${where}.`
                  : `Bilden sparas bland sekvensens bilder${where}.`
                : 'Bilden hör inte till någon sekvens eller storyboard och sparas i Referensbilder, bland alla bilder.',
          safeMode === undefined
            ? undefined
            : safeMode
              ? 'Säkert läge är på: Venice suddar ut vuxet innehåll.'
              : 'Säkert läge är av: Venice suddar inte ut vuxet innehåll.'
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
    </section>
  )
}

/** One reference audio clip that will be sent: its token, whose voice or sound it is, the window, a play button. */
function AudioRow({ audio }: { audio: FormAudio }) {
  const token = `@Audio${audio.index}`
  const { name, detail } = audioLabelParts(audio)
  const tone = audio.source ? KIND_TONE[audio.source.asset.kind].text : 'text-text'
  return (
    <li className="flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1.5 text-[12px]">
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
 * "Promptspråk" from Settings (the legend's words: "References" or "Referenser"); undefined until read, so a
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

/** "Säkert läge för bilder" from Settings; undefined until read. */
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
    // Switched in Inställningar or the image dialog while the request is on screen.
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
