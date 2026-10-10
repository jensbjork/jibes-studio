import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { workKey, type ExportSummary } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { markSeen, useIsUnseen } from '../../lib/work'
import { fileName, formatLength } from '../editor/editorUtils'
import { formatTotalLength } from '../feed/feedText'
import { FilmIcon } from '../icons'
import { formatStillTime } from '../images/imageModels'
import { PlayIcon } from '../sequences/icons'
import { NewChip } from '../work/StatusMark'
import { CountLine, MediaToolbar, NoticeRow } from './ui'

// Filmer: every film exported from a sequence or a storyboard, newest first, as cards with the film's first frame.
// A film plays in a player over the window, with the way on to Redigera, its sequence or storyboard, and Finder.
// Films aren't deleted here.

interface OpenRequest {
  exportId: string
  source?: 'agent'
}

interface Props {
  /** The Mediabank's tabs, at the start of the header. */
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
  return n === 1 ? '1 film' : `${n} filmer`
}

function filmName(e: ExportSummary): string {
  return e.sequenceName ?? fileName(e.path)
}

const KIND_LABEL = { sequence: 'Sekvens', storyboard: 'Storyboard' } as const

/** "8 okt. 14:02 · 1:24 · 6 klipp". */
function filmFacts(e: ExportSummary): string[] {
  return [
    formatStillTime(e.createdAt),
    e.duration !== undefined ? formatLength(e.duration) : undefined,
    e.cuts ? `${e.cuts.length + 1} klipp` : undefined
  ].filter((f): f is string => !!f)
}

export default function FilmsTab({ tabs, navigate, openRequest, onOpenRequestHandled }: Props) {
  const { exports, loaded, reload } = useExports()
  const [notice, setNotice] = useState<string>()
  const [opened, setOpened] = useState<{ id: string; byAgent: boolean }>()

  // Pågår och klart or an agent showing a film: it opens in the player. One that just finished may not be listed
  // yet, so the list is read once more before it counts as gone.
  const handled = useRef<OpenRequest>(undefined)
  useEffect(() => {
    if (!openRequest || !loaded || handled.current === openRequest) return
    handled.current = openRequest
    const request = openRequest
    const show = (list: readonly ExportSummary[]) => {
      if (list.some((e) => e.id === request.exportId)) {
        setOpened({ id: request.exportId, byAgent: request.source === 'agent' })
      } else setNotice('Filmen finns inte längre i biblioteket.')
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
      {notice && <NoticeRow text={notice} onClose={() => setNotice(undefined)} />}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
        {!loaded ? null : exports.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <p className="max-w-sm leading-relaxed">
              Inga exporterade filmer än. Exportera en sekvens eller en storyboard, så hamnar filmen här.
            </p>
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
          position={exports.length > 1 ? `${openIndex + 1} av ${exports.length}` : undefined}
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
    <div className="group min-w-0 overflow-hidden rounded-lg border border-line bg-panel">
      <button
        type="button"
        onClick={() => onOpen(film)}
        title={missing ? `Filen saknas: ${film.path}` : `Spela upp ”${name}”`}
        className="relative block aspect-video w-full overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-muted"
      >
        {missing ? (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[12px] text-accent">
            <FilmIcon size={18} className="text-muted" />
            Filen saknas
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
            {fresh && <NewChip variant="overlay" title="Klar och inte tittad på än" />}
            {film.sequenceKind && (
              <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-text backdrop-blur">
                {KIND_LABEL[film.sequenceKind]}
              </span>
            )}
          </span>
        )}
      </button>
      <div className="px-3 py-2.5">
        <p className="truncate font-medium" title={name}>
          {name}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {filmFacts(film).join(' · ')}
          {missing && <span className="text-accent"> · Filen saknas</span>}
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A focused player seeks with the arrows itself.
      const onMedia = e.target instanceof HTMLMediaElement
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && !onMedia && onPrev) onPrev()
      else if (e.key === 'ArrowRight' && !onMedia && onNext) onNext()
      else return
      // Captured and stopped here, so the view underneath doesn't act on the same key.
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onPrev, onNext])

  const ownerLabel =
    film.sequenceKind === 'storyboard' ? 'Gå till storyboarden' : film.sequenceKind === 'sequence' ? 'Gå till sekvensen' : undefined
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
      role="dialog"
      aria-modal="true"
      aria-label={filmName(film)}
      className="no-drag fixed inset-0 z-[60] flex flex-col bg-black/85 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-10 pt-12"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        {playable ? (
          <video
            key={film.id}
            src={mediaUrl(film.path)}
            controls
            autoPlay={!byAgent}
            onError={() => setBroken(true)}
            className="max-h-full max-w-full rounded-md bg-black shadow-2xl"
          />
        ) : (
          <p className="max-w-sm text-center text-muted select-text">
            Filen finns inte längre.
            <br />
            <span className="text-[11px] break-all">{film.path}</span>
          </p>
        )}
        {(onPrev || onNext) && (
          <>
            <NavButton side="left" onClick={onPrev} />
            <NavButton side="right" onClick={onNext} />
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
            title={film.exists ? 'Redigera filmen (exporten lämnas orörd)' : 'Filen saknas'}
            className={action}
          >
            Öppna i Redigera
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
            Visa i Finder
          </button>
          <button type="button" onClick={onClose} className={action}>
            Stäng
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={side === 'left' ? 'Föregående film' : 'Nästa film'}
      title={side === 'left' ? 'Föregående (←)' : 'Nästa (→)'}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-lg leading-none text-white/80 transition hover:bg-black/80 hover:text-white disabled:opacity-0 ${
        side === 'left' ? 'left-3' : 'right-3'
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}
