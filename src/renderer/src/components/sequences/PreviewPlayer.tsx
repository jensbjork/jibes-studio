import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { durationSeconds } from '@shared/models'
import type { Sequence } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { CloseIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon } from './icons'
import { MIN_CLIP_SECONDS, formatClock, readyTake } from './sequenceUtils'

interface Clip {
  segmentId: string
  /** 1-based clip number in the sequence. */
  number: number
  path: string
  start: number
  trimEnd: number
  /** Source length as known from the database; replaced by the measured one once the file has loaded. */
  duration: number
}

interface Props {
  sequence: Sequence
  /** Start at this segment (or the first ready one after it). */
  startSegmentId?: string
  onClose: () => void
}

function ignoreAbort(e: unknown): boolean {
  // play() is "interrupted" whenever we switch clips mid-start; that isn't a failure.
  return e instanceof DOMException && e.name === 'AbortError'
}

// Keeps clicks on controls from moving focus, so Space keeps meaning play/pause.
const keepFocus = (e: ReactMouseEvent) => e.preventDefault()

/**
 * Plays the selected takes back-to-back with their trims, using a single <video>: each clip is loaded,
 * seeked to its start trim, and swapped for the next one when playback reaches its end trim.
 * Segments without a finished selected take are skipped.
 */
