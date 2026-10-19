import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type RefObject
} from 'react'
import { durationSeconds } from '@shared/models'
import type { Generation, Segment } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { pauseOthers } from '../feed/playback'
import { MIN_CLIP_SECONDS, formatLength, formatTakeTime, round2 } from './sequenceUtils'
import { shortTakeNote, songCut } from '@shared/song-trims'
import { songSeconds } from './song/songText'
import { useDraft, useRegisterFlush, type DraftStatus, type FlushRegistry } from './useDraft'
import type { SequenceStore } from './useSequence'

interface Trims {
  trimStart: number
  trimEnd: number
}

/** What the take strip asks of the player: Space and Enter. */
export interface TakePlayerHandle {
  /** Space: play or pause. */
  toggle: () => void
  /** Enter: from the kept start (a previewed take from its beginning). */
  playFromStart: () => void
}

/** Play `takeId` from its kept start once it is in the player; a new `n` asks again (a click on the same take). */
export interface PlayRequest {
  takeId: string
  n: number
}

interface Props {
  segment: Segment
  /** The chosen take, finished with a file; undefined when there is none (a preview, or only the hint). */
  take?: Generation
  /** A take shown without being chosen (⌥-click): the trims are put away while it is. */
  preview?: Generation
  /** Shown in the player's place when there is nothing to play (why no take is in use). */
  hint?: ReactNode
  number: number
  /** The next segment starts from this take's (trimmed) last frame. */
  nextContinues: boolean
  /**
   * The previous segment ends on this take's first frame after the start trim ("End on the next clip's first
   * frame").
   */
  previousEndsHere: boolean
  patchSegment: SequenceStore['patchSegment']
  flushers: FlushRegistry
  /** The choice of take hasn't reached main yet: the trims wait, since they would land on the take before. */
  selecting?: boolean
  /**
   * A clip of a sequence cut to a song: the length of its place. The cut keeps exactly that much of the take, so only
   * where it starts is chosen (main works out the end); `syncOffset` is where the measured singing put it.
   */
  song?: { length: number; syncOffset?: number }
  playRequest?: PlayRequest
  playerRef?: Ref<TakePlayerHandle>
  /** "Use this take": the previewed take becomes the chosen one. */
  onChoosePreview: () => void
  /** "Show selected" (or Esc): back to the chosen take. */
  onLeavePreview: () => void
  /** The take strip, right under the player. */
  children?: ReactNode
}

const snap = (t: number) => Math.round(t * 10) / 10

// Hatching for the parts that are cut away.
const HATCH = 'repeating-linear-gradient(135deg, #00000088 0 4px, #00000044 4px 8px)'

/** The trims as the editor below the strip has them (its draft), reported up for the header and the player. */
interface TrimState extends Trims {
  status: DraftStatus
  error?: string
}

/**
 * The clip's player, the take strip under it, then the chosen take's start/end trims. Mount with a key per segment:
 * the player and the strip stay while takes are chosen (the strip keeps its focus), and only the trim editor is
 * remounted per take. Trims are saved debounced as a trims-only patch; main clamps them, and the clamped values come
 * back through the draft. A take can also be previewed here without being chosen: the header says so, and
 * "Use this take" / "Show selected" stand where the trims are.
 */
