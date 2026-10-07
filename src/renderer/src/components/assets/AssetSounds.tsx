import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  DEFAULT_MODEL,
  MAX_AUDIO_CLIP_SECONDS,
  MAX_REFERENCE_AUDIO_SECONDS,
  MIN_AUDIO_CLIP_SECONDS,
  maxReferenceAudios
} from '@shared/models'
import type { Asset, AssetAudio } from '@shared/types'
import { ASSET_COPY, ASSET_FOLDER, assetAudio, type AudioCopy } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import OpenFolderButton from '../library/OpenFolderButton'
import ConfirmButton from '../sequences/ConfirmButton'
import { PauseIcon, PlayIcon } from '../sequences/icons'
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

/** In-app drags carry this type, so they can't be mistaken for files dropped from Finder. */
const DRAG_TYPE = 'application/x-studio-asset-audio'
const MAX_AUDIOS = maxReferenceAudios(DEFAULT_MODEL['reference-to-video'])

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
  /** Whether a window edit is waiting to be saved or being saved (Generera waits for it). */
  onBusyChange: (busy: boolean) => void
}

/**
 * A character's voice ("Röst") or an environment's sound ("Ljudmiljö"): the clips in order, each with a
 * player and the window that is sent to Venice. Add (drop or pick), remove, reorder, and preview exactly
 * what is sent.
 */
