import { useEffect, useId, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { supportsAudioInput } from '@shared/models'
import {
  lyricsInWindow,
  MAX_SONG_WINDOW_SECONDS,
  MIN_SONG_WINDOW_SECONDS,
  songClipDuration,
  windowLength
} from '@shared/song-window'
import { shortTakeNote, songCut, songTrimBase } from '@shared/song-trims'
import type { Generation, GenerationParams, Segment, Sequence, SongPart, VideoModel } from '@shared/types'
import { ipcErrorMessage, useAssets } from '../../../lib/hooks'
import { assetsByPath } from '../../pickers/assetRefs'
import { MIN_CLIP_SECONDS, patchSegmentLocally, takeDuration } from '../sequenceUtils'
import type { SequenceStore } from '../useSequence'
import { durationText, offsetText, PART_HINT, PART_LABEL, placeText, songSeconds, syncState } from './songText'

interface Props {
  sequence: Sequence
  /** The clip as main has it (its place, trims and syncs). */
  segment: Segment
  /** The clip's params as its editor holds them (the draft), and how to change them. */
  params: GenerationParams
  setParams: Dispatch<SetStateAction<GenerationParams>>
  /** The reference images the clip sends (its own or those it carries), for Who sings. */
  referenceImages: readonly string[]
  /** The model the take is sent with. */
  sentModel: string
  models: VideoModel[]
  /** The selected take, finished with its file. */
  take?: Generation
  store: SequenceStore
}

const PARTS: SongPart[] = ['vocals', 'mix', 'none']
/** Most of Venice's video models make 24 frames a second; the take's own rate is read from its file. */
const DEFAULT_FPS = 24

const nudgeButton =
  'px-1 py-1 text-[11px] tabular-nums text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * Who sings, in view and focused: the prompt checks' "Choose who sings" (the singer isn't among the clip's pictures).
 * Only the editor's own pane scrolls (scrollIntoView would move the window's fixed panes too).
 */
export function revealWhoSings(): void {
  const el = document.querySelector<HTMLSelectElement>('[data-song-singer]')
  if (!el) return
  el.focus({ preventScroll: true })
  let pane = el.parentElement
  while (pane && !['auto', 'scroll'].includes(getComputedStyle(pane).overflowY)) pane = pane.parentElement
  if (pane) pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 3
}

/**
 * A song clip's place in the song and what it does with it: the words sung there, What the clip hears, Who sings,
 * the automatic duration, and – once a take is chosen – where its singing sits against the song (In sync, No singing
 * found) with nudges by a frame or a tenth of a second.
 */