export default function TrimControls({
  segment,
  take,
  preview,
  hint,
  number,
  nextContinues,
  previousEndsHere,
  patchSegment,
  flushers,
  selecting = false,
  song,
  playRequest,
  playerRef,
  onChoosePreview,
  onLeavePreview,
  children
}: Props) {
  const previewing = !!preview && preview.id !== take?.id
  const shown = previewing ? preview : take
  const video = useRef<HTMLVideoElement>(null)
  const [measured, setMeasured] = useState<{ id: string; seconds: number }>()
  const duration = take
    ? (take.videoDuration ??
      (measured?.id === take.id ? measured.seconds : undefined) ??
      durationSeconds(take.params.duration))
    : 0

  // The editor below reports its draft; until it has (or while a preview hides it) main's trims are the truth.
  const [reported, setReported] = useState<TrimState & { takeId: string }>()
  const trims: TrimState =
    reported && take && reported.takeId === take.id && !previewing
      ? reported
      : { trimStart: segment.trimStart, trimEnd: segment.trimEnd, status: 'idle' }
  const { trimStart, trimEnd } = trims
  const keepEnd = Math.max(trimStart, duration - trimEnd)
  const [time, setTime] = useState(trimStart)
  const [playing, setPlaying] = useState(false)
  const [onlyTrimmed, setOnlyTrimmed] = useState(true)

  // Play requests and the editor's callbacks outlive the render that created them, so they read the latest values.
  // `server` is main's answer: right after another take was chosen it carries that take's remembered trims a render
  // before the editor's draft takes them over.
  const latest = useRef({ trims, server: segment.trimStart, previewing })
  useEffect(() => {
    latest.current = { trims, server: segment.trimStart, previewing }
  })

  /** Where the take starts in the sequence: what the user is editing, else main's. A preview starts at 0. */
  const keptStart = useCallback(() => {
    const l = latest.current
    if (l.previewing) return 0
    return l.trims.status === 'idle' ? l.server : l.trims.trimStart
  }, [])

  // A play that waits for the video to know its length (a take just put in the player).
  const pendingPlay = useRef(false)
  const startPlaying = useCallback(() => {
    const el = video.current
    if (!el) return
    if (el.readyState < 1) {
      pendingPlay.current = true
      return
    }
    pendingPlay.current = false
    el.currentTime = keptStart()
    setTime(el.currentTime)
    void el.play().catch(() => undefined)
  }, [keptStart])

  useImperativeHandle(
    playerRef,
    () => ({
      toggle: () => {
        const el = video.current
        if (!el) return
        if (el.paused) void el.play().catch(() => undefined)
        else el.pause()
      },
      playFromStart: startPlaying
    }),
    [startPlaying]
  )

  // A click on a take plays it, with sound, from where it starts in the sequence.
  const handledRequest = useRef(playRequest?.n)
  useEffect(() => {
    if (!playRequest || !shown || playRequest.takeId !== shown.id || handledRequest.current === playRequest.n) return
    handledRequest.current = playRequest.n
    startPlaying()
  }, [playRequest, shown?.id, startPlaying])

  // A start that changes by itself – main's remembered trims for a take just chosen (they arrive a moment after it
  // is shown), an agent's trim, main's clamping, Reset – moves a paused player there, so the frame it shows is
  // where the take begins in the sequence. Dragging or typing a start already shows that frame.
  useEffect(() => {
    const el = video.current
    if (!el || previewing || !el.paused || pendingPlay.current || el.readyState < 1) return
    if (Math.abs(el.currentTime - trimStart) > 0.02) {
      el.currentTime = trimStart
      setTime(trimStart)
    }
  }, [trimStart, previewing, take?.id])

  // Follow the playhead smoothly while playing, and stop at the end trim when playing only what is used.
  useEffect(() => {
    if (!playing || previewing) return
    let raf = 0
    const tick = () => {
      const el = video.current
      if (el) {
        setTime(el.currentTime)
        if (onlyTrimmed && el.currentTime >= keepEnd - 0.01) {
          el.pause()
          el.currentTime = keepEnd
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, onlyTrimmed, keepEnd, previewing])

  const keptLength = Math.max(0, keepEnd - trimStart)

  // The strip keeps one place in the tree whatever is above and below it, so it is never remounted (focus stays).
  return (
    <section>
      {shown?.filePath ? (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
            {previewing ? (
              <>
                <h3 className="font-medium">Preview</h3>
                <span className="text-[12px] text-muted">take {formatTakeTime(shown.createdAt)} (not selected)</span>
              </>
            ) : (
              <>
                <h3 className="font-medium">Selected take</h3>
                <span className="text-[12px] text-muted">
                  clip {number} · {formatLength(keptLength)} in the sequence
                </span>
              </>
            )}
            <span className="ml-auto text-[11px] text-muted">
              {trims.error ? <span className="text-accent">{trims.error}</span> : trims.status !== 'idle' && 'Saving…'}
            </span>
          </div>
          <video
            key={shown.id}
            ref={video}
            src={mediaUrl(shown.filePath)}
            poster={shown.thumbPath ? mediaUrl(shown.thumbPath) : undefined}
            controls
            preload="auto"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget
              if (!previewing && take && Number.isFinite(el.duration)) {
                setMeasured({ id: take.id, seconds: el.duration })
              }
              const start = keptStart()
              if (start > 0) el.currentTime = start
              setTime(el.currentTime)
              if (pendingPlay.current) {
                pendingPlay.current = false
                void el.play().catch(() => undefined)
              }
            }}
            onPlay={(e) => {
              setPlaying(true)
              pauseOthers(e.currentTarget)
              const el = e.currentTarget
              const outside = el.currentTime < trimStart - 0.05 || el.currentTime >= keepEnd - 0.05
              if (!previewing && onlyTrimmed && outside) el.currentTime = trimStart
            }}
            onPause={() => setPlaying(false)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            className="aspect-video max-h-[40vh] w-full rounded-lg bg-black object-contain"
          />
        </>
      ) : (
        hint
      )}

      <div className={shown?.filePath || hint ? 'mt-3' : undefined}>{children}</div>

      {previewing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onChoosePreview}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover"
          >
            Use this take
          </button>
          <button
            type="button"
            onClick={onLeavePreview}
            title="Back to the selected take (Esc)"
            className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text"
          >
            {take ? 'Show selected' : 'Close preview'}
          </button>
          <span className="text-[11px] text-muted">The trim belongs to the selected take.</span>
        </div>
      ) : (
        take?.filePath && (
          <TrimEditor
            key={take.id}
            segment={segment}
            takeId={take.id}
            duration={duration}
            number={number}
            nextContinues={nextContinues}
            previousEndsHere={previousEndsHere}
            patchSegment={patchSegment}
            flushers={flushers}
            disabled={selecting}
            song={song}
            video={video}
            time={time}
            onTime={setTime}
            onlyTrimmed={onlyTrimmed}
            onOnlyTrimmed={setOnlyTrimmed}
            onReport={setReported}
          />
        )
      )}
    </section>
  )
}

