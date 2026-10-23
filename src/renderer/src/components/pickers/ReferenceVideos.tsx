import { useEffect, useRef, useState, type DragEvent, type Ref, type RefObject } from 'react'
import type { ReferenceVideoLimits } from '@shared/models'
import ClipWindowTrack from '../assets/ClipWindowTrack'
import { formatDuration, formatPosition, type ClipWindow } from '../assets/audioUtils'
import { VIDEO_TONE } from './assetKinds'
import Popover from './Popover'
import ReferenceVideoDialog, { type VideoSourceTab } from './ReferenceVideoDialog'
import { occurrenceKeys, reorderHint, useReorder } from './useReorder'
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

/** Whether a file on disk is a video a reference video can be made from (by its name). */
export const isVideoFile = (path: string): boolean => VIDEO_EXT.test(path)

/**
 * Video files from disk as candidates for the form: measured first (their length decides the window); the note says
 * what couldn't be used (not a video, unreadable). Also used for videos dropped on the reference images.
 */
export async function videoFilesAsCandidates(paths: string[]): Promise<{ candidates: VideoCandidate[]; note?: string }> {
  const files = paths.filter(isVideoFile)
  if (!files.length) {
    return { candidates: [], note: paths.length ? 'Only video files (MP4 or MOV) can be reference videos.' : undefined }
  }
  let measured: Map<string, VideoFacts>
  try {
    measured = await measureVideos(files)
  } catch {
    return { candidates: [], note: 'The videos couldn’t be read.' }
  }
  const unreadable = files.filter((p) => measured.get(p)?.error)
  return {
    candidates: files
      .filter((p) => !measured.get(p)?.error)
      .map((p) => ({ path: p, duration: measured.get(p)?.duration })),
    note: unreadable.length ? measured.get(unreadable[0])?.error : undefined
  }
}

/** How a row of videos speaks: a form's reference videos (@VideoN), or a director's style videos. */
export interface VideoRowWording {
  title: string
  /** The badge on a tile that is sent ("@Video2", "Style 2"); 1-based. */
  badge: (n: number) => string
  addTitle: string
  /** Under the tiles once there are some; none when the tiles say enough (a form's, whose prompt names them). */
  hint?: string
  /** Under the empty row: what the videos are for (the limits follow); none: the limits are the ＋ Video tooltip. */
  empty?: string
}

/** A form's reference videos: the tiles, the "@" menu and the reference list under the prompt explain them. */
export const REFERENCE_VIDEO_WORDING: VideoRowWording = {
  title: 'Reference videos',
  badge: (n) => `@Video${n}`,
  addTitle: 'Add a video whose motion, camera or style the clip follows'
}

interface Props {
  /** How the row speaks; a form's reference videos when left out. */
  wording?: VideoRowWording
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
  /**
   * Without videos, only the header row (title and ＋ Video), which takes dropped files too: an optional part of a
   * long form (Generate's). Left out, the empty row and its explanation show (a director's style videos).
   */
  collapsedWhenEmpty?: boolean
}

const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'

/**
 * The form's reference videos as tiles: each one's first frame (it plays its window while hovered), its @VideoN
 * badge, the length that is sent and ✕. A click opens the window editor (which part is sent); a drag or ⌥← / ⌥→
 * puts it in another place, and the prompt's @VideoN tokens follow. Videos come from Media, a sequence's takes, the
 * exported films or a file (picked or dropped). Under the tiles: the family's limits, live (and in the ＋ Video
 * tooltip, which is all an empty row says with collapsedWhenEmpty).
 */
