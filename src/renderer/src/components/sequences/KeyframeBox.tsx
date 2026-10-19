import { useMemo, useState, type ReactNode } from 'react'
import { droppedImagesNote, type ContinuationPlan } from '@shared/continuation'
import { endImageVariant, referenceVideosOf, supportsEndImage } from '@shared/models'
import type { Asset, ContinueMode, Segment, Sequence, VideoModel } from '@shared/types'
import { useAssets } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { FFMPEG_INSTALL } from '../../lib/platform'
import { assetsByPath } from '../pickers/assetRefs'
import { audioSourcesByPath } from '../pickers/audioRefs'
import { BridgeIcon } from './icons'
import {
  bridgeDescription,
  continuationMismatch,
  endMismatch,
  formatFrameTime,
  isOwnTake,
  readyTake,
  selectedTake
} from './sequenceUtils'
import { hasAutomaticFrames, useFramePreview } from './useFramePreview'

/** Remembers that the note about real people in own films has been read (shown once, at the first such frame). */
const PERSON_NOTICE_KEY = 'ownClips:personNotice:v1'

function personNoticeRead(): boolean {
  try {
    return localStorage.getItem(PERSON_NOTICE_KEY) === '1'
  } catch {
    return false
  }
}

interface Props {
  sequence: Sequence
  segment: Segment
  index: number
  models: VideoModel[]
  /** The model in the editor right now (the draft), which decides whether an end image can be sent. */
  model: string
  ffmpegOk: boolean
  /** A switch or "Redo between neighbours" is being saved. */
  busy: boolean
  /** "Redo between neighbours" just configured this clip: say what to do next. */
  justBridged: boolean
  /** How the clip continues from the previous one, as its draft says (sequenceUtils continuationOf). */
  plan?: ContinuationPlan
  onContinue: (on: boolean) => void
  /** "With references" / "Exact start frame". */
  onContinueMode: (mode: ContinueMode) => void
  onEndFromNext: (on: boolean) => void
  onBridge: () => void
}

/** "Anna's voice", "Lukas's voice", "Hamnen's sound". */
function soundOf(asset: Asset): string {
  return `${asset.name.trim()}'s ${asset.kind === 'character' ? 'voice' : 'sound'}`
}

/**
 * "Sends along: Anna, Strandpromenad, Anna's voice + the last frame (@Image4)" – what a continuation in reference mode
 * sends, by asset (pictures that belong to none are counted), and where it carries it from.
 */
function carriedText(plan: ContinuationPlan, assets: readonly Asset[]): string {
  const byPath = assetsByPath(assets)
  const sounds = audioSourcesByPath(assets)
  const parts: string[] = []
  let loose = 0
  for (const path of plan.images) {
    const asset = byPath.get(path)
    if (!asset) loose++
    else if (!parts.includes(asset.name)) parts.push(asset.name)
  }
  if (loose) parts.push(loose === 1 ? '1 image' : `${loose} images`)
  for (const clip of plan.audios) {
    const source = sounds.get(clip.path)
    const label = source ? soundOf(source.asset) : 'a sound clip'
    if (!parts.includes(label)) parts.push(label)
  }
  // Reference videos are carried like the pictures.
  const videos = plan.videos.length
  if (videos) parts.push(videos === 1 ? '1 reference video' : `${videos} reference videos`)
  const from = plan.carried?.inherited ? ` from clip ${plan.carried.fromClip}` : ''
  return `Sends along${from}: ${parts.join(', ')} + the last frame (@Image${plan.frameToken ?? plan.images.length + 1})`
}

/**
 * The segment editor's start and end frames from the neighbours: "Start on the previous clip's last frame" and
 * "End on the next clip's first frame", each with a live preview of the exact frame main will send
 * (previewSegmentFrames), what stands in the way, and "Redo between neighbours", which sets both and picks a model
 * that takes an end image.
 */