export default function SongBox({
  sequence,
  segment,
  params,
  setParams,
  referenceImages,
  sentModel,
  models,
  take,
  store
}: Props) {
  const song = sequence.song!
  // The place as main has it (the strip changes it); what the clip hears and who sings as the editor has them.
  const place = segment.params.song ?? params.song
  const draftSong = params.song ?? place
  const part: SongPart = draftSong?.part ?? 'vocals'
  const groupName = useId()

  const assets = useAssets()
  const singers = useMemo(() => {
    const byPath = assetsByPath(assets)
    const seen = new Map<string, string>()
    for (const path of referenceImages) {
      const a = byPath.get(path)
      if (a?.kind === 'character' && !seen.has(a.id)) seen.set(a.id, a.name)
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [assets, referenceImages])

  const length = place ? windowLength(place) : 0
  const model = models.find((m) => m.id === params.model)
  const wanted = place ? songClipDuration(model?.durations, length) : undefined

  // The duration follows the place and the model: the shortest the model offers that holds the place and a second
  // more (main does the same when places change; a model picked here is the editor's to follow).
  useEffect(() => {
    if (!model || !wanted || params.duration === wanted) return
    setParams((p) => (p.song ? { ...p, duration: wanted } : p))
  }, [model?.id, wanted])

  if (!place) return null

  const setSong = (patch: { part?: SongPart; singer?: string | null }) =>
    setParams((p) => {
      const base = p.song ?? place
      const next = { ...base, start: place.start, end: place.end, ...patch }
      if ('singer' in patch && patch.singer === undefined) delete next.singer
      return { ...p, song: next }
    })

  const words = lyricsInWindow(song.lyrics, place.start, place.end)
  const singer = draftSong?.singer
  const firstSinger = singers[0]
  const hears = part !== 'none' && !supportsAudioInput(sentModel)

  return (
    <section aria-label="Place in the song" className="mb-4 rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="shrink-0 font-medium">Place in the song</h3>
        <span className="ml-auto truncate text-[12px] tabular-nums text-muted" title="Change it in the song strip">
          {placeText(place)}
        </span>
      </div>
      <p className={`mt-1 text-[12px] leading-snug ${words ? 'text-text/90' : 'text-muted'}`}>
        {words
          ? `“${words}”`
          : song.lyrics
            ? 'No words are sung here.'
            : 'No lyrics yet – transcribe them in the song strip to see the words sung here.'}
      </p>

      <fieldset className="mt-3">
        <legend className="mb-1.5 text-[12px] text-muted">What the clip hears</legend>
        <div role="radiogroup" aria-label="What the clip hears" className="space-y-1">
          {PARTS.map((p) => (
            <label key={p} className="flex cursor-pointer items-start gap-2" title={PART_HINT[p]}>
              <input
                type="radio"
                name={groupName}
                checked={part === p}
                onChange={() => setSong({ part: p })}
                className="mt-0.5 accent-accent"
              />
              <span className="min-w-0">
                <span className="text-[12px]">{PART_LABEL[p]}</span>
                {part === p && <span className="block text-[11px] leading-snug text-muted">{PART_HINT[p]}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {part === 'vocals' && (
        <label className="mt-3 flex items-center gap-2 text-[12px]">
          <span className="shrink-0 text-muted">Who sings</span>
          <select
            data-song-singer
            value={singer === null ? 'nobody' : (singer ?? '')}
            onChange={(e) => {
              const v = e.target.value
              setSong({ singer: v === 'nobody' ? null : v || undefined })
            }}
            className="min-w-0 flex-1 rounded border border-line bg-raised px-1.5 py-1 text-[12px] outline-none focus:border-muted"
          >
            <option value="">{firstSinger ? `${firstSinger.name} (the first character)` : 'The first character'}</option>
            {singers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {singer && !singers.some((c) => c.id === singer) && (
              <option value={singer}>A character not in the clip</option>
            )}
            <option value="nobody">Nobody on screen</option>
          </select>
        </label>
      )}
      {part === 'vocals' && !singers.length && singer !== null && (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          The clip has no character among its references yet – add one (or set the cast) for someone to sing.
        </p>
      )}

      <p className="mt-3 text-[11px] text-muted" title="Set by the place in the song and the model">
        Duration: {durationText(wanted ?? params.duration, place)}
      </p>

      {hears && (
        <Note>
          This model can't hear the song: choose Seedance 2.5 R2V or set What the clip hears to No song.
        </Note>
      )}
      {part !== 'none' && length < MIN_SONG_WINDOW_SECONDS && (
        <Note>
          The place is {songSeconds(length)}: at least {MIN_SONG_WINDOW_SECONDS} s are needed to send the song. Move a
          boundary in the song strip, or set No song.
        </Note>
      )}
      {part !== 'none' && length > MAX_SONG_WINDOW_SECONDS && (
        <Note>Only the first {MAX_SONG_WINDOW_SECONDS} s of the place are sent; the take still fills all of it.</Note>
      )}

      {take && <TakeSync segment={segment} take={take} length={length} store={store} />}
    </section>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
      {children}
    </p>
  )
}

/**
 * Where the selected take's singing sits against the song (measured when it finished): In sync with its offset, No
 * singing found, or measuring; the nudges move where the take starts in the cut (main keeps the place's length), and
 * Measure again asks main to look again.
 */
function TakeSync({
  segment,
  take,
  length,
  store
}: {
  segment: Segment
  take: Generation
  length: number
  store: SequenceStore
}) {
  const [fps, setFps] = useState(DEFAULT_FPS)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState<string>()
  const state = syncState(segment, take)
  const takeLength = takeDuration(take)
  const start = segment.trimStart
  const latest = Math.max(0, takeLength - MIN_CLIP_SECONDS)
  const short = shortTakeNote(songCut(takeLength, start, { start: 0, end: length }).shortBy)
  // How far it was moved by hand from where the singing put it (the measurement, moved with the place since).
  const sync = segment.songSyncs?.[take.id]
  const place = segment.params.song
  const nudged = sync && place ? start - songTrimBase(sync.offset, place, take.params.song) : 0

  const path = take.filePath
  useEffect(() => {
    if (!path) return
    let current = true
    window.studio.inspectVideoFiles([path]).then(
      ([info]) => {
        if (current && info?.fps) setFps(info.fps)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [path])

  const nudge = (delta: number) => {
    // Shown at once with the end that keeps the place's length, as main cuts it (shared/song-trims.ts).
    const { trimStart, trimEnd } = songCut(takeLength, start + delta, { start: 0, end: length })
    if (Math.abs(trimStart - start) < 0.0005) return
    setError(undefined)
    store.update((s) => patchSegmentLocally(s, segment.id, { trimStart, trimEnd }))
    store.mutate(() => window.studio.updateSegment(segment.id, { trimStart })).catch((e: unknown) => {
      setError(ipcErrorMessage(e))
      store.refresh()
    })
  }

  const measure = async () => {
    setMeasuring(true)
    setError(undefined)
    try {
      await store.mutate(() => window.studio.syncSongTake(take.id))
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setMeasuring(false)
    }
  }

  const status =
    measuring || state.kind === 'measuring'
      ? { dot: 'bg-muted animate-pulse', text: 'Measuring where the singing sits…' }
      : state.kind === 'in-sync'
        ? { dot: 'bg-emerald-400', text: `In sync (${offsetText(state.sync.offset)})` }
        : state.kind === 'not-found'
          ? { dot: 'bg-amber-400', text: 'No singing found – check the lips' }
          : undefined
  const frame = 1 / fps

  return (
    <div className="mt-3 border-t border-line pt-2.5">
      {status && (
        <div className="mb-2 flex items-center gap-2 text-[12px]" role="status">
          <span className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} aria-hidden />
          <span
            className={`min-w-0 flex-1 ${state.kind === 'not-found' && !measuring ? 'text-amber-300' : ''}`}
            title={
              state.kind === 'in-sync' || state.kind === 'not-found'
                ? `Measured against the song's vocals: ${Math.round(state.sync.score * 100)}% alike`
                : undefined
            }
          >
            {status.text}
          </span>
          {/* Main measures the take against the place it was made for, when that place heard the vocals. */}
          {take.params.song?.part === 'vocals' && (
            <button
              type="button"
              onClick={() => void measure()}
              disabled={measuring}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
            >
              Measure again
            </button>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted">
        Starts <span className="tabular-nums text-text">{start.toFixed(2)} s</span> into the take
        {Math.abs(nudged) >= 0.005 && <span className="tabular-nums"> · nudged {offsetText(nudged)}</span>}
      </p>
      <div
        role="group"
        aria-label="Where the take starts in the cut"
        className="mt-1.5 grid grid-cols-4 overflow-hidden rounded-md border border-line"
      >
        {(
          [
            [-0.1, '−0.1 s', '0.1 s earlier'],
            [-frame, '−1 frame', 'One frame earlier'],
            [frame, '+1 frame', 'One frame later'],
            [0.1, '+0.1 s', '0.1 s later']
          ] as const
        ).map(([delta, label, title], i) => (
          <button
            key={label}
            type="button"
            onClick={() => nudge(delta)}
            disabled={delta < 0 ? start <= 0 : start >= latest}
            title={`${title} – the take starts there in the cut`}
            className={`${nudgeButton} ${i > 0 ? 'border-l border-line' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      {short && <p className="mt-1.5 text-[11px] leading-snug text-amber-300">{short}</p>}
      {error && <p className="mt-1.5 select-text text-[11px] leading-snug text-accent">{error}</p>}
    </div>
  )
}
