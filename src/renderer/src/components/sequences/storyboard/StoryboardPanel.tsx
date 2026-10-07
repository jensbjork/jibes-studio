import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import type {
  Asset,
  AssetKind,
  Generation,
  Segment,
  SegmentImageSlot,
  SegmentImageSource,
  Sequence,
  Still,
  VideoModel
} from '@shared/types'
import { formatUsd, mediaUrl } from '../../../lib/media'
import { clipBlocked } from '../clipChecks'
import ConfirmButton from '../ConfirmButton'
import { ArrowRightIcon, BridgeIcon, GripIcon, PlusIcon } from '../icons'
import NotesField from '../NotesField'
import {
  clipLength,
  continuationMismatch,
  effectiveParams,
  endMismatch,
  formatLength,
  pendingTake,
  readyTake,
  selectedTake,
  takeProgress
} from '../sequenceUtils'
import type { FlushRegistry } from '../useDraft'
import { hasAutomaticFrames, useFramePreview } from '../useFramePreview'
import type { SequenceStore } from '../useSequence'
import { useClipQuote } from '../useTotalQuote'
import ImageSlot, { type AutoFrame } from './ImageSlot'
import { bridgeDescription, describeImage, slotState, usesKeyframes } from './slots'

interface Props {
  sequence: Sequence
  segment: Segment
  index: number
  /** The clip selected in the sequence (shared with the timeline). */
  selected: boolean
  models: VideoModel[]
  modelsError?: string
  stills: Still[]
  assets: Asset[]
  ffmpegOk: boolean
  slotWidth: number
  slotHeight: number
  store: SequenceStore
  flushers: FlushRegistry
  /** A take of this clip is being sent from the storyboard. */
  submitting: boolean
  /** Why the last "Generera tagning" from this panel failed. */
  error?: string
  /** The slot whose change is being saved. */
  busySlot?: SegmentImageSlot
  /** Being dragged to another place. */
  dragging: boolean
  /** Where a dragged panel would land: before or after this one. */
  dropSide?: 'before' | 'after'
  adding: boolean
  panelRef: (el: HTMLElement | null) => void
  onSelect: () => void
  onEdit: () => void
  onGenerate: () => void
  onBridge: () => void
  /** Opens the clip in the timeline, where its takes are. */
  onShowTakes: () => void
  /** Plays the sequence from this clip. */
  onPreview: () => void
  onAddAfter: () => void
  onDelete: () => void
  onDismissError: () => void
  onUseTake: (take: Generation) => void
  onSetImage: (slot: SegmentImageSlot, source: SegmentImageSource | null) => void
  onCreateImage: (slot: SegmentImageSlot) => void
  onPickFrame: (slot: SegmentImageSlot) => void
  onManage?: (kind: AssetKind) => void
  onError: (message: string) => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
}

const secondary =
  'flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 py-1.5 text-[12px] transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * One clip as a storyboard panel: its start and end images with the clip between them, the notes ("Vad händer"),
 * the prompt, the take it has and what can be done with it.
 */
