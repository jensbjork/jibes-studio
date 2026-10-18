import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatTimecode, frameCaptions } from '@shared/edit-plan'
import type {
  ApprovalEditRequest,
  ApprovalRequest,
  Asset,
  AssetAudio,
  Edit,
  EditJob,
  EditOperation,
  EditPlan
} from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatUsd, mediaUrl } from '../../lib/media'
import AudioPlayButton from '../pickers/AudioPlayButton'
import { possessive } from '../pickers/audioRefs'
import { KIND_TONE } from '../pickers/assetKinds'
import { markKey } from '../prompt/promptText'
import { ImageTile, PictureHover } from './ApprovalPictures'
import PromptText, { type TokenTarget } from './PromptText'

// The approval dialog's panels for the Editor's paid requests: an operation on a version of an edit (the version's
// poster, the start and end frames of a picture operation, what changes – prompt, old → new lines, the voice – the
// parts and the price), continuing a stopped paid job ("Continue"), and a new voice designed for a character. A
// cloned voice also needs the user's own consent, asked here with a required checkbox, since an agent can never give
// it.

/** The plan's problem that only the clone consent solves; the checkbox below takes care of it. */
const CONSENT_PROBLEM = /right to use the voice/i

/** A library audio clip by id, with the asset it belongs to. */
function audioById(assets: readonly Asset[], audioId: string): { asset: Asset; audio: AssetAudio } | undefined {
  for (const asset of assets) {
    const audio = asset.audio?.find((a) => a.id === audioId)
    if (audio) return { asset, audio }
  }
  return undefined
}

/** A library photo by id, with the asset it belongs to and its number. */
function photoById(assets: readonly Asset[], imageId: string): { asset: Asset; path: string; number: number } | undefined {
  for (const asset of assets) {
    const i = asset.images.findIndex((img) => img.id === imageId)
    if (i >= 0) return { asset, path: asset.images[i].path, number: i + 1 }
  }
  return undefined
}

export interface EditApprovalState {
  /** The edit as it is now (its versions give the base version's poster); undefined while it is read. */
  edit?: Edit
  /** The plan as it would run now (free): warnings to show, and problems that would make main refuse it. */
  plan?: EditPlan
  /** Continuing a stopped job: the job as it is now. */
  job?: EditJob
  /** What approving waits for is on screen: the plan (an operation) or the job (continuing one). */
  ready: boolean
  /** Why it can't be approved as it looks now, e.g. the version is gone. */
  blocking?: string
  /** The plan is being made again (after the edit changed): approving waits for it. */
  loading: boolean
}

/**
 * What the dialog knows about an 'edit' request beyond what main sent: the edit and its base version as they are
 * now, and – while it waits for an answer – the operation planned again (free), so the user sees the plan's
 * warnings (lip sync, real people…) and learns before clicking what main's re-check would refuse. Read again
 * whenever the edit changes.
 */
export function useEditApproval(a: ApprovalRequest): EditApprovalState {
  const request = a.kind === 'edit' ? a.edit : undefined
  const pending = a.status === 'pending'
  const editId = request?.editId
  const baseId = request?.baseId
  const operation = request?.operation
  const resumeJobId = request?.resumeJobId
  const key = JSON.stringify([editId, baseId, operation, resumeJobId])
  const [state, setState] = useState<{ key?: string; edit?: Edit; plan?: EditPlan; error?: string; loading: boolean }>({
    loading: false
  })
  useEffect(() => {
    if (!editId || (!operation && !resumeJobId)) return
    let active = true
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      const mine = ++seq
      setState((s) => (s.key === key ? { ...s, loading: true } : { key, loading: true }))
      try {
        const edit = await window.studio.getEdit(editId)
        // A decided request only needs the version's poster; planning is for what may still be approved.
        // Continuing a job plans nothing: the job itself (edit.jobs) says whether it still can, and at what price.
        const plan =
          operation && pending && edit.versions.some((v) => v.id === baseId)
            ? await window.studio.planEditOperation(editId, operation, baseId)
            : undefined
        if (active && mine === seq) setState({ key, edit, plan, loading: false })
      } catch (e) {
        if (active && mine === seq) setState({ key, loading: false, error: ipcErrorMessage(e) })
      }
    }
    void load()
    // Jobs report progress through edit changes too, so a burst of them gives one new plan.
    const off = window.studio.onEditChange((changed) => {
      if (changed !== editId) return
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 800)
    })
    return () => {
      active = false
      clearTimeout(timer)
      off()
    }
    // `key` stands for the edit, the version and the operation (a new copy of the same request changes nothing).
  }, [key, pending])

  if (!request) return { loading: false, ready: false }
  if (state.key !== key) return { loading: pending, ready: false }
  if (resumeJobId) return resumeState(a, request, state.edit, state.error, state.loading)
  const versionGone = state.edit && !state.edit.versions.some((v) => v.id === baseId)
  const problems = (state.plan?.problems ?? []).filter((p) => !(request.needsCloneConsent && CONSENT_PROBLEM.test(p)))
  const blocking = !pending
    ? undefined
    : state.error
      ? `The edit couldn’t be read: ${state.error.replace(/\.$/, '')}`
      : versionGone
        ? `Version v${request.baseNumber ?? '?'} is no longer in the edit`
        : problems[0]?.replace(/\.$/, '')
  return { edit: state.edit, plan: state.plan, blocking, loading: state.loading, ready: !!state.plan }
}