export default function KeyframeBox({
  sequence,
  segment,
  index,
  models,
  model,
  ffmpegOk,
  busy,
  justBridged,
  plan,
  onContinue,
  onContinueMode,
  onEndFromNext,
  onBridge
}: Props) {
  const count = sequence.segments.length
  const previous = index > 0 ? sequence.segments[index - 1] : undefined
  const next = sequence.segments[index + 1]
  const startOn = segment.continueFromPrevious && !!previous
  const endOn = segment.endFromNext && !!next
  const { preview, loading, error } = useFramePreview(sequence, index, hasAutomaticFrames(segment, index, count))
  const bridge = bridgeDescription(index, count)
  // Already set up as far as the neighbours allow: the button would change nothing.
  const bridged = (startOn || !previous) && (endOn || !next)

  const modelName = (id: string) => models.find((m) => m.id === id)?.name ?? id
  // Turning "End on the next clip's first frame" on makes main switch to a model that takes an end image; say which.
  const endModel = supportsEndImage(model) ? undefined : endImageVariant(model, models.map((m) => m.id))
  // …and drops the clip's references (image-to-video can't send them), their @ tokens with them.
  const hasReferences = !!(
    segment.params.referenceImages?.length ||
    segment.params.referenceAudios?.length ||
    referenceVideosOf(segment.params).length
  )
  const dropsReferences = hasReferences ? " The references are removed, since image-to-video can't send them." : ''

  const references = startOn && plan?.mode === 'references'
  const assets = useAssets()
  const carried = useMemo(() => (references && plan ? carriedText(plan, assets) : undefined), [references, plan, assets])
  const dropped = references ? droppedImagesNote(plan) : undefined
  const trimmed = previous && previous.trimEnd > 0 ? ' (after trim)' : ''
  const startText = !previous
    ? 'The first clip starts from your prompt and your own images.'
    : !ffmpegOk && !startOn
      ? `Needs ffmpeg (${FFMPEG_INSTALL}).`
      : startOn
        ? references
          ? `The last frame of clip ${index}${trimmed} is sent as a reference image after the clip's references, and the clip starts on it – close, but not always exactly the same picture.`
          : `The start image is taken from the end of clip ${index}${trimmed} when the take is generated, so the transition is seamless.`
        : `Use the last frame of clip ${index} as the start image for a seamless transition.`

  const endText = !next
    ? 'The last clip has no next clip to end on.'
    : !ffmpegOk && !endOn
      ? `Needs ffmpeg (${FFMPEG_INSTALL}).`
      : endOn
        ? `The end image is taken from the start of clip ${index + 2}${next.trimStart > 0 ? ' (after trim)' : ''}, so the clip ends exactly where the next one starts.`
        : endModel
          ? `Let the clip end exactly where clip ${index + 2} starts. ${modelName(model)} can't take an end image, so the model is switched to ${modelName(endModel)}.${dropsReferences}`
          : `Let the clip end exactly where clip ${index + 2} starts.${dropsReferences}`

  const start = preview?.start?.source === 'previous' ? preview.start : undefined
  const end = preview?.end?.source === 'next' ? preview.end : undefined
  // A frame from the user's own film (not one Venice made): said so, and once that Venice may refuse real people.
  const fromOwnStart = startOn && isOwnTake(previous && selectedTake(previous))
  const fromOwnEnd = endOn && isOwnTake(next && selectedTake(next))
  const [noticeRead, setNoticeRead] = useState(personNoticeRead)
  const showPersonNotice = (fromOwnStart || fromOwnEnd) && !noticeRead
  const dismissPersonNotice = () => {
    setNoticeRead(true)
    try {
      localStorage.setItem(PERSON_NOTICE_KEY, '1')
    } catch {
      // Then it shows again next time; harmless.
    }
  }
  const startMismatch = continuationMismatch(segment, previous)
  const endChanged = endMismatch(segment, next)
  // A missing neighbour take is already said beside the frame it would give.
  const problems = (preview?.problems ?? []).filter(
    (p) => !(startOn && !start && p.startsWith(`Clip ${index} `)) && !(endOn && !end && p.startsWith(`Clip ${index + 2} `))
  )

  return (
    <div className="mb-5 rounded-lg border border-line bg-panel">
      <ToggleRow
        label="Start on the previous clip's last frame"
        description={startText}
        on={startOn}
        // Turning it off must stay possible without ffmpeg; turning it on needs ffmpeg for the frame grab.
        disabled={!previous || busy || (!startOn && !ffmpegOk)}
        onChange={onContinue}
      >
        {startOn && plan && <ContinueModeChoice plan={plan} disabled={busy} onChange={onContinueMode} />}
        {startOn && (
          <FramePreview
            path={start?.path}
            loading={loading}
            caption={
              start
                ? (fromOwnStart
                    ? `Continues from the last frame of your clip${start.time !== undefined ? ` (${formatFrameTime(start.time)})` : ''}`
                    : `Start image: the last frame of clip ${start.fromClip ?? index}${start.time !== undefined ? ` (${formatFrameTime(start.time)})` : ''}`) +
                  (references ? ` – sent as @Image${plan?.frameToken ?? 1}` : '')
                : previous && !readyTake(previous)
                  ? `Clip ${index} needs a finished selected take before this clip can be generated.`
                  : loading
                    ? 'Getting the frame…'
                    : "The frame couldn't be extracted."
            }
          />
        )}
        {carried && <p className="mt-2 pl-12 text-[11px] leading-snug text-text">{carried}</p>}
        {dropped && <p className="mt-1 pl-12 text-[11px] leading-snug text-amber-300">{dropped}</p>}
        {startOn && plan?.applies && plan.chosen === 'references' && plan.mode === 'exact' && plan.note && (
          <p className="mt-1.5 pl-12 text-[11px] leading-snug text-muted">{plan.note}</p>
        )}
      </ToggleRow>

      <div className="border-t border-line" />

      <ToggleRow
        label="End on the next clip's first frame"
        description={endText}
        on={endOn}
        disabled={!next || busy || (!endOn && !ffmpegOk)}
        onChange={onEndFromNext}
      >
        {endOn && (
          <FramePreview
            path={end?.path}
            loading={loading}
            caption={
              end
                ? fromOwnEnd
                  ? `Ends on the first frame of your clip${end.time ? ` (${formatFrameTime(end.time)})` : ''}`
                  : `End image: the first frame of clip ${end.fromClip ?? index + 2}${end.time ? ` (${formatFrameTime(end.time)})` : ''}`
                : next && !readyTake(next)
                  ? `Clip ${index + 2} needs a finished selected take before this clip can be generated.`
                  : loading
                    ? 'Getting the frame…'
                    : "The frame couldn't be extracted."
            }
          />
        )}
      </ToggleRow>

      {showPersonNotice && (
        <div className="flex items-start gap-2 border-t border-line p-3">
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
            Some Venice models may refuse images and video of real people. If the continuation is refused, try another
            model.
          </p>
          <button
            type="button"
            onClick={dismissPersonNotice}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text"
          >
            OK
          </button>
        </div>
      )}

      {(problems.length > 0 || error || startMismatch || endChanged || justBridged || (bridge && !bridged)) && (
        <div className="space-y-2 border-t border-line p-3">
          {justBridged && (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] leading-snug text-emerald-200">
              The clip is now set to be redone between its neighbours. Check the frames above and the prompt, then press
              Generate. The old take is kept under Takes.
            </p>
          )}
          {problems.map((p) => (
            <p key={p} className="text-[11px] leading-snug text-amber-300">
              {p}
            </p>
          ))}
          {error && <p className="text-[11px] leading-snug text-muted">The frames couldn't be shown: {error}</p>}
          {startMismatch && (
            <Warning>
              The selected take doesn't start where clip {index} now ends. Generate a new take for a seamless transition.
            </Warning>
          )}
          {endChanged && (
            <Warning>
              The selected take doesn't end where clip {index + 2} now starts. Generate a new take for a seamless
              transition.
            </Warning>
          )}
          {bridge && !bridged && (
            <button
              onClick={onBridge}
              disabled={busy}
              title={bridge}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] transition hover:bg-raised disabled:opacity-40"
            >
              <BridgeIcon size={13} />
              Redo between neighbours
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ToggleRow({
  label,
  description,
  on,
  disabled,
  onChange,
  children
}: {
  label: string
  description: string
  on: boolean
  disabled: boolean
  onChange: (on: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="p-3">
      <div
        className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
        onClick={() => !disabled && onChange(!on)}
      >
        <button
          role="switch"
          aria-checked={on}
          aria-label={label}
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
          <span className="block">{label}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">{description}</span>
        </span>
      </div>
      {children}
    </div>
  )
}

/**
 * "With references – keeps the characters (recommended)" / "Exact start frame – no references": how a clip that
 * continues from the previous one starts on its last frame. Greyed out, with the reason, where it doesn't apply (the
 * clip also ends on the next clip's first frame, or has an end image of its own).
 */
function ContinueModeChoice({
  plan,
  disabled,
  onChange
}: {
  plan: ContinuationPlan
  disabled: boolean
  onChange: (mode: ContinueMode) => void
}) {
  const options: { mode: ContinueMode; label: string; hint: string; title: string }[] = [
    {
      mode: 'references',
      label: 'With references',
      hint: 'keeps the characters (recommended)',
      title:
        "Sends the reference images and voices – the clip's own, otherwise those of the clip before – and the last frame as one more reference image. The clip starts close to the frame, and characters who leave the picture come back as themselves."
    },
    {
      mode: 'exact',
      label: 'Exact start frame',
      hint: 'no references',
      title:
        "Image-to-video from the last frame: the clip starts exactly on it, but sends no references. The clip's own references and their @ mentions are removed from the prompt."
    }
  ]
  return (
    <div className="mt-3 pl-12">
      <div
        role="radiogroup"
        aria-label="How the clip starts on the frame"
        className={`grid grid-cols-2 gap-1 rounded-lg bg-raised p-1 ${plan.applies ? '' : 'opacity-50'}`}
      >
        {options.map((o) => {
          const on = plan.applies ? plan.chosen === o.mode : o.mode === 'exact'
          return (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={on}
              title={o.title}
              disabled={disabled || !plan.applies}
              onClick={() => !on && onChange(o.mode)}
              className={`rounded-md px-2 py-1.5 text-left transition disabled:cursor-default ${
                on ? 'bg-line text-text' : 'text-muted hover:text-text'
              }`}
            >
              <span className="block text-[12px]">{o.label}</span>
              <span className="block text-[11px] leading-snug text-muted">{o.hint}</span>
            </button>
          )
        })}
      </div>
      {!plan.applies && plan.note && <p className="mt-1.5 text-[11px] leading-snug text-muted">{plan.note}</p>}
    </div>
  )
}

function FramePreview({ path, loading, caption }: { path?: string; loading: boolean; caption: string }) {
  return (
    <div className="mt-3 flex items-center gap-3 pl-12">
      <div className="aspect-video w-28 shrink-0 overflow-hidden rounded bg-black">
        {path ? (
          <img src={mediaUrl(path)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <div className={`h-full w-full bg-raised ${loading ? 'animate-pulse' : ''}`} />
        )}
      </div>
      <p className="text-[11px] leading-snug text-muted">{caption}</p>
    </div>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-300">
      {children}
    </p>
  )
}
