import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref
} from 'react'
import { durationSeconds } from '@shared/models'
import type { Generation, Segment, Sequence, Still } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Modal from '../pickers/Modal'
import { plainImagePrompt } from './imageModels'

export interface FramePickerDialogProps {
  open: boolean
  sequenceId: string
  /** The clip whose takes are shown first (its selected take, else its newest finished one). */
  segment?: Pick<Segment, 'id'>
  /** Where to start in that take: the first frame the sequence uses (default) or the last. */
  at?: 'start' | 'end'
  onClose: () => void
  /** The frame, saved as a still of the sequence. The dialog closes itself right after. */
  onPicked: (still: Still) => void
}

/**
 * "Bildruta från ett klipp": pick any finished take of the sequence, scrub or step frame by frame, and save the
 * frame on screen as a still (saveFrameAsStill). Free: the frame is cut out locally with ffmpeg.
 */
export default function FramePickerDialog(props: FramePickerDialogProps) {
  // Mounted only while open, so each opening starts on the take and frame the props point at.
  if (!props.open) return null
  return <FramePickerBody {...props} />
}

/** A take that can be shown: finished, with its file on disk. */
function isReady(take: Generation): boolean {
  return take.status === 'completed' && !!take.filePath && !take.fileMissing
}

interface Choice {
  take: Generation
  segment: Segment
  /** 1-based clip number. */
  clip: number
  /** The take used in the sequence (its trims apply). */
  selected: boolean
}

