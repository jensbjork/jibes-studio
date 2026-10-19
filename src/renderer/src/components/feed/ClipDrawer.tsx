import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { canUseAgain, generationTitle, sourceBadge } from '@shared/generation-label'
import { durationSeconds, kindOfModelId, referenceVideosOf, videosAreReferences, type Kind } from '@shared/models'
import { workKey, type Edit, type Generation, type GenerationReview, type VideoModel } from '@shared/types'
import { ASSET_VIEW } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import { fileName } from '../../lib/library'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { FILE_MANAGER, TRASH } from '../../lib/platform'
import { markSeen, useSeenWhenVisible } from '../../lib/work'
import { findTakeOwner, openTakeOwner, takeOwnerLabel, type TakeOwner } from '../../lib/takes'
import { KIND_TONE, VIDEO_TONE } from '../pickers/assetKinds'
import { useVideoFacts } from '../pickers/videoFacts'
import { videoLabelParts } from '../pickers/videoRefs'
import VideoWindowPreview from '../pickers/VideoWindowPreview'
import Popover from '../pickers/Popover'
import SequencePicker, { type AddedToSequence } from '../pickers/SequencePicker'
import { titleFromPrompt } from '../pickers/text'
import { sentPromptDiffers } from '../prompt/descriptions'
import { CopyButton } from '../prompts/controls'
import { formatWhen } from '../prompts/prompt-utils'
import { requestLearning, useLearnings } from '../prompts/useLearnings'
import ConfirmButton from '../sequences/ConfirmButton'
import { CloseIcon } from '../sequences/icons'
import { Spinner } from '../work/StatusMark'
import { STATUS_LABEL, formatClipLength, isPending, progressOf } from './feedText'
import HighlightedPrompt from './HighlightedPrompt'
import { BulbIcon, CameraIcon, ChevronLeftIcon, ChevronRightIcon, ScissorsIcon, SoundIcon } from './icons'
import { workingCopyNote } from './ownClips'
import { pauseOthers } from './playback'
import {
  audioWindowFragment,
  audioWindowText,
  imageCaption,
  referencesOf,
  type AudioReference,
  type ImageReference,
  type LibraryIndex,
  type VideoReference
} from './references'
import { AgentReviews, YourReview } from './ReviewSection'
import SentPrompt from './SentPrompt'
import { useReviews } from './useReviews'

interface Props {
  generation: Generation
  models: readonly VideoModel[]
  index: LibraryIndex
  /** Where the clip is in the list the drawer steps through ("3 av 42"). */
  position?: { index: number; total: number }
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
  onReuse: (g: Generation) => void
  onDelete: (g: Generation) => void
  /** A locally patched copy, e.g. with segmentId set after "Add to sequence". */
  onChange?: (g: Generation) => void
  onRate: (g: Generation, rating: number | null) => void
  navigate?: Navigate
  /** Opens a learning; without it the learning is opened in the Prompts view. */
  onOpenLearning?: (id: string) => void
  /** "Use again" also takes the user to Generate (when the drawer is shown elsewhere). */
  reuseTitle?: string
  /**
   * An agent opened the drawer (open_in_studio): showing the clip then isn't the user looking at it, so it is not
   * marked seen on opening (playing it still is; a failure counts once it has been on screen for a moment).
   */
  openedByAgent?: boolean
}

const MODE_LABEL: Record<Kind, string> = {
  'text-to-video': 'Text to video',
  'image-to-video': 'Start image to video',
  'reference-to-video': 'Reference images to video'
}

const sectionTitle = 'mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted'
const actionButton =
  'rounded-md border border-line px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40'

/** A text field: typing (and Escape, e.g. closing the prompt editor's @ menu) belongs to it. */
function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/** Whether a key press belongs to a field, a player or a control rather than to the drawer's shortcuts. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    isTextField(target) ||
    ['VIDEO', 'AUDIO'].includes(target.tagName) ||
    target.closest('[role="slider"], [role="grid"], [role="menu"], [role="dialog"], [role="listbox"]') !== null
  )
}

/**
 * Everything about one clip: a large player, the prompt with its references highlighted, the pictures and
 * sounds it was made from, its settings and cost, the actions, the user's own rating and note, and what agents
 * thought of it. ← / → step through the list, Esc closes.
 */