export default function ReferenceVideos({
  wording = REFERENCE_VIDEO_WORDING,
  videos,
  limits,
  onAdd,
  onRemove,
  onMove,
  onWindow,
  sequenceId,
  fits,
  note,
  onNote,
  collapsedWhenEmpty = false
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
        ? `${name} moved to place ${to + 1} and is now ${wording.badge(to + 1)}.`
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
    const { candidates, note } = await videoFilesAsCandidates(paths)
    if (candidates.length) onAdd(candidates)
    if (note) onNote(note)
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
  const collapsed = collapsedWhenEmpty && !videos.length
  const limitsText =
    limits &&
    `${limits.family} takes up to ${videoCount(limits.maxVideos)}, ${perVideoText(limits)}, ` +
      `${limits.maxTotalSeconds} s together. Video seconds raise the price.`

  return (
    // Collapsed, the header row is the drop target (the tiles' row isn't there).
    <div
      onDragOver={collapsed ? onDragOver : undefined}
      onDragLeave={
        collapsed
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
            }
          : undefined
      }
      onDrop={collapsed ? onDrop : undefined}
      className={collapsed ? `-m-1 rounded-md p-1 transition ${over ? 'bg-accent/5 ring-1 ring-accent' : ''}` : undefined}
    >
      <div className={`flex items-center justify-between gap-2 ${collapsed ? '' : 'mb-1.5'}`}>
        <span className="text-muted">{wording.title}</span>
        {limits && (
          <button
            ref={addButton}
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={full}
            className={`${smallButton} ${menuOpen ? 'bg-raised text-text' : ''}`}
            title={
              full
                ? `${limits.family} takes at most ${videoCount(max)}`
                : `${wording.addTitle} (or drop one on the row) – ${limitsText}`
            }
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

      {!collapsed && (
        <div
          role="list"
          aria-label={`${wording.title}${reorder.enabled ? ` – ${reorderHint()}` : ''}`}
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
                  `${isSent ? wording.badge(at + 1) : 'Not sent'}: ${label}, ${formatPosition(v.start)}–${formatPosition(v.start + v.length)}. ` +
                  `Enter chooses the part that is sent${reorder.enabled ? `; ${reorderHint()}.` : '.'}`
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
                    ? `${label} – click to choose the part that is sent${reorder.enabled ? `, ${reorderHint()}` : ''}`
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
                    <span className={`shrink-0 tabular-nums ${wrong ? 'text-danger' : ''}`}>{videoLengthText(v.length)}</span>
                  </span>
                </div>
                {isSent ? (
                  <span className={`absolute left-1 top-1 rounded px-1 text-[10px] ${renamed ? 'bg-text text-bg' : `bg-black/70 ${VIDEO_TONE.text}`}`}>
                    {wording.badge(at + 1)}
                  </span>
                ) : (
                  <span className="absolute left-1 top-1 rounded bg-black/80 px-1 text-[9px] leading-[14px] text-danger">not sent</span>
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
              {videos.length ? '+' : 'Drop a video here or click'}
            </button>
          )}
          {!limits && !videos.length && <span className="px-1 text-[11px] text-muted">No reference videos.</span>}
        </div>
      )}

      {videos.length > 0 && limits && (
        <div className="mt-1.5 flex items-start justify-end gap-3 text-[11px] text-muted">
          {wording.hint && <span className="min-w-0 flex-1">{wording.hint}</span>}
          <span
            className={`shrink-0 tabular-nums ${problems.count || problems.total ? 'text-danger' : ''}`}
            title={
              `${videos.length} of at most ${videoCount(limits.maxVideos)}, ${videoLengthText(seconds)} of at most ` +
              `${limits.maxTotalSeconds} s together. ${limits.family} takes ${perVideoText(limits)}. Video seconds raise the price.`
            }
          >
            {videos.length}/{limits.maxVideos} · {videoLengthText(seconds).replace(/ s$/, '')}/{limits.maxTotalSeconds} s
          </span>
        </div>
      )}
      {!videos.length && !collapsed && limits && wording.empty && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          {wording.empty} – {limitsText}
        </p>
      )}
      {(problems.count || problems.total || problems.lengths.length > 0) && (
        <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-danger">
          {problems.lengths.map((p) => (
            <li key={p.index}>{p.message}</li>
          ))}
          {problems.total && <li>{problems.total}</li>}
          {problems.count && <li>{problems.count}</li>}
        </ul>
      )}
      {note && <p className="mt-1 text-[11px] text-warning">{note}</p>}
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>

      <WindowEditor
        anchorRef={editAnchor}
        badge={edited ? wording.badge(edited.index) : ''}
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
  badge,
  video,
  limits,
  onClose,
  onChange
}: {
  anchorRef: RefObject<HTMLElement | null>
  /** "@Video2", "Style 2". */
  badge: string
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
          <span className={`shrink-0 font-medium ${VIDEO_TONE.text}`}>{badge}</span>
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
