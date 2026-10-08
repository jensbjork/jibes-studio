import {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref
} from 'react'
import { queryGenerations } from '@shared/generation-filter'
import { generationTitle, isVeniceGeneration } from '@shared/generation-label'
import { durationSeconds } from '@shared/models'
import type { Generation, Segment, Sequence, Still } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Modal from '../pickers/Modal'
import {
  clipChoices,
  firstClipChoice,
  isReadyVideo,
  libraryChoice,
  takeTime,
  withLiveUpdate,
  type ClipGroup,
  type FrameChoice
} from './frameChoices'
import { plainImagePrompt } from './imageModels'

export interface FramePickerDialogProps {
  open: boolean
  /**
   * The sequence or storyboard the frame is saved with (it becomes one of its stills); none: Referensbilder.
   * Without `anyGeneration` it is also where the takes come from (a sequence's clips).
   */
  sequenceId?: string
  /**
   * Offer every finished video in the library, with a search over the prompts, instead of only the sequence's
   * takes. Always the case without a sequenceId (and the fallback when the id isn't a sequence, e.g. a storyboard).
   */
  anyGeneration?: boolean
  /** Sequence takes: the clip whose takes are shown first (its selected take, else its newest finished one). */
  segment?: Pick<Segment, 'id'>
  /** Any generation: the video shown first, when it is in the library (else the newest one). */
  generationId?: string
  /**
   * Where to start in the take shown first: its first frame (default) or its last. In a sequence's take that is
   * the first or last frame the sequence keeps after trimming.
   */
  at?: 'start' | 'end'
  onClose: () => void
  /** The frame, saved as a still (of the sequence or storyboard, if given). The dialog closes itself right after. */
  onPicked: (still: Still) => void
}

/**
 * "Bildruta ur ett klipp": pick a finished video – a take of the sequence, or any video in the library – scrub or
 * step frame by frame, and save the frame on screen as a still (saveFrameAsStill). Free: the frame is cut out
 * locally with ffmpeg.
 */
export default function FramePickerDialog(props: FramePickerDialogProps) {
  // Mounted only while open, so each opening starts on the take and frame the props point at.
  if (!props.open) return null
  return <FramePickerBody {...props} />
}

const pickButton =
  'rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40'

function FramePickerBody({
  sequenceId,
  anyGeneration = false,
  segment: wanted,
  generationId,
  at = 'start',
  onClose,
  onPicked
}: FramePickerDialogProps) {
  // The sequence's own takes, unless every video was asked for, or the id turns out not to be a sequence.
  const [library, setLibrary] = useState(anyGeneration || !sequenceId)
  const sequenceTakes = useSequenceTakes(library ? undefined : sequenceId, wanted?.id, at, () => setLibrary(true))
  const libraryTakes = useLibraryTakes(library, generationId, at)
  const source = library ? libraryTakes : sequenceTakes

  const player = useRef<PlayerHandle>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  // Takes whose video couldn't be played (the file was moved or deleted since the list was read).
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set())
  const choice = source.choice
  const unplayable = !!choice && broken.has(choice.take.id)

  const pick = async () => {
    const handle = player.current
    if (!handle || !choice || saving || unplayable) return
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

  return (
    <Modal
      title="Bildruta ur ett klipp"
      subtitle={
        library
          ? 'Välj ett klipp ur biblioteket, spola fram till rätt bildruta och använd den som bild.'
          : 'Välj en tagning, spola fram till rätt bildruta och spara den som en bild i sekvensen.'
      }
      onClose={onClose}
      maxWidth={1040}
      footer={
        <>
          {error && <p className="mr-auto max-w-lg text-[12px] text-accent select-text">{error}</p>}
          {!error && choice && !unplayable && (
            <p className="mr-auto text-[11px] text-muted">
              ← → en bildruta · Shift + ← → en sekund · Mellanslag spelar
            </p>
          )}
          <button onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Avbryt
          </button>
          <button onClick={() => void pick()} disabled={!choice || saving || unplayable} className={pickButton}>
            {saving ? 'Sparar…' : 'Använd den här bildrutan'}
          </button>
        </>
      }
    >
      {source.error ? (
        <p className="text-accent select-text">{source.error}</p>
      ) : !source.loaded ? (
        <p className="text-muted">{library ? 'Hämtar klippen…' : 'Hämtar sekvensen…'}</p>
      ) : source.empty ? (
        <p className="py-10 text-center leading-relaxed text-muted">
          {library ? 'Det finns inga färdiga klipp i biblioteket än.' : 'Ingen tagning i sekvensen är klar än.'}
          <br />
          {library
            ? 'När en video är klar under Generera kan du ta en bildruta ur den här.'
            : 'När ett klipp har en färdig tagning kan du ta en bildruta ur den här.'}
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-[236px_minmax(0,1fr)]">
          {library ? (
            <LibraryChooser takes={libraryTakes.takes} current={choice?.take.id} onChoose={libraryTakes.choose} />
          ) : (
            <TakeChooser clips={sequenceTakes.clips} current={choice?.take.id} onChoose={sequenceTakes.choose} />
          )}
          {choice ? (
            <FramePlayer
              key={choice.take.id}
              ref={player}
              choice={choice}
              onBroken={() => setBroken((s) => new Set(s).add(choice.take.id))}
            />
          ) : (
            <div />
          )}
        </div>
      )}
    </Modal>
  )
}