export default function ClipDrawer({
  generation: g,
  models,
  index,
  position,
  onPrev,
  onNext,
  onClose,
  onReuse,
  onDelete,
  onChange,
  onRate,
  navigate,
  onOpenLearning,
  reuseTitle = 'Fill in the form with the clip’s settings',
  openedByAgent = false
}: Props) {
  const asideRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [highlighted, setHighlighted] = useState<string>()
  const { reviews, loaded, reload } = useReviews(g.id)
  const [error, setError] = useState<string>()
  useEffect(() => setError(undefined), [g.id])

  const userReview = reviews.find((r) => r.author === 'user')
  const otherReviews = reviews.filter((r) => r.author !== 'user')
  const mapped = referencesOf(g.params, index)
  const videoFacts = useVideoFacts(mapped.videos.map((v) => v.path))
  const refs = { ...mapped, videos: mapped.videos.map((v) => ({ ...v, facts: videoFacts.get(v.path) })) }
  const model = models.find((m) => m.id === g.model)

  // Opening a clip in the drawer is looking at it on purpose: a finished or failed one is seen from now on (also
  // one that finishes while the drawer shows it). Not when an agent opened it.
  const settled = g.status === 'completed' || g.status === 'failed'
  useEffect(() => {
    if (settled && !openedByAgent) markSeen([workKey.generation(g.id)])
  }, [g.id, settled, openedByAgent])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      // A popover or dialog on top (the sequence picker, an approval) handles its own Escape.
      const overlay = document.querySelector('[role="dialog"], [aria-modal="true"]')
      if (e.key === 'Escape') {
        if (overlay || isTextField(e.target)) return
        e.preventDefault()
        onClose()
        return
      }
      if (overlay || ownsKeys(e.target)) return
      if (e.key === 'ArrowLeft' && onPrev) {
        e.preventDefault()
        onPrev()
      } else if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault()
        onNext()
      } else if (e.key === ' ' && (e.target === document.body || asideRef.current?.contains(e.target as Node))) {
        // Space plays and pauses, unless a button has the focus (it presses the button).
        if (e.target instanceof HTMLButtonElement) return
        const video = videoRef.current
        if (!video) return
        e.preventDefault()
        if (video.paused) void video.play().catch(() => {})
        else video.pause()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, onPrev, onNext])

  const deleteReview = async (r: GenerationReview) => {
    try {
      await window.studio.deleteReview(r.id)
      reload()
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  return (
    <aside
      ref={asideRef}
      aria-label="Clip details"
      className="no-drag absolute inset-y-0 right-0 z-30 flex flex-col border-l border-line bg-panel shadow-2xl shadow-black/60"
      style={{ width: 'min(620px, 82%)' }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line/60 px-3">
        {/* The open clip may have dropped out of the list (rated while filtering on unrated clips, finished while
            filtering on running ones): it has no place to count from, but stepping on still works. */}
        {(position || onPrev || onNext) && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={onPrev}
              disabled={!onPrev}
              title="Previous clip (←)"
              className="rounded p-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-30"
            >
              <ChevronLeftIcon size={13} />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              title="Next clip (→)"
              className="rounded p-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-30"
            >
              <ChevronRightIcon size={13} />
            </button>
            {position && (
              <span className="ml-1 text-[11px] text-muted tabular-nums">
                {position.index + 1} of {position.total}
              </span>
            )}
          </div>
        )}
        <h2 className="min-w-0 flex-1 truncate px-2 font-medium" title={generationTitle(g)}>
          {g.title?.trim() ? generationTitle(g, 60) : titleFromPrompt(g.prompt, 8, 60) || 'Clip'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="rounded p-1.5 text-muted transition hover:bg-raised hover:text-text"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Player key={g.id} g={g} videoRef={videoRef} autoPlay={!openedByAgent} />

        <div className="space-y-6 px-5 pb-8 pt-4">
          {/* Keyed by clip: an armed "Delete" (and its focused confirm button) must never carry over to the next
              clip, or → then Space would delete a clip the user never confirmed. (Not g.id alone: YourReview is a
              sibling keyed by it, and duplicate keys would leave the old one in the page.) */}
          <Actions
            key={`actions:${g.id}`}
            g={g}
            onReuse={onReuse}
            onDelete={onDelete}
            onChange={onChange}
            navigate={navigate}
            reuseTitle={reuseTitle}
          />
          {error && <p className="text-[12px] text-accent select-text">{error}</p>}

          <YourReview key={g.id} generation={g} review={userReview} loaded={loaded} onRate={onRate} />

          {(g.source === 'import' || g.source === 'edit') && <OwnFilm key={`own:${g.id}`} g={g} navigate={navigate} />}

          {/* An own film or a version has no prompt of its own: its name is shown above instead. */}
          {(g.prompt || g.source === undefined || g.source === 'generated') && (
            <section>
              <div className="mb-2 flex items-center">
                <h3 className={`${sectionTitle} mb-0 flex-1`}>Prompt</h3>
                <CopyButton text={g.prompt} disabled={!g.prompt} />
              </div>
              <HighlightedPrompt
                text={g.prompt}
                images={refs.images}
                audios={refs.audios}
                videos={refs.videos}
                highlighted={highlighted}
                onHover={setHighlighted}
                className="text-[13px]"
              />
              {/* What Venice actually got, when Studio appended the referenced assets' descriptions to it. Keyed by
                  clip, so an unfolded prompt folds again on the next one. */}
              {sentPromptDiffers(g.prompt, g.sentPrompt) && (
                <SentPrompt
                  key={`sent:${g.id}`}
                  prompt={g.prompt}
                  sentPrompt={g.sentPrompt}
                  images={refs.images}
                  audios={refs.audios}
                  videos={refs.videos}
                  highlighted={highlighted}
                  onHover={setHighlighted}
                />
              )}
              {g.params.negativePrompt && (
                <div className="mt-3">
                  <h4 className="mb-1 text-[11px] text-muted">Negative prompt</h4>
                  <HighlightedPrompt
                    text={g.params.negativePrompt}
                    images={refs.images}
                    audios={refs.audios}
                    videos={refs.videos}
                    className="text-[12px] text-muted"
                  />
                </div>
              )}
            </section>
          )}

          {(refs.images.length > 0 || refs.audios.length > 0 || refs.videos.length > 0) && (
            <References
              images={refs.images}
              audios={refs.audios}
              videos={refs.videos}
              highlighted={highlighted}
              onHover={setHighlighted}
              navigate={navigate}
            />
          )}

          <Settings g={g} modelName={model?.name} navigate={navigate} />

          <AgentReviews reviews={otherReviews} onDelete={(r) => void deleteReview(r)} />

          <LinkedLearnings generationId={g.id} navigate={navigate} onOpenLearning={onOpenLearning} />
        </div>
      </div>
    </aside>
  )
}

function Player({
  g,
  videoRef,
  autoPlay
}: {
  g: Generation
  videoRef: RefObject<HTMLVideoElement | null>
  /**
   * Off when an agent opened the drawer: the clip waits for the user to press play (playing it is what marks it
   * seen, and an agent showing a clip shouldn't start sound on its own).
   */
  autoPlay: boolean
}) {
  const progress = progressOf(g)
  // A failure shown in a drawer an agent opened counts as seen once it has been on screen for a moment.
  const failureRef = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(failureRef, g.status === 'failed' ? workKey.generation(g.id) : undefined)
  return (
    <div className="relative aspect-video w-full shrink-0 bg-black">
      {g.status === 'completed' && g.filePath ? (
        <video
          ref={videoRef}
          src={mediaUrl(g.filePath)}
          poster={g.thumbPath ? mediaUrl(g.thumbPath) : undefined}
          controls
          autoPlay={autoPlay}
          loop
          preload="auto"
          onPlay={(e) => pauseOthers(e.currentTarget)}
          className="h-full w-full object-contain"
        />
      ) : isPending(g) ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-muted">
          <span className="flex items-center gap-2">
            <Spinner />
            {g.status === 'queued' ? 'Queued…' : 'Generating…'}
          </span>
          <div className="h-1 w-full max-w-64 overflow-hidden rounded bg-raised">
            <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${(progress ?? 0.03) * 100}%` }} />
          </div>
          <span className="text-[11px]">
            {formatSeconds(g.executionDuration)}
            {g.averageExecutionTime ? ` of ~${formatSeconds(g.averageExecutionTime)}` : ''}
          </span>
        </div>
      ) : (
        <div
          ref={failureRef}
          className="flex h-full items-center justify-center overflow-y-auto p-6 text-center text-accent select-text"
        >
          {g.status === 'failed' ? (g.error ?? 'Failed') : 'The video doesn’t exist.'}
        </div>
      )}
    </div>
  )
}

function Actions({
  g,
  onReuse,
  onDelete,
  onChange,
  navigate,
  reuseTitle
}: {
  g: Generation
  onReuse: (g: Generation) => void
  onDelete: (g: Generation) => void
  onChange?: (g: Generation) => void
  navigate?: Navigate
  reuseTitle: string
}) {
  const sequenceButton = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const closePicker = useCallback(() => setPickerOpen(false), [])
  // Mounted per clip (keyed by g.id), so the picker, the "added" note and an armed delete start fresh.
  const [added, setAdded] = useState<{ sequenceId: string; name: string; clipNumber: number }>()

  const onAdded = ({ sequence, clipNumber, segmentId }: AddedToSequence) => {
    setPickerOpen(false)
    setAdded({ sequenceId: sequence.id, name: sequence.name, clipNumber })
    if (!g.segmentId) onChange?.({ ...g, segmentId })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {canUseAgain(g) && (
          <button
            type="button"
            onClick={() => onReuse(g)}
            title={reuseTitle}
            className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover"
          >
            Use again
          </button>
        )}
        {g.status === 'completed' && g.filePath && navigate && (
          <button
            type="button"
            onClick={() => {
              // Taking a clip into the Editor is choosing it on purpose.
              markSeen([workKey.generation(g.id)])
              navigate('editor', { type: 'open-editor', generationId: g.id })
            }}
            title="Change the clip with AI in the Editor. The original is left untouched – every change becomes a new version."
            className={`${actionButton} flex items-center gap-1.5`}
          >
            <ScissorsIcon size={12} />
            Edit…
          </button>
        )}
        {g.status !== 'failed' && (
          <button
            ref={sequenceButton}
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className={`${actionButton} ${pickerOpen ? 'bg-raised text-text' : ''}`}
          >
            Add to sequence
          </button>
        )}
        {g.filePath && (
          <button type="button" onClick={() => void window.studio.revealFile(g.filePath!)} className={actionButton}>
            Show file
          </button>
        )}
        {!isPending(g) && (
          <span className="ml-auto">
            <ConfirmButton
              question={g.segmentId ? 'Used as a take – delete?' : 'Delete the video?'}
              onConfirm={() => onDelete(g)}
              title={`Moves the video to ${TRASH}`}
              className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-accent"
            >
              Delete
            </ConfirmButton>
          </span>
        )}
      </div>
      {added && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-[12px]">
          <span className="text-emerald-400">✓</span>
          <span className="min-w-0 flex-1 truncate">
            Clip {added.clipNumber} in “{added.name}”
          </span>
          {navigate && (
            <button
              type="button"
              onClick={() => navigate('sequences', { type: 'open-sequence', sequenceId: added.sequenceId })}
              className="shrink-0 font-medium text-accent hover:underline"
            >
              Open
            </button>
          )}
        </div>
      )}
      <Popover anchorRef={sequenceButton} open={pickerOpen} onClose={closePicker} width={300} label="Add to sequence">
        <SequencePicker generation={g} onAdded={onAdded} />
      </Popover>
    </div>
  )
}

function References({
  images,
  audios,
  videos,
  highlighted,
  onHover,
  navigate
}: {
  images: ImageReference[]
  audios: AudioReference[]
  videos: VideoReference[]
  highlighted?: string
  onHover: (token: string | undefined) => void
  navigate?: Navigate
}) {
  const openAsset = (ref: { asset?: ImageReference['asset'] }, path: string) => {
    if (ref.asset && navigate) navigate(ASSET_VIEW[ref.asset.kind], { type: 'open-asset', assetId: ref.asset.id })
    else void window.studio.revealFile(path)
  }
  return (
    <section>
      <h3 className={sectionTitle}>References</h3>
      {images.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
          {images.map((r) => {
            const label = r.token ?? (r.role === 'start' ? 'Start image' : 'End image')
            const tone = r.asset ? KIND_TONE[r.asset.kind] : undefined
            return (
              <li key={`${label}:${r.path}`}>
                <button
                  type="button"
                  onClick={() => openAsset(r, r.path)}
                  onMouseEnter={() => r.token && onHover(r.token)}
                  onMouseLeave={() => onHover(undefined)}
                  title={r.asset ? `Open ${r.asset.name} in the library` : `Show the file in ${FILE_MANAGER}`}
                  className={`group block w-full overflow-hidden rounded-md border text-left transition ${
                    highlighted && highlighted === r.token ? 'border-white/60' : 'border-line hover:border-muted'
                  } ${r.unsent ? 'opacity-45' : ''}`}
                >
                  <span className="relative block aspect-square bg-raised">
                    <ReferenceImage path={r.path} />
                    <span
                      className={`absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-medium ${tone?.text ?? 'text-text'}`}
                    >
                      {label}
                    </span>
                  </span>
                  <span className="block truncate px-1.5 py-1 text-[11px] text-muted">
                    {r.unsent ? 'Not sent' : imageCaption(r)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {audios.length > 0 && (
        <ul className={`space-y-1.5 ${images.length ? 'mt-3' : ''}`}>
          {audios.map((a) => {
            const tone = a.asset ? KIND_TONE[a.asset.kind] : undefined
            return (
              <li
                key={`${a.token}:${a.path}`}
                onMouseEnter={() => onHover(a.token)}
                onMouseLeave={() => onHover(undefined)}
                className={`rounded-md border px-2.5 py-2 transition ${
                  highlighted === a.token ? 'border-white/60' : 'border-line'
                }`}
              >
                <div className="mb-1.5 flex items-center gap-2 text-[12px]">
                  <SoundIcon size={12} className="shrink-0 text-muted" />
                  <span className={`shrink-0 font-medium ${tone?.text ?? 'text-text'}`}>{a.token}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {a.asset ? a.asset.name : <span className="text-muted">Own sound</span>}
                    {a.asset && a.asset.audio.length > 1 && <span className="text-muted"> · clip {a.number}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted tabular-nums" title="The part of the audio file that was sent">
                    {audioWindowText(a.start, a.length)}
                  </span>
                </div>
                <audio
                  src={mediaUrl(a.path) + audioWindowFragment(a.start, a.length)}
                  controls
                  preload="none"
                  onPlay={(e) => pauseOthers(e.currentTarget)}
                  className="h-8 w-full"
                  style={{ colorScheme: 'dark' }}
                />
              </li>
            )
          })}
        </ul>
      )}
      {videos.length > 0 && (
        <ul className={`grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 ${images.length || audios.length ? 'mt-3' : ''}`}>
          {videos.map((v) => (
            <ReferenceVideoTile
              key={`${v.token}:${v.path}`}
              video={v}
              lit={highlighted === v.token}
              onHover={onHover}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * A reference video that was sent: its first frame, the part that was sent playing while hovered, its token, what it
 * is and the window. A click shows the file in Finder (videos aren't library assets).
 */
function ReferenceVideoTile({
  video: v,
  lit,
  onHover
}: {
  video: VideoReference
  lit: boolean
  onHover: (token: string | undefined) => void
}) {
  const [playing, setPlaying] = useState(false)
  const { name, detail } = videoLabelParts(v)
  return (
    <li>
      <button
        type="button"
        onClick={() => void window.studio.revealFile(v.path)}
        onMouseEnter={() => {
          onHover(v.token)
          setPlaying(true)
        }}
        onMouseLeave={() => {
          onHover(undefined)
          setPlaying(false)
        }}
        onFocus={() => setPlaying(true)}
        onBlur={() => setPlaying(false)}
        title={`${name} · ${detail} – the part that was sent plays while you point at it. Click to show the file in ${FILE_MANAGER}.`}
        className={`group block w-full overflow-hidden rounded-md border text-left transition ${
          lit ? 'border-white/60' : 'border-line hover:border-muted'
        } ${v.unsent ? 'opacity-45' : ''}`}
      >
        <span className="relative block aspect-video bg-black">
          <VideoWindowPreview path={v.path} start={v.start} length={v.length} playing={playing} className="h-full w-full object-contain" />
          <span className={`absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-medium ${VIDEO_TONE.text}`}>{v.token}</span>
        </span>
        <span className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] text-muted">
          <span className="min-w-0 flex-1 truncate">{v.unsent ? 'Not sent' : name}</span>
          <span className="shrink-0 tabular-nums" title="The part of the video that was sent">
            {audioWindowText(v.start, v.length)}
          </span>
        </span>
      </button>
    </li>
  )
}

function ReferenceImage({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className="flex h-full w-full items-center justify-center p-2 text-center text-[10px] text-muted">
        The image no longer exists
      </span>
    )
  }
  return (
    <img
      src={mediaUrl(path)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  )
}

function Settings({ g, modelName, navigate }: { g: Generation; modelName?: string; navigate?: Navigate }) {
  const p = g.params
  // An own film or a version has no model, mode or price of its own to speak of.
  const own = g.source === 'import' || g.source === 'edit'
  const rows: [string, ReactNode][] = own
    ? [
        ['Source', g.source === 'import' ? 'Own film' : 'Version from the Editor'],
        ['Duration', g.videoDuration ? formatClipLength(g.videoDuration) : p.duration]
      ]
    : [
        ['Model', <span title={g.model}>{modelName ?? g.model}</span>],
        [
          'Mode',
          // A take made from a video in the Editor (an edit or an upscale) isn't one of the Generate form's modes.
          p.upscaleFactor
            ? 'Upscale'
            : p.sourceVideo || (referenceVideosOf(p).length > 0 && !videosAreReferences(p))
              ? 'Video to video'
              : MODE_LABEL[kindOfModelId(g.model)]
        ],
        [
          'Duration',
          // The model sometimes delivers a little more or less than asked for.
          g.videoDuration && Math.abs(g.videoDuration - durationSeconds(p.duration)) > 0.05
            ? `${p.duration} (became ${formatClipLength(g.videoDuration)})`
            : p.duration
        ]
      ]
  if (p.resolution) rows.push(['Resolution', p.resolution])
  if (p.aspectRatio) rows.push(['Aspect ratio', p.aspectRatio])
  if (p.audio !== undefined) rows.push(['Audio', p.audio ? 'On' : 'Off'])
  rows.push(['Cost', g.source === 'import' ? 'None (own film)' : formatUsd(g.quote)])
  rows.push(['Status', STATUS_LABEL[g.status]])
  rows.push(['Created', new Date(g.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })])
  if (g.completedAt && g.status === 'completed') rows.push(['Took', formatSeconds(g.completedAt - g.createdAt)])
  if (g.segmentId) {
    rows.push([
      'Take in',
      <TakeOwnerLink key={g.segmentId} segmentId={g.segmentId} generationId={g.id} navigate={navigate} />
    ])
  }
  if (g.filePath) {
    rows.push([
      'File',
      <span className="break-all text-muted select-text" title={g.filePath}>
        {fileName(g.filePath)}
      </span>
    ])
  }
  return (
    <section>
      <h3 className={sectionTitle}>Settings</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * An own film's original (when Studio made a working copy of it), or where a version came from: "Made from v2 in
 * "<edit>"", with a way to open the edit.
 */
function OwnFilm({ g, navigate }: { g: Generation; navigate?: Navigate }) {
  const badge = sourceBadge(g)
  // A version's edit, for its name and the base version's number; undefined while looking, null when it is gone.
  const [edit, setEdit] = useState<Edit | null>()
  useEffect(() => {
    if (!g.editId) return
    let current = true
    window.studio.getEdit(g.editId).then(
      (e) => current && setEdit(e),
      () => current && setEdit(null)
    )
    return () => {
      current = false
    }
  }, [g.editId])

  const reasons = g.recipe?.import?.workingCopy
  const note = workingCopyNote(reasons)
  const parent = edit && g.parentId ? edit.versions.find((v) => v.id === g.parentId) : undefined

  return (
    <section>
      <h3 className={sectionTitle}>{g.source === 'import' ? 'Own film' : 'Version'}</h3>
      <div className="space-y-2 rounded-md border border-line px-3 py-2.5 text-[12px]">
        <p className="flex items-center gap-1.5">
          {g.source === 'import' ? (
            <CameraIcon size={12} className="shrink-0 text-muted" />
          ) : (
            <ScissorsIcon size={12} className="shrink-0 text-muted" />
          )}
          <span className="min-w-0 truncate font-medium" title={generationTitle(g)}>
            {generationTitle(g)}
          </span>
          {badge && <span className="shrink-0 text-[11px] text-muted">· {badge.label}</span>}
        </p>
        {g.source === 'import' && (
          <>
            {g.recipe?.import?.name && (
              <p className="text-muted">
                Imported from <span className="text-text">{g.recipe.import.name}</span>
                {note ? ` · ${note}` : ''}
              </p>
            )}
            {g.originalPath && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 text-muted">
                  Original file: <span className="break-all text-text select-text">{fileName(g.originalPath)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void window.studio.revealFile(g.originalPath!)}
                  className="rounded px-1.5 py-0.5 text-muted transition hover:bg-raised hover:text-text"
                >
                  Show original in {FILE_MANAGER}
                </button>
              </div>
            )}
          </>
        )}
        {g.source === 'edit' && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-muted">
              {edit === undefined && g.editId
                ? 'Looking for the edit…'
                : edit
                  ? parent
                    ? `Made from v${parent.number} in “${edit.name}”`
                    : `A version in “${edit.name}”`
                  : 'The edit no longer exists.'}
            </span>
            {edit && navigate && (
              <button
                type="button"
                onClick={() => navigate('editor', { type: 'open-editor', editId: edit.id })}
                className="rounded px-1.5 py-0.5 text-muted transition hover:bg-raised hover:text-text"
              >
                Open in the Editor
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** The sequence clip or storyboard transition a take belongs to, named, and opened on click (with the take in focus). */
function TakeOwnerLink({
  segmentId,
  generationId,
  navigate
}: {
  segmentId: string
  generationId: string
  navigate?: Navigate
}) {
  // undefined while looking, null when it can't be found (the take's clip or transition is gone).
  const [owner, setOwner] = useState<TakeOwner | null>()
  useEffect(() => {
    let current = true
    setOwner(undefined)
    findTakeOwner(segmentId).then(
      (found) => current && setOwner(found ?? null),
      (e: unknown) => {
        // Only a label and a shortcut; the take is still reachable from the sidebar.
        console.warn('Could not find where the take belongs', e)
        if (current) setOwner(null)
      }
    )
    return () => {
      current = false
    }
  }, [segmentId])
  if (owner === undefined) return <span className="text-muted">…</span>
  if (owner === null) return <span className="text-muted">A sequence or storyboard</span>
  if (!navigate) return <span>{takeOwnerLabel(owner)}</span>
  return (
    <button
      type="button"
      onClick={() => openTakeOwner(owner, segmentId, navigate, generationId)}
      title={owner.kind === 'storyboard' ? 'Open the storyboard' : 'Open the sequence'}
      className="text-left text-text underline-offset-2 hover:underline"
    >
      {takeOwnerLabel(owner)}
    </button>
  )
}

/** Learnings that cite this clip as evidence: what was concluded from it. */
function LinkedLearnings({
  generationId,
  navigate,
  onOpenLearning
}: {
  generationId: string
  navigate?: Navigate
  onOpenLearning?: (id: string) => void
}) {
  const { learnings } = useLearnings()
  const linked = learnings.filter((l) => l.evidence.includes(generationId))
  if (!linked.length) return null
  const open = (id: string) => {
    if (onOpenLearning) return onOpenLearning(id)
    requestLearning(id)
    navigate?.('prompts')
  }
  return (
    <section>
      <h3 className={sectionTitle}>Learnings from the clip</h3>
      <ul className="space-y-1.5">
        {linked.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => open(l.id)}
              disabled={!onOpenLearning && !navigate}
              className="flex w-full items-start gap-2 rounded-md border border-line px-2.5 py-2 text-left transition hover:bg-raised"
            >
              <BulbIcon size={13} className="mt-0.5 shrink-0 text-amber-300" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{l.title}</span>
                <span className="line-clamp-2 text-[12px] leading-snug text-muted">{l.insight}</span>
              </span>
              <span className="shrink-0 text-[11px] text-muted">{formatWhen(l.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
