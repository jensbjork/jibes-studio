import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { DEFAULT_MODEL, MAX_AUDIO_CLIP_SECONDS, MIN_AUDIO_CLIP_SECONDS, maxReferenceAudios } from '@shared/models'
import { workKey, type Asset, type AssetAudio, type EditJob, type FinishedWork } from '@shared/types'
import { ASSET_COPY, assetAudio, originText, type AudioCopy } from '../../lib/assets'
import { SERVICE_NAME, ipcErrorMessage } from '../../lib/hooks'
import { TRASH } from '../../lib/platform'
import { markSeen, useIsUnseen, useSeenWhenVisible, useUnseen } from '../../lib/work'
import SectionTitle from '../library/SectionTitle'
import { reorderHint } from '../pickers/useReorder'
import { CloseIcon, PauseIcon, PlayIcon, PlusIcon } from '../sequences/icons'
import { buttonClass } from '../ui/button'
import ConfirmButton from '../ui/ConfirmButton'
import { NewChip, Spinner } from '../work/StatusMark'
import ClipWindowTrack from './ClipWindowTrack'
import {
  AUDIO_FORMATS,
  LONG_AUDIO_SECONDS,
  clampWindow,
  clipFileName,
  formatDuration,
  formatPosition,
  formatSecondsField,
  moveWindow,
  parseTime,
  type ClipWindow
} from './audioUtils'
import { insertIndex, type DropTarget } from './imageUtils'
import { useClipPlayer, type ClipPlayer } from './useClipPlayer'
import { useWindowDraft } from './useWindowDraft'
import VoiceDesignDialog from './VoiceDesignDialog'

/** In-app drags carry this type, so they can't be mistaken for files dropped from Finder. */
const DRAG_TYPE = 'application/x-studio-asset-audio'
const MAX_AUDIOS = maxReferenceAudios(DEFAULT_MODEL['reference-to-video'])

/** What Activity's "Go there" points out in Voice: a new clip, or a voice design that failed. */
export interface SoundFocus {
  audioId?: string
  jobId?: string
}

/** A voice being made for this character ("Design a voice with AI"). */
interface DesignJob {
  id: string
  label: string
  fraction?: number
}

interface Props {
  /** A character or an environment (the kinds with sound clips). */
  asset: Asset
  /** Audio files currently being copied into the library. */
  adding: number
  /** Audio files from Finder are being dragged over the editor. */
  fileOver: boolean
  onAdd: (paths: string[]) => void
  onUpdated: (a: Asset) => void
  onError: (message: string) => void
  /** Whether a window edit is waiting to be saved or being saved (Generate waits for it). */
  onBusyChange: (busy: boolean) => void
  /**
   * A clip (or a failed voice design) to bring into view and point out once (Activity's "Go there"). Changes to
   * a new request object each time, so the same one can be pointed out again.
   */
  focus?: SoundFocus
}

/**
 * A character's voice ("Voice") or an environment's sound ("Soundscape"): the clips in order, the first the default,
 * each with a player and the window that is sent to Venice. Add (drop or pick), remove, reorder, and preview exactly
 * what is sent. The folder they are in opens from the editor's ⋯.
 */
