import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { durationSeconds } from '@shared/models'
import type { Generation, Segment } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { MIN_CLIP_SECONDS, formatLength, round2 } from './sequenceUtils'
import { useDraft, useRegisterFlush, type FlushRegistry } from './useDraft'
import type { SequenceStore } from './useSequence'

interface Trims {
  trimStart: number
  trimEnd: number
}

interface Props {
  segment: Segment
  /** The selected take; must be completed with a file. */
  take: Generation
  number: number
  /** The next segment starts from this take's (trimmed) last frame. */
  nextContinues: boolean
  patchSegment: SequenceStore['patchSegment']
  flushers: FlushRegistry
}

const snap = (t: number) => Math.round(t * 10) / 10

// Hatching for the parts that are cut away.
const HATCH = 'repeating-linear-gradient(135deg, #00000088 0 4px, #00000044 4px 8px)'

/**
 * The selected take with start/end trims. Mount with a key per segment + take. Trims are saved debounced
 * as a trims-only patch; main clamps them, and the clamped values come back through the draft.
 */
export default function TrimControls({ segment, take, number, nextContinues, patchSegment, flushers }: Props) {
  const segmentId = segment.id
  const save = useCallback((t: Trims) => patchSegment(segmentId, t), [patchSegment, segmentId])
  const draft = useDraft<Trims>({ trimStart: segment.trimStart, trimEnd: segment.trimEnd }, save)
  const { value, setValue } = draft
  useRegisterFlush(flushers, draft.flush)

  const video = useRef<HTMLVideoElement>(null)
  const [measured, setMeasured] = useState<number>()
  const duration = take.videoDuration ?? measured ?? durationSeconds(take.params.duration)
  const { trimStart, trimEnd } = value
  const keepEnd = Math.max(trimStart, duration - trimEnd)
  const [time, setTime] = useState(trimStart)
  const [playing, setPlaying] = useState(false)
  const [onlyTrimmed, setOnlyTrimmed] = useState(true)

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
        setTime(el.currentTime)
      }
    },
    [setValue]
  )

  const seek = (t: number) => {
    const el = video.current
    if (!el) return
    el.currentTime = t
    setTime(t)
  }

  // Follow the playhead smoothly while playing, and stop at the end trim when previewing the trimmed part.
  useEffect(() => {
    if (!playing) return
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
  }, [playing, onlyTrimmed, keepEnd])

  const keptLength = Math.max(0, keepEnd - trimStart)

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-medium">Vald tagning</h3>
        <span className="text-[12px] text-muted">
          klipp {number} · {formatLength(keptLength)} i sekvensen
        </span>
        <span className="ml-auto text-[11px] text-muted">
          {draft.error ? <span className="text-accent">{draft.error}</span> : draft.status !== 'idle' && 'Sparar…'}
        </span>
      </div>

      <video
        ref={video}
        src={mediaUrl(take.filePath!)}
        poster={take.thumbPath ? mediaUrl(take.thumbPath) : undefined}
        controls
        preload="auto"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          if (Number.isFinite(el.duration)) setMeasured(el.duration)
          if (latest.current.value.trimStart > 0) el.currentTime = latest.current.value.trimStart
        }}
        onPlay={(e) => {
          setPlaying(true)
          const el = e.currentTarget
          if (onlyTrimmed && (el.currentTime < trimStart - 0.05 || el.currentTime >= keepEnd - 0.05)) {
            el.currentTime = trimStart
          }
        }}
        onPause={() => setPlaying(false)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        className="aspect-video max-h-[46vh] w-full rounded-lg bg-black object-contain"
      />

      <div className="mt-3 space-y-3">
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
            label="Trimma början"
            value={trimStart}
            onChange={(v) => setTrim('trimStart', v, true)}
            onHere={() => setTrim('trimStart', video.current?.currentTime ?? time, false)}
            hereTitle="Börja klippet vid uppspelningshuvudet"
          />
          <SecondsInput
            label="Trimma slutet"
            value={trimEnd}
            onChange={(v) => setTrim('trimEnd', v, true)}
            onHere={() => setTrim('trimEnd', duration - (video.current?.currentTime ?? time), false)}
            hereTitle="Avsluta klippet vid uppspelningshuvudet"
          />
          <button
            onClick={() => {
              setTrim('trimStart', 0, false)
              setTrim('trimEnd', 0, false)
            }}
            disabled={trimStart === 0 && trimEnd === 0}
            className="rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Nollställ
          </button>
          <label className="ml-auto flex items-center gap-2 pb-1.5 text-muted">
            <input
              type="checkbox"
              checked={onlyTrimmed}
              onChange={(e) => setOnlyTrimmed(e.target.checked)}
              className="accent-accent"
            />
            Spela bara det som används
          </label>
        </div>

        {nextContinues && (
          <p className="text-[11px] leading-relaxed text-muted">
            Klipp {number + 1} fortsätter från bildrutan vid {formatLength(keepEnd)}. Ändrar du slutet behöver klipp{' '}
            {number + 1} en ny tagning för att övergången ska bli sömlös.
          </p>
        )}
      </div>
    </section>
  )
}

function TrimBar({
  duration,
  trimStart,
  trimEnd,
  time,
  onSeek,
  onDrag
}: {
  duration: number
  trimStart: number
  trimEnd: number
  time: number
  onSeek: (t: number) => void
  onDrag: (key: keyof Trims, t: number) => void
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
        title="Klicka för att spola"
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
            title={key === 'trimStart' ? 'Dra för att trimma början' : 'Dra för att trimma slutet'}
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
          Här
        </button>
      </span>
    </label>
  )
}
