import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { workKey, type ExportSummary } from '@shared/types'
import { useViewerKeys } from '../../lib/dialogs'
import { focusedWithKeyboard, refocused } from '../../lib/focusOrigin'
import { mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { FILE_MANAGER } from '../../lib/platform'
import { nativeVideoControls } from '../../lib/video'
import { markSeen, useIsUnseen } from '../../lib/work'
import { fileName } from '../editor/editorUtils'
import { formatTotalLength } from '../feed/feedText'
import { ScissorsIcon } from '../feed/icons'
import { FilmIcon } from '../icons'
import { formatStillTime } from '../images/imageModels'
import { PlayIcon } from '../sequences/icons'
import EmptyState from '../ui/EmptyState'
import ViewerNavButton from '../ui/ViewerNavButton'
import { NewChip } from '../work/StatusMark'
import { CountLine, MEDIA_CAPTION, MEDIA_CARD, MediaToolbar, NoticeRow } from './ui'

// Films: every film exported from a sequence or a storyboard, newest first, as cards with the film's first frame.
// A film plays in a player over the window, with the way on to the Editor, its sequence or storyboard, and the file
// manager; it has the image viewer's keys (Esc, ← →) and Space to play. Films aren't deleted here.

interface OpenRequest {
  exportId: string
  source?: 'agent'
}

interface Props {
  /** Media's tabs, at the start of the header. */
  tabs: ReactNode
  navigate: Navigate
  /** Open this film in the player; `source: 'agent'` neither plays it nor marks it seen. */
  openRequest?: OpenRequest
  onOpenRequestHandled: () => void
}

/**
 * The exported films, newest first, kept current: a finished export adds one, a renamed or deleted sequence or
 * storyboard changes its name, and coming back to the window notices a file removed in Finder.
 */
function useExports(): { exports: ExportSummary[]; loaded: boolean; reload: () => Promise<ExportSummary[]> } {
  const [state, setState] = useState<{ exports: ExportSummary[]; loaded: boolean }>({ exports: [], loaded: false })
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const n = ++latest.current
    try {
      const list = [...(await window.studio.listExports())].sort((a, b) => b.createdAt - a.createdAt)
      if (n === latest.current) setState({ exports: list, loaded: true })
      return list
    } catch {
      if (n === latest.current) setState((s) => ({ ...s, loaded: true }))
      return []
    }
  }, [])
  useEffect(() => {
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 200)
    }
    const offExport = window.studio.onExportProgress((p) => p.done && soon())
    const offSequence = window.studio.onSequenceChange(soon)
    const offStoryboard = window.studio.onStoryboardChange(soon)
    window.addEventListener('focus', soon)
    return () => {
      clearTimeout(timer)
      offExport()
      offSequence()
      offStoryboard()
      window.removeEventListener('focus', soon)
    }
  }, [reload])
  return { ...state, reload }
}

function filmsText(n: number): string {
  return n === 1 ? '1 film' : `${n} films`
}

function filmName(e: ExportSummary): string {
  return e.sequenceName ?? fileName(e.path)
}

const KIND_LABEL = { sequence: 'Sequence', storyboard: 'Storyboard' } as const

/** "8 Oct 14:02 · 1 min 24 s · 6 clips": lengths written as everywhere in Media. */
function filmFacts(e: ExportSummary): string[] {
  return [
    formatStillTime(e.createdAt),
    e.duration !== undefined ? formatTotalLength(e.duration) : undefined,
    e.cuts ? `${e.cuts.length + 1} ${e.cuts.length ? 'clips' : 'clip'}` : undefined
  ].filter((f): f is string => !!f)
}