export default function StoryboardPanel({
  sequence,
  segment,
  index,
  selected,
  models,
  modelsError,
  stills,
  assets,
  ffmpegOk,
  slotWidth,
  slotHeight,
  store,
  flushers,
  submitting,
  error,
  busySlot,
  dragging,
  dropSide,
  adding,
  panelRef,
  onSelect,
  onEdit,
  onGenerate,
  onBridge,
  onShowTakes,
  onPreview,
  onAddAfter,
  onDelete,
  onDismissError,
  onUseTake,
  onSetImage,
  onCreateImage,
  onPickFrame,
  onManage,
  onError,
  onDragStart,
  onDragEnd
}: Props) {
  const count = sequence.segments.length
  const number = index + 1
  const previous = index > 0 ? sequence.segments[index - 1] : undefined
  const next = sequence.segments[index + 1]
  const params = effectiveParams(segment, index)
  const quote = useClipQuote(params)
  const blocked = clipBlocked({ sequence, index, params, models, modelsError, ffmpegOk })
  const { preview, loading } = useFramePreview(sequence, index, hasAutomaticFrames(segment, index, count))

  const start = slotState(sequence, index, 'start')
  const end = slotState(sequence, index, 'end')
  const startFrame: AutoFrame = {
    path: preview?.start?.source === 'previous' ? preview.start.path : undefined,
    time: preview?.start?.source === 'previous' ? preview.start.time : undefined,
    loading
  }
  const endFrame: AutoFrame = {
    path: preview?.end?.source === 'next' ? preview.end.path : undefined,
    time: preview?.end?.source === 'next' ? preview.end.time : undefined,
    loading
  }

  const bridge = bridgeDescription(index, count)
  const bridged = (segment.continueFromPrevious || !previous) && (segment.endFromNext || !next)
  const changedNeighbour = continuationMismatch(segment, previous) || endMismatch(segment, next)
  const prompt = segment.params.prompt.trim()
  const length = clipLength(segment)
  const problems = preview?.problems ?? []

  // The panel moves only from its handle, so selecting text in the notes never drags it.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const disarm = () => setArmed(false)
    window.addEventListener('mouseup', disarm)
    return () => window.removeEventListener('mouseup', disarm)
  }, [armed])

  return (
    <article
      ref={panelRef}
      draggable={armed}
      onDragStart={(e) => {
        if (!armed) return
        onDragStart(e)
      }}
      onDragEnd={() => {
        setArmed(false)
        onDragEnd()
      }}
      onMouseDown={onSelect}
      aria-label={`Klipp ${number}`}
      className={`group/panel relative flex flex-col rounded-xl border bg-panel transition ${
        selected ? 'border-accent/70 ring-1 ring-accent/25' : 'border-line hover:border-muted/50'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      {dropSide && (
        <span
          className={`pointer-events-none absolute inset-y-2 w-0.5 rounded-full bg-accent ${
            dropSide === 'before' ? '-left-[13px]' : '-right-[13px]'
          }`}
        />
      )}

      <header className="flex h-10 items-center gap-2 border-b border-line/70 pl-3 pr-2">
        <span className="rounded bg-raised px-1.5 py-px text-[12px] font-semibold tabular-nums">{number}</span>
        <TakeStatus segment={segment} onPreview={onPreview} onShowTakes={onShowTakes} />
        <div className="ml-auto flex items-center gap-0.5">
          <ConfirmButton
            question="Radera rutan?"
            onConfirm={onDelete}
            title="Radera rutan (tagningarna finns kvar under Generera)"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted opacity-0 transition hover:bg-raised hover:text-accent focus:opacity-100 group-hover/panel:opacity-100"
          >
            Radera
          </ConfirmButton>
          <button
            type="button"
            onMouseDown={() => setArmed(true)}
            onMouseUp={() => setArmed(false)}
            title="Dra för att flytta rutan"
            aria-label="Flytta rutan"
            className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-muted transition hover:bg-raised hover:text-text active:cursor-grabbing"
          >
            <GripIcon size={12} />
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="flex items-center justify-center gap-1">
          <ImageSlot
            slot="start"
            state={start}
            number={number}
            hasPrevious={!!previous}
            hasNext={!!next}
            autoFrame={startFrame}
            label={start.kind === 'image' ? describeImage(start.path, stills, assets) : undefined}
            width={slotWidth}
            height={slotHeight}
            stills={stills}
            assets={assets}
            busy={busySlot === 'start'}
            onSet={(source) => onSetImage('start', source)}
            onCreateImage={() => onCreateImage('start')}
            onPickFrame={() => onPickFrame('start')}
            onManage={onManage}
            onError={onError}
          />
          <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 text-muted" title="Klippet går från startbilden till slutbilden">
            <span className="text-[10px] tabular-nums">
              {length !== undefined ? formatLength(length) : `≈ ${segment.params.duration.replace(/s$/, ' s')}`}
            </span>
            <ArrowRightIcon size={16} />
          </div>
          <ImageSlot
            slot="end"
            state={end}
            number={number}
            hasPrevious={!!previous}
            hasNext={!!next}
            autoFrame={endFrame}
            label={end.kind === 'image' ? describeImage(end.path, stills, assets) : undefined}
            width={slotWidth}
            height={slotHeight}
            stills={stills}
            assets={assets}
            busy={busySlot === 'end'}
            onSet={(source) => onSetImage('end', source)}
            onCreateImage={() => onCreateImage('end')}
            onPickFrame={() => onPickFrame('end')}
            onManage={onManage}
            onError={onError}
          />
        </div>

        <NewerTake segment={segment} onUse={onUseTake} onCompare={onShowTakes} />

        <NotesField segment={segment} store={store} flushers={flushers} compact />

        <button
          type="button"
          onClick={onEdit}
          title="Öppna klippet i redigeraren"
          className="-mx-1 rounded-md px-1 py-1 text-left transition hover:bg-raised"
        >
          <span className="block text-[11px] text-muted">Prompt</span>
          <span className={`line-clamp-2 text-[12px] leading-snug ${prompt ? '' : 'italic text-muted'}`}>
            {prompt || 'Ingen prompt än – klicka för att skriva en'}
          </span>
        </button>

        {(usesKeyframes(sequence, index) || problems.length > 0 || changedNeighbour) && (
          <div className="space-y-1 text-[11px] leading-snug">
            {usesKeyframes(sequence, index) && (
              <p className="text-muted">Med start-/slutbild används bild-till-video – utseendet kommer från bilderna.</p>
            )}
            {/* Calm on purpose: a new panel always starts with something to do (a prompt, a neighbour's take). */}
            {problems.map((p) => (
              <p key={p} className="flex gap-1.5 text-muted">
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/80" aria-hidden />
                <span>{p}</span>
              </p>
            ))}
            {changedNeighbour && (
              <p className="text-amber-300">
                Den valda tagningen möter inte grannarnas bildrutor som de ser ut nu. Generera en ny tagning för en
                sömlös övergång.
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[11px] text-[#ffb3b5]">
            <p className="min-w-0 flex-1 select-text">{error}</p>
            <button onClick={onDismissError} className="shrink-0 opacity-60 hover:opacity-100" title="Stäng">
              ✕
            </button>
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={onGenerate}
            disabled={!!blocked || submitting}
            title={blocked ?? 'Generera en tagning av klippet'}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
          >
            {submitting ? 'Skickar…' : segment.takes.length ? 'Ny tagning' : 'Generera tagning'}
            <span className="text-white/75">{formatUsd(quote)}</span>
          </button>
          {bridge && !bridged && (
            <button type="button" onClick={onBridge} title={bridge} className={secondary}>
              <BridgeIcon size={13} />
              Gör om mellan grannarna
            </button>
          )}
          <button type="button" onClick={onEdit} className={`${secondary} ml-auto`} title="Öppna klippet i redigeraren">
            Redigera
          </button>
        </div>
        {blocked && !submitting && !problems.length && (
          <p className="-mt-1.5 text-[11px] text-muted">{blocked}</p>
        )}
      </div>

      <button
        type="button"
        onClick={onAddAfter}
        disabled={adding}
        title={`Ny ruta efter ruta ${number}`}
        aria-label={`Ny ruta efter ruta ${number}`}
        className="absolute -right-6 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-raised text-muted opacity-0 shadow transition hover:border-muted hover:text-text focus:opacity-100 group-hover/panel:opacity-100 disabled:opacity-0"
      >
        <PlusIcon size={11} />
      </button>
    </article>
  )
}

/** The take the clip has: its poster (plays the sequence from here), progress, or that there is none yet. */
function TakeStatus({
  segment,
  onPreview,
  onShowTakes
}: {
  segment: Segment
  onPreview: () => void
  onShowTakes: () => void
}) {
  const ready = readyTake(segment)
  const pending = pendingTake(segment)
  const selected = selectedTake(segment)
  const latest = segment.takes[0]
  const count = segment.takes.length

  let status: ReactNode
  if (pending) {
    const progress = takeProgress(pending)
    status = (
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
        <span className="animate-pulse">{pending.status === 'queued' ? 'I kö…' : 'Genererar…'}</span>
        <span className="h-1 w-14 overflow-hidden rounded bg-raised">
          <span className="block h-full bg-accent transition-all duration-1000" style={{ width: `${(progress ?? 0.03) * 100}%` }} />
        </span>
      </span>
    )
  } else if (ready) {
    status = <span className="truncate text-[11px] text-muted">Vald tagning</span>
  } else if (selected?.fileMissing) {
    status = <span className="text-[11px] text-muted">Filen saknas</span>
  } else if (latest?.status === 'failed') {
    status = (
      <span className="truncate text-[11px] text-accent" title={latest.error}>
        Senaste försöket misslyckades
      </span>
    )
  } else {
    status = <span className="text-[11px] text-muted">{count ? 'Ingen vald tagning' : 'Ingen tagning än'}</span>
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {ready && (
        <button
          type="button"
          onClick={onPreview}
          title="Spela sekvensen härifrån"
          className="relative h-7 w-12 shrink-0 overflow-hidden rounded bg-black outline-none ring-offset-1 ring-offset-panel focus-visible:ring-2 focus-visible:ring-muted"
        >
          {ready.thumbPath ? (
            <img src={mediaUrl(ready.thumbPath)} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            <video src={`${mediaUrl(ready.filePath!)}#t=0.5`} preload="metadata" muted className="pointer-events-none h-full w-full object-cover" />
          )}
        </button>
      )}
      {status}
      {count > 0 && (
        <button
          type="button"
          onClick={onShowTakes}
          title="Visa tagningarna i tidslinjen"
          className="shrink-0 rounded px-1 text-[11px] text-muted transition hover:bg-raised hover:text-text"
        >
          {count} {count === 1 ? 'tagning' : 'tagningar'}
        </button>
      )}
    </div>
  )
}