export default function AssetSounds({
  asset,
  adding,
  fileOver,
  onAdd,
  onUpdated,
  onError,
  onBusyChange,
  focus
}: Props) {
  const copy = ASSET_COPY[asset.kind].audio
  const player = useClipPlayer()
  // Optimistic state so the list reacts before main answers.
  const [order, setOrder] = useState<string[]>()
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set())
  const [busyClips, setBusyClips] = useState<ReadonlySet<string>>(() => new Set())
  const [dragId, setDragId] = useState<string>()
  const [target, setTarget] = useState<DropTarget>()
  const dragRef = useRef<string | undefined>(undefined)
  const reorderSeq = useRef(0)
  // Characters only: voices made with AI ("Design a voice with AI"), and the dialog that starts one.
  const voices = asset.kind === 'character'
  const [designing, setDesigning] = useState(false)
  const [designs, setDesigns] = useState<DesignJob[]>([])
  const latestAsset = useRef(asset)
  latestAsset.current = asset

  // Voice designs of this character that failed and haven't been seen – wherever the user was when they failed: each
  // is said here as a row, which counts as seen once it has been on screen a moment (D4) and stays listed until its ✕
  // or another character, so it can be read.
  const unseenFailures = useUnseen(
    (w) => voices && w.kind === 'job' && w.status === 'failed' && w.ownerId === asset.id
  )
  const [keptFailures, setKeptFailures] = useState<FinishedWork[]>([])
  const [closedFailures, setClosedFailures] = useState<ReadonlySet<string>>(() => new Set())
  const failures = useMemo(() => {
    const byKey = new Map<string, FinishedWork>()
    for (const w of [...unseenFailures, ...keptFailures]) {
      if (!closedFailures.has(w.key) && !byKey.has(w.key)) byKey.set(w.key, w)
    }
    return [...byKey.values()].sort((a, b) => b.finishedAt - a.finishedAt)
  }, [unseenFailures, keptFailures, closedFailures])
  const keepFailure = (w: FinishedWork) =>
    setKeptFailures((list) => (list.some((x) => x.key === w.key) ? list : [...list, w]))
  const closeFailure = (w: FinishedWork) => {
    markSeen([w.key])
    setClosedFailures((closed) => new Set(closed).add(w.key))
  }

  // A designed voice reports its progress per character; when it is done the new clip is fetched (main has marked it
  // new in Activity, so its row shows "New" until it has been played).
  const designsRef = useRef(designs)
  designsRef.current = designs
  useEffect(() => {
    if (!voices) return
    return window.studio.onEditProgress((p) => {
      if (p.assetId !== asset.id) return
      const list = designsRef.current
      const job = list.find((d) => d.id === p.jobId) ?? (list.length === 1 && !p.jobId ? list[0] : undefined)
      if (!p.done) {
        if (job) {
          setDesigns((l) => l.map((d) => (d.id === job.id ? { ...d, fraction: p.fraction, label: p.label || d.label } : d)))
        }
        return
      }
      if (job) setDesigns((l) => l.filter((d) => d.id !== job.id))
      // A failure also gets its row below (from Activity), which is what marks it seen.
      if (p.error) onError(p.error)
      // Also for a job started before this view mounted (or by an agent): the new clip shows at once.
      else void collect()
    })
  }, [voices, asset.id])

  /** Fetches the character again after a voice was made, so the new clip shows at once. */
  const collect = async () => {
    try {
      const updated = (await window.studio.listAssets('character')).find((a) => a.id === latestAsset.current.id)
      if (!updated) return
      onUpdated(updated)
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  const designStarted = (job: EditJob) =>
    setDesigns((list) => [
      ...list,
      {
        id: job.id,
        label: job.label || 'Designing a voice with AI',
        fraction: job.fraction
      }
    ])

  const toggleConsent = async (clip: AssetAudio, consent: boolean) => {
    try {
      onUpdated(await window.studio.setVoiceCloneConsent(clip.id, consent))
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  const clips = useMemo(() => {
    const visible = assetAudio(asset).filter((c) => !removing.has(c.id))
    if (!order) return visible
    const rank = new Map(order.map((id, i) => [id, i]))
    return visible.slice().sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length))
  }, [asset, removing, order])

  const ids = clips.map((c) => c.id)
  const dropAt = insertIndex(ids, dragId, target)

  const busy = busyClips.size > 0 || order !== undefined
  useEffect(() => onBusyChange(busy), [busy])
  useEffect(() => () => onBusyChange(false), [])

  const setClipBusy = (id: string, on: boolean) =>
    setBusyClips((s) => {
      if (s.has(id) === on) return s
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const reorder = async (next: string[]) => {
    const seq = ++reorderSeq.current
    setOrder(next)
    try {
      onUpdated(await window.studio.reorderAssetAudio(asset.id, next))
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      // A newer reorder owns the optimistic order until it settles.
      if (seq === reorderSeq.current) setOrder(undefined)
    }
  }

  const move = (id: string, to: number) => {
    const from = ids.indexOf(id)
    if (from === -1 || to < 0 || to >= ids.length || to === from) return
    const next = ids.filter((x) => x !== id)
    next.splice(to, 0, id)
    void reorder(next)
  }

  const remove = async (id: string) => {
    if (player.state.clipId === id) player.stop()
    setRemoving((s) => new Set(s).add(id))
    try {
      onUpdated(await window.studio.removeAssetAudio(id))
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setRemoving((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  const pick = async () => {
    try {
      const paths = await window.studio.pickAudio(true)
      if (paths.length) onAdd(paths)
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  // ── Reordering with HTML5 drag and drop (by the grip) ──

  const isInternal = (e: DragEvent) => !!dragRef.current && e.dataTransfer.types.includes(DRAG_TYPE)

  const startDrag = (e: DragEvent<HTMLElement>, id: string) => {
    e.dataTransfer.setData(DRAG_TYPE, id)
    e.dataTransfer.effectAllowed = 'move'
    // Drag the whole row's picture, not just the grip.
    const row = e.currentTarget.closest('[data-clip-row]')
    if (row instanceof HTMLElement) e.dataTransfer.setDragImage(row, 24, 24)
    dragRef.current = id
    requestAnimationFrame(() => {
      if (dragRef.current === id) setDragId(id)
    })
  }

  const endDrag = () => {
    dragRef.current = undefined
    setDragId(undefined)
    setTarget(undefined)
  }

  const overRow = (e: DragEvent<HTMLElement>, id: string) => {
    if (!isInternal(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    setTarget((t) => (t?.id === id && t.after === after ? t : { id, after }))
  }

  const overList = (e: DragEvent) => {
    if (!isInternal(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const leaveList = (e: DragEvent<HTMLElement>) => {
    if (dragRef.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(undefined)
  }

  const dropOnList = (e: DragEvent) => {
    if (!isInternal(e)) return
    e.preventDefault()
    const dragged = dragRef.current!
    const to = insertIndex(ids, dragged, target)
    endDrag()
    if (to !== undefined) move(dragged, to)
  }

  if (!copy) return null
  const empty = clips.length === 0 && adding === 0 && designs.length === 0 && failures.length === 0

  return (
    <div>
      <SectionTitle
        title={copy.title}
        hint={copy.intro}
        hintTitle={copy.introMore}
        actions={
          <>
            {voices && (
              <button
                type="button"
                onClick={() => setDesigning(true)}
                className={buttonClass('ghost', 'sm')}
                title={`Describe a voice – ${SERVICE_NAME} creates it and it is saved as a new voice clip`}
              >
                Design a voice with AI…
              </button>
            )}
            {!empty && (
              <button
                type="button"
                onClick={() => void pick()}
                className={buttonClass('ghost', 'sm')}
                title={`Choose audio files (${AUDIO_FORMATS})`}
              >
                <PlusIcon size={12} />
                Add
              </button>
            )}
          </>
        }
      />

      {empty ? (
        <button
          type="button"
          onClick={() => void pick()}
          className={`flex h-32 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed transition ${
            fileOver ? 'border-accent bg-accent/5 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
          }`}
        >
          <PlusIcon size={18} />
          <span className="text-sm">
            {fileOver ? 'Drop to add' : 'Drop an audio file here or click to choose'}
          </span>
          <span className="max-w-md text-[11px] leading-relaxed text-muted">
            {AUDIO_FORMATS}, at least {MIN_AUDIO_CLIP_SECONDS} seconds. {copy.tips}
          </span>
        </button>
      ) : (
        <ul
          onDragOver={overList}
          onDragLeave={leaveList}
          onDrop={dropOnList}
          className={`-m-2 flex flex-col gap-2 rounded-lg border border-dashed p-2 transition ${
            fileOver ? 'border-accent bg-accent/5' : 'border-transparent'
          }`}
        >
          {clips.map((clip, i) => (
            <ClipRow
              key={clip.id}
              clip={clip}
              index={i}
              count={clips.length}
              copy={copy}
              player={player}
              dragging={dragId === clip.id}
              indicator={
                dropAt === undefined || target?.id !== clip.id ? undefined : target.after ? 'after' : 'before'
              }
              onUpdated={onUpdated}
              voice={voices}
              focus={focus?.audioId === clip.id ? focus : undefined}
              onConsent={(on) => void toggleConsent(clip, on)}
              onBusy={(on) => setClipBusy(clip.id, on)}
              onRemove={() => void remove(clip.id)}
              onMove={(to) => move(clip.id, to)}
              onDragStart={(e) => startDrag(e, clip.id)}
              onDragOver={(e) => overRow(e, clip.id)}
              onDragEnd={endDrag}
            />
          ))}
          {Array.from({ length: adding }, (_, i) => (
            <li
              key={`adding-${i}`}
              className="flex h-16 animate-pulse items-center rounded-lg bg-raised px-4 text-[11px] text-muted"
            >
              Adding sound…
            </li>
          ))}
          {designs.map((d) => (
            <li key={d.id} className="flex h-16 items-center gap-3 rounded-lg bg-raised px-4 text-[11px] text-muted">
              <Spinner />
              <span className="min-w-0 flex-1 truncate">{d.label}…</span>
              {d.fraction !== undefined && <span className="tabular-nums">{Math.round(d.fraction * 100)}%</span>}
            </li>
          ))}
          {failures.map((w) => (
            <DesignFailureRow
              key={w.key}
              work={w}
              focus={focus?.jobId && focus.jobId === w.jobId ? focus : undefined}
              onSeen={() => keepFailure(w)}
              onClose={() => closeFailure(w)}
            />
          ))}
        </ul>
      )}
      {designing && (
        <VoiceDesignDialog asset={asset} onClose={() => setDesigning(false)} onStarted={designStarted} />
      )}

      {/* Only what applies, one line each (Generate shows the seconds against its limit itself). */}
      {clips.length > MAX_AUDIOS && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          A generation takes at most {MAX_AUDIOS} {MAX_AUDIOS === 1 ? 'sound clip' : 'sound clips'} – the first
          ones come along.
        </p>
      )}
      {!empty && asset.images.length === 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Sound is sent only together with a reference image – add one above.
        </p>
      )}
    </div>
  )
}

/** A voice design that failed: its error, until ✕. Being on screen a moment marks it seen. */
function DesignFailureRow({
  work,
  focus,
  onSeen,
  onClose
}: {
  work: FinishedWork
  /** Set when "Go there" points it out (a new request object each time). */
  focus?: SoundFocus
  /** Told just before it is marked seen: it stays listed until ✕. */
  onSeen: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLLIElement>(null)
  useSeenWhenVisible(ref, work.key, 1500, onSeen)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!focus) return
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1600)
    return () => clearTimeout(t)
  }, [focus])
  return (
    <li
      ref={ref}
      className={`flex items-start gap-3 rounded-lg border bg-accent/10 px-4 py-3 text-[11px] leading-relaxed transition duration-500 ${
        flash ? 'border-accent' : 'border-transparent'
      }`}
    >
      <span className="min-w-0 flex-1 select-text">
        <span className="font-medium text-danger">Couldn't create the voice.</span>{' '}
        <span className="text-danger">{work.error ?? 'The job failed.'}</span>
      </span>
      <button
        type="button"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition hover:bg-raised hover:text-text"
      >
        <CloseIcon size={11} />
      </button>
    </li>
  )
}

interface RowProps {
  clip: AssetAudio
  index: number
  count: number
  copy: AudioCopy
  player: ClipPlayer
  dragging: boolean
  /** Side on which the drop marker is drawn. */
  indicator?: 'before' | 'after'
  onUpdated: (a: Asset) => void
  /** A character's voice: it can be marked as allowed to clone ("May be cloned for new lines"). */
  voice: boolean
  /** Set when this clip is to be brought into view and pointed out (a new request object each time). */
  focus?: SoundFocus
  onConsent: (consent: boolean) => void
  onBusy: (busy: boolean) => void
  onRemove: () => void
  /** Moves the clip to this index. */
  onMove: (to: number) => void
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragOver: (e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

/**
 * One clip: grip, play/pause, name and length, the window on a track with a way to hear it and to start it at the
 * playhead; the window as numbers only on request ("Exact times…"), since the track already shows them.
 */
function ClipRow({
  clip,
  index,
  count,
  copy,
  player,
  dragging,
  indicator,
  onUpdated,
  voice,
  focus,
  onConsent,
  onBusy,
  onRemove,
  onMove,
  onDragStart,
  onDragOver,
  onDragEnd
}: RowProps) {
  const draft = useWindowDraft(clip, onUpdated)
  const w = draft.value
  const name = clipFileName(clip.path)
  const loaded = player.state.clipId === clip.id
  const playingFile = loaded && player.state.playing && player.state.mode === 'file'
  const playingWindow = loaded && player.state.playing && player.state.mode === 'window'
  const failed = player.failed.has(clip.id)
  const tooShort = clip.duration < MIN_AUDIO_CLIP_SECONDS
  const long = clip.duration > LONG_AUDIO_SECONDS
  // A voice made with AI that hasn't been played yet (Activity); playing a second of it clears it.
  const fresh = useIsUnseen(workKey.audio(clip.id))
  const origin = originText(clip.origin)
  const [exact, setExact] = useState(false)

  // Pointed out from elsewhere: scrolled into view and outlined for a moment.
  const rowRef = useRef<HTMLLIElement>(null)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!focus) return
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1600)
    return () => clearTimeout(t)
  }, [focus])

  useEffect(() => onBusy(draft.busy), [draft.busy])
  // A clip removed mid-edit must not keep the section busy.
  useEffect(() => () => onBusy(false), [])
  // A preview that is playing follows the window while it is dragged or typed.
  useEffect(() => player.windowChanged(clip.id, w), [w.start, w.length])

  // ↑ ↓ on the grip, or ⌥↑ / ⌥↓ as everywhere else an item moves; the grip keeps the focus as its row moves.
  const gripRef = useRef<HTMLButtonElement>(null)
  const refocusGrip = useRef(false)
  useEffect(() => {
    if (!refocusGrip.current) return
    refocusGrip.current = false
    gripRef.current?.focus()
  }, [index])
  const gripKeys = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return
    const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : undefined
    if (to === undefined) return
    e.preventDefault()
    if (to < 0 || to >= count) return
    refocusGrip.current = true
    onMove(to)
  }

  const startHere = () => {
    if (loaded) draft.change(moveWindow(w, Math.round(player.state.time * 10) / 10, clip.duration), 'now')
  }

  return (
    <li ref={rowRef} data-clip-row className="relative" onDragOver={onDragOver}>
      {indicator && (
        <div
          className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent ${
            indicator === 'before' ? '-top-[5px]' : '-bottom-[5px]'
          }`}
        />
      )}
      <div
        className={`rounded-lg border bg-panel px-3 pb-3 pt-2.5 transition duration-500 ${
          flash ? 'border-emerald-400/70' : 'border-line'
        } ${dragging ? 'opacity-30' : ''}`}
      >
        <div className="flex items-center gap-2">
          {count > 1 && (
            <button
              ref={gripRef}
              type="button"
              draggable
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onKeyDown={gripKeys}
              aria-label={`Move ${name}: ${reorderHint('y')}`}
              title={reorderHint('y').replace(/^./, (c) => c.toUpperCase())}
              className="-ml-1 flex h-7 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-muted active:cursor-grabbing"
            >
              <GripIcon />
            </button>
          )}
          <button
            type="button"
            onClick={() => player.toggleFile(clip)}
            disabled={failed}
            aria-label={playingFile ? 'Pause' : `Play ${name}`}
            title={failed ? undefined : playingFile ? 'Pause' : 'Play the whole recording'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-text transition hover:bg-line disabled:opacity-40 disabled:hover:bg-raised"
          >
            {playingFile ? <PauseIcon size={12} /> : <PlayIcon size={12} className="translate-x-px" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate" title={origin ? `${origin}\n${clip.path}` : clip.path}>
                {name}
              </span>
              {fresh && <NewChip title="New voice – play it to listen" className="shrink-0" />}
              {index === 0 && copy.firstBadge && (
                <span title={copy.firstBadge.title} className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted">
                  {copy.firstBadge.label}
                </span>
              )}
            </div>
            <div className="text-[11px] tabular-nums text-muted">
              {loaded && (player.state.playing || player.state.time > 0)
                ? `${formatPosition(player.state.time)} of ${formatDuration(clip.duration)}`
                : formatDuration(clip.duration)}
            </div>
          </div>
          {index > 0 && (
            <button
              type="button"
              onClick={() => onMove(0)}
              title={copy.firstBadge ? copy.firstBadge.title : 'Move the clip to the top of the list'}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-text"
            >
              Make default
            </button>
          )}
          <ConfirmButton
            question={`Remove ${copy.clipDefinite}?`}
            confirmLabel="Remove"
            onConfirm={onRemove}
            title={`Remove ${copy.clipDefinite} – the file is moved to ${TRASH}, or to “Reference images” if generations have used it`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-danger"
          >
            <CloseIcon size={11} />
            <span className="sr-only">Remove</span>
          </ConfirmButton>
        </div>

        <div className="mt-3 pl-1">
          <ClipWindowTrack
            duration={clip.duration}
            window={w}
            playhead={loaded ? player.state.time : undefined}
            onSeek={(t) => player.seek(clip, t)}
            onBegin={draft.begin}
            onPreview={draft.preview}
            onEnd={draft.end}
            onChange={draft.change}
          />

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => player.toggleWindow(clip, w)}
              disabled={failed}
              className={buttonClass('secondary', 'sm')}
            >
              {playingWindow ? <PauseIcon size={11} /> : <PlayIcon size={11} />}
              {playingWindow ? 'Stop' : 'Listen to the excerpt'}
            </button>
            <button
              type="button"
              onClick={startHere}
              disabled={!loaded}
              title={loaded ? 'Start the excerpt at the playhead' : 'Play or click in the sound first'}
              className={buttonClass('secondary', 'sm')}
            >
              Start here
            </button>
            <button
              type="button"
              onClick={() => setExact((on) => !on)}
              aria-expanded={exact}
              title="Type where the excerpt starts and how long it is"
              className={buttonClass('ghost', 'sm')}
            >
              {exact ? 'Hide exact times' : 'Exact times…'}
            </button>
            <span className="ml-auto text-[11px] text-muted">
              {draft.error ? (
                <span className="text-danger select-text" title={draft.error}>
                  Couldn't save: {draft.error}
                </span>
              ) : (
                draft.saving && 'Saving…'
              )}
            </span>
          </div>

          {exact && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <TimeField
                label="From"
                value={w.start}
                format={formatPosition}
                onCommit={(t) => draft.change(moveWindow(w, t, clip.duration), 'now')}
                title="Where the excerpt starts, in minutes and seconds (e.g. 0:05.5) or seconds"
                clamp={(t) => moveWindow(w, t, clip.duration).start}
              />
              <TimeField
                label="Length"
                value={w.length}
                format={formatSecondsField}
                suffix="s"
                onCommit={(t) => draft.change(withLength(w, t, clip.duration), 'now')}
                title={`How long a part is sent, ${MIN_AUDIO_CLIP_SECONDS}–${MAX_AUDIO_CLIP_SECONDS} seconds`}
                clamp={(t) => withLength(w, t, clip.duration).length}
              />
            </div>
          )}

          {voice && (
            <label
              className="mt-2.5 flex w-fit cursor-pointer items-center gap-2 text-[12px]"
              title="The Editor may then clone the voice for new lines (Re-record lines)."
            >
              <input
                type="checkbox"
                checked={clip.cloneConsent}
                onChange={(e) => onConsent(e.target.checked)}
                className="accent-accent"
              />
              <span>I have the right to use this voice</span>
            </label>
          )}

          {(tooShort || long || failed) && (
            <div className="mt-2 space-y-1 text-[11px] leading-relaxed">
              {tooShort && (
                <p className="text-warning">
                  ⚠ The recording is only {formatDuration(clip.duration)} – the models need at least{' '}
                  {MIN_AUDIO_CLIP_SECONDS} seconds. Choose a longer recording.
                </p>
              )}
              {long && !tooShort && (
                <p className="text-muted">Long recording – only the excerpt is sent, so pick the part that sounds best.</p>
              )}
              {failed && (
                <p className="text-muted">
                  The file can't be played here, but the excerpt is sent as usual when you generate.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/** The window with a typed length: from the same start, moved back if the recording ends before it does. */
function withLength(w: ClipWindow, length: number, duration: number): ClipWindow {
  return clampWindow({ start: w.start, length }, duration)
}

/** A time typed by hand; saved on Enter or when leaving the field, Esc restores it. */
function TimeField({
  label,
  value,
  format,
  suffix,
  title,
  onCommit,
  clamp
}: {
  label: string
  value: number
  format: (seconds: number) => string
  suffix?: string
  title: string
  onCommit: (seconds: number) => void
  /** What the value becomes, so an unchanged result isn't saved again. */
  clamp?: (seconds: number) => number
}) {
  const [text, setText] = useState(format(value))
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const clickedIn = useRef(false)

  useEffect(() => {
    if (!focused) setText(format(value))
  }, [value, focused])

  // Leaving the field is the one place a typed time is saved; Esc leaves it without saving.
  const discard = useRef(false)
  const leave = () => {
    const t = discard.current ? undefined : parseTime(text)
    discard.current = false
    setInvalid(false)
    setFocused(false)
    if (t === undefined) {
      setText(format(value))
      return
    }
    const next = clamp ? clamp(t) : t
    if (Math.abs(next - value) >= 0.005) onCommit(t)
    setText(format(next))
  }

  return (
    <label className="flex items-center gap-1.5" title={title}>
      <span className="text-muted">{label}</span>
      <span className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={text}
          spellCheck={false}
          aria-invalid={invalid}
          onChange={(e) => {
            setText(e.target.value)
            setInvalid(false)
          }}
          // Focusing the field selects the whole time, so typing replaces it. A click puts the caret where it
          // landed after the focus handler has run, and again when the button comes up; so select a frame
          // later and keep that click's mouseup from undoing it.
          onMouseDown={() => {
            clickedIn.current = !focused
          }}
          onMouseUp={(e) => {
            if (!clickedIn.current) return
            clickedIn.current = false
            e.preventDefault()
          }}
          onFocus={(e) => {
            setFocused(true)
            const input = e.currentTarget
            input.select()
            requestAnimationFrame(() => {
              if (document.activeElement === input) input.select()
            })
          }}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // A time that can't be read stays for correcting, marked.
              if (parseTime(text) === undefined) setInvalid(true)
              else e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              discard.current = true
              e.currentTarget.blur()
            }
          }}
          className={`w-[4.75rem] rounded-md border bg-raised py-1 pl-2 tabular-nums outline-none focus:border-muted ${
            suffix ? 'pr-5' : 'pr-2'
          } ${invalid ? 'border-accent' : 'border-line'}`}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted">{suffix}</span>
        )}
      </span>
    </label>
  )
}

function GripIcon() {
  return (
    <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden>
      {[2, 7, 12].map((y) => (
        <g key={y}>
          <circle cx="2" cy={y} r="1.1" />
          <circle cx="6" cy={y} r="1.1" />
        </g>
      ))}
    </svg>
  )
}
