import { useEffect, useRef, type ReactNode } from 'react'
import type { EditVersion } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from '../sequences/icons'
import { useEditor } from './EditorContext'
import { formatClock, markedIn, markedOut, versionName } from './editorUtils'
import { CompareIcon, FrameBackIcon, FrameForwardIcon, LoopIcon, RedoIcon, UndoIcon } from './icons'
import { usePlayhead, usePlayerState, type PlayerController } from './playerController'

// The big player: the current version, or the version it is compared with (Jämför ⇄) at the same playhead.
// Transport, marking in and out, looping the marked range, and undo/redo between versions.

const EVENTS = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'seeked', 'loadedmetadata'] as const

interface Props {
  current: EditVersion
  /** The version Jämför shows (the current one's parent, or one picked under Versioner). */
  other?: EditVersion
  comparing: boolean
  onCompare: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

export default function Player({ current, other, comparing, onCompare, canUndo, canRedo, onUndo, onRedo }: Props) {
  const { player, duration, selection, setSelection } = useEditor()
  const state = usePlayerState(player)
  const shown = comparing && other ? other : current
  // Both stay loaded, so switching between them is instant.
  const versions = other && other.id !== current.id ? [current, other] : [current]

  useEffect(() => player.show(shown.id), [player, shown.id])
  useEffect(() => player.rangeChanged(selection), [player, selection])

  // As in an editing program: an in-point alone marks to the end, an out-point alone from the start.
  const markIn = () => setSelection(markedIn(player.markInTime(), selection, duration))
  const markOut = () => setSelection(markedOut(player.markOutTime(), selection))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {versions.map((v) => (
          <VideoOf key={v.id} version={v} player={player} visible={v.id === shown.id} />
        ))}
        {comparing && other && (
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[12px] text-white">
            Visar {versionName(other)}
          </span>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-2">
        <div className="flex items-center gap-0.5">
          <IconButton title="Till början" onClick={() => player.seek(selection?.start ?? 0)}>
            <PrevIcon size={12} />
          </IconButton>
          <IconButton title="En bildruta bakåt (←, ⇧← en sekund)" onClick={() => player.stepFrames(-1)}>
            <FrameBackIcon size={13} />
          </IconButton>
          <button
            type="button"
            onClick={() => player.toggle()}
            title={state.playing ? 'Pausa (mellanslag, K)' : 'Spela (mellanslag, L)'}
            aria-label={state.playing ? 'Pausa' : 'Spela'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-raised text-text transition hover:bg-line"
          >
            {state.playing ? <PauseIcon size={12} /> : <PlayIcon size={12} className="translate-x-px" />}
          </button>
          <IconButton title="En bildruta framåt (→, ⇧→ en sekund)" onClick={() => player.stepFrames(1)}>
            <FrameForwardIcon size={13} />
          </IconButton>
          <IconButton title="Till slutet" onClick={() => player.seek(selection?.end ?? duration)}>
            <NextIcon size={12} />
          </IconButton>
        </div>
        <Clock player={player} duration={duration} rate={state.playing && state.rate !== 1 ? state.rate * state.direction : undefined} />

        {/* Wraps in a narrow window, where the player column beside Redigera's list is only a few hundred px. */}
        <div className="flex flex-wrap items-center gap-1">
          <TextButton title="Markera in vid spelhuvudet (I)" onClick={markIn}>
            Markera in
          </TextButton>
          <TextButton title="Markera ut vid spelhuvudet (O)" onClick={markOut}>
            Markera ut
          </TextButton>
          <TextButton
            title={selection ? 'Spelar markeringen om och om igen' : 'Markera ett avsnitt först'}
            onClick={() => player.loopRange(state.looping ? undefined : selection)}
            disabled={!selection}
            active={state.looping}
          >
            <LoopIcon size={12} />
            Spela markeringen
          </TextButton>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <TextButton
            title={
              other
                ? comparing
                  ? `Tillbaka till ${versionName(current)}`
                  : `Visa ${versionName(other)} vid samma ställe`
                : 'Det finns ingen annan version att jämföra med än'
            }
            onClick={onCompare}
            disabled={!other}
            active={comparing}
          >
            <CompareIcon size={12} />
            {other ? `Jämför${comparing ? '' : ` med v${other.number}`}` : 'Jämför'}
          </TextButton>
          <IconButton title="Ångra – gå tillbaka till versionen före (⌘Z)" onClick={onUndo} disabled={!canUndo}>
            <UndoIcon size={13} />
          </IconButton>
          <IconButton title="Gör om – gå till den nyaste versionen efter (⌘⇧Z)" onClick={onRedo} disabled={!canRedo}>
            <RedoIcon size={13} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

function VideoOf({ version, player, visible }: { version: EditVersion; player: PlayerController; visible: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const path = version.generation.filePath
  const id = version.id

  useEffect(() => {
    const el = ref.current
    player.attach(id, el)
    if (!el) return
    const handlers = EVENTS.map((type) => {
      const handler = () => (type === 'loadedmetadata' ? player.loaded(id) : player.elementEvent(id, type))
      el.addEventListener(type, handler)
      return [type, handler] as const
    })
    return () => {
      for (const [type, handler] of handlers) el.removeEventListener(type, handler)
      player.attach(id, null)
    }
  }, [player, id, path])

  if (!path || version.generation.fileMissing) {
    return visible ? (
      <p className="px-6 text-center text-muted">Filmfilen för {versionName(version)} saknas (flyttad eller raderad i Finder).</p>
    ) : null
  }
  return (
    <video
      ref={ref}
      src={mediaUrl(path)}
      preload="auto"
      playsInline
      onClick={() => player.toggle()}
      className={`absolute inset-0 h-full w-full object-contain ${visible ? '' : 'invisible'}`}
    />
  )
}

function Clock({ player, duration, rate }: { player: PlayerController; duration: number; rate?: number }) {
  const t = usePlayhead(player)
  return (
    <span className="whitespace-nowrap text-[12px] tabular-nums text-muted">
      <span className="text-text">{formatClock(t)}</span> / {formatClock(duration)}
      {rate !== undefined && <span className="ml-1.5 text-[11px]">{rate > 0 ? `${rate}×` : `◀ ${-rate}×`}</span>}
    </span>
  )
}

function IconButton({
  title,
  onClick,
  disabled,
  children
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

function TextButton({
  title,
  onClick,
  disabled,
  active,
  children
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] transition disabled:opacity-35 disabled:hover:bg-transparent ${
        active ? 'bg-accent/15 text-text' : 'text-muted hover:bg-raised hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}