function FramePickerBody({ sequenceId, segment: wanted, at = 'start', onClose, onPicked }: FramePickerDialogProps) {
  const [sequence, setSequence] = useState<Sequence>()
  const [loadError, setLoadError] = useState<string>()

  useEffect(() => {
    let active = true
    let latest = 0
    const load = () => {
      const n = ++latest
      window.studio.getSequence(sequenceId).then(
        (s) => active && n === latest && setSequence(s),
        (e: unknown) => active && n === latest && setLoadError(ipcErrorMessage(e))
      )
    }
    load()
    // Takes finish (or get deleted) while the dialog is open; the list follows.
    const off = window.studio.onSequenceChange((id) => id === sequenceId && load())
    return () => {
      active = false
      off()
    }
  }, [sequenceId])

  const clips = useMemo(
    () =>
      (sequence?.segments ?? []).map((segment, i) => {
        // The take in the cut first, then the rest newest first (takes come newest first).
        const inCut = (t: Generation) => Number(t.id === segment.selectedGenerationId)
        const ready = segment.takes.filter(isReady).sort((a, b) => inCut(b) - inCut(a))
        return {
          segment,
          clip: i + 1,
          choices: ready.map((take): Choice => ({
            take,
            segment,
            clip: i + 1,
            selected: take.id === segment.selectedGenerationId
          }))
        }
      }),
    [sequence]
  )
  const allChoices = useMemo(() => clips.flatMap((c) => c.choices), [clips])

  const [takeId, setTakeId] = useState<string>()
  // The first choice once the sequence has loaded: the asked-for clip's take in the cut, else the first clip with one.
  useEffect(() => {
    if (takeId || !allChoices.length) return
    const ofWanted = wanted ? clips.find((c) => c.segment.id === wanted.id)?.choices[0] : undefined
    setTakeId((ofWanted ?? allChoices.find((c) => c.selected) ?? allChoices[0]).take.id)
  }, [allChoices, takeId])
  const choice = allChoices.find((c) => c.take.id === takeId)
  // The take was deleted meanwhile: fall back to another.
  useEffect(() => {
    if (takeId && sequence && !choice) setTakeId(undefined)
  }, [takeId, sequence, choice])

  const player = useRef<PlayerHandle>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const pick = async () => {
    const handle = player.current
    if (!handle || !choice || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const time = await handle.frameTime()
      const still = await window.studio.saveFrameAsStill(choice.take.id, time, sequenceId)
      onPicked(still)
      onClose()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const loading = !sequence && !loadError
  const empty = !!sequence && allChoices.length === 0

  return (
    <Modal
      title="Bildruta från ett klipp"
      subtitle="Välj en tagning, spola fram till rätt bildruta och spara den som en bild i sekvensen."
      onClose={onClose}
      maxWidth={1040}
      footer={
        <>
          {error && <p className="mr-auto max-w-lg text-[12px] text-accent select-text">{error}</p>}
          {!error && choice && (
            <p className="mr-auto text-[11px] text-muted">
              ← → en bildruta · Shift + ← → en sekund · Mellanslag spelar
            </p>
          )}
          <button onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Avbryt
          </button>
          <button
            onClick={() => void pick()}
            disabled={!choice || saving}
            className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {saving ? 'Sparar…' : 'Använd den här bildrutan'}
          </button>
        </>
      }
    >
      {loadError ? (
        <p className="text-accent select-text">{loadError}</p>
      ) : loading ? (
        <p className="text-muted">Hämtar sekvensen…</p>
      ) : empty ? (
        <p className="py-10 text-center leading-relaxed text-muted">
          Ingen tagning i sekvensen är klar än.
          <br />
          När ett klipp har en färdig tagning kan du ta en bildruta ur den här.
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <TakeChooser clips={clips} current={takeId} onChoose={setTakeId} />
          {choice ? (
            <FramePlayer
              key={choice.take.id}
              ref={player}
              choice={choice}
              startAt={choice.segment.id === wanted?.id ? at : 'start'}
            />
          ) : (
            <div />
          )}
        </div>
      )}
    </Modal>
  )
}

function TakeChooser({
  clips,
  current,
  onChoose
}: {
  clips: { segment: Segment; clip: number; choices: Choice[] }[]
  current?: string
  onChoose: (takeId: string) => void
}) {
  return (
    <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
      {clips.map(({ segment, clip, choices }) => (
        <div key={segment.id}>
          <p className="mb-1 truncate text-[12px]" title={segment.params.prompt || undefined}>
            <span className="font-medium">Klipp {clip}</span>
            {segment.params.prompt && <span className="text-muted"> · {plainImagePrompt(segment.params.prompt)}</span>}
          </p>
          {choices.length === 0 ? (
            <p className="text-[11px] text-muted">Ingen färdig tagning</p>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {choices.map((c) => (
                <button
                  key={c.take.id}
                  onClick={() => onChoose(c.take.id)}
                  title={c.selected ? 'Tagningen som används i sekvensen' : 'En annan tagning av klippet'}
                  className={`relative aspect-video overflow-hidden rounded bg-black transition ${
                    c.take.id === current ? 'ring-2 ring-accent' : 'opacity-80 hover:opacity-100'
                  }`}
                >
                  {c.take.thumbPath && (
                    <img
                      src={mediaUrl(c.take.thumbPath)}
                      alt=""
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  )}
                  {c.selected && (
                    <span className="absolute left-1 top-1 rounded bg-accent px-1 text-[9px] font-medium text-white">
                      Vald
                    </span>
                  )}
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] text-white/90">
                    {takeTime(c.take.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** "14:02" today, else "3 okt." – enough to tell a clip's takes apart. */
function takeTime(ms: number): string {
  const d = new Date(ms)
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })
}

// ── Player ────────────────────────────────────────────────────────────────────

interface PlayerHandle {
  /**
   * The time to save so that main extracts exactly the frame on screen. Main takes the frame a paused player
   * shows at that time (the last one starting at or before it), so a moment just after the frame's own start
   * is safe whichever way its timestamp was rounded. Waits for a pending seek to show its frame first.
   */
  frameTime: () => Promise<number>
}

/** Most Venice video models render at 24 fps; used until the video itself shows its frame length. */
const DEFAULT_FRAME = 1 / 24
// Hatching for the parts the sequence cuts away.
const HATCH = 'repeating-linear-gradient(135deg, #00000088 0 4px, #00000044 4px 8px)'

const decimal = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** "3,42 s" */
function formatFrameTime(seconds: number): string {
  return `${decimal.format(Math.max(0, seconds))} s`
}

const control =
  'rounded-md border border-line px-2.5 py-1.5 tabular-nums transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

function FramePlayer({
  choice,
  startAt,
  ref
}: {
  choice: Choice
  startAt: 'start' | 'end'
  ref: Ref<PlayerHandle>
}) {
  const { take, segment, selected } = choice
  const video = useRef<HTMLVideoElement>(null)
  const [measured, setMeasured] = useState<number>()
  const duration = take.videoDuration ?? measured ?? durationSeconds(take.params.duration)
  // The part of the take the sequence uses; trims only apply to the take in the cut.
  const usedStart = selected ? Math.min(segment.trimStart, Math.max(0, duration - 0.05)) : 0
  const usedEnd = selected ? Math.max(usedStart, duration - segment.trimEnd) : duration

  const [shown, setShown] = useState(0)
  const [playing, setPlaying] = useState(false)
  // Start time of the frame on screen, as the video reports it (requestVideoFrameCallback); undefined while a
  // seek is on its way and only the time asked for is known.
  const anchor = useRef<number | undefined>(undefined)
  // Shortest time seen between two consecutive frames: the frame length (24 fps until measured).
  const frameLength = useRef<number | undefined>(undefined)
  const [frameMeasured, setFrameMeasured] = useState(false)
  const presented = useRef(true)
  const waiters = useRef<(() => void)[]>([])
  // Runs once the next frame is on screen (used to land on the first frame the sequence keeps).
  const afterPresent = useRef<((pts: number) => void) | undefined>(undefined)

  const frame = () => frameLength.current ?? DEFAULT_FRAME

  const seekTo = useCallback(
    (t: number, nextAnchor?: number) => {
      const el = video.current
      if (!el) return
      const max = Math.max(0, (Number.isFinite(el.duration) ? el.duration : duration) - 0.001)
      const clamped = Math.min(max, Math.max(0, t))
      anchor.current = clamped === t ? nextAnchor : undefined
      presented.current = false
      el.currentTime = clamped
      setShown(clamped)
    },
    [duration]
  )

  /** Moves n frames: into the middle of the target frame, so rounding can't land on its neighbour. */
  const step = useCallback(
    (n: number) => {
      const el = video.current
      if (!el) return
      el.pause()
      const d = frame()
      if (anchor.current !== undefined) {
        const start = anchor.current + n * d
        seekTo(start + d / 2, start)
      } else {
        seekTo(el.currentTime + n * d)
      }
    },
    [seekTo]
  )

  const jumpFirst = () => {
    video.current?.pause()
    // The first frame the sequence keeps is the first one starting at or after the start trim, which may be the
    // one after the frame showing at that moment.
    afterPresent.current = (pts) => {
      if (pts < usedStart - 0.0005) step(1)
    }
    seekTo(usedStart, usedStart === 0 ? 0 : undefined)
  }

  const jumpLast = () => {
    video.current?.pause()
    // The last frame kept is the last one starting before the end of the used part.
    seekTo(usedEnd - 0.001)
  }

  // Track the frame on screen, and learn the frame length from consecutive frames.
  useEffect(() => {
    const el = video.current
    if (!el || typeof el.requestVideoFrameCallback !== 'function') return
    let handle = 0
    let last: { time: number; count: number } | undefined
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      const time = meta.mediaTime
      if (last && meta.presentedFrames === last.count + 1) {
        const d = time - last.time
        if (d > 0.004 && d < 0.1 && d < (frameLength.current ?? Infinity) - 1e-6) {
          frameLength.current = d
          setFrameMeasured(true)
        }
      }
      last = { time, count: meta.presentedFrames }
      anchor.current = time
      presented.current = true
      setShown(time)
      const after = afterPresent.current
      afterPresent.current = undefined
      after?.(time)
      for (const w of waiters.current.splice(0)) w()
      handle = el.requestVideoFrameCallback(onFrame)
    }
    handle = el.requestVideoFrameCallback(onFrame)
    return () => el.cancelVideoFrameCallback(handle)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      frameTime: async () => {
        const el = video.current
        if (el && !el.paused) {
          // Pausing can show one more frame; pin the one that was on screen when the button was pressed.
          el.pause()
          if (anchor.current !== undefined) seekTo(anchor.current + frame() / 2, anchor.current)
        }
        if (!presented.current) {
          // A seek is still on its way: wait (briefly) for its frame, whose start time is then known.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 600)
            waiters.current.push(() => {
              clearTimeout(t)
              resolve()
            })
          })
        }
        if (anchor.current !== undefined) return anchor.current + Math.min(frame() / 2, 0.004)
        return el?.currentTime ?? shown
      }
    }),
    [shown, seekTo]
  )

  // Follow playback smoothly where requestVideoFrameCallback isn't available.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const el = video.current
      if (el && typeof el.requestVideoFrameCallback !== 'function') setShown(el.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // Arrow keys step, Shift+arrows jump a second, space plays, Home/End go to the ends of the used part.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      const el = video.current
      if (!el) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowRight' ? 1 : -1
        if (e.shiftKey) {
          el.pause()
          seekTo(el.currentTime + dir)
        } else step(dir)
      } else if (e.key === ' ' && !target?.closest('button')) {
        if (el.paused) void el.play()
        else el.pause()
      } else if (e.key === 'Home') jumpFirst()
      else if (e.key === 'End') jumpLast()
      else return
      // Captured and stopped, so the view underneath (e.g. a timeline) doesn't act on the same keys.
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const frameNumber = frameMeasured ? Math.round(shown / frame()) + 1 : undefined
  const outside = selected && (shown < usedStart - 0.0005 || shown >= usedEnd - 0.0005)

  return (
    <div className="min-w-0">
      <video
        ref={video}
        src={mediaUrl(take.filePath!)}
        poster={take.thumbPath ? mediaUrl(take.thumbPath) : undefined}
        preload="auto"
        playsInline
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          if (Number.isFinite(el.duration)) setMeasured(el.duration)
          const d = Number.isFinite(el.duration) ? el.duration : duration
          const end = selected ? Math.max(0, d - segment.trimEnd) : d
          if (startAt === 'end') seekTo(end - 0.001)
          else if (usedStart > 0) jumpFirst()
        }}
        onPlay={(e) => {
          setPlaying(true)
          const el = e.currentTarget
          if (el.currentTime >= el.duration - 0.05) el.currentTime = 0
        }}
        onPause={() => setPlaying(false)}
        onSeeked={(e) => {
          if (typeof e.currentTarget.requestVideoFrameCallback !== 'function') {
            setShown(e.currentTarget.currentTime)
            presented.current = true
          }
        }}
        onClick={(e) => {
          const el = e.currentTarget
          if (el.paused) void el.play()
          else el.pause()
        }}
        className="aspect-video max-h-[50vh] w-full cursor-pointer rounded-lg bg-black object-contain"
      />

      <ScrubBar
        duration={duration}
        time={shown}
        usedStart={selected ? usedStart : 0}
        usedEnd={selected ? usedEnd : duration}
        onSeek={(t) => {
          video.current?.pause()
          seekTo(t)
        }}
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button onClick={jumpFirst} className={control} title="Första bildrutan som används (Home)">
          ⇤
        </button>
        <button
          onClick={() => {
            video.current?.pause()
            seekTo((video.current?.currentTime ?? shown) - 1)
          }}
          className={control}
          title="En sekund bakåt (Shift + ←)"
        >
          −1 s
        </button>
        <button onClick={() => step(-1)} className={control} title="En bildruta bakåt (←)">
          ‹ Bildruta
        </button>
        <button
          onClick={() => {
            const el = video.current
            if (!el) return
            if (el.paused) void el.play()
            else el.pause()
          }}
          className={`${control} w-20`}
          title="Spela / pausa (mellanslag)"
        >
          {playing ? 'Pausa' : 'Spela'}
        </button>
        <button onClick={() => step(1)} className={control} title="En bildruta framåt (→)">
          Bildruta ›
        </button>
        <button
          onClick={() => {
            video.current?.pause()
            seekTo((video.current?.currentTime ?? shown) + 1)
          }}
          className={control}
          title="En sekund framåt (Shift + →)"
        >
          +1 s
        </button>
        <button onClick={jumpLast} className={control} title="Sista bildrutan som används (End)">
          ⇥
        </button>
        <span className="ml-auto text-right text-[12px] tabular-nums text-muted">
          <span className="text-text">{formatFrameTime(shown)}</span> av {formatFrameTime(duration)}
          {frameNumber !== undefined && ` · bildruta ${frameNumber}`}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        Klipp {choice.clip}
        {selected ? ', tagningen som används i sekvensen' : ', en annan tagning än den som används'}.
        {selected && (segment.trimStart > 0 || segment.trimEnd > 0) && ' Randade delar är bortklippta i sekvensen.'}
        {outside && <span className="text-accent"> Den här bildrutan syns inte i sekvensen.</span>}
      </p>
    </div>
  )
}

function ScrubBar({
  duration,
  time,
  usedStart,
  usedEnd,
  onSeek
}: {
  duration: number
  time: number
  usedStart: number
  usedEnd: number
  onSeek: (t: number) => void
}) {
  const bar = useRef<HTMLDivElement>(null)
  const pct = (t: number) => `${duration > 0 ? (Math.min(duration, Math.max(0, t)) / duration) * 100 : 0}%`

  const timeAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration))
  }

  /** Captures the pointer so scrubbing keeps working outside the bar. */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    onSeek(timeAt(e.clientX))
    const move = (ev: PointerEvent) => onSeek(timeAt(ev.clientX))
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
    <div className="mt-3">
      <div
        ref={bar}
        onPointerDown={onPointerDown}
        className="relative h-8 cursor-pointer touch-none rounded-md bg-raised"
        title="Klicka eller dra för att spola"
      >
        {usedStart > 0 && (
          <div className="absolute inset-y-0 left-0 rounded-l-md" style={{ width: pct(usedStart), backgroundImage: HATCH }} />
        )}
        {usedEnd < duration && (
          <div
            className="absolute inset-y-0 right-0 rounded-r-md"
            style={{ width: `calc(100% - ${pct(usedEnd)})`, backgroundImage: HATCH }}
          />
        )}
        <div
          className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-accent"
          style={{ left: pct(time) }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
        <span>0 s</span>
        <span>{formatFrameTime(duration)}</span>
      </div>
    </div>
  )
}

export { FramePickerDialog }