/** What a chooser offers and which of it is on screen. */
interface TakeSource {
  loaded: boolean
  error?: string
  /** Loaded, but nothing to take a frame from. */
  empty: boolean
  choice?: FrameChoice
  choose: (takeId: string) => void
}

/**
 * The finished takes of a sequence's clips, kept up to date while the dialog is open. Calls `onNotSequence` (and
 * stays empty) when the id can't be loaded as a sequence, so the dialog can offer the whole library instead.
 */
function useSequenceTakes(
  sequenceId: string | undefined,
  wantedSegmentId: string | undefined,
  at: 'start' | 'end',
  onNotSequence: () => void
): TakeSource & { clips: ClipGroup[] } {
  const [sequence, setSequence] = useState<Sequence>()
  const fallback = useRef(onNotSequence)
  useEffect(() => {
    fallback.current = onNotSequence
  })

  useEffect(() => {
    if (!sequenceId) return
    let active = true
    let latest = 0
    const load = () => {
      const n = ++latest
      window.studio.getSequence(sequenceId).then(
        (s) => active && n === latest && setSequence(s),
        // Not a sequence (a storyboard, or deleted meanwhile): every finished video is a fine thing to offer.
        () => active && n === latest && fallback.current()
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
    () => (sequence ? clipChoices(sequence, wantedSegmentId, at) : []),
    [sequence, wantedSegmentId, at]
  )
  const all = useMemo(() => clips.flatMap((c) => c.choices), [clips])

  const [takeId, setTakeId] = useState<string>()
  // The first choice once the sequence has loaded: the asked-for clip's take in the cut, else the first clip with one.
  useEffect(() => {
    if (takeId) return
    const first = firstClipChoice(clips, wantedSegmentId)
    if (first) setTakeId(first.take.id)
  }, [clips, takeId])
  const choice = all.find((c) => c.take.id === takeId)
  // The take was deleted meanwhile: fall back to another.
  useEffect(() => {
    if (takeId && sequence && !choice) setTakeId(undefined)
  }, [takeId, sequence, choice])

  return { loaded: !!sequence, empty: !!sequence && all.length === 0, choice, choose: setTakeId, clips }
}

/** Every finished video in the library, newest first, kept up to date while the dialog is open. */
function useLibraryTakes(
  enabled: boolean,
  firstId: string | undefined,
  at: 'start' | 'end'
): TakeSource & { takes: Generation[] } {
  const [takes, setTakes] = useState<Generation[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!enabled) return
    let active = true
    window.studio.listGenerations().then(
      (list) => active && setTakes(list.filter(isReadyVideo)),
      (e: unknown) => active && setError(ipcErrorMessage(e))
    )
    // A video that finishes while the dialog is open is added; one deleted elsewhere goes.
    const offUpdate = window.studio.onGenerationUpdate((g) => {
      if (!active) return
      setTakes((list) => list && withLiveUpdate(list, g))
    })
    const offDelete = window.studio.onGenerationDelete((id) => {
      if (active) setTakes((list) => list?.filter((t) => t.id !== id))
    })
    return () => {
      active = false
      offUpdate()
      offDelete()
    }
  }, [enabled])

  const [takeId, setTakeId] = useState<string>()
  // The asked-for video once the list has loaded, else the newest.
  useEffect(() => {
    if (takeId || !takes?.length) return
    setTakeId((takes.find((t) => t.id === firstId) ?? takes[0]).id)
  }, [takes, takeId])
  const take = takes?.find((t) => t.id === takeId)
  useEffect(() => {
    if (takeId && takes && !take) setTakeId(undefined)
  }, [takeId, takes, take])

  const choice = useMemo(() => take && libraryChoice(take, firstId, at), [take, firstId, at])

  return { loaded: !!takes, error, empty: !!takes && takes.length === 0, choice, choose: setTakeId, takes: takes ?? [] }
}

function TakeChooser({
  clips,
  current,
  onChoose
}: {
  clips: ClipGroup[]
  current?: string
  onChoose: (takeId: string) => void
}) {
  return (
    <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
      {clips.map(({ segment, clip, choices }) => {
        // A clip that is an own film is named by it; any other by its prompt.
        const chosen = segment.takes.find((t) => t.id === segment.selectedGenerationId)
        const label =
          chosen && !isVeniceGeneration(chosen) ? generationTitle(chosen) : plainImagePrompt(segment.params.prompt)
        return (
          <div key={segment.id}>
            <p className="mb-1 truncate text-[12px]" title={label || undefined}>
              <span className="font-medium">Klipp {clip}</span>
              {label && <span className="text-muted"> · {label}</span>}
            </p>
            {choices.length === 0 ? (
              <p className="text-[11px] text-muted">Ingen färdig tagning</p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {choices.map((c) => (
                  <TakeTile
                    key={c.take.id}
                    take={c.take}
                    current={c.take.id === current}
                    badge={c.inCut ? 'Vald' : undefined}
                    title={c.inCut ? 'Tagningen som används i sekvensen' : 'En annan tagning av klippet'}
                    onChoose={onChoose}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** What a video is called on its tile: an own film or a version by its title, a Venice clip by its prompt. */
function takeLabel(take: Generation): string {
  if (take.title?.trim()) return generationTitle(take)
  return plainImagePrompt(take.prompt || take.params.prompt || '') || 'Klipp utan prompt'
}

/** How many videos the library chooser shows before "Visa fler" (a library can hold hundreds). */
const LIBRARY_PAGE = 60

/** Every finished video in the library, newest first, with a search over the prompts. */
function LibraryChooser({
  takes,
  current,
  onChoose
}: {
  takes: Generation[]
  current?: string
  onChoose: (takeId: string) => void
}) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [limit, setLimit] = useState(LIBRARY_PAGE)
  useEffect(() => setLimit(LIBRARY_PAGE), [deferred])
  // The same search as the clip feed's: every word in the prompt (or negative prompt, or an own clip's name), letter
  // case ignored.
  const found = useMemo(() => queryGenerations(takes, { query: deferred, sort: 'newest' }), [takes, deferred])
  const shown = found.slice(0, limit)

  return (
    <div className="flex max-h-[62vh] min-h-0 flex-col">
      <input
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Sök i prompter och namn"
        aria-label="Sök bland klippen"
        spellCheck={false}
        className="mb-2 w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
      />
      <p className="mb-1.5 text-[11px] text-muted" aria-live="polite">
        {deferred.trim() ? `${found.length} klipp hittades` : `${takes.length} klipp, nyast först`}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {found.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-muted">
            Inget klipp har de orden i prompten eller namnet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {shown.map((take) => (
              <TakeTile
                key={take.id}
                take={take}
                current={take.id === current}
                title={takeLabel(take)}
                onChoose={onChoose}
              />
            ))}
          </div>
        )}
        {found.length > shown.length && (
          <button
            onClick={() => setLimit((n) => n + LIBRARY_PAGE)}
            className="mt-2 w-full rounded-md border border-line px-2 py-1.5 text-[12px] text-muted transition hover:bg-raised hover:text-text"
          >
            Visa fler ({found.length - shown.length})
          </button>
        )}
      </div>
    </div>
  )
}

function TakeTile({
  take,
  current,
  badge,
  title,
  onChoose
}: {
  take: Generation
  current: boolean
  badge?: string
  title: string
  onChoose: (takeId: string) => void
}) {
  return (
    <button
      onClick={() => onChoose(take.id)}
      title={title}
      aria-label={title}
      aria-pressed={current}
      className={`relative aspect-video overflow-hidden rounded bg-black transition ${
        current ? 'ring-2 ring-accent' : 'opacity-80 hover:opacity-100'
      }`}
    >
      {take.thumbPath && (
        <img
          src={mediaUrl(take.thumbPath)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}
      {badge && (
        <span className="absolute left-1 top-1 rounded bg-accent px-1 text-[9px] font-medium text-white">{badge}</span>
      )}
      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] text-white/90">
        {takeTime(take.createdAt)}
      </span>
    </button>
  )
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
  onBroken,
  ref
}: {
  choice: FrameChoice
  /** The video can't be played (its file is gone): nothing can be taken from it. */
  onBroken: () => void
  ref: Ref<PlayerHandle>
}) {
  const { take, inCut, trimStart, trimEnd, startAt } = choice
  const video = useRef<HTMLVideoElement>(null)
  const [measured, setMeasured] = useState<number>()
  const [broken, setBroken] = useState(false)
  const duration = take.videoDuration ?? measured ?? durationSeconds(take.params.duration)
  // The part of the take the sequence uses; trims only apply to the take in the cut.
  const usedStart = inCut ? Math.min(trimStart, Math.max(0, duration - 0.05)) : 0
  const usedEnd = inCut ? Math.max(usedStart, duration - trimEnd) : duration

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
  const outside = inCut && (shown < usedStart - 0.0005 || shown >= usedEnd - 0.0005)

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
          const end = inCut ? Math.max(0, d - trimEnd) : d
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
        onError={() => {
          // The list said the file was there, but it was moved or deleted since (e.g. in Finder).
          setBroken(true)
          onBroken()
        }}
        className="aspect-video max-h-[50vh] w-full cursor-pointer rounded-lg bg-black object-contain"
      />
      {broken && (
        <p className="mt-2 text-[12px] text-accent select-text">
          Videon kunde inte spelas – filen finns inte kvar där Studio har den. Välj ett annat klipp.
        </p>
      )}

      <ScrubBar
        duration={duration}
        time={shown}
        usedStart={usedStart}
        usedEnd={usedEnd}
        onSeek={(t) => {
          video.current?.pause()
          seekTo(t)
        }}
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          onClick={jumpFirst}
          className={control}
          title={inCut ? 'Första bildrutan som används (Home)' : 'Första bildrutan (Home)'}
        >
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
        <button
          onClick={jumpLast}
          className={control}
          title={inCut ? 'Sista bildrutan som används (End)' : 'Sista bildrutan (End)'}
        >
          ⇥
        </button>
        <span className="ml-auto text-right text-[12px] tabular-nums text-muted">
          <span className="text-text">{formatFrameTime(shown)}</span> av {formatFrameTime(duration)}
          {frameNumber !== undefined && ` · bildruta ${frameNumber}`}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted select-text">
        {choice.caption}
        {inCut && (trimStart > 0 || trimEnd > 0) && ' Randade delar är bortklippta i sekvensen.'}
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
