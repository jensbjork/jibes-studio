import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  formatDuration,
  formatPosition,
  moveWindow,
  resizeEnd,
  resizeStart,
  type ClipWindow
} from './audioUtils'

interface Props {
  /** Seconds, the whole recording. */
  duration: number
  window: ClipWindow
  /** Playhead when this clip is the one in the player. */
  playhead?: number
  onSeek: (time: number) => void
  /** A drag started. */
  onBegin: () => void
  /** The window while dragging (not saved yet). */
  onPreview: (w: ClipWindow) => void
  /** The drag ended without a change. */
  onEnd: () => void
  /** A finished change: saved at once after a drag, after a pause for key presses. */
  onChange: (w: ClipWindow, when: 'now' | 'soon') => void
}

// Parts of the recording that are not sent, hatched like the trimmed-away parts of a take.
const HATCH = 'repeating-linear-gradient(135deg, #00000088 0 4px, #00000044 4px 8px)'
// A pointer that moves less than this is a click on the window (seek), not a drag.
const DRAG_THRESHOLD_PX = 3

const snap = (t: number) => Math.round(t * 10) / 10

/**
 * The whole recording as a bar with the reference window on it. Drag the window to move it, its edges to
 * change its length (2–15 s), click anywhere to move the playhead. The window and both edges are sliders
 * for the keyboard: ←/→ nudge (with ⇧ in bigger steps), Home/End go to the start or end of the recording.
 */