export default function FilmsTab({ tabs, navigate, openRequest, onOpenRequestHandled }: Props) {
  const { exports, loaded, reload } = useExports()
  const [notice, setNotice] = useState<string>()
  const [opened, setOpened] = useState<{ id: string; byAgent: boolean }>()

  // Activity or an agent showing a film: it opens in the player. One that just finished may not be listed
  // yet, so the list is read once more before it counts as gone.
  const handled = useRef<OpenRequest>(undefined)
  useEffect(() => {
    if (!openRequest || !loaded || handled.current === openRequest) return
    handled.current = openRequest
    const request = openRequest
    const show = (list: readonly ExportSummary[]) => {
      if (list.some((e) => e.id === request.exportId)) {
        setOpened({ id: request.exportId, byAgent: request.source === 'agent' })
      } else setNotice('The film is no longer in the library.')
    }
    if (exports.some((e) => e.id === request.exportId)) show(exports)
    else void reload().then(show)
    onOpenRequestHandled()
  }, [openRequest, loaded])

  const open = useCallback((e: ExportSummary) => setOpened({ id: e.id, byAgent: false }), [])
  const totalSeconds = exports.reduce((sum, e) => sum + (e.duration ?? 0), 0)
  const count = [filmsText(exports.length), totalSeconds > 0 ? formatTotalLength(totalSeconds) : undefined]
    .filter(Boolean)
    .join(' · ')
  const openIndex = opened ? exports.findIndex((e) => e.id === opened.id) : -1

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <MediaToolbar tabs={tabs} below={<CountLine text={loaded ? count : ''} />} />
      {notice && <NoticeRow onClose={() => setNotice(undefined)}>{notice}</NoticeRow>}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
        {!loaded ? null : exports.length === 0 ? (
          <div className="flex h-full flex-col">
            <EmptyState
              icon={<FilmIcon size={24} />}
              title="No films yet"
              text="Export a sequence or a storyboard and the film ends up here."
            />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {exports.map((e) => (
              <FilmCard key={e.id} film={e} onOpen={open} />
            ))}
          </div>
        )}
      </div>

      {opened && openIndex >= 0 && (
        <FilmPlayer
          film={exports[openIndex]}
          position={exports.length > 1 ? `${openIndex + 1} of ${exports.length}` : undefined}
          byAgent={opened.byAgent}
          onPrev={openIndex > 0 ? () => setOpened({ id: exports[openIndex - 1].id, byAgent: false }) : undefined}
          onNext={
            openIndex < exports.length - 1
              ? () => setOpened({ id: exports[openIndex + 1].id, byAgent: false })
              : undefined
          }
          onClose={() => setOpened(undefined)}
          navigate={navigate}
        />
      )}
    </div>
  )
}

/** A film as a card: its first frame, what it was exported from, when, how long and how many clips. */
const FilmCard = memo(function FilmCard({ film, onOpen }: { film: ExportSummary; onOpen: (e: ExportSummary) => void }) {
  const fresh = useIsUnseen(workKey.export(film.id))
  const [broken, setBroken] = useState(false)
  const missing = !film.exists || broken
  const name = filmName(film)
  return (
    <div className={MEDIA_CARD}>
      <button
        type="button"
        onClick={() => onOpen(film)}
        title={missing ? `File missing: ${film.path}` : `Play “${name}”`}
        className="relative block aspect-video w-full overflow-hidden bg-black outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted"
      >
        {missing ? (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[12px] text-danger">
            <FilmIcon size={18} className="text-muted" />
            File missing
          </span>
        ) : (
          <>
            {/* The browser shows the frame at half a second as the poster: exports have no picture of their own. */}
            <video
              src={`${mediaUrl(film.path)}#t=0.5`}
              preload="metadata"
              muted
              playsInline
              tabIndex={-1}
              onError={() => setBroken(true)}
              className="pointer-events-none h-full w-full object-contain"
            />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white/90 opacity-0 backdrop-blur transition group-hover:opacity-100">
                <PlayIcon size={16} />
              </span>
            </span>
          </>
        )}
        {(fresh || film.sequenceKind) && (
          <span className="absolute left-2 top-2 flex items-center gap-1">
            {fresh && <NewChip variant="overlay" title="Done and not looked at yet" />}
            {film.sequenceKind && (
              <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-text backdrop-blur">
                {KIND_LABEL[film.sequenceKind]}
              </span>
            )}
          </span>
        )}
      </button>
      <div className={MEDIA_CAPTION}>
        <p className="truncate font-medium" title={name}>
          {name}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {filmFacts(film).join(' · ')}
          {missing && <span className="text-danger"> · File missing</span>}
        </p>
      </div>
    </div>
  )
})

const action =
  'rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent'

