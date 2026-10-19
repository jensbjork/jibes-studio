import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Sequence } from '@shared/types'
import { mediaUrl } from '../../../lib/media'
import { pauseOthers } from '../../feed/playback'
import { CloseIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from '../icons'
import { formatClock, readyTake } from '../sequenceUtils'
import { placeOf } from './songText'
import { useMediaPlaying, useMediaTime } from './useMediaTime'

// The preview of a sequence cut to a song: the song plays from start to end and the clips follow it, muted, each
// over its place – the take at (time in the song − place start + trimStart), as the export cuts it. A clip without a
// finished take is black while the song goes on. Two video elements take turns, so the next clip is loaded and on
// its first frame before its place begins.

interface Shot {
  segmentId: string
  /** 1-based clip number. */
  number: number
  /** The place in the song. */
  start: number
  end: number
  /** The selected take's file; undefined while the clip has none finished. */
  path?: string
  trimStart: number
}

interface Props {
  sequence: Sequence
  startSegmentId?: string
  onClose: () => void
}

/** Seconds a muted take may drift from the song before it is put back in step by a seek … */
const DRIFT = 0.12
/** … and beyond which it is brought back gently, a little faster or slower (no visible jump). */
const NUDGE = 0.02
/** A take that ends before its place holds this far before its end (its last frame). */
const HOLD = 0.04

const keepFocus = (e: ReactMouseEvent) => e.preventDefault()

export default function SongPreview({ sequence, startSegmentId, onClose }: Props) {
  const song = sequence.song!
  const shots = useMemo<Shot[]>(
    () =>
      sequence.segments.flatMap((s, i) => {
        const place = placeOf(s)
        if (!place) return []
        const path = readyTake(s)?.filePath
        return [{ segmentId: s.id, number: i + 1, start: place.start, end: place.end, path, trimStart: s.trimStart }]
      }),
    [sequence.segments]
  )
  const duration = song.duration

  const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
  const playing = useMediaPlaying(audio)
  const videos = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)]
  // Which shot each of the two video elements holds, and which one is in front.
  const [slots, setSlots] = useState<[number | undefined, number | undefined]>([undefined, undefined])
  const [front, setFront] = useState<0 | 1>(0)
  const [current, setCurrent] = useState(0)
  const [ended, setEnded] = useState(false)
  const live = useRef({ shots, slots, front, current })
  live.current = { shots, slots, front, current }

  const shotAt = (t: number) => {
    const list = live.current.shots
    const i = list.findIndex((s) => t >= s.start && t < s.end)
    return i !== -1 ? i : t >= (list.at(-1)?.end ?? Infinity) - 1e-3 ? list.length - 1 : 0
  }

  // Start where asked (or at the beginning) once the song can seek, and play.
  const started = useRef(false)
  const begin = (el: HTMLAudioElement) => {
    if (started.current) return
    started.current = true
    const from = shots.find((s) => s.segmentId === startSegmentId)
    el.currentTime = from?.start ?? 0
    void el.play().catch(() => undefined)
  }

  // The clock: the song leads, the takes follow it.
  useEffect(() => {
    if (!audio) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const { shots: list, slots: held, front: shown, current: was } = live.current
      if (!list.length) return
      const t = audio.currentTime
      const i = shotAt(t)
      if (i !== was) setCurrent(i)
      // The shot in front: in the element that holds it, else the one at the back takes it.
      let f: 0 | 1 | undefined = held[0] === i ? 0 : held[1] === i ? 1 : undefined
      const next = list.findIndex((s, k) => k > i && !!s.path)
      if (f === undefined) {
        f = (1 - shown) as 0 | 1
        const nextSlots: [number | undefined, number | undefined] = [...held]
        nextSlots[f] = i
        setSlots(nextSlots)
        live.current.slots = nextSlots
      }
      if (f !== shown) {
        setFront(f)
        live.current.front = f
      }
      // The other element waits on the next clip's first frame.
      const back = (1 - f) as 0 | 1
      if (next !== -1 && live.current.slots[back] !== next) {
        const nextSlots: [number | undefined, number | undefined] = [...live.current.slots]
        nextSlots[back] = next
        setSlots(nextSlots)
        live.current.slots = nextSlots
      }
      const shot = list[i]
      const el = videos[f].current
      if (!el || !shot.path || el.readyState < 1) return
      const want = shot.trimStart + (t - shot.start)
      const last = Number.isFinite(el.duration) ? el.duration - HOLD : Infinity
      const target = Math.min(want, last)
      const behind = target - el.currentTime
      if (Math.abs(behind) > DRIFT) {
        el.currentTime = target
        el.playbackRate = 1
      } else el.playbackRate = Math.abs(behind) > NUDGE ? (behind > 0 ? 1.08 : 0.92) : 1
      const run = !audio.paused && want < last
      if (run && el.paused) void el.play().catch(() => undefined)
      else if (!run && !el.paused) el.pause()
      // The one at the back stays paused on its start.
      const other = videos[back].current
      if (other && !other.paused) other.pause()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [audio])

  const seek = (t: number) => {
    if (!audio) return
    setEnded(false)
    audio.currentTime = Math.min(duration, Math.max(0, t))
  }
  const toggle = () => {
    if (!audio) return
    if (audio.paused) {
      if (ended || audio.ended) seek(0)
      void audio.play().catch(() => undefined)
    } else audio.pause()
  }
  const goTo = (i: number) => {
    const shot = shots[i]
    if (shot) seek(shot.start)
  }
  const next = () => goTo(Math.min(shots.length - 1, current + 1))
  const previous = () => {
    // Like most players: the first press restarts the clip, a quick second press goes back one.
    const shot = shots[current]
    if (shot && (audio?.currentTime ?? 0) - shot.start > 1.5) goTo(current)
    else goTo(Math.max(0, current - 1))
  }

  const keys = useRef({ onClose, toggle, next, previous })
  keys.current = { onClose, toggle, next, previous }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current
      if (e.key === 'Escape') k.onClose()
      else if (e.key === ' ') k.toggle()
      else if (e.key === 'ArrowRight') k.next()
      else if (e.key === 'ArrowLeft') k.previous()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shot = shots[current]
  const control =
    'flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black/95" role="dialog" aria-label="Preview">
      <audio
        ref={setAudio}
        src={mediaUrl(song.path)}
        preload="auto"
        onLoadedMetadata={(e) => begin(e.currentTarget)}
        onPlay={(e) => pauseOthers(e.currentTarget)}
        onEnded={() => setEnded(true)}
        className="hidden"
      />
      <div className="drag flex h-12 shrink-0 items-center gap-3 pl-24 pr-4">
        <span className="truncate font-medium text-white/90">{sequence.name}</span>
        <span className="shrink-0 text-[12px] text-white/50">Preview · with the song</span>
        <button
          onClick={onClose}
          onMouseDown={keepFocus}
          title="Close (Esc)"
          className="no-drag ml-auto flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 px-6" onClick={toggle}>
        {([0, 1] as const).map((slot) => {
          const held = slots[slot] !== undefined ? shots[slots[slot]!] : undefined
          return (
            <video
              key={slot}
              ref={videos[slot]}
              src={held?.path ? mediaUrl(held.path) : undefined}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                // Waiting at the back: on the frame its place starts with.
                if (held && slot !== live.current.front) e.currentTarget.currentTime = held.trimStart
              }}
              className="absolute inset-0 h-full w-full object-contain px-6"
              style={{ opacity: slot === front && shot?.path && held?.segmentId === shot.segmentId ? 1 : 0 }}
            />
          )
        })}
        {shot && !shot.path && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-white/50">
            Clip {shot.number} has no finished take yet – the song plays on
          </span>
        )}
        {shot && (
          <span className="pointer-events-none absolute left-9 top-3 rounded bg-black/60 px-2 py-1 text-[12px] text-white/90">
            Clip {shot.number}
            <span className="text-white/50"> of {sequence.segments.length}</span>
          </span>
        )}
        {!shots.length && (
          <div className="flex h-full items-center justify-center text-white/60">The song has no clips yet.</div>
        )}
        {ended && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-white">
              <PlayIcon size={22} />
            </span>
          </span>
        )}
      </div>

      <div className="shrink-0 space-y-3 px-6 pb-5 pt-3">
        <Progress audio={audio} shots={shots} duration={duration} current={current} onSeek={seek} />
        <div className="flex items-center gap-2">
          <button onClick={previous} onMouseDown={keepFocus} disabled={!shots.length} className={control} title="Previous clip (←)">
            <PrevIcon size={14} />
          </button>
          <button
            onClick={toggle}
            onMouseDown={keepFocus}
            disabled={!audio}
            className={`${control} bg-white/10`}
            title={playing ? 'Pause (space)' : 'Play (space)'}
          >
            {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          </button>
          <button
            onClick={next}
            onMouseDown={keepFocus}
            disabled={current >= shots.length - 1}
            className={control}
            title="Next clip (→)"
          >
            <NextIcon size={14} />
          </button>
          <Clock audio={audio} duration={duration} />
          <div className="ml-auto flex flex-wrap justify-end gap-1">
            {shots.map((s, i) => (
              <button
                key={s.segmentId}
                onClick={() => goTo(i)}
                onMouseDown={keepFocus}
                title={s.path ? `Play from clip ${s.number}` : `Play from clip ${s.number} (no finished take yet)`}
                className={`h-7 min-w-7 rounded-md px-2 text-[12px] tabular-nums transition ${
                  i === current
                    ? 'bg-accent text-white'
                    : s.path
                      ? 'bg-white/10 text-white/80 hover:bg-white/20'
                      : 'bg-white/5 text-white/35 hover:bg-white/10'
                }`}
              >
                {s.number}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Clock({ audio, duration }: { audio: HTMLAudioElement | null; duration: number }) {
  const t = useMediaTime(audio)
  return (
    <span className="ml-2 text-[12px] tabular-nums text-white/70">
      {formatClock(t)} / {formatClock(duration)}
    </span>
  )
}

/** The places as one bar each (as long as the place), filled to the song's time; a press seeks there. */
function Progress({
  audio,
  shots,
  duration,
  current,
  onSeek
}: {
  audio: HTMLAudioElement | null
  shots: Shot[]
  duration: number
  current: number
  onSeek: (t: number) => void
}) {
  const t = useMediaTime(audio)
  if (!shots.length) {
    return (
      <div className="h-2 overflow-hidden rounded-full bg-white/15">
        <div className="h-full bg-accent" style={{ width: `${duration ? (t / duration) * 100 : 0}%` }} />
      </div>
    )
  }
  return (
    <div className="flex h-2 gap-0.5">
      {shots.map((s, i) => {
        const length = Math.max(0.01, s.end - s.start)
        const fill = Math.min(1, Math.max(0, (t - s.start) / length))
        return (
          <div
            key={s.segmentId}
            title={`Clip ${s.number}`}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              onSeek(s.start + ((e.clientX - r.left) / r.width) * length)
            }}
            className={`h-full cursor-pointer overflow-hidden rounded-full transition hover:bg-white/25 ${
              s.path ? 'bg-white/15' : 'bg-white/[0.07]'
            }`}
            style={{ flexGrow: length, flexBasis: 0 }}
          >
            <div className={`h-full ${i === current ? 'bg-accent' : 'bg-white/50'}`} style={{ width: `${fill * 100}%` }} />
          </div>
        )
      })}
    </div>
  )
}