export default function ClipWindowTrack({
  duration,
  window: w,
  playhead,
  onSeek,
  onBegin,
  onPreview,
  onEnd,
  onChange
}: Props) {
  const bar = useRef<HTMLDivElement>(null)
  const pct = (t: number) => `${(Math.min(duration, Math.max(0, t)) / duration) * 100}%`
  const end = w.start + w.length

  // Pointer listeners outlive the render that created them.
  const latest = useRef({ w, duration })
  useEffect(() => {
    latest.current = { w, duration }
  })

  const timeAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration))
  }

  /**
   * Follows a pointer captured by the element until it is released. onMove gets the time under the pointer
   * and the distance moved in pixels; onUp whether it moved past the drag threshold.
   */
  const track = (
    e: ReactPointerEvent<HTMLElement>,
    onMove: (time: number, dx: number) => void,
    onUp: (moved: boolean, time: number) => void
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const x0 = e.clientX
    let moved = false
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD_PX) return
      moved = true
      onMove(timeAt(ev.clientX), ev.clientX - x0)
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      onUp(moved, timeAt(ev.clientX))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  /** A drag of the window or an edge: shown live, saved when released. */
  const drag = (e: ReactPointerEvent<HTMLElement>, next: (time: number, dx: number) => ClipWindow) => {
    if (e.button !== 0) return
    const r = bar.current?.getBoundingClientRect()
    let current: ClipWindow | undefined
    onBegin()
    track(
      e,
      (time, dx) => {
        current = next(time, r && r.width ? (dx / r.width) * latest.current.duration : 0)
        onPreview(current)
      },
      (moved, time) => {
        if (moved && current) onChange(current, 'now')
        else {
          onEnd()
          onSeek(time)
        }
      }
    )
  }

  const startDragWindow = (e: ReactPointerEvent<HTMLElement>) => {
    const from = latest.current.w
    drag(e, (_time, dt) => moveWindow(from, snap(from.start + dt), latest.current.duration))
  }
  const startDragEdge = (e: ReactPointerEvent<HTMLElement>, edge: 'start' | 'end') => {
    const from = latest.current.w
    drag(e, (time) =>
      edge === 'start'
        ? resizeStart(from, snap(time), latest.current.duration)
        : resizeEnd(from, snap(time), latest.current.duration)
    )
  }

  /** ←/→ nudges, ⇧ for bigger steps; Home/End to the ends of the recording. */
  const keys = (e: KeyboardEvent, apply: (delta: number | 'home' | 'end') => ClipWindow, step: number, big: number) => {
    let delta: number | 'home' | 'end'
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -(e.shiftKey ? big : step)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = e.shiftKey ? big : step
    else if (e.key === 'Home') delta = 'home'
    else if (e.key === 'End') delta = 'end'
    else return
    e.preventDefault()
    e.stopPropagation()
    onChange(apply(delta), 'soon')
  }

  const at = (base: number, delta: number | 'home' | 'end') =>
    delta === 'home' ? 0 : delta === 'end' ? duration : snap(base + delta)

  const range = `${formatPosition(w.start)}–${formatPosition(end)}`
  // Main only keeps clips it could measure; a length of 0 would put everything at NaN %.
  if (!(duration > 0)) return null

  return (
    <div>
      <div
        ref={bar}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          onSeek(timeAt(e.clientX))
          track(
            e,
            (time) => onSeek(time),
            () => {}
          )
        }}
        title="Klicka för att flytta uppspelningen hit"
        className="relative h-9 cursor-pointer touch-none select-none rounded-md bg-raised"
      >
        <div className="absolute inset-y-0 left-0 rounded-l-md" style={{ width: pct(w.start), backgroundImage: HATCH }} />
        <div
          className="absolute inset-y-0 right-0 rounded-r-md"
          style={{ width: `calc(100% - ${pct(end)})`, backgroundImage: HATCH }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Utdraget som skickas"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, duration - w.length)}
          aria-valuenow={w.start}
          aria-valuetext={`${range}, ${formatDuration(w.length)}`}
          onPointerDown={startDragWindow}
          onKeyDown={(e) =>
            keys(
              e,
              (d) => moveWindow(w, d === 'home' ? 0 : d === 'end' ? duration : snap(w.start + d), duration),
              0.5,
              5
            )
          }
          title={`Utdraget ${range} skickas. Dra för att flytta det.`}
          className="absolute inset-y-0 cursor-grab rounded-[5px] border-2 border-accent/80 bg-accent/15 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:cursor-grabbing"
          style={{ left: pct(w.start), width: `calc(${pct(end)} - ${pct(w.start)})` }}
        />
        {playhead !== undefined && (
          <div
            className="pointer-events-none absolute -inset-y-1 z-20 w-0.5 -translate-x-1/2 rounded-full bg-text"
            style={{ left: pct(playhead) }}
          />
        )}
        {(['start', 'end'] as const).map((edge) => (
          <div
            key={edge}
            role="slider"
            tabIndex={0}
            aria-label={edge === 'start' ? 'Utdragets början' : 'Utdragets slut'}
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={edge === 'start' ? w.start : end}
            aria-valuetext={formatPosition(edge === 'start' ? w.start : end)}
            onPointerDown={(e) => startDragEdge(e, edge)}
            onKeyDown={(e) =>
              keys(
                e,
                (d) =>
                  edge === 'start' ? resizeStart(w, at(w.start, d), duration) : resizeEnd(w, at(end, d), duration),
                0.1,
                1
              )
            }
            title={edge === 'start' ? 'Dra för att ändra var utdraget börjar' : 'Dra för att ändra var utdraget slutar'}
            // The grip sits just outside the window, so a short window on a long recording can still be
            // dragged by its middle.
            className={`group absolute inset-y-0 z-10 flex w-3 cursor-ew-resize touch-none items-center outline-none ${
              edge === 'start' ? '-translate-x-full justify-end' : 'justify-start'
            }`}
            style={{ left: pct(edge === 'start' ? w.start : end) }}
          >
            <span className="h-full w-1.5 rounded-full bg-accent shadow-[0_0_0_2px_#0b0b0d] group-focus-visible:ring-2 group-focus-visible:ring-accent/60" />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between gap-3 text-[11px] tabular-nums text-muted">
        <span>0:00</span>
        <span className="truncate">
          Skickas {range} · {formatDuration(w.length)}
        </span>
        <span>{formatPosition(duration)}</span>
      </div>
    </div>
  )
}
