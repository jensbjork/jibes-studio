import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import type { Segment, Sequence, SongLyricLine, SongPart, SongWindow } from '@shared/types'
import { ipcErrorMessage, useSeparationStatus } from '../../../lib/hooks'
import { mediaUrl } from '../../../lib/media'
import { pauseOthers } from '../../feed/playback'
import Popover from '../../pickers/Popover'
import { Spinner } from '../../work/StatusMark'
import ConfirmButton from '../ConfirmButton'
import { PauseIcon, PlayIcon } from '../icons'
import { formatFrameTime, isUntouchedClip } from '../sequenceUtils'
import type { SequenceStore } from '../useSequence'
import {
  boundariesOf,
  clipAt,
  moveBoundary,
  PART_LABEL,
  placeOf,
  placeText,
  snapToBeat,
  splitProblem,
  stepBeat,
  workText
} from './songText'
import SongWave from './SongWave'
import TranscribeLyrics from './TranscribeLyrics'
import { useMediaPlaying, useMediaTime } from './useMediaTime'
import { useSongOverview } from './useSongOverview'

// The song strip of a sequence cut to a song, above its clips: the song's waveform (the vocals tinted once
// separated), its beats and bars, the clips' places in it with boundaries to drag (on the beat; ⌥ for anywhere),
// split at the playhead and merge with the next, the lyric lines under it (click one to correct it), and the song
// itself to play, pause and scrub (Space while the strip has the focus). Progress and failures of the work on the
// song (separating, transcribing, finding the beat) show at its top, with the steps still to do.

interface Props {
  /** A sequence with a song. */
  sequence: Sequence
  selectedId?: string
  onSelect: (segmentId: string) => void
  store: SequenceStore
  /** Saves every open draft first: main rewrites the clips' places and durations in the same step. */
  flushAll: () => Promise<boolean>
}

/** Below this the strip scrolls instead of squeezing a long song into the width. */
const MIN_PX_PER_SECOND = 10
/** Arrow keys on a boundary are saved after a pause, so a run of presses is one change. */
const KEY_SAVE_MS = 700
// A pointer that moves less than this is a click (select and seek), not a drag.
const DRAG_THRESHOLD_PX = 3

const button =
  'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-line px-2 py-0.5 text-[12px] transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

const PART_DOT: Record<SongPart, string> = {
  vocals: 'bg-violet-300',
  mix: 'bg-sky-300',
  none: 'border border-muted'
}

interface Draft {
  /** The boundary being moved. */
  index: number
  boundaries: number[]
  /** Why the boundary stopped where it is (a place would get under 2 s). */
  held?: string
}

interface Note {
  text: string
  tone: 'error' | 'info'
}

const round2 = (v: number) => Math.round(v * 100) / 100

