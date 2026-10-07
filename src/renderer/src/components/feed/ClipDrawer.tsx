import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { durationSeconds, kindOfModelId, type Kind } from '@shared/models'
import type { Generation, GenerationReview, VideoModel } from '@shared/types'
import { ASSET_VIEW } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatSeconds, formatUsd, mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { findTakeOwner, openTakeOwner, takeOwnerLabel, type TakeOwner } from '../../lib/takes'
import { KIND_TONE } from '../pickers/assetKinds'
import Popover from '../pickers/Popover'
import SequencePicker, { type AddedToSequence } from '../pickers/SequencePicker'
import { titleFromPrompt } from '../pickers/text'
import { sentPromptDiffers } from '../prompt/descriptions'
import { CopyButton } from '../prompts/controls'
import { formatWhen } from '../prompts/prompt-utils'
import { requestLearning, useLearnings } from '../prompts/useLearnings'
import ConfirmButton from '../sequences/ConfirmButton'
import { CloseIcon } from '../sequences/icons'
import { STATUS_LABEL, formatClipLength, isPending, progressOf } from './feedText'
import HighlightedPrompt from './HighlightedPrompt'
import { BulbIcon, ChevronLeftIcon, ChevronRightIcon, SoundIcon } from './icons'
import { pauseOthers } from './playback'
import {
  audioWindowFragment,
  audioWindowText,
  imageCaption,
  referencesOf,
  type AudioReference,
  type ImageReference,
  type LibraryIndex
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
  /** A locally patched copy, e.g. with segmentId set after "Lägg i sekvens". */
  onChange?: (g: Generation) => void
  onRate: (g: Generation, rating: number | null) => void
  navigate?: Navigate
  /** Opens a learning; without it the learning is opened in the Prompter view. */
  onOpenLearning?: (id: string) => void
  /** "Använd igen" also takes the user to Generera (when the drawer is shown elsewhere). */
  reuseTitle?: string
}