// Newer takes the user has said no to ("✕" on the note), for as long as the window is open.
const dismissedNewer = new Set<string>()

/**
 * A finished take newer than the selected one. Main only selects a new take by itself when the clip has no
 * usable one, so a clip redone between its neighbours keeps the old take until the user picks the new one.
 */
function NewerTake({
  segment,
  onUse,
  onCompare
}: {
  segment: Segment
  onUse: (take: Generation) => void
  onCompare: () => void
}) {
  const [, setDismissed] = useState(0)
  const ready = readyTake(segment)
  const newest = segment.takes.find((t) => t.status === 'completed' && t.filePath && !t.fileMissing)
  if (!ready || !newest || newest.id === ready.id || newest.createdAt <= ready.createdAt) return null
  if (dismissedNewer.has(newest.id)) return null
  return (
    <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
      {newest.thumbPath && (
        <img src={mediaUrl(newest.thumbPath)} alt="" draggable={false} className="h-6 w-10 shrink-0 rounded object-cover" />
      )}
      <span className="min-w-0 flex-1">En ny tagning är klar.</span>
      <button
        type="button"
        onClick={onCompare}
        className="shrink-0 rounded px-1.5 py-0.5 text-emerald-200/80 transition hover:bg-emerald-400/10 hover:text-emerald-100"
      >
        Jämför
      </button>
      <button
        type="button"
        onClick={() => onUse(newest)}
        className="shrink-0 rounded bg-emerald-500/20 px-2 py-0.5 font-medium transition hover:bg-emerald-500/30"
      >
        Använd den
      </button>
      <button
        type="button"
        onClick={() => {
          dismissedNewer.add(newest.id)
          setDismissed((n) => n + 1)
        }}
        title="Behåll den valda tagningen"
        aria-label="Behåll den valda tagningen"
        className="shrink-0 rounded px-1 text-emerald-200/60 transition hover:text-emerald-100"
      >
        ✕
      </button>
    </div>
  )
}