export default function PreviewPlayer({ sequence, startSegmentId, onClose }: Props) {
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const clips = useMemo<Clip[]>(
    () =>
      sequence.segments.flatMap((s, i) => {
        const take = readyTake(s)
        if (!take?.filePath) return []
        return [
          {
            segmentId: s.id,
            number: i + 1,
            path: take.filePath,
            start: s.trimStart,
            trimEnd: s.trimEnd,
            duration: take.videoDuration ?? durationSeconds(take.params.duration)
          }
        ]
      }),
    [sequence.segments]
  )

  const lengthOf = (c: Clip) => Math.max(MIN_CLIP_SECONDS, (measured[c.path] ?? c.duration) - c.start - c.trimEnd)
  const endOf = (c: Clip) => c.start + lengthOf(c)

  const [currentId, setCurrentId] = useState<string | undefined>(() => {
    const from = Math.max(0, sequence.segments.findIndex((s) => s.id === startSegmentId))
    return (clips.find((c) => c.number - 1 >= from) ?? clips[0])?.segmentId
  })
  const index = clips.findIndex((c) => c.segmentId === currentId)
  const clip = index === -1 ? undefined : clips[index]

  const video = useRef<HTMLVideoElement>(null)
  const wantPlay = useRef(true)
  const seekOffset = useRef(0)
  const loadedPath = useRef<string | undefined>(undefined)
  const [playing, setPlaying] = useState(true)
  const [ended, setEnded] = useState(false)
  const [time, setTime] = useState(0)

  // The current clip can vanish while open (its take deleted or deselected); continue with the first one.
  useEffect(() => {
    if (index === -1 && clips.length) setCurrentId(clips[0].segmentId)
  }, [index, clips])

  const play = (el: HTMLVideoElement) =>
    el.play().catch((e: unknown) => {
      if (ignoreAbort(e)) return
      wantPlay.current = false
      setPlaying(false)
    })

  /** Seeks the loaded clip to its start (plus a pending offset) and plays it if wanted. */
  const begin = (c: Clip) => {
    const el = video.current
    if (!el) return
    el.currentTime = c.start + seekOffset.current
    setTime(seekOffset.current)
    seekOffset.current = 0
    if (wantPlay.current) void play(el)
    else el.pause()
  }

  const goTo = (i: number, offset = 0) => {
    const c = clips[i]
    if (!c) return
    setEnded(false)
    seekOffset.current = offset
    if (c.segmentId === clip?.segmentId && loadedPath.current === c.path) {
      begin(c)
    } else {
      setTime(offset)
      setCurrentId(c.segmentId)
    }
  }

  // Two segments can share a file (a take selected in both); then no new load event comes.
  useEffect(() => {
    const el = video.current
    if (clip && el && loadedPath.current === clip.path && el.readyState >= 1) begin(clip)
  }, [clip?.segmentId])

  const advance = () => {
    video.current?.pause()
    if (index < clips.length - 1) {
      wantPlay.current = true
      goTo(index + 1)
    } else {
      wantPlay.current = false
      setPlaying(false)
      setEnded(true)
    }
  }

  const togglePlay = () => {
    const el = video.current
    if (!el || !clip) return
    if (ended) {
      wantPlay.current = true
      setPlaying(true)
      goTo(0)
      return
    }
    if (wantPlay.current) {
      wantPlay.current = false
      setPlaying(false)
      el.pause()
      return
    }
    wantPlay.current = true
    setPlaying(true)
    if (loadedPath.current !== clip.path) return // starts once loaded
    if (el.currentTime >= endOf(clip) - 0.05 || el.currentTime < clip.start - 0.05) el.currentTime = clip.start
    void play(el)
  }

  const next = () => {
    if (index < clips.length - 1) goTo(index + 1)
  }
  const previous = () => {
    // Like most players: the first press restarts the clip, a quick second press goes back one.
    if (time > 1.5 || index <= 0) goTo(Math.max(0, index))
    else goTo(index - 1)
  }

  // Frame-accurate end detection (timeupdate only fires about every 250 ms) and the playhead.
  const latest = useRef({ clip, endOf, advance })
  useEffect(() => {
    latest.current = { clip, endOf, advance }
  })
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = video.current
      const { clip: c, endOf: end, advance: onEnd } = latest.current
      if (el && c && loadedPath.current === c.path) {
        const offset = el.currentTime - c.start
        setTime((prev) => (Math.abs(prev - offset) > 0.04 ? offset : prev))
        if (!el.paused && el.currentTime >= end(c) - 0.015) onEnd()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const keys = useRef({ onClose, togglePlay, next, previous })
  useEffect(() => {
    keys.current = { onClose, togglePlay, next, previous }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current
      if (e.key === 'Escape') k.onClose()
      else if (e.key === ' ') k.togglePlay()
      else if (e.key === 'ArrowRight') k.next()
      else if (e.key === 'ArrowLeft') k.previous()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const lengths = clips.map(lengthOf)
  const total = lengths.reduce((a, b) => a + b, 0)
  const elapsed =
    lengths.slice(0, Math.max(0, index)).reduce((a, b) => a + b, 0) + Math.min(Math.max(0, time), lengths[index] ?? 0)

  const control =
    'flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black/95" role="dialog" aria-label="Förhandsvisning">
      <div className="drag flex h-12 shrink-0 items-center gap-3 pl-24 pr-4">
        <span className="truncate font-medium text-white/90">{sequence.name}</span>
        <span className="shrink-0 text-[12px] text-white/50">Förhandsvisning</span>
        <button
          onClick={onClose}
          onMouseDown={keepFocus}
          title="Stäng (Esc)"
          className="no-drag ml-auto flex h-8 w-8 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 px-6" onClick={togglePlay}>
        {clip ? (
          <>
            <video
              ref={video}
              src={mediaUrl(clip.path)}
              preload="auto"
              playsInline
              onLoadedMetadata={(e) => {
                const el = e.currentTarget
                loadedPath.current = clip.path
                if (Number.isFinite(el.duration)) {
                  const d = el.duration
                  setMeasured((m) => (m[clip.path] === d ? m : { ...m, [clip.path]: d }))
                }
                begin(clip)
              }}
              onEnded={() => wantPlay.current && advance()}
              className="h-full w-full object-contain"
            />
            <span className="pointer-events-none absolute left-9 top-3 rounded bg-black/60 px-2 py-1 text-[12px] text-white/90">
              Klipp {clip.number}
              <span className="text-white/50"> av {sequence.segments.length}</span>
            </span>
            {ended && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-white">
                  <PlayIcon size={22} />
                </span>
              </span>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-white/60">
            Inga klipp har en färdig vald tagning ännu.
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3 px-6 pb-5 pt-3">
        <div className="flex h-2 gap-0.5">
          {clips.map((c, i) => {
            const fill = i < index ? 1 : i === index ? Math.min(1, Math.max(0, time) / lengths[i]) : 0
            return (
              <div
                key={c.segmentId}
                title={`Klipp ${c.number}`}
                onPointerDown={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  const offset = ((e.clientX - r.left) / r.width) * lengths[i]
                  goTo(i, Math.min(Math.max(0, offset), lengths[i] - 0.05))
                }}
                className="h-full cursor-pointer overflow-hidden rounded-full bg-white/15 transition hover:bg-white/25"
                style={{ flexGrow: lengths[i], flexBasis: 0 }}
              >
                <div className={`h-full ${i === index ? 'bg-accent' : 'bg-white/50'}`} style={{ width: `${fill * 100}%` }} />
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={previous} onMouseDown={keepFocus} disabled={!clip} className={control} title="Föregående klipp (←)">
            <PrevIcon size={14} />
          </button>
          <button
            onClick={togglePlay}
            onMouseDown={keepFocus}
            disabled={!clip}
            className={`${control} bg-white/10`}
            title={playing ? 'Pausa (mellanslag)' : 'Spela (mellanslag)'}
          >
            {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          </button>
          <button
            onClick={next}
            onMouseDown={keepFocus}
            disabled={index === -1 || index >= clips.length - 1}
            className={control}
            title="Nästa klipp (→)"
          >
            <NextIcon size={14} />
          </button>
          <span className="ml-2 text-[12px] tabular-nums text-white/70">
            {formatClock(elapsed)} / {formatClock(total)}
          </span>

          <div className="ml-auto flex flex-wrap justify-end gap-1">
            {sequence.segments.map((s, i) => {
              const ci = clips.findIndex((c) => c.segmentId === s.id)
              const current = ci !== -1 && ci === index
              return (
                <button
                  key={s.id}
                  onClick={() => goTo(ci)}
                  onMouseDown={keepFocus}
                  disabled={ci === -1}
                  title={ci === -1 ? `Klipp ${i + 1} saknar färdig vald tagning och hoppas över` : `Spela från klipp ${i + 1}`}
                  className={`h-7 min-w-7 rounded-md px-2 text-[12px] tabular-nums transition ${
                    current
                      ? 'bg-accent text-white'
                      : ci === -1
                        ? 'text-white/25 line-through'
                        : 'bg-white/10 text-white/80 hover:bg-white/20'
                  }`}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