/**
 * Continuing a stopped job, as the edit has it now: main lapses the request when the job can no longer be continued
 * or "Continue" would cost more than the user is shown (by more than a cent), so the dialog says so before the click.
 */
function resumeState(
  a: ApprovalRequest,
  request: ApprovalEditRequest,
  edit: Edit | undefined,
  error: string | undefined,
  loading: boolean
): EditApprovalState {
  const job = edit?.jobs.find((j) => j.id === request.resumeJobId)
  if (a.status !== 'pending') return { edit, job, loading, ready: !!job }
  const rose =
    !!job &&
    ((a.priceUsd === undefined
      ? job.resumePriceUsd !== undefined
      : job.resumePriceUsd === undefined || job.resumePriceUsd > a.priceUsd + 0.01) ||
      (!request.partialPrice && !!job.resumePartialPrice))
  const blocking = error
    ? `The edit couldn’t be read: ${error.replace(/\.$/, '')}`
    : !edit
      ? undefined
      : !job
        ? 'The job is no longer in the edit'
        : !job.canResume
          ? `The job “${job.label}” can no longer be continued`
          : rose
            ? `Continuing now costs ${job.resumePriceUsd !== undefined ? formatUsd(job.resumePriceUsd) : 'an unknown price'}${job.resumePartialPrice ? ' +' : ''}`
            : undefined
  return { edit, job, blocking, loading, ready: !!job }
}