const MODE_LABEL: Record<Kind, string> = {
  'text-to-video': 'Text till video',
  'image-to-video': 'Startbild till video',
  'reference-to-video': 'Referensbilder till video'
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
  reuseTitle = 'Fyll i formuläret med klippets inställningar'
}: Props) {
  const asideRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [highlighted, setHighlighted] = useState<string>()
  const { reviews, loaded, reload } = useReviews(g.id)
  const [error, setError] = useState<string>()
  useEffect(() => setError(undefined), [g.id])

  const userReview = reviews.find((r) => r.author === 'user')
  const otherReviews = reviews.filter((r) => r.author !== 'user')
  const refs = referencesOf(g.params, index)
  const model = models.find((m) => m.id === g.model)

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
      aria-label="Klippets detaljer"
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
              title="Föregående klipp (←)"
              className="rounded p-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-30"
            >
              <ChevronLeftIcon size={13} />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              title="Nästa klipp (→)"
              className="rounded p-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-30"
            >
              <ChevronRightIcon size={13} />
            </button>
            {position && (
              <span className="ml-1 text-[11px] text-muted tabular-nums">
                {position.index + 1} av {position.total}
              </span>
            )}
          </div>
        )}
        <h2 className="min-w-0 flex-1 truncate px-2 font-medium" title={g.prompt}>
          {titleFromPrompt(g.prompt, 8, 60) || 'Klipp'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          title="Stäng (Esc)"
          className="rounded p-1.5 text-muted transition hover:bg-raised hover:text-text"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Player key={g.id} g={g} videoRef={videoRef} />

        <div className="space-y-6 px-5 pb-8 pt-4">
          {/* Keyed by clip: an armed "Radera" (and its focused confirm button) must never carry over to the next
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

          <section>
            <div className="mb-2 flex items-center">
              <h3 className={`${sectionTitle} mb-0 flex-1`}>Prompt</h3>
              <CopyButton text={g.prompt} disabled={!g.prompt} />
            </div>
            <HighlightedPrompt
              text={g.prompt}
              images={refs.images}
              audios={refs.audios}
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
                highlighted={highlighted}
                onHover={setHighlighted}
              />
            )}
            {g.params.negativePrompt && (
              <div className="mt-3">
                <h4 className="mb-1 text-[11px] text-muted">Negativ prompt</h4>
                <HighlightedPrompt
                  text={g.params.negativePrompt}
                  images={refs.images}
                  audios={refs.audios}
                  className="text-[12px] text-muted"
                />
              </div>
            )}
          </section>

          {(refs.images.length > 0 || refs.audios.length > 0) && (
            <References
              images={refs.images}
              audios={refs.audios}
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

function Player({ g, videoRef }: { g: Generation; videoRef: RefObject<HTMLVideoElement | null> }) {
  const progress = progressOf(g)
  return (
    <div className="relative aspect-video w-full shrink-0 bg-black">
      {g.status === 'completed' && g.filePath ? (
        <video
          ref={videoRef}
          src={mediaUrl(g.filePath)}
          poster={g.thumbPath ? mediaUrl(g.thumbPath) : undefined}
          controls
          autoPlay
          loop
          preload="auto"
          onPlay={(e) => pauseOthers(e.currentTarget)}
          className="h-full w-full object-contain"
        />
      ) : isPending(g) ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-muted">
          <span className="animate-pulse">{g.status === 'queued' ? 'I kö…' : 'Genererar…'}</span>
          <div className="h-1 w-full max-w-64 overflow-hidden rounded bg-raised">
            <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${(progress ?? 0.03) * 100}%` }} />
          </div>
          <span className="text-[11px]">
            {formatSeconds(g.executionDuration)}
            {g.averageExecutionTime ? ` av ~${formatSeconds(g.averageExecutionTime)}` : ''}
          </span>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center overflow-y-auto p-6 text-center text-accent select-text">
          {g.status === 'failed' ? (g.error ?? 'Misslyckades') : 'Videon finns inte.'}
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
        <button
          type="button"
          onClick={() => onReuse(g)}
          title={reuseTitle}
          className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover"
        >
          Använd igen
        </button>
        {g.status !== 'failed' && (
          <button
            ref={sequenceButton}
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className={`${actionButton} ${pickerOpen ? 'bg-raised text-text' : ''}`}
          >
            Lägg i sekvens
          </button>
        )}
        {g.filePath && (
          <button type="button" onClick={() => void window.studio.revealFile(g.filePath!)} className={actionButton}>
            Visa fil
          </button>
        )}
        {!isPending(g) && (
          <span className="ml-auto">
            <ConfirmButton
              question={g.segmentId ? 'Används som tagning – radera?' : 'Radera videon?'}
              onConfirm={() => onDelete(g)}
              title="Flyttar videon till papperskorgen"
              className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-accent"
            >
              Radera
            </ConfirmButton>
          </span>
        )}
      </div>
      {added && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-[12px]">
          <span className="text-emerald-400">✓</span>
          <span className="min-w-0 flex-1 truncate">
            Klipp {added.clipNumber} i ”{added.name}”
          </span>
          {navigate && (
            <button
              type="button"
              onClick={() => navigate('sequences', { type: 'open-sequence', sequenceId: added.sequenceId })}
              className="shrink-0 font-medium text-accent hover:underline"
            >
              Öppna
            </button>
          )}
        </div>
      )}
      <Popover anchorRef={sequenceButton} open={pickerOpen} onClose={closePicker} width={300} label="Lägg i sekvens">
        <SequencePicker generation={g} onAdded={onAdded} />
      </Popover>
    </div>
  )
}

function References({
  images,
  audios,
  highlighted,
  onHover,
  navigate
}: {
  images: ImageReference[]
  audios: AudioReference[]
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
      <h3 className={sectionTitle}>Referenser</h3>
      {images.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
          {images.map((r) => {
            const label = r.token ?? (r.role === 'start' ? 'Startbild' : 'Slutbild')
            const tone = r.asset ? KIND_TONE[r.asset.kind] : undefined
            return (
              <li key={`${label}:${r.path}`}>
                <button
                  type="button"
                  onClick={() => openAsset(r, r.path)}
                  onMouseEnter={() => r.token && onHover(r.token)}
                  onMouseLeave={() => onHover(undefined)}
                  title={r.asset ? `Öppna ${r.asset.name} i biblioteket` : 'Visa filen i Finder'}
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
                    {r.unsent ? 'Skickades inte' : imageCaption(r)}
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
                    {a.asset ? a.asset.name : <span className="text-muted">Eget ljud</span>}
                    {a.asset && a.asset.audio.length > 1 && <span className="text-muted"> · klipp {a.number}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted tabular-nums" title="Den del av ljudfilen som skickades">
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
    </section>
  )
}

function ReferenceImage({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className="flex h-full w-full items-center justify-center p-2 text-center text-[10px] text-muted">
        Bilden finns inte längre
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
  const rows: [string, ReactNode][] = [
    ['Modell', <span title={g.model}>{modelName ?? g.model}</span>],
    ['Läge', MODE_LABEL[kindOfModelId(g.model)]],
    [
      'Längd',
      // The model sometimes delivers a little more or less than asked for.
      g.videoDuration && Math.abs(g.videoDuration - durationSeconds(p.duration)) > 0.05
        ? `${p.duration} (blev ${formatClipLength(g.videoDuration)})`
        : p.duration
    ]
  ]
  if (p.resolution) rows.push(['Upplösning', p.resolution])
  if (p.aspectRatio) rows.push(['Bildformat', p.aspectRatio])
  if (p.audio !== undefined) rows.push(['Ljud', p.audio ? 'På' : 'Av'])
  rows.push(['Kostnad', formatUsd(g.quote)])
  rows.push(['Status', STATUS_LABEL[g.status]])
  rows.push(['Skapad', new Date(g.createdAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })])
  if (g.completedAt && g.status === 'completed') rows.push(['Tog', formatSeconds(g.completedAt - g.createdAt)])
  if (g.segmentId) {
    rows.push(['Tagning i', <TakeOwnerLink key={g.segmentId} segmentId={g.segmentId} navigate={navigate} />])
  }
  if (g.filePath) {
    rows.push([
      'Fil',
      <span className="break-all text-muted select-text" title={g.filePath}>
        {g.filePath.split('/').pop()}
      </span>
    ])
  }
  return (
    <section>
      <h3 className={sectionTitle}>Inställningar</h3>
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

/** The sequence clip or storyboard transition a take belongs to, named, and opened on click. */
function TakeOwnerLink({ segmentId, navigate }: { segmentId: string; navigate?: Navigate }) {
  // undefined while looking, null when it can't be found (the take's clip or transition is gone).
  const [owner, setOwner] = useState<TakeOwner | null>()
  useEffect(() => {
    let current = true
    setOwner(undefined)
    findTakeOwner(segmentId).then(
      (found) => current && setOwner(found ?? null),
      (e: unknown) => {
        // Only a label and a shortcut; the take is still reachable from the sidebar.
        console.warn('Kunde inte hitta var tagningen hör hemma', e)
        if (current) setOwner(null)
      }
    )
    return () => {
      current = false
    }
  }, [segmentId])
  if (owner === undefined) return <span className="text-muted">…</span>
  if (owner === null) return <span className="text-muted">En sekvens eller storyboard</span>
  if (!navigate) return <span>{takeOwnerLabel(owner)}</span>
  return (
    <button
      type="button"
      onClick={() => openTakeOwner(owner, segmentId, navigate)}
      title={owner.kind === 'storyboard' ? 'Öppna storyboarden' : 'Öppna sekvensen'}
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
      <h3 className={sectionTitle}>Lärdomar från klippet</h3>
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