export default function SongStrip({ sequence, selectedId, onSelect, store, flushAll }: Props) {
  const song = sequence.song!
  const { overview, error: overviewError, loading, retry } = useSongOverview(sequence)
  const separation = useSeparationStatus()
  const duration = overview?.duration ?? song.duration
  const beats = overview?.beats
  const working = sequence.songWork

  const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
  const playing = useMediaPlaying(audio)
  const scroller = useRef<HTMLDivElement>(null)
  const lanes = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [draft, setDraft] = useState<Draft>()
  // Boundaries sent to main, shown until its answer has landed.
  const [pending, setPending] = useState<number[]>()
  const [busy, setBusy] = useState<'split' | 'merge' | 'separate' | 'lyrics'>()
  const [note, setNote] = useState<Note>()
  const [editing, setEditing] = useState<number>()
  const lineAnchor = useRef<HTMLElement | null>(null)
  const keyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // ── Geometry ─────────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const inner = Math.max(width, duration * MIN_PX_PER_SECOND)
  const px = duration > 0 ? inner / duration : 0
  const x = (t: number) => Math.min(inner, Math.max(0, t * px))
  const timeAt = (clientX: number) => {
    const r = lanes.current?.getBoundingClientRect()
    if (!r || !px) return 0
    return Math.min(duration, Math.max(0, (clientX - r.left) / px))
  }

  // ── The places as they are, while dragged or on their way to main ──────────

  const server = useMemo(() => boundariesOf(sequence), [sequence])
  const shown = draft?.boundaries ?? pending ?? server
  const places = useMemo(() => {
    const edges = shown && shown.length === sequence.segments.length - 1 ? [0, ...shown, duration] : undefined
    return sequence.segments.flatMap((segment, index) => {
      const own = placeOf(segment)
      if (!own) return []
      const place: SongWindow = edges ? { ...own, start: edges[index], end: edges[index + 1] } : own
      return [{ segment, index, place }]
    })
  }, [sequence.segments, shown, duration])

  // Main's answer has landed (or the places changed elsewhere): the list sent is no longer needed.
  useEffect(() => setPending(undefined), [server?.join()])

  const selected = places.find((p) => p.segment.id === selectedId)

  // The open clip's place in view when the strip scrolls.
  useEffect(() => {
    const el = scroller.current
    if (!el || !selected || inner <= el.clientWidth) return
    const left = x(selected.place.start)
    const right = x(selected.place.end)
    if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: Math.max(0, left - 24), behavior: 'smooth' })
    }
  }, [selectedId, inner])

  // ── Playing ──────────────────────────────────────────────────────────────

  const seek = (t: number) => {
    if (!audio) return
    audio.currentTime = Math.min(duration, Math.max(0, t))
  }
  const toggle = () => {
    if (!audio) return
    if (audio.paused) {
      if (audio.ended || audio.currentTime >= duration - 0.05) audio.currentTime = 0
      void audio.play().catch(() => undefined)
    } else audio.pause()
  }

  // ── Changing the places ──────────────────────────────────────────────────

  const editable = !working && !busy && !pending && !!server
  const blockedTitle = working ? 'Wait until the song is ready' : undefined

  const commit = async (boundaries: number[]) => {
    setDraft(undefined)
    if (server && boundaries.join() === server.join()) return
    setPending(boundaries)
    setNote(undefined)
    try {
      if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
      await store.mutate(() => window.studio.setSongSections(sequence.id, boundaries))
    } catch (e) {
      setNote({ text: ipcErrorMessage(e), tone: 'error' })
    } finally {
      setPending(undefined)
    }
  }

  /** A drag of boundary `i`: on the beat, anywhere with ⌥; held 2 s from its neighbours. */
  const dragBoundary = (e: ReactPointerEvent<HTMLElement>, i: number) => {
    if (e.button !== 0 || !editable || !server) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    el.focus()
    const base = server
    let last: Draft = { index: i, boundaries: base }
    const move = (ev: PointerEvent) => {
      const raw = timeAt(ev.clientX)
      const t = ev.altKey ? round2(raw) : snapToBeat(raw, beats)
      last = { index: i, ...moveBoundary(base, i, t, duration) }
      setDraft(last)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      void commit(last.boundaries)
      // Said after the commit has cleared the last note: why the cut stopped where it did.
      if (last.held) setNote({ text: last.held, tone: 'info' })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  /** ← / → move a boundary to the previous or next beat (⌥: a tenth of a second); saved after a pause. */
  const boundaryKeys = (e: KeyboardEvent<HTMLElement>, i: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    if (!editable && !draft) return
    const base = draft?.boundaries ?? server
    if (!base) return
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const t = e.altKey ? round2(base[i] + dir * 0.1) : stepBeat(base[i], dir, beats)
    const next: Draft = { index: i, ...moveBoundary(base, i, t, duration) }
    setDraft(next)
    setNote(next.held ? { text: next.held, tone: 'info' } : undefined)
    clearTimeout(keyTimer.current)
    keyTimer.current = setTimeout(() => {
      void commit(next.boundaries)
      if (next.held) setNote({ text: next.held, tone: 'info' })
    }, KEY_SAVE_MS)
  }
  useEffect(() => () => clearTimeout(keyTimer.current), [])

  /** A press on the song: selects the clip there and moves the playhead; dragging scrubs. */
  const pressLanes = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const t = timeAt(e.clientX)
    seek(t)
    const at = places.find((p) => t >= p.place.start && t < p.place.end) ?? places.at(-1)
    if (at && at.segment.id !== selectedId) onSelect(at.segment.id)
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD_PX) return
      moved = true
      seek(timeAt(ev.clientX))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const laneKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === ' ') toggle()
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowRight' ? 1 : -1)
      seek((audio?.currentTime ?? 0) + step)
    } else return
    e.preventDefault()
  }

  /** "Split at playhead": main splits the clip in two (the new one after it), then the cut is moved to the playhead. */
  const split = async () => {
    const t = round2(audio?.currentTime ?? 0)
    const at = clipAt(sequence, t)
    if (!at) return
    const problem = splitProblem(at.place, t, at.index + 1)
    if (problem) {
      setNote({ text: problem, tone: 'info' })
      return
    }
    setBusy('split')
    setNote(undefined)
    const before = new Set(sequence.segments.map((s) => s.id))
    try {
      if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
      // Splitting through addSegment keeps every later clip on its own place (setSongSections would shift them).
      const added = await store.mutate(() => window.studio.addSegment(sequence.id, { afterSegmentId: at.segment.id }))
      const fresh = added.segments.find((s) => !before.has(s.id))
      const cuts = boundariesOf(added)
      if (cuts && Math.abs(cuts[at.index] - t) > 0.005) {
        const next = [...cuts]
        next[at.index] = t
        await store.mutate(() => window.studio.setSongSections(sequence.id, next))
      }
      if (fresh) onSelect(fresh.id)
    } catch (e) {
      setNote({ text: ipcErrorMessage(e), tone: 'error' })
    } finally {
      setBusy(undefined)
    }
  }

  /** "Merge with next": the next clip leaves the sequence and its place joins the open clip's. */
  const merge = async (next: Segment) => {
    setBusy('merge')
    setNote(undefined)
    try {
      if (!(await flushAll())) throw new Error("The clip's changes couldn't be saved. Try again.")
      await store.mutate(() => window.studio.deleteSegment(next.id))
    } catch (e) {
      setNote({ text: ipcErrorMessage(e), tone: 'error' })
    } finally {
      setBusy(undefined)
    }
  }

  const separate = async () => {
    setBusy('separate')
    setNote(undefined)
    try {
      await store.mutate(() => window.studio.separateSongVocals(sequence.id))
    } catch (e) {
      setNote({ text: ipcErrorMessage(e), tone: 'error' })
    } finally {
      setBusy(undefined)
    }
  }

  const correctLine = async (index: number, text: string) => {
    setBusy('lyrics')
    try {
      await store.mutate(() => window.studio.editSongLyricLine(sequence.id, index, text))
      setEditing(undefined)
    } finally {
      setBusy(undefined)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const selectedAt = selected ? sequence.segments.findIndex((s) => s.id === selected.segment.id) : -1
  const nextClip = selectedAt !== -1 ? sequence.segments[selectedAt + 1] : undefined
  const nextUntouched = !!nextClip && isUntouchedClip(nextClip, sequence.cast)
  const lyrics = song.lyrics?.lines ?? []
  const noVocals = !song.vocalsPath && !working
  const noLyrics = !song.lyrics && !working

  return (
    <section aria-label="Song strip" className="shrink-0 border-b border-line px-4 pb-2.5 pt-2">
      <audio
        ref={setAudio}
        src={mediaUrl(song.path)}
        preload="auto"
        onPlay={(e) => pauseOthers(e.currentTarget)}
        className="hidden"
      />
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={toggle}
          disabled={!audio}
          aria-label={playing ? 'Pause the song' : 'Play the song'}
          title={playing ? 'Pause (Space in the strip)' : 'Play the song (Space in the strip)'}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-text transition hover:bg-line"
        >
          {playing ? <PauseIcon size={10} /> : <PlayIcon size={10} />}
        </button>
        <span className="shrink-0 font-medium">Song</span>
        <span className="min-w-0 max-w-28 truncate text-[12px] text-muted @min-[75rem]/main:max-w-56" title={song.name}>
          {song.name}
        </span>
        <Clock audio={audio} duration={duration} />
        {overview?.bpm !== undefined && (
          <span className="shrink-0 text-[12px] tabular-nums text-muted">{Math.round(overview.bpm)} BPM</span>
        )}

        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {working ? (
            <span className="flex items-center gap-2 text-[12px] text-muted" role="status" aria-live="polite">
              <Spinner size={11} />
              {workText(working)}
              {!!working.fraction && (
                <span className="h-1 w-20 overflow-hidden rounded-full bg-raised">
                  <span
                    className="block h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${Math.max(3, working.fraction * 100)}%` }}
                  />
                </span>
              )}
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void split()}
                disabled={!editable}
                title={blockedTitle ?? 'Split the clip under the playhead in two, at the playhead'}
                className={button}
              >
                {busy === 'split' ? (
                  'Splitting…'
                ) : (
                  <>
                    Split<span className="hidden @min-[67rem]/main:inline"> at playhead</span>
                  </>
                )}
              </button>
              {nextClip && !nextUntouched ? (
                <ConfirmButton
                  question={`Clip ${selectedAt + 2} leaves the sequence (its takes stay in Media) – merge?`}
                  confirmLabel="Merge"
                  onConfirm={() => void merge(nextClip)}
                  disabled={!editable}
                  title={`Merge clip ${selectedAt + 1} with clip ${selectedAt + 2}: its place joins this one`}
                  className={button}
                >
                  Merge<span className="hidden @min-[67rem]/main:inline"> with next</span>
                </ConfirmButton>
              ) : (
                <button
                  type="button"
                  onClick={() => nextClip && void merge(nextClip)}
                  disabled={!editable || !nextClip}
                  title={
                    blockedTitle ??
                    (selectedAt === -1
                      ? 'Select a clip first'
                      : nextClip
                        ? `Merge clip ${selectedAt + 1} with clip ${selectedAt + 2}: its place joins this one`
                        : `Clip ${selectedAt + 1} is the last clip`)
                  }
                  className={button}
                >
                  {busy === 'merge' ? (
                    'Merging…'
                  ) : (
                    <>
                      Merge<span className="hidden @min-[67rem]/main:inline"> with next</span>
                    </>
                  )}
                </button>
              )}
            </>
          )}
          {noVocals && (
            <button
              type="button"
              onClick={() => void separate()}
              disabled={!!busy || !separation?.available}
              title={
                separation?.available
                  ? 'Free, on this Mac: singing shots then hear only the voice'
                  : (separation?.message ?? "This Mac can't separate voices")
              }
              className={button}
            >
              {busy === 'separate' ? 'Starting…' : 'Separate the vocals'}
            </button>
          )}
          {noLyrics && (
            <TranscribeLyrics
              sequence={sequence}
              onTranscribe={(opts) => store.mutate(() => window.studio.transcribeSong(sequence.id, opts))}
              onError={(text) => setNote({ text, tone: 'error' })}
              disabled={!!busy}
              className={button}
            />
          )}
        </div>
      </div>

      <div ref={scroller} className="overflow-x-auto overflow-y-hidden [scrollbar-width:thin]">
        <div
          ref={lanes}
          tabIndex={0}
          role="group"
          aria-label="Song strip: Space plays or pauses, ← → move the playhead"
          onKeyDown={laneKeys}
          className="relative rounded-md outline-none focus-visible:ring-1 focus-visible:ring-muted"
          style={{ width: inner || '100%' }}
        >
          {/* Beats and bars */}
          <div className="relative h-2.5" aria-hidden>
            {beats?.map((b, i) => (
              <span key={i} className="absolute bottom-0 h-1 w-px bg-muted/40" style={{ left: x(b) }} />
            ))}
            {overview?.bars?.map((b, i) => (
              <span key={`bar${i}`} className="absolute bottom-0 h-2.5 w-px bg-muted/80" style={{ left: x(b) }} />
            ))}
          </div>

          {/* The waveform with the clips' places */}
          <div
            className="relative h-12 cursor-pointer touch-none overflow-hidden rounded bg-raised/50"
            onPointerDown={pressLanes}
          >
            {overview ? (
              <>
                <SongWave peaks={overview.peaks} className={overview.vocalPeaks ? 'text-sky-300/35' : 'text-sky-300/60'} />
                {overview.vocalPeaks && <SongWave peaks={overview.vocalPeaks} className="text-violet-300/80" />}
              </>
            ) : loading ? (
              <div className="absolute inset-1 animate-pulse rounded bg-raised" />
            ) : (
              overviewError && (
                <span className="absolute inset-0 flex items-center gap-2 px-2 text-[11px] text-muted">
                  The waveform couldn't be read: {overviewError}
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={retry}
                    className="rounded px-1 text-text hover:bg-line"
                  >
                    Try again
                  </button>
                </span>
              )
            )}
            {places.map(({ segment, index, place }) => {
              const on = segment.id === selectedId
              const part = segment.params.song?.part ?? 'vocals'
              return (
                <div
                  key={segment.id}
                  title={`Clip ${index + 1} · ${placeText(place)} · ${PART_LABEL[part]}`}
                  className={`absolute inset-y-0 ${index > 0 ? 'border-l border-white/25' : ''} ${
                    on ? 'bg-accent/15 ring-1 ring-inset ring-accent' : 'hover:bg-white/5'
                  }`}
                  style={{ left: x(place.start), width: Math.max(0, x(place.end) - x(place.start)) }}
                >
                  <span
                    className={`pointer-events-none absolute left-0.5 top-0.5 flex items-center gap-1 rounded bg-black/60 px-1 text-[10px] font-semibold tabular-nums leading-[14px] ${
                      on ? 'text-white' : 'text-white/80'
                    }`}
                  >
                    {index + 1}
                    <span className={`h-1.5 w-1.5 rounded-full ${PART_DOT[part]}`} aria-hidden />
                  </span>
                </div>
              )
            })}
            {shown && shown.length === places.length - 1 &&
              shown.map((b, i) => (
                <div
                  key={`b${i}`}
                  role="slider"
                  tabIndex={editable || draft?.index === i ? 0 : -1}
                  aria-label={`Boundary between clip ${i + 1} and clip ${i + 2}`}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration * 100) / 100}
                  aria-valuenow={b}
                  aria-valuetext={formatFrameTime(b)}
                  aria-disabled={!editable || undefined}
                  title={
                    blockedTitle ??
                    `${formatFrameTime(b)} – drag to move the cut (on the beat; hold ⌥ for anywhere), or ← →`
                  }
                  onPointerDown={(e) => dragBoundary(e, i)}
                  onKeyDown={(e) => boundaryKeys(e, i)}
                  onBlur={() => {
                    // Arrow presses waiting to be saved go now.
                    if (draft?.index === i && keyTimer.current) {
                      clearTimeout(keyTimer.current)
                      keyTimer.current = undefined
                      void commit(draft.boundaries)
                    }
                  }}
                  className={`group/cut absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 justify-center outline-none ${
                    editable ? 'cursor-ew-resize' : 'cursor-default'
                  }`}
                  style={{ left: x(b) }}
                >
                  <span
                    className={`h-full w-0.5 rounded-full transition ${
                      draft?.index === i
                        ? draft.held
                          ? 'bg-amber-300'
                          : 'bg-white'
                        : 'bg-white/45 group-hover/cut:bg-white group-focus-visible/cut:bg-white'
                    }`}
                  />
                  {/* Where the cut is while it moves, and – when it stops – that a place keeps 2 s. */}
                  {draft?.index === i && (
                    <span
                      className={`pointer-events-none absolute top-1 whitespace-nowrap rounded bg-black/85 px-1 text-[10px] tabular-nums leading-[14px] ${
                        x(b) > inner - 140 ? 'right-2.5' : 'left-2.5'
                      } ${draft.held ? 'text-amber-300' : 'text-white'}`}
                    >
                      {formatFrameTime(b)}
                      {draft.held && ' · a place is at least 2 s'}
                    </span>
                  )}
                </div>
              ))}
          </div>

          {/* The lyrics */}
          <div className="relative mt-1 h-5">
            {lyrics.length ? (
              lyrics.map((line, i) => (
                <LyricLine
                  key={i}
                  line={line}
                  left={x(line.start)}
                  width={Math.max(14, x(line.end) - x(line.start))}
                  onOpen={(el) => {
                    lineAnchor.current = el
                    seek(line.start)
                    setEditing(i)
                  }}
                />
              ))
            ) : (
              <span className="absolute inset-y-0 left-0 flex items-center text-[11px] text-muted">
                {working?.stage === 'transcribing' ? 'Transcribing the lyrics…' : 'No lyrics yet.'}
              </span>
            )}
          </div>

          <Playhead audio={audio} x={x} scroller={scroller} />
        </div>
      </div>

      {(note || sequence.songError) && (
        <p
          role={note?.tone === 'error' || sequence.songError ? 'alert' : 'status'}
          className={`mt-1.5 select-text text-[11px] leading-snug ${
            note?.tone === 'info' ? 'text-amber-300' : 'text-accent'
          }`}
        >
          {note?.text ?? sequence.songError}
          {note && (
            <button type="button" onClick={() => setNote(undefined)} className="ml-2 text-muted hover:text-text">
              Close
            </button>
          )}
        </p>
      )}

      {editing !== undefined && lyrics[editing] && (
        <LineEditor
          anchorRef={lineAnchor}
          index={editing}
          line={lyrics[editing]}
          busy={busy === 'lyrics'}
          onSave={(text) => correctLine(editing, text)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  )
}

/** "0:12.3 / 0:40.0". */
function Clock({ audio, duration }: { audio: HTMLAudioElement | null; duration: number }) {
  const t = useMediaTime(audio)
  return (
    <span className="shrink-0 text-[12px] tabular-nums text-muted">
      {formatFrameTime(t)} / {formatFrameTime(duration)}
    </span>
  )
}

/** The song's playhead across the lanes; while playing it keeps itself in view. */
function Playhead({
  audio,
  x,
  scroller
}: {
  audio: HTMLAudioElement | null
  x: (t: number) => number
  scroller: RefObject<HTMLDivElement | null>
}) {
  const t = useMediaTime(audio)
  const left = x(t)
  useEffect(() => {
    const el = scroller.current
    if (!el || !audio || audio.paused) return
    if (left > el.scrollLeft + el.clientWidth - 24 || left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 48)
  }, [Math.round(left)])
  return (
    <span className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white" style={{ left }} aria-hidden>
      <span className="absolute -left-[4px] top-0 h-0 w-0 border-x-[4.5px] border-t-[6px] border-x-transparent border-t-white" />
    </span>
  )
}

/** One sung line under the waveform; a click opens it for correcting. */
function LyricLine({
  line,
  left,
  width,
  onOpen
}: {
  line: SongLyricLine
  left: number
  width: number
  onOpen: (el: HTMLElement) => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      title={`${formatFrameTime(line.start)} ${line.text}${line.edited ? ' (corrected)' : ''} – click to correct`}
      className={`absolute inset-y-0 truncate rounded border px-1 text-left text-[10px] leading-[18px] transition hover:text-text ${
        line.edited ? 'border-violet-300/40 bg-violet-300/10 text-text/90' : 'border-line bg-raised text-muted'
      }`}
      style={{ left, width }}
    >
      {line.text}
    </button>
  )
}

/** Correcting a line: the words keep their times when there are as many, else they share the line's span. */
function LineEditor({
  anchorRef,
  index,
  line,
  busy,
  onSave,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  index: number
  line: SongLyricLine
  busy: boolean
  onSave: (text: string) => Promise<void>
  onClose: () => void
}) {
  const [text, setText] = useState(line.text)
  const [error, setError] = useState<string>()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next = text.trim()
    if (!next || next === line.text.trim()) {
      onClose()
      return
    }
    setError(undefined)
    try {
      await onSave(next)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }
  return (
    <Popover anchorRef={anchorRef} open onClose={onClose} width={360} label="Correct the line">
      <form onSubmit={(e) => void submit(e)} className="space-y-2 p-3">
        <p className="text-[11px] tabular-nums text-muted">
          Line {index + 1} · {formatFrameTime(line.start)} – {formatFrameTime(line.end)}
        </p>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={`Line ${index + 1}`}
          spellCheck={false}
          className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
        />
        <p className="text-[11px] leading-snug text-muted">
          With as many words as before, each keeps its time; otherwise the words share the line's time.
        </p>
        {error && <p className="select-text text-[11px] text-accent">{error}</p>}
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Popover>
  )
}
