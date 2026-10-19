import { useEffect, useRef, useState, type DragEvent, type Ref, type RefObject } from 'react'
import type { ReferenceVideoLimits } from '@shared/models'
import { shortcut } from '../../lib/platform'
import ClipWindowTrack from '../assets/ClipWindowTrack'
import { formatDuration, formatPosition, type ClipWindow } from '../assets/audioUtils'
import { VIDEO_TONE } from './assetKinds'
import Popover from './Popover'
import ReferenceVideoDialog, { type VideoSourceTab } from './ReferenceVideoDialog'
import { occurrenceKeys, useReorder } from './useReorder'
import { measureVideos, rememberVideoFacts } from './videoFacts'
import {
  clampVideoWindow,
  perVideoText,
  videoCount,
  videoLabel,
  videoLabelParts,
  videoLengthText,
  videoProblems,
  videoWindowLimits,
  type FormVideo,
  type VideoCandidate,
  type VideoFacts
} from './videoRefs'
import VideoWindowPreview from './VideoWindowPreview'

/** Drag payload of a reference video tile being moved within its row (its key). */
export const REFERENCE_VIDEO_DRAG_TYPE = 'application/x-studio-reference-video'

/** The video files main reads (MP4, MOV and the like); anything else dropped is refused with a note. */
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i


interface Props {
  /** The form's reference videos, in @VideoN order (also the ones that aren't sent). */
  videos: FormVideo[]
  /** The model family's limits; undefined when the model takes no reference videos. */
  limits: ReferenceVideoLimits | undefined
  /** Adds videos (the parent gives each its window and renumbers nothing: they go at the end). */
  onAdd: (candidates: VideoCandidate[]) => void
  /** Takes the video out (1-based @VideoN number); its tokens in the prompt go. */
  onRemove: (index: number) => void
  /** Moves the video at `from` to `to` (0-based), after a drag or ⌥← / ⌥→; the prompt's tokens follow. */
  onMove: (from: number, to: number) => void
  /** Gives the video at `index` (0-based) another window. */
  onWindow: (index: number, w: ClipWindow) => void
  /** A sequence clip's sequence: the Takes tab opens on it. */
  sequenceId?: string
  /** Whether a video of this length at this path could be added now, and why not (the dialog's cards). */
  fits: (path: string, duration: number | undefined) => { fits: boolean; reason?: string }
  /** A note from the last change (what didn't fit), shown under the row. */
  note?: string
  onNote: (note: string | undefined) => void
}

const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'

/**
 * The form's reference videos as tiles: each one's first frame (it plays its window while hovered), its @VideoN
 * badge, the length that is sent and ✕. A click opens the window editor (which part is sent); a drag or ⌥← / ⌥→
 * puts it in another place, and the prompt's @VideoN tokens follow. Videos come from Media, a sequence's takes, the
 * exported films or a file (picked or dropped). Under the tiles: the family's limits, live.
 */