function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mb-1.5 text-[11px] text-muted ${className}`}>{children}</p>
}

/** A frame or a poster: a wide tile with a badge (hovering shows it larger), or a dashed box when the file is missing. */
function Frame({ path, badge, caption }: { path?: string; badge: string; caption?: string }) {
  const [missing, setMissing] = useState(false)
  return (
    <div className="w-40 space-y-1">
      {path && !missing ? (
        <PictureHover
          path={path}
          badge={badge}
          info={{ name: caption }}
          className="relative block h-24 w-40 overflow-hidden rounded bg-raised outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <img src={mediaUrl(path)} alt="" draggable={false} onError={() => setMissing(true)} className="h-full w-full object-cover" />
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">{badge}</span>
        </PictureHover>
      ) : (
        <div className="flex h-24 w-40 items-center justify-center rounded border border-dashed border-line px-2 text-center text-[11px] text-muted">
          {path ? 'Image missing' : 'No image'}
        </div>
      )}
      {caption && <p className="text-[11px] leading-snug text-muted">{caption}</p>}
    </div>
  )
}

/** "Preset voice Aria (ElevenLabs …)", "Voice ID …", or the character whose Voice clip is cloned, with a play button. */
function VoiceRow({ op, assets }: { op: EditOperation; assets: readonly Asset[] }) {
  if (op.op !== 'change-voice' && op.op !== 'speak-lines') return null
  const v = op.voice
  if (v.kind === 'clone') {
    const found = audioById(assets, v.audioId)
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1.5 text-[12px]">
        {found && (
          <AudioPlayButton
            path={found.audio.path}
            start={found.audio.clipStart}
            length={found.audio.clipLength}
            label={`${possessive(found.asset.name, 'en')} voice sample`}
          />
        )}
        <span className={`font-medium ${found ? KIND_TONE[found.asset.kind].text : ''}`}>
          {found ? `${possessive(found.asset.name, 'en')} voice` : 'A character’s voice'}
        </span>
        <span className="truncate text-muted">cloned from the voice sample · {op.model}</span>
      </div>
    )
  }
  return (
    <p className="rounded-md border border-line bg-raised px-3 py-1.5 text-[12px]">
      {v.kind === 'preset' ? (
        <>
          <span className="font-medium">{v.voice}</span>
          <span className="text-muted"> · preset voice in {op.model}</span>
        </>
      ) : (
        <>
          <span className="font-medium">Voice ID {v.voiceId}</span>
          <span className="text-muted"> · {op.model}</span>
        </>
      )}
    </p>
  )
}

const BACKGROUND: Record<string, string> = {
  keep: 'The background sound is kept',
  duck: 'The original sound is lowered where the voice changes',
  remove: 'The original sound is removed where the voice changes'
}

/** The settings line of an operation: model, resolution, sound, background. */
function settingsOf(op: EditOperation): string[] {
  switch (op.op) {
    case 'regenerate':
    case 'prompt-edit':
      return [op.model, op.resolution, op.audio === 'keep' ? 'the original sound is kept' : 'new sound from the model'].filter(
        (s): s is string => !!s
      )
    case 'extend':
      return [op.model, op.resolution, op.audio === 'model' ? 'sound from the model' : 'silence'].filter((s): s is string => !!s)
    case 'music':
      return [op.model, op.instrumental ? 'instrumental' : undefined, op.duck === false ? undefined : 'lowered under speech'].filter(
        (s): s is string => !!s
      )
    case 'effect':
      return [op.model, `${op.seconds} s`]
    case 'change-voice':
      return [BACKGROUND[op.background], op.removeNoise ? 'noise is removed' : undefined].filter((s): s is string => !!s)
    case 'speak-lines':
      return [BACKGROUND[op.background], op.fit === 'tempo' ? 'the tempo is adjusted (at most 15%)' : 'a line may run long'].filter(
        (s): s is string => !!s
      )
    case 'transcribe':
      return [op.model ?? 'ElevenLabs Scribe', op.language ? `language: ${op.language}` : 'the language is detected automatically']
    case 'upscale':
      return [`${op.factor}×`, 'the whole version']
    default:
      return []
  }
}

/** The parts and their prices, and the price note ("charged per started minute: 3 min"). */
function Steps({ request }: { request: ApprovalEditRequest }) {
  const steps = request.steps ?? []
  if (!steps.length && !request.priceNote) return null
  return (
    <div>
      {steps.length > 1 && (
        <>
          <Label className="mt-3">Parts</Label>
          <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[12px]">
            {steps.map((s, i) => (
              <li key={`${s.label}:${i}`} className="flex justify-between gap-3">
                <span className="truncate text-muted">{s.label}</span>
                <span className="shrink-0 tabular-nums">{s.priceUsd !== undefined ? formatUsd(s.priceUsd) : 'no price given'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {request.priceNote && <p className="mt-2 text-[12px] text-muted">{request.priceNote}</p>}
    </div>
  )
}

/** The edit panel: the version, what changes and how, and the consent a cloned voice needs. */
export function EditSummary({
  approval: a,
  request,
  state,
  assets,
  consent,
  onConsent
}: {
  approval: ApprovalRequest
  request: ApprovalEditRequest
  state: EditApprovalState
  assets: readonly Asset[]
  /** The consent checkbox: ticked by the user in this dialog. */
  consent: boolean
  onConsent: (on: boolean) => void
}) {
  const op = request.operation
  const base = state.edit?.versions.find((v) => v.id === request.baseId)
  const poster = base?.generation.thumbPath
  const prompt = op && 'prompt' in op ? op.prompt : undefined
  const references = useMemo(
    () =>
      op?.op === 'prompt-edit'
        ? (op.referenceImageIds ?? []).map((id) => ({ id, photo: photoById(assets, id) }))
        : [],
    [op, assets]
  )
  const pending = a.status === 'pending'
  // Asked again while the dialog is open: the consent may have been given in Characters meanwhile.
  const given = request.needsCloneConsent ? audioById(assets, request.needsCloneConsent.audioId)?.audio.cloneConsent : false
  const settings = op ? settingsOf(op) : []
  const editName = state.edit?.name ?? request.editName
  const captions = frameCaptions(op)
  const versionBadge = request.baseNumber ? `v${request.baseNumber}` : 'Version'
  // A Seedance edit's pictures to start from are @Image1… in its prompt: the tokens and tiles light up together.
  const [lit, setLit] = useState<string>()
  const targets: TokenTarget[] = references.map(({ id, photo }) => ({
    kind: photo?.asset.kind,
    label: photo ? `${photo.asset.name} (photo ${photo.number})` : `Image missing (${id})`,
    path: photo?.path,
    name: photo?.asset.name,
    number: photo?.number,
    count: photo?.asset.images.length
  }))

  return (
    <section className="space-y-3">
      <div>
        <p className="font-medium">{request.summary}</p>
        <p className="text-[12px] text-muted">
          {editName ? `The edit “${editName}”` : 'The edit'}
          {request.baseNumber ? ` · starts from v${request.baseNumber}` : ''}
          {base?.generation.videoDuration ? ` (${formatTimecode(base.generation.videoDuration)})` : ''}
          {base && !base.current ? ' – not the current version, so the result becomes a branch of its own' : ''}
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Frame path={poster} badge={versionBadge} caption="The version that changes" />
        {request.frames?.start !== undefined || request.frames?.end !== undefined ? (
          <>
            {request.frames?.start && (
              <Frame path={request.frames.start} badge="Start" caption={captions.start.ui} />
            )}
            {request.frames?.end && <Frame path={request.frames.end} badge="End" caption={captions.end.ui} />}
          </>
        ) : null}
      </div>

      {settings.length > 0 && <p className="text-[12px] text-muted">{settings.join(' · ')}</p>}

      {prompt !== undefined && (
        <div>
          <Label>{op?.op === 'music' ? 'Description of the music' : op?.op === 'effect' ? 'Description of the sound' : 'Prompt'}</Label>
          {references.length > 0 ? (
            <PromptText
              prompt={prompt}
              targets={targets}
              highlighted={lit}
              onHighlight={setLit}
              className="max-h-48 overflow-y-auto rounded-md border border-line bg-raised px-3 py-2"
            />
          ) : (
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 leading-relaxed select-text">
              {prompt}
            </p>
          )}
        </div>
      )}

      {references.length > 0 && (
        <div>
          <Label>Images to start from</Label>
          <div className="flex flex-wrap gap-2">
            {references.map(({ id, photo }, i) => {
              const key = markKey('image', i + 1)
              return photo ? (
                <ImageTile
                  key={id}
                  path={photo.path}
                  badge={`@Image${i + 1}`}
                  photo={photo}
                  lit={lit === key}
                  onLight={(on) => setLit((cur) => (on ? key : cur === key ? undefined : cur))}
                />
              ) : (
                <div key={id} className="relative h-16 w-16 shrink-0 overflow-hidden rounded bg-raised" title="Image missing">
                  <span className="flex h-full items-center justify-center text-[10px] text-accent">Missing</span>
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">@Image{i + 1}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {op && (op.op === 'change-voice' || op.op === 'speak-lines') && (
        <div>
          <Label>New voice</Label>
          <VoiceRow op={op} assets={assets} />
        </div>
      )}

      {request.lines && request.lines.length > 0 && (
        <div>
          <Label>{request.lines.length === 1 ? 'The line' : `Lines (${request.lines.length})`}</Label>
          <ul className="max-h-56 space-y-1.5 overflow-y-auto">
            {request.lines.map((line, i) => (
              <li key={i} className="rounded-md border border-line bg-raised px-3 py-1.5 text-[12px] leading-relaxed">
                <span className="mr-2 tabular-nums text-muted">{formatTimecode(line.at)}</span>
                {line.old !== undefined ? (
                  <>
                    <span className="text-muted line-through decoration-muted/60">{line.old}</span>
                    <span className="mx-1.5 text-muted">→</span>
                  </>
                ) : (
                  <span className="mr-1.5 text-muted">New line:</span>
                )}
                <span className="select-text">{line.new}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {request.voiceLines && request.voiceLines.length > 0 && (
        <div>
          <Label>{request.voiceLines.length === 1 ? 'The line that gets a new voice' : `Lines that get a new voice (${request.voiceLines.length})`}</Label>
          <ul className="max-h-56 space-y-1.5 overflow-y-auto">
            {request.voiceLines.map((line, i) => (
              <li key={i} className="rounded-md border border-line bg-raised px-3 py-1.5 text-[12px] leading-relaxed">
                <span className="mr-2 tabular-nums text-muted">{formatTimecode(line.at)}</span>
                <span className="select-text">{line.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Steps request={request} />

      {state.plan && (state.plan.warnings.length > 0 || state.plan.notes.length > 0) && (
        <ul className="space-y-1 text-[12px]">
          {state.plan.warnings.map((w) => (
            <li key={w} className="text-amber-300">
              {w}
            </li>
          ))}
          {state.plan.notes.map((n) => (
            <li key={n} className="text-muted">
              {n}
            </li>
          ))}
        </ul>
      )}
      {pending &&
        state.plan &&
        a.priceUsd !== undefined &&
        state.plan.priceUsd !== undefined &&
        Math.abs(state.plan.priceUsd - a.priceUsd) > 0.01 && (
          <p className="text-[12px] text-amber-300">
            Venice now quotes {formatUsd(state.plan.priceUsd)}. If that’s more than when the agent asked, the request
            won’t go through – then ask the agent to ask again.
          </p>
        )}

      {request.needsCloneConsent && pending && (
        <label className="flex items-start gap-2 rounded-md border border-line bg-raised/60 px-3 py-2 text-[12px] leading-relaxed">
          <input
            type="checkbox"
            checked={consent || !!given}
            disabled={!!given}
            onChange={(e) => onConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">I have the right to use this voice</span>
            <span className="block text-muted">
              {given
                ? `You have already said that ${possessive(request.needsCloneConsent.assetName, 'en')} voice may be cloned.`
                : `${possessive(request.needsCloneConsent.assetName, 'en')} voice sample is cloned for the new lines. Required before you approve; it’s saved on the voice clip (Characters → Voice).`}
            </span>
          </span>
        </label>
      )}
    </section>
  )
}

/** "≈ $0.45 +" for a price with a part Venice doesn't price, else "$0.45". */
function priceText(usd: number | undefined, partial: boolean | undefined): string {
  if (usd === undefined) return 'unknown price'
  return partial ? `≈ ${formatUsd(usd)} +` : formatUsd(usd)
}

/** "Continue the job “Change voice” · $0.40": the stopped job, how far it got and what continuing it sends again. */
export function ResumeSummary({
  approval: a,
  request,
  state
}: {
  approval: ApprovalRequest
  request: ApprovalEditRequest
  state: EditApprovalState
}) {
  const job = state.job
  const base = state.edit?.versions.find((v) => v.id === request.baseId)
  const editName = state.edit?.name ?? request.editName
  const stopped = job?.status === 'cancelled' ? 'Cancelled' : 'Stopped'
  return (
    <section className="space-y-3">
      <div>
        <p className="font-medium">
          {request.summary} · {priceText(a.priceUsd, request.partialPrice)}
        </p>
        <p className="text-[12px] text-muted">
          {editName ? `The edit “${editName}”` : 'The edit'}
          {request.baseNumber ? ` · starts from v${request.baseNumber}` : ''}
          {base?.generation.videoDuration ? ` (${formatTimecode(base.generation.videoDuration)})` : ''}
        </p>
      </div>
      {request.baseId && (
        <Frame
          path={base?.generation.thumbPath}
          badge={request.baseNumber ? `v${request.baseNumber}` : 'Version'}
          caption="The version the job starts from"
        />
      )}
      {job ? (
        <div className="rounded-md border border-line bg-raised px-3 py-2 text-[12px] leading-relaxed">
          <p>
            {stopped} after {job.stepsDone} of {job.stepsTotal} {job.stepsTotal === 1 ? 'part' : 'parts'}
            {job.costUsd > 0 ? ` · ${formatUsd(job.costUsd)} already paid` : ''}
          </p>
          {job.error && <p className="text-[#ffb3b5] select-text">{job.error}</p>}
          <p className="mt-1 text-muted">
            What’s already done is used. Only the parts that weren’t sent or that failed are sent again.
          </p>
        </div>
      ) : (
        !state.blocking && <p className="text-[12px] text-muted">Reading the job…</p>
      )}
      {request.priceNote && <p className="text-[12px] text-muted">{request.priceNote}</p>}
    </section>
  )
}

/** The voice-design panel: whose voice, the description and the sample text, and where the result goes. */
export function VoiceDesignSummary({ request }: { request: ApprovalEditRequest }) {
  const design = request.voiceDesign
  return (
    <section className="space-y-3">
      <p className="font-medium">{request.summary}</p>
      {design ? (
        <>
          <div>
            <Label>Describe the voice</Label>
            <p className="whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 leading-relaxed select-text">
              {design.description}
            </p>
          </div>
          <div>
            <Label>Sample text</Label>
            <p className="whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 leading-relaxed select-text">
              {design.sampleText}
            </p>
          </div>
          <p className="text-[12px] text-muted">
            {design.model ?? 'seed-audio-1-0'} · The voice is added as a new voice clip under Voice
            {request.assetName ? ` for ${request.assetName}` : ''}. Listen to it before it’s used.
          </p>
        </>
      ) : (
        <p className="text-accent">The request doesn’t say anything about the voice.</p>
      )}
      <Steps request={request} />
    </section>
  )
}