export default function AssetSounds({ asset, adding, fileOver, onAdd, onUpdated, onError, onBusyChange }: Props) {
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
  const empty = clips.length === 0 && adding === 0

  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-medium">{copy.title}</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">{copy.intro}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <OpenFolderButton
            target={ASSET_FOLDER[asset.kind]}
            id={asset.id}
            title={`Visa mappen med ${copy.clip} i Finder`}
            onError={onError}
            className="rounded-md px-2.5 py-1 text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          />
          {!empty && (
            <button
              onClick={() => void pick()}
              className="rounded-md px-2.5 py-1 text-muted hover:bg-raised hover:text-text"
              title={`Välj ljudfiler (${AUDIO_FORMATS})`}
            >
              ＋ Lägg till
            </button>
          )}
        </div>
      </div>

      {empty ? (
        <button
          onClick={() => void pick()}
          className={`flex h-32 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed transition ${
            fileOver ? 'border-accent bg-accent/5 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
          }`}
        >
          <span className="text-xl">＋</span>
          <span className="text-sm">
            {fileOver ? 'Släpp för att lägga till' : 'Släpp en ljudfil här eller klicka för att välja'}
          </span>
          <span className="max-w-md text-[11px] leading-relaxed text-muted">
            {AUDIO_FORMATS}, minst {MIN_AUDIO_CLIP_SECONDS} sekunder. {copy.tips}
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
              Lägger till ljud…
            </li>
          ))}
        </ul>
      )}

      {!empty && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Bara utdraget skickas. Venice tar emot högst {MAX_AUDIOS} ljudklipp och sammanlagt{' '}
          {MAX_REFERENCE_AUDIO_SECONDS} sekunder per generering, och bara tillsammans med minst en referensbild.
          Ljudet visar hur det ska låta – vad som sägs eller händer skriver du i prompten.
        </p>
      )}
    </div>
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
  onBusy: (busy: boolean) => void
  onRemove: () => void
  /** Moves the clip to this index. */
  onMove: (to: number) => void
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragOver: (e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

/** One clip: grip, play/pause, name and length, the window on a track, and the window as numbers. */
function ClipRow({
  clip,
  index,
  count,
  copy,
  player,
  dragging,
  indicator,
  onUpdated,
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

  useEffect(() => onBusy(draft.busy), [draft.busy])
  // A clip removed mid-edit must not keep the section busy.
  useEffect(() => () => onBusy(false), [])
  // A preview that is playing follows the window while it is dragged or typed.
  useEffect(() => player.windowChanged(clip.id, w), [w.start, w.length])

  const gripKeys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' && index > 0) onMove(index - 1)
    else if (e.key === 'ArrowDown' && index < count - 1) onMove(index + 1)
    else return
    e.preventDefault()
  }

  const startHere = () => {
    if (loaded) draft.change(moveWindow(w, Math.round(player.state.time * 10) / 10, clip.duration), 'now')
  }

  return (
    <li data-clip-row className="relative" onDragOver={onDragOver}>
      {indicator && (
        <div
          className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent ${
            indicator === 'before' ? '-top-[5px]' : '-bottom-[5px]'
          }`}
        />
      )}
      <div className={`rounded-lg border border-line bg-panel px-3 pb-3 pt-2.5 transition ${dragging ? 'opacity-30' : ''}`}>
        <div className="flex items-center gap-2">
          {count > 1 && (
            <button
              type="button"
              draggable
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onKeyDown={gripKeys}
              aria-label={`Flytta ${name} – dra, eller använd ↑ och ↓`}
              title="Dra för att ändra ordning"
              className="-ml-1 flex h-7 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60 active:cursor-grabbing"
            >
              <GripIcon />
            </button>
          )}
          <button
            type="button"
            onClick={() => player.toggleFile(clip)}
            disabled={failed}
            aria-label={playingFile ? 'Pausa' : `Spela upp ${name}`}
            title={failed ? undefined : playingFile ? 'Pausa' : 'Spela upp hela inspelningen'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-text transition hover:bg-line disabled:opacity-40 disabled:hover:bg-raised"
          >
            {playingFile ? <PauseIcon size={12} /> : <PlayIcon size={12} className="translate-x-px" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate" title={clip.path}>
                {name}
              </span>
              {index === 0 && copy.firstBadge && (
                <span title={copy.firstBadge.title} className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted">
                  {copy.firstBadge.label}
                </span>
              )}
            </div>
            <div className="text-[11px] tabular-nums text-muted">
              {loaded && (player.state.playing || player.state.time > 0)
                ? `${formatPosition(player.state.time)} av ${formatDuration(clip.duration)}`
                : formatDuration(clip.duration)}
            </div>
          </div>
          {index > 0 && (
            <button
              type="button"
              onClick={() => onMove(0)}
              title={copy.firstBadge ? copy.firstBadge.title : 'Flytta klippet först i listan'}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-text"
            >
              Flytta överst
            </button>
          )}
          <ConfirmButton
            question={`Ta bort ${copy.clipDefinite}?`}
            confirmLabel="Ta bort"
            onConfirm={onRemove}
            title={`Ta bort ${copy.clipDefinite} – filen flyttas till papperskorgen, eller till Referensbilder om genereringar har använt den`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-accent"
          >
            <span aria-hidden>✕</span>
            <span className="sr-only">Ta bort</span>
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

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1.5">
              <TimeField
                label="Från"
                value={w.start}
                format={formatPosition}
                onCommit={(t) => draft.change(moveWindow(w, t, clip.duration), 'now')}
                title="Var utdraget börjar, i minuter och sekunder (t.ex. 0:05,5) eller sekunder"
                clamp={(t) => moveWindow(w, t, clip.duration).start}
              />
              <button
                type="button"
                onClick={startHere}
                disabled={!loaded}
                title={loaded ? 'Låt utdraget börja vid uppspelningen' : 'Spela upp eller klicka i ljudet först'}
                className="rounded-md border border-line px-2 py-1 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
              >
                Här
              </button>
            </div>
            <TimeField
              label="Längd"
              value={w.length}
              format={formatSecondsField}
              suffix="s"
              onCommit={(t) => draft.change(withLength(w, t, clip.duration), 'now')}
              title={`Hur lång del som skickas, ${MIN_AUDIO_CLIP_SECONDS}–${MAX_AUDIO_CLIP_SECONDS} sekunder`}
              clamp={(t) => withLength(w, t, clip.duration).length}
            />
            <button
              type="button"
              onClick={() => player.toggleWindow(clip, w)}
              disabled={failed}
              className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {playingWindow ? <PauseIcon size={11} /> : <PlayIcon size={11} />}
              {playingWindow ? 'Stoppa' : 'Lyssna på utdraget'}
            </button>
            <span className="ml-auto text-[11px] text-muted">
              {draft.error ? (
                <span className="text-accent select-text" title={draft.error}>
                  Kunde inte spara: {draft.error}
                </span>
              ) : (
                draft.saving && 'Sparar…'
              )}
            </span>
          </div>

          {(tooShort || long || failed) && (
            <div className="mt-2 space-y-1 text-[11px] leading-relaxed">
              {tooShort && (
                <p className="text-amber-400">
                  ⚠ Inspelningen är bara {formatDuration(clip.duration)} – Venice kräver minst {MIN_AUDIO_CLIP_SECONDS}{' '}
                  sekunder. Välj en längre inspelning.
                </p>
              )}
              {long && !tooShort && (
                <p className="text-muted">Lång inspelning – bara utdraget skickas, så välj den del som låter bäst.</p>
              )}
              {failed && (
                <p className="text-muted">
                  Filen kan inte spelas upp här, men utdraget skickas som vanligt när du genererar.
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