/**
 * The chosen take's trims: the bar, the two inputs with Here, Reset, "Play only what's used" and the notes
 * about seamless neighbours. Mounted per take (its draft belongs to that take), so a switch saves a pending trim
 * first – on unmount – while main still has the take it was made for.
 */
function TrimEditor({
  segment,
  takeId,
  duration,
  number,
  nextContinues,
  previousEndsHere,
  patchSegment,
  flushers,
  disabled,
  song,
  video,
  time,
  onTime,
  onlyTrimmed,
  onOnlyTrimmed,
  onReport
}: {
  segment: Segment
  takeId: string
  duration: number
  number: number
  nextContinues: boolean
  previousEndsHere: boolean
  patchSegment: SequenceStore['patchSegment']
  flushers: FlushRegistry
  disabled: boolean
  song?: { length: number; syncOffset?: number }
  video: RefObject<HTMLVideoElement | null>
  time: number
  onTime: (t: number) => void
  onlyTrimmed: boolean
  onOnlyTrimmed: (on: boolean) => void
  onReport: (state: TrimState & { takeId: string }) => void
}) {
  const segmentId = segment.id
  const songLength = song?.length
  // A song clip sends only where it starts: main keeps the place's length (the end follows).
  const save = useCallback(
    (t: Trims) => patchSegment(segmentId, songLength !== undefined ? { trimStart: t.trimStart } : t),
    [patchSegment, segmentId, songLength]
  )
  const draft = useDraft<Trims>({ trimStart: segment.trimStart, trimEnd: segment.trimEnd }, save)
  const { value, setValue } = draft
  useRegisterFlush(flushers, draft.flush)
  const { trimStart, trimEnd } = value
  const keepEnd = Math.max(trimStart, duration - trimEnd)

  // The header and the player above follow the draft (the length in the sequence, where playing stops).
  useLayoutEffect(() => {
    onReport({ takeId, trimStart, trimEnd, status: draft.status, error: draft.error })
  }, [takeId, trimStart, trimEnd, draft.status, draft.error, onReport])

  // Pointer listeners outlive the render that created them, so trims are computed from the latest values.
  const latest = useRef({ value, duration })
  useEffect(() => {
    latest.current = { value, duration }
  })

  const setTrim = useCallback(
    (key: keyof Trims, raw: number, seek: boolean) => {
      if (!Number.isFinite(raw)) return
      const { value: current, duration: d } = latest.current
      const other = key === 'trimStart' ? current.trimEnd : current.trimStart
      const v = round2(Math.min(Math.max(0, d - other - MIN_CLIP_SECONDS), Math.max(0, raw)))
      const next: Trims = { ...current, [key]: v }
      latest.current = { value: next, duration: d }
      setValue(next)
      const el = video.current
      if (seek && el) {
        // Show the frame at the cut point; for the end that is the frame the next clip continues from.
        el.pause()
        el.currentTime = key === 'trimStart' ? v : Math.max(0, d - v - 0.04)
        onTime(el.currentTime)
      }
    },
    [setValue, video, onTime]
  )

  /** A song clip: the take starts at `raw` and keeps the place's length (the end follows). */
  const setStart = useCallback(
    (raw: number, seek: boolean) => {
      if (!Number.isFinite(raw) || songLength === undefined) return
      const d = latest.current.duration
      // As main cuts it (shared/song-trims.ts): from the start for the place's length, the rest off the end.
      const { trimStart, trimEnd } = songCut(d, raw, { start: 0, end: songLength })
      const next: Trims = { trimStart, trimEnd }
      latest.current = { value: next, duration: d }
      setValue(next)
      const el = video.current
      if (seek && el) {
        el.pause()
        el.currentTime = trimStart
        onTime(trimStart)
      }
    },
    [songLength, setValue, video, onTime]
  )

  const seek = (t: number) => {
    const el = video.current
    if (!el) return
    el.currentTime = t
    onTime(t)
  }

  if (songLength !== undefined) {
    const shortNote = shortTakeNote(songCut(duration, trimStart, { start: 0, end: songLength }).shortBy)
    const synced = song?.syncOffset
    const back = synced ?? 0
    return (
      <div className={`mt-3 space-y-3 transition-opacity ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
        {duration > 0 && (
          <TrimBar
            duration={duration}
            trimStart={trimStart}
            trimEnd={trimEnd}
            time={time}
            onSeek={seek}
            onDrag={(key, t) => setStart(snap(key === 'trimStart' ? t : t - songLength), true)}
            dragTitle="Drag to choose where the take starts – it keeps the place's length"
          />
        )}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <SecondsInput
            label="Starts at"
            value={trimStart}
            onChange={(v) => setStart(v, true)}
            onHere={() => setStart(video.current?.currentTime ?? time, false)}
            hereTitle="Start the take at the playhead"
          />
          <button
            onClick={() => setStart(back, true)}
            disabled={Math.abs(trimStart - back) < 0.005}
            title={synced !== undefined ? 'Back to where the measured singing put it' : 'Start at the beginning of the take'}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {synced !== undefined ? 'Back to the sync' : 'Reset'}
          </button>
          <label className="ml-auto flex items-center gap-2 pb-1.5 text-muted">
            <input
              type="checkbox"
              checked={onlyTrimmed}
              onChange={(e) => onOnlyTrimmed(e.target.checked)}
              className="accent-accent"
            />
            Play only what's used
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          The cut keeps {songSeconds(songLength)} of the take – the clip's place in the song – from where it starts.
        </p>
        {shortNote && <p className="text-[11px] leading-relaxed text-amber-300">{shortNote}</p>}
      </div>
    )
  }

  return (
    <div className={`mt-3 space-y-3 transition-opacity ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
      {duration > 0 && (
        <TrimBar
          duration={duration}
          trimStart={trimStart}
          trimEnd={trimEnd}
          time={time}
          onSeek={seek}
          onDrag={(key, t) => setTrim(key, snap(key === 'trimStart' ? t : latest.current.duration - t), true)}
        />
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <SecondsInput
          label="Trim start"
          value={trimStart}
          onChange={(v) => setTrim('trimStart', v, true)}
          onHere={() => setTrim('trimStart', video.current?.currentTime ?? time, false)}
          hereTitle="Start the clip at the playhead"
        />
        <SecondsInput
          label="Trim end"
          value={trimEnd}
          onChange={(v) => setTrim('trimEnd', v, true)}
          onHere={() => setTrim('trimEnd', duration - (video.current?.currentTime ?? time), false)}
          hereTitle="End the clip at the playhead"
        />
        <button
          onClick={() => {
            setTrim('trimStart', 0, false)
            setTrim('trimEnd', 0, false)
          }}
          disabled={trimStart === 0 && trimEnd === 0}
          className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Reset
        </button>
        <label className="ml-auto flex items-center gap-2 pb-1.5 text-muted">
          <input
            type="checkbox"
            checked={onlyTrimmed}
            onChange={(e) => onOnlyTrimmed(e.target.checked)}
            className="accent-accent"
          />
          Play only what's used
        </label>
      </div>

      {previousEndsHere && (
        <p className="text-[11px] leading-relaxed text-muted">
          Clip {number - 1} ends on the frame at {formatLength(trimStart)}. If you change the start, clip{' '}
          {number - 1} needs a new take for the transition to be seamless.
        </p>
      )}
      {nextContinues && (
        <p className="text-[11px] leading-relaxed text-muted">
          Clip {number + 1} continues from the frame at {formatLength(keepEnd)}. If you change the end, clip{' '}
          {number + 1} needs a new take for the transition to be seamless.
        </p>
      )}
    </div>
  )
}

function TrimBar({
  duration,
  trimStart,
  trimEnd,
  time,
  onSeek,
  onDrag,
  dragTitle
}: {
  duration: number
  trimStart: number
  trimEnd: number
  time: number
  onSeek: (t: number) => void
  onDrag: (key: keyof Trims, t: number) => void
  /** Both handles' tooltip (a song clip's move together); else each says which end it trims. */
  dragTitle?: string
}) {
  const bar = useRef<HTMLDivElement>(null)
  const pct = (t: number) => `${(Math.min(duration, Math.max(0, t)) / duration) * 100}%`

  const timeAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration))
  }

  /** Captures the pointer so dragging keeps working outside the element. */
  const track = (e: ReactPointerEvent<HTMLDivElement>, onMove: (t: number) => void) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => onMove(timeAt(ev.clientX))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div>
      <div
        ref={bar}
        onPointerDown={(e) => {
          onSeek(timeAt(e.clientX))
          track(e, onSeek)
        }}
        className="relative h-9 cursor-pointer touch-none rounded-md bg-raised"
        title="Click to seek"
      >
        <div
          className="absolute inset-y-0 rounded-md border-2 border-accent/80 bg-accent/10"
          style={{ left: pct(trimStart), right: pct(trimEnd) }}
        />
        <div className="absolute inset-y-0 left-0 rounded-l-md" style={{ width: pct(trimStart), backgroundImage: HATCH }} />
        <div className="absolute inset-y-0 right-0 rounded-r-md" style={{ width: pct(trimEnd), backgroundImage: HATCH }} />
        <div
          className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-text"
          style={{ left: pct(time) }}
        />
        {(['trimStart', 'trimEnd'] as const).map((key) => (
          <div
            key={key}
            onPointerDown={(e) => track(e, (t) => onDrag(key, t))}
            title={dragTitle ?? (key === 'trimStart' ? 'Drag to trim the start' : 'Drag to trim the end')}
            className="absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center"
            style={{ left: pct(key === 'trimStart' ? trimStart : duration - trimEnd) }}
          >
            <span className="h-full w-1.5 rounded-full bg-accent shadow-[0_0_0_2px_#0b0b0d]" />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
        <span>0 s</span>
        <span>
          {formatLength(trimStart)} – {formatLength(duration - trimEnd)}
        </span>
        <span>{formatLength(duration)}</span>
      </div>
    </div>
  )
}

/** Number input that tolerates half-typed values like "1." and shows the clamped value once left. */
function SecondsInput({
  label,
  value,
  onChange,
  onHere,
  hereTitle
}: {
  label: string
  value: number
  onChange: (v: number) => void
  onHere: () => void
  hereTitle: string
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  return (
    <label className="block">
      <span className="mb-1.5 block text-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="relative">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.1}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              const n = e.target.valueAsNumber
              if (Number.isFinite(n)) onChange(n)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="w-24 rounded-md border border-line bg-raised py-1.5 pl-2.5 pr-6 tabular-nums outline-none [appearance:textfield] focus:border-muted [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted">s</span>
        </span>
        <button
          type="button"
          onClick={onHere}
          title={hereTitle}
          className="rounded-md border border-line px-2 py-1.5 text-muted transition hover:bg-raised hover:text-text"
        >
          Here
        </button>
      </span>
    </label>
  )
}