export default function ReferenceVideos({
  videos,
  limits,
  onAdd,
  onRemove,
  onMove,
  onWindow,
  sequenceId,
  fits,
  note,
  onNote
}: Props) {
  const addButton = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<VideoSourceTab>()
  const [over, setOver] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [hovered, setHovered] = useState<string>()
  const editAnchor = useRef<HTMLElement | null>(null)
  const keys = occurrenceKeys(videos.map((v) => v.path))
  const max = limits?.maxVideos ?? 0

  const reorder = useReorder({
    type: REFERENCE_VIDEO_DRAG_TYPE,
    keys,
    onMove,
    describeMove: (from, to) => {
      const name = videoLabel(videos[from])
      return limits && to < limits.maxVideos
        ? `${name} moved to place ${to + 1} and is now @Video${to + 1}.`
        : `${name} moved to place ${to + 1} and isn’t sent with this model.`
    }
  })
  const dragging = reorder.dragging !== -1

  // A tile that left the row (removed, or an agent changed the list) takes its editor along.
  const editIndex = editing ? keys.indexOf(editing) : -1
  useEffect(() => {
    if (editing && editIndex === -1) setEditing(undefined)
  }, [editing, editIndex])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => onNote(undefined), 8000)
    return () => clearTimeout(t)
  }, [note])

  /** Files from disk: measured first (their length decides the window), then added; others get a note. */
  const addFiles = async (paths: string[]) => {
    const files = paths.filter((p) => VIDEO_EXT.test(p))
    const refused = paths.length - files.length
    if (!files.length) {
      if (refused) onNote('Only video files (MP4 or MOV) can be reference videos.')
      return
    }
    let measured: Map<string, VideoFacts>
    try {
      measured = await measureVideos(files)
    } catch {
      onNote('The videos couldn’t be read.')
      return
    }
    const unreadable = files.filter((p) => measured.get(p)?.error)
    onAdd(
      files
        .filter((p) => !measured.get(p)?.error)
        .map((p) => ({ path: p, duration: measured.get(p)?.duration }))
    )
    if (unreadable.length) onNote(measured.get(unreadable[0])?.error)
  }

  const pickFile = async () => {
    setMenuOpen(false)
    const paths = await window.studio.pickVideos(true).catch(() => [] as string[])
    if (paths.length) await addFiles(paths)
  }

  const carriesFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')
  const onDragOver = (e: DragEvent) => {
    if (reorder.onDragOver(e)) return
    if (!carriesFiles(e) || !limits) return
    e.preventDefault()
    setOver(true)
  }
  const onDrop = (e: DragEvent) => {
    if (reorder.onDrop(e)) return
    e.preventDefault()
    setOver(false)
    if (!limits) return
    void addFiles(Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f)))
  }

  const openDialog = (tab: VideoSourceTab) => {
    setMenuOpen(false)
    setDialog(tab)
  }

  const problems = videoProblems(videos, limits)
  const sent = videos.filter((v) => v.sent)
  const seconds = Math.round(sent.reduce((sum, v) => sum + v.length, 0) * 10) / 10
  const full = !limits || videos.length >= limits.maxVideos
  const edited = editIndex === -1 ? undefined : videos[editIndex]

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-muted">Reference videos</span>
        {limits && (
          <button
            ref={addButton}
            onClick={() => setMenuOpen((o) => !o)}
            disabled={full}
            className={`${smallButton} ${menuOpen ? 'bg-raised text-text' : ''}`}
            title={full ? `${limits.family} takes at most ${videoCount(max)}` : 'Add a video whose motion, camera or style the clip follows'}
          >
            ＋ Video
          </button>
        )}
      </div>
      <Popover anchorRef={addButton} open={menuOpen} onClose={() => setMenuOpen(false)} align="end" width={240} label="Add a reference video">
        <div className="p-1 text-[12px]">
          {(
            [
              ['media', 'From Media…', 'A clip from Media: generated, your own or a version'],
              ['takes', 'A take…', 'A take of a sequence clip'],
              ['films', 'An exported film…', 'A film exported from a sequence or a storyboard']
            ] as const
          ).map(([tab, label, title]) => (
            <button
              key={tab}
              onClick={() => openDialog(tab)}
              title={title}
              className="block w-full rounded-md px-2.5 py-1.5 text-left transition hover:bg-raised"
            >
              {label}
            </button>
          ))}
          <button onClick={() => void pickFile()} className="block w-full rounded-md px-2.5 py-1.5 text-left transition hover:bg-raised">
            From a file…
          </button>
        </div>
      </Popover>

      <div
        role="list"
        aria-label={`Reference videos${reorder.enabled ? shortcut(' – drag or press ⌥← / ⌥→ on a video to change the order') : ''}`}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          reorder.onDragLeave(e)
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={onDrop}
        className={`flex flex-wrap gap-2 rounded-md border border-dashed p-2 transition ${
          over ? 'border-accent bg-accent/5' : dragging ? 'border-muted/60' : 'border-line'
        }`}
      >
        {videos.map((v, i) => {
          // While dragging, every tile shows the number (and sent state) it would have after the drop.
          const at = reorder.positions[i] ?? i
          const isSent = dragging ? !!limits && at < limits.maxVideos : v.sent
          const renamed = dragging && at !== i
          const label = videoLabel(v)
          const { name } = videoLabelParts(v)
          const wrong = problems.lengths.some((p) => p.index === v.index)
          const key = keys[i]
          const { ref, ...item } = reorder.itemProps(i)
          return (
            <div
              key={key}
              ref={ref as Ref<HTMLDivElement>}
              {...item}
              role="listitem"
              tabIndex={0}
              aria-haspopup="dialog"
              aria-expanded={editing === key}
              aria-label={
                `${isSent ? `@Video${at + 1}` : 'Not sent'}: ${label}, ${formatPosition(v.start)}–${formatPosition(v.start + v.length)}. ` +
                `Enter chooses the part that is sent${reorder.enabled ? shortcut(', ⌥← and ⌥→ move it.') : '.'}`
              }
              onMouseEnter={() => setHovered(key)}
              onMouseLeave={() => setHovered((h) => (h === key ? undefined : h))}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) return
                editAnchor.current = e.currentTarget
                setEditing((cur) => (cur === key ? undefined : key))
              }}
              onKeyDown={(e) => {
                item.onKeyDown?.(e)
                if (e.defaultPrevented || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                editAnchor.current = e.currentTarget
                setEditing((cur) => (cur === key ? undefined : key))
              }}
              title={
                isSent
                  ? `${label} – click to choose the part that is sent${reorder.enabled ? shortcut(', drag to move (⌥← / ⌥→)') : ''}`
                  : limits
                    ? `Not sent – ${limits.family} takes at most ${videoCount(limits.maxVideos)}`
                    : 'Not sent with this model'
              }
              className={`group relative aspect-video w-28 shrink-0 rounded bg-raised outline-none ring-offset-2 ring-offset-panel transition focus-visible:ring-2 focus-visible:ring-muted ${
                reorder.enabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
              } ${editing === key ? 'ring-2 ring-text' : wrong ? 'ring-1 ring-accent' : ''} ${reorder.dragging === i ? 'opacity-30' : ''}`}
            >
              <div className="absolute inset-0 overflow-hidden rounded">
                <div className={`h-full w-full ${isSent ? '' : 'opacity-40'}`}>
                  <VideoWindowPreview
                    path={v.path}
                    start={v.start}
                    length={v.length}
                    playing={hovered === key && !dragging && editing !== key}
                    onDuration={(d) => v.facts?.duration === undefined && rememberVideoFacts(v.path, { duration: d })}
                  />
                </div>
                <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-1 pb-0.5 pt-2 text-[10px] text-white">
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className={`shrink-0 tabular-nums ${wrong ? 'text-red-300' : ''}`}>{videoLengthText(v.length)}</span>
                </span>
              </div>
              {isSent ? (
                <span className={`absolute left-1 top-1 rounded px-1 text-[10px] ${renamed ? 'bg-text text-bg' : `bg-black/70 ${VIDEO_TONE.text}`}`}>
                  @Video{at + 1}
                </span>
              ) : (
                <span className="absolute left-1 top-1 rounded bg-black/80 px-1 text-[9px] leading-[14px] text-accent">not sent</span>
              )}
              <button
                onClick={() => {
                  if (editing === key) setEditing(undefined)
                  onRemove(v.index)
                }}
                draggable={false}
                className={`pointer-events-none absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] opacity-0 outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-text ${
                  dragging ? '' : 'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:opacity-100'
                }`}
                title="Remove"
                aria-label={`Remove ${label}`}
              >
                ✕
              </button>
              {reorder.gap === i && <DropMarker side="before" />}
              {reorder.gap === videos.length && i === videos.length - 1 && <DropMarker side="after" />}
            </div>
          )
        })}
        {limits && !full && (
          <button
            onClick={() => setMenuOpen(true)}
            className="flex h-[63px] min-w-16 flex-1 items-center justify-center rounded px-2 text-center text-[11px] text-muted hover:bg-raised hover:text-text"
          >
            {videos.length ? '+' : 'Drop a video here, or add one from Media, a take or a film'}
          </button>
        )}
        {!limits && !videos.length && <span className="px-1 text-[11px] text-muted">No reference videos.</span>}
      </div>

      {videos.length > 0 && limits && (
        <div className="mt-1.5 flex items-start gap-3 text-[11px] text-muted">
          <span className="min-w-0 flex-1">
            Hover a video to play the part that is sent – click it to choose the part. Refer to it as @Video1 … in the prompt.
          </span>
          <span
            className={`shrink-0 tabular-nums ${problems.count || problems.total ? 'text-accent' : ''}`}
            title={
              `${videos.length} of at most ${videoCount(limits.maxVideos)}, ${videoLengthText(seconds)} of at most ` +
              `${limits.maxTotalSeconds} s together. ${limits.family} takes ${perVideoText(limits)}. Video seconds raise the price.`
            }
          >
            {videos.length}/{limits.maxVideos} · {videoLengthText(seconds).replace(/ s$/, '')}/{limits.maxTotalSeconds} s
          </span>
        </div>
      )}
      {!videos.length && limits && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          A video as a reference for the motion, the camera or the style – {limits.family} takes up to{' '}
          {videoCount(limits.maxVideos)}, {perVideoText(limits)}, {limits.maxTotalSeconds} s together. Video seconds raise
          the price.
        </p>
      )}
      {(problems.count || problems.total || problems.lengths.length > 0) && (
        <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-accent">
          {problems.lengths.map((p) => (
            <li key={p.index}>{p.message}</li>
          ))}
          {problems.total && <li>{problems.total}</li>}
          {problems.count && <li>{problems.count}</li>}
        </ul>
      )}
      {note && <p className="mt-1 text-[11px] text-accent">{note}</p>}
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>

      <WindowEditor
        anchorRef={editAnchor}
        video={edited}
        limits={limits}
        onClose={() => setEditing(undefined)}
        onChange={(w) => editIndex !== -1 && onWindow(editIndex, w)}
      />

      {dialog && (
        <ReferenceVideoDialog
          open
          tab={dialog}
          sequenceId={sequenceId}
          fits={fits}
          onClose={() => setDialog(undefined)}
          onPick={(candidate, facts) => {
            rememberVideoFacts(candidate.path, facts)
            setDialog(undefined)
            onAdd([candidate])
          }}
        />
      )}
    </div>
  )
}