/**
 * A film over the window, playing, with what it is and where to take it. Opening a film, or stepping to one, is
 * looking at it (the playback rule marks it seen too); not one an agent opened, which also doesn't start playing.
 * Esc closes, ← → step, Space plays and pauses; it takes the focus while open and gives it back when it closes.
 */
function FilmPlayer({
  film,
  position,
  byAgent,
  onPrev,
  onNext,
  onClose,
  navigate
}: {
  film: ExportSummary
  position?: string
  byAgent: boolean
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
  navigate: Navigate
}) {
  const key = workKey.export(film.id)
  useEffect(() => {
    if (!byAgent) markSeen([key])
  }, [key, byAgent])
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [film.id])
  const playable = film.exists && !broken
  const videoRef = useRef<HTMLVideoElement>(null)

  // The keys are the player's while it is open: the card behind it no longer takes Space or the arrows.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const byKeyboard = focusedWithKeyboard(before)
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      // Only when the focus went down with the player: never taken from what the closing action focused.
      const lost = !document.activeElement || document.activeElement === document.body
      if (lost && before?.isConnected) refocused(before, byKeyboard)
    }
  }, [])

  useViewerKeys({
    onClose,
    onPrev,
    onNext,
    onSpace: () => {
      const video = videoRef.current
      if (!video) return
      if (video.paused) void video.play().catch(() => {})
      else video.pause()
    }
  })

  const ownerLabel =
    film.sequenceKind === 'storyboard' ? 'Go to the storyboard' : film.sequenceKind === 'sequence' ? 'Go to the sequence' : undefined
  const goToOwner = () => {
    if (!film.sequenceId) return
    if (film.sequenceKind === 'storyboard') {
      navigate('storyboards', { type: 'open-storyboard', storyboardId: film.sequenceId })
    } else navigate('sequences', { type: 'open-sequence', sequenceId: film.sequenceId })
  }
  const facts = [film.sequenceKind && KIND_LABEL[film.sequenceKind], ...filmFacts(film), position].filter(
    (f): f is string => !!f
  )

  return createPortal(
    // no-drag: the overlay covers the views' title-bar drag regions.
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={filmName(film)}
      tabIndex={-1}
      className="no-drag fixed inset-0 z-[60] flex flex-col bg-black/85 outline-none backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-10 pt-12"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        {playable ? (
          <video
            ref={videoRef}
            key={film.id}
            src={mediaUrl(film.path)}
            {...nativeVideoControls}
            autoPlay={!byAgent}
            onError={() => setBroken(true)}
            className="max-h-full max-w-full rounded-md bg-black shadow-2xl"
          />
        ) : (
          <p className="max-w-sm text-center text-muted select-text">
            The file is gone.
            <br />
            <span className="text-[11px] break-all">{film.path}</span>
          </p>
        )}
        {(onPrev || onNext) && (
          <>
            <ViewerNavButton side="prev" label="Previous film" onClick={() => onPrev?.()} disabled={!onPrev} />
            <ViewerNavButton side="next" label="Next film" onClick={() => onNext?.()} disabled={!onNext} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-line bg-panel px-5 py-3 text-text">
        <div className="min-w-0 flex-1 basis-80">
          <p className="truncate font-medium">{filmName(film)}</p>
          <p className="mt-0.5 text-[12px] text-muted">{facts.join(' · ')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <button
            type="button"
            disabled={!film.exists}
            onClick={() => {
              markSeen([key])
              navigate('editor', { type: 'open-editor', exportId: film.id })
            }}
            title={
              film.exists
                ? 'Change the film with AI in the Editor. The original is left untouched – every change becomes a new version.'
                : 'File missing'
            }
            className={`${action} flex items-center gap-1.5`}
          >
            <ScissorsIcon size={12} />
            Edit…
          </button>
          {ownerLabel && film.sequenceId && (
            <button type="button" onClick={goToOwner} className={action}>
              {ownerLabel}
            </button>
          )}
          <button
            type="button"
            disabled={!film.exists}
            onClick={() => {
              markSeen([key])
              void window.studio.revealFile(film.path)
            }}
            className={action}
          >
            Show in {FILE_MANAGER}
          </button>
          <button type="button" onClick={onClose} title="Close (Esc)" className={action}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
