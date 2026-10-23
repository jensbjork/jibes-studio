import { useEffect, useRef, type ReactNode } from 'react'
import type { EditVersion } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { FILE_MANAGER, shortcut } from '../../lib/platform'
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from '../sequences/icons'
import { useEditor } from './EditorContext'
import { formatClock, markedIn, markedOut, versionName } from './editorUtils'
import { CompareIcon, FrameBackIcon, FrameForwardIcon, RedoIcon, UndoIcon } from './icons'
import { usePlayhead, usePlayerState, type PlayerController } from './playerController'

// The big player: the current version, or the version it is compared with (Compare ⇄) at the same playhead – which
// says which version the actions change, with a way to use the one on screen. Transport, marking in and out, and
// undo/redo between versions, on one row at 1440 px (looping the marked range is in the timeline's selection chip).

const EVENTS = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'seeked', 'loadedmetadata'] as const

interface Props {
  current: EditVersion
  /** The version Compare shows (the current one's parent, or one picked under Versions). */
  other?: EditVersion
  comparing: boolean
  onCompare: () => void
  /** "Use v2" while comparing: the version on screen becomes the one the actions change. */
  onUseOther?: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

export default function Player({
  current,
  other,
  comparing,
  onCompare,
  onUseOther,
  canUndo,
  canRedo,
  onUndo,
  onRedo
}: Props) {
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
        {/* Clicks on the video still play and pause: only the button takes the pointer. */}
        {comparing && other && (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-md bg-black/70 py-1 pl-2 pr-1 text-[12px] text-white">
            <span>
              Showing v{other.number} · actions change v{current.number}
            </span>
            {onUseOther && (
              <button
                type="button"
                onClick={onUseOther}
                title={`Make ${versionName(other)} the version the actions change`}
                className="pointer-events-auto rounded px-1.5 py-0.5 font-medium transition hover:bg-white/15"
              >
                Use v{other.number}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-2">
        <div className="flex items-center gap-0.5">
          <IconButton title="To the start" onClick={() => player.seek(selection?.start ?? 0)}>
            <PrevIcon size={12} />
          </IconButton>
          <IconButton title={`One frame back (←, ${shortcut('⇧←')} one second)`} onClick={() => player.stepFrames(-1)}>
            <FrameBackIcon size={13} />
          </IconButton>
          <button
            type="button"
            onClick={() => player.toggle()}
            title={state.playing ? 'Pause (space, K)' : 'Play (space, L)'}
            aria-label={state.playing ? 'Pause' : 'Play'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-raised text-text transition hover:bg-line"
          >
            {state.playing ? <PauseIcon size={12} /> : <PlayIcon size={12} className="translate-x-px" />}
          </button>
          <IconButton title={`One frame forward (→, ${shortcut('⇧→')} one second)`} onClick={() => player.stepFrames(1)}>
            <FrameForwardIcon size={13} />
          </IconButton>
          <IconButton title="To the end" onClick={() => player.seek(selection?.end ?? duration)}>
            <NextIcon size={12} />
          </IconButton>
        </div>
        <Clock player={player} duration={duration} rate={state.playing && state.rate !== 1 ? state.rate * state.direction : undefined} />

        {/* Wraps in a narrow window, where the player column beside the Editor's list is only a few hundred px. */}
        <div className="flex flex-wrap items-center gap-1">
          <TextButton title="Mark in at the playhead (I)" onClick={markIn}>
            Mark in
          </TextButton>
          <TextButton title="Mark out at the playhead (O)" onClick={markOut}>
            Mark out
          </TextButton>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {/* Only once there is another version: a new edit has nothing to compare with. */}
          {other && (
            <TextButton
              title={comparing ? `Back to ${versionName(current)}` : `Show ${versionName(other)} at the same spot`}
              onClick={onCompare}
              active={comparing}
            >
              <CompareIcon size={12} />
              {`Compare${comparing ? '' : ` with v${other.number}`}`}
            </TextButton>
          )}
          <IconButton title={`Undo – go back to the version before (${shortcut('⌘Z')})`} onClick={onUndo} disabled={!canUndo}>
            <UndoIcon size={13} />
          </IconButton>
          <IconButton title={`Redo – go to the newest version after (${shortcut('⌘⇧Z')})`} onClick={onRedo} disabled={!canRedo}>
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
      <p className="px-6 text-center text-muted">The film file for {versionName(version)} is missing (moved or deleted in {FILE_MANAGER}).</p>
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