/**
 * Which part of a reference video is sent: the video at the playhead, the whole file as a bar with the window on it
 * (drag the window or its edges, click to move the playhead; ←/→ from the keyboard) and a button that plays the part.
 * The window keeps to the family's per-video range and inside the file; every change goes into the form at once.
 */
function WindowEditor({
  anchorRef,
  video,
  limits,
  onClose,
  onChange
}: {
  anchorRef: RefObject<HTMLElement | null>
  video: FormVideo | undefined
  limits: ReferenceVideoLimits | undefined
  onClose: () => void
  onChange: (w: ClipWindow) => void
}) {
  const [draft, setDraft] = useState<ClipWindow>()
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState<number>()
  const [measured, setMeasured] = useState<number>()
  const path = video?.path
  useEffect(() => {
    setDraft(undefined)
    setPlaying(false)
    setPlayhead(undefined)
    setMeasured(undefined)
  }, [path])

  const duration = video?.facts?.duration ?? measured
  const w = draft ?? (video ? { start: video.start, length: video.length } : { start: 0, length: 0 })
  const range = videoWindowLimits(limits)
  const commit = (next: ClipWindow) => {
    setDraft(undefined)
    onChange(next)
  }

  let body = null
  if (video) {
    body = (
      <div className="p-3">
        <p className="mb-2 flex items-baseline gap-2 text-[12px]">
          <span className={`shrink-0 font-medium ${VIDEO_TONE.text}`}>@Video{video.index}</span>
          <span className="min-w-0 flex-1 truncate">{videoLabel(video)}</span>
        </p>
        <div className="relative mb-2.5 aspect-video overflow-hidden rounded-md bg-black">
          <VideoWindowPreview
            path={video.path}
            start={w.start}
            length={w.length}
            playing={playing}
            sound
            at={playhead}
            onTime={setPlayhead}
            onDuration={(d) => {
              setMeasured(d)
              if (video.facts?.duration === undefined) rememberVideoFacts(video.path, { duration: d })
            }}
            className="h-full w-full object-contain"
          />
        </div>
        {duration ? (
          <ClipWindowTrack
            duration={duration}
            window={w}
            playhead={playhead}
            limits={range}
            onSeek={(t) => {
              setPlaying(false)
              setPlayhead(t)
            }}
            onBegin={() => setPlaying(false)}
            onPreview={setDraft}
            onEnd={() => setDraft(undefined)}
            onChange={(next) => commit(next)}
          />
        ) : (
          <p className="text-[11px] text-muted">Reading the video’s length…</p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="rounded-md border border-line px-3 py-1 text-[12px] transition hover:bg-raised"
          >
            {playing ? 'Stop' : 'Play the part'}
          </button>
          {duration !== undefined && (
            <>
              <button
                type="button"
                disabled={playhead === undefined}
                onClick={() => playhead !== undefined && commit(clampVideoWindow({ start: playhead, length: w.length }, duration, limits))}
                title={playhead === undefined ? 'Play or click in the bar first' : 'Start the part at the playhead'}
                className="rounded-md border border-line px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
              >
                Start here
              </button>
              <button
                type="button"
                onClick={() => commit(clampVideoWindow({ start: 0, length: Math.min(duration, range.max) }, duration, limits))}
                title={`As much of the video as one reference may be (${range.max} s)`}
                className="rounded-md border border-line px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text"
              >
                {duration <= range.max ? 'Whole video' : `First ${range.max} s`}
              </button>
            </>
          )}
          <button type="button" onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-[12px] text-muted hover:text-text">
            Done
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted">
          {duration !== undefined && `The video is ${formatDuration(duration)}. `}
          {limits ? `${limits.family} takes ${perVideoText(limits)}, ${limits.maxTotalSeconds} s together.` : 'This model takes no reference videos.'}
        </p>
      </div>
    )
  }
  return (
    <Popover anchorRef={anchorRef} open={!!video} onClose={onClose} width={360} maxHeight={520} label="The part of the video that is sent">
      {body}
    </Popover>
  )
}

/** The insertion marker in the gap before (or after) a tile, centred in the 8 px gap. */
function DropMarker({ side }: { side: 'before' | 'after' }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute -inset-y-1 w-0.5 rounded-full bg-accent ${side === 'before' ? '-left-[5px]' : '-right-[5px]'}`}
    />
  )
}
