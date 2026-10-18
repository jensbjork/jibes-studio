import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { EditSummary } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { useOwnerWork, useRunning } from '../../lib/work'
import { GridIcon, ListIcon } from '../feed/icons'
import { carriesFiles, droppedVideoPaths, ImportCardView, useImportCards } from '../feed/ownClips'
import { formatWhen } from '../prompts/prompt-utils'
import { CloseIcon, FilmIcon } from '../sequences/icons'
import { secondaryButton } from '../storyboards/ui'
import { formatLength, formatPrice, originLabel, summaryLine } from './editorUtils'
import { CameraIcon, ScissorsIcon } from './icons'
import { NewChip, Spinner } from '../work/StatusMark'
import { countsTitle } from '../work/workText'

// All edits, the Editor's overview beside the list while no edit is open: every edit as a card (poster, name,
// where it came from, versions, length, spent) or as a table row – the same Cards/Table switch as Generate's clip
// feed – and the ways to start one: an own film (file dialog, or dropped here), a clip from the feed, an exported
// film. Each edit can be deleted from here too (after a question). It lays out by its own width (@container/edits):
// in a narrow window the table drops its less needed columns and the header leaves the ways to start one to the
// list's "＋ New edit".

export type EditListView = 'cards' | 'table'
export type EditSort = 'updated' | 'name' | 'length' | 'cost' | 'versions'

const VIEW_KEY = 'editor:listView'

function loadView(): EditListView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards'
  } catch {
    return 'cards'
  }
}

function saveView(view: EditListView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Only a convenience.
  }
}

/** Newest change first by default; names A–Z; length, cost and versions largest first. */
function sortEdits(edits: readonly EditSummary[], sort: EditSort): EditSummary[] {
  const list = [...edits]
  switch (sort) {
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    case 'length':
      return list.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1))
    case 'cost':
      return list.sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    case 'versions':
      return list.sort((a, b) => b.versionCount - a.versionCount)
    default:
      return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

const segment = (on: boolean) =>
  `flex h-full items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] transition ${
    on ? 'bg-raised text-text shadow-sm shadow-black/40' : 'text-muted hover:text-text'
  }`

interface Props {
  edits?: EditSummary[]
  error?: string
  /** Paths of own films this view is importing (their progress cards show here). */
  importing: ReadonlySet<string>
  busy?: string
  onOpen: (editId: string) => void
  onOwnFilm: () => void
  onDropFiles: (paths: string[], hadOther: boolean) => void
  onFromFeed: () => void
  onFromExport: () => void
  /** Asks before it deletes (the view shows the question). */
  onDelete: (edit: EditSummary) => void
}

export default function EditList({
  edits,
  error,
  importing,
  busy,
  onOpen,
  onOwnFilm,
  onDropFiles,
  onFromFeed,
  onFromExport,
  onDelete
}: Props) {
  const cards = useImportCards().filter((c) => importing.has(c.path))
  const [view, setViewState] = useState<EditListView>(loadView)
  const setView = (v: EditListView) => {
    setViewState(v)
    saveView(v)
  }
  const [sort, setSort] = useState<EditSort>('updated')
  const sorted = useMemo(() => (edits ? sortEdits(edits, sort) : undefined), [edits, sort])
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const onDragEnter = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current += 1
    setOver(true)
  }
  const onDragLeave = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setOver(false)
  }
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const { paths, other } = droppedVideoPaths(e)
    onDropFiles(paths, other)
  }

  const empty = edits?.length === 0 && cards.length === 0
  const actions = (
    <>
      <button type="button" onClick={onOwnFilm} disabled={!!busy} className={secondaryButton}>
        <CameraIcon size={13} />
        Open your own film…
      </button>
      <button type="button" onClick={onFromFeed} disabled={!!busy} className={secondaryButton}>
        From the clip feed…
      </button>
      <button type="button" onClick={onFromExport} disabled={!!busy} className={secondaryButton}>
        From an export…
      </button>
    </>
  )

  return (
    <div
      className="@container/edits relative flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line pl-5 pr-3">
        <h1 className="shrink-0 font-medium">All edits</h1>
        {!empty && (
          <div
            role="radiogroup"
            aria-label="View"
            className="no-drag flex h-7 shrink-0 items-center rounded-md border border-line bg-panel p-0.5"
          >
            <button
              type="button"
              role="radio"
              aria-checked={view === 'cards'}
              onClick={() => setView('cards')}
              title="Large cards with a picture"
              className={segment(view === 'cards')}
            >
              <GridIcon size={12} />
              Cards
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'table'}
              onClick={() => setView('table')}
              title="Table – many edits at once"
              className={segment(view === 'table')}
            >
              <ListIcon size={12} />
              Table
            </button>
          </div>
        )}
        {busy && <span className="ml-2 truncate text-[12px] text-muted">{busy}</span>}
        {!empty && <div className="no-drag ml-auto hidden items-center gap-2 @min-[56rem]/edits:flex">{actions}</div>}
      </div>
      {error && <p className="mx-5 mt-3 text-[12px] text-accent select-text">{error}</p>}

      {empty ? (
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
          <div className="max-w-md text-center">
            <ScissorsIcon size={30} className="mx-auto mb-4 text-muted" />
            <h2 className="mb-2 text-base font-semibold">Edit a film</h2>
            <p className="leading-relaxed text-muted">
              Open a clip from Media, an exported film or your own film to change it with AI. The original is left
              untouched — every change becomes a new version.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>
            <p className="mt-4 text-[11px] text-muted">You can also drop a film file here.</p>
          </div>
        </div>
      ) : !sorted ? (
        <div className="flex flex-1 items-center justify-center text-muted">Loading edits…</div>
      ) : view === 'table' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {cards.map((card) => (
            <div key={card.path} className="mx-5 mt-3 h-16 overflow-hidden rounded-md border border-line bg-panel">
              <ImportCardView card={card} compact />
            </div>
          ))}
          <EditTable edits={sorted} sort={sort} onSort={setSort} onOpen={onOpen} onDelete={onDelete} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
            {cards.map((card) => (
              <div key={card.path} className="overflow-hidden rounded-lg border border-line bg-panel">
                <div className="aspect-video bg-black/40">
                  <ImportCardView card={card} compact />
                </div>
                <div className="px-3 py-2.5 text-[11px] text-muted">Own film · importing</div>
              </div>
            ))}
            {sorted.map((e) => (
              <EditCard key={e.id} edit={e} onOpen={() => onOpen(e.id)} onDelete={() => onDelete(e)} />
            ))}
          </div>
        </div>
      )}

      {over && (
        <div className="pointer-events-none absolute inset-3 top-14 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-bg/80">
          <p className="text-base">Drop to open as your own film</p>
        </div>
      )}
    </div>
  )
}

/** "“Interview” – Create music" → "Create music": the card already names its edit. */
function jobLabel(label: string, editName: string): string {
  const head = `“${editName}” – `
  return label.startsWith(head) ? label.slice(head.length) : label
}

/** What an edit is doing and what is new in it (Activity), for its card, its table row and its list row. */
export function useEditStatus(edit: EditSummary) {
  // A paid job or a free render running for this edit (main counts both), new versions, failures.
  const counts = useOwnerWork(edit.id)
  const work = useRunning((w) => w.ownerId === edit.id && w.view === 'editor')
  const first = work[0]
  const running = edit.running || work.length > 0
  const runningCount = Math.max(counts.running, work.length, edit.running ? 1 : 0)
  const runningText = first
    ? `${jobLabel(first.label, edit.name)}${first.progress !== undefined ? ` ${Math.round(first.progress * 100)}%` : ''}${
        work.length > 1 ? ` +${work.length - 1}` : ''
      }`
    : 'Running…'
  const title = countsTitle('edit', { ...counts, running: Math.max(counts.running, work.length) })
  return { counts, running, runningCount, runningText, title }
}

/** The ✕ that deletes an edit (after the view's question), shown on hover or keyboard focus. */
function DeleteButton({ edit, onDelete, className }: { edit: EditSummary; onDelete: () => void; className: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onDelete()
      }}
      title="Delete the edit"
      aria-label={`Delete ${edit.name}`}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-muted opacity-0 transition hover:text-accent focus:opacity-100 group-hover:opacity-100 ${className}`}
    >
      <CloseIcon size={11} />
    </button>
  )
}

function EditCard({ edit, onOpen, onDelete }: { edit: EditSummary; onOpen: () => void; onDelete: () => void }) {
  const { counts, running, runningText, title } = useEditStatus(edit)
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        title={title}
        className="block w-full overflow-hidden rounded-lg border border-line bg-panel text-left outline-none transition hover:border-muted/60 focus-visible:ring-1 focus-visible:ring-muted"
      >
        <div className="relative flex aspect-video items-center justify-center bg-black">
          {edit.posterPath ? (
            <img src={mediaUrl(edit.posterPath)} alt="" draggable={false} className="h-full w-full object-contain" />
          ) : (
            <FilmIcon size={22} className="text-muted/50" />
          )}
          <span className="absolute left-2 top-2 flex max-w-[calc(100%-3rem)] items-center gap-1">
            {running && (
              <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white backdrop-blur">
                <Spinner size={10} className="text-white" />
                <span className="truncate">{runningText}</span>
              </span>
            )}
            {counts.unseen > 0 && (
              <NewChip
                variant="overlay"
                label={counts.unseen === 1 ? 'New version' : `${counts.unseen} new versions`}
                className="shrink-0"
              />
            )}
            {counts.failed > 0 && (
              <span className="shrink-0 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-[#ffb3b5] backdrop-blur">
                Failed
              </span>
            )}
          </span>
        </div>
        <div className="px-3 py-2.5">
          <p className="truncate font-medium">{edit.name}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted">
            {edit.origin.kind === 'import' && <CameraIcon size={11} className="shrink-0" />}
            <span className="truncate">
              {originLabel(edit.origin)}
              {edit.origin.missing && ' (gone)'}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted">{summaryLine(edit)}</p>
        </div>
      </button>
      <DeleteButton edit={edit} onDelete={onDelete} className="absolute right-2 top-2 bg-black/70 backdrop-blur" />
    </div>
  )
}

interface Column {
  id: 'thumb' | 'name' | 'versions' | 'length' | 'cost' | 'status' | 'updated' | 'actions'
  label: string
  width: string
  align?: 'right'
  sort?: EditSort
  /** Only where the overview is wide enough (≥ 50rem): a narrow window keeps poster, name, length and status. */
  wide?: true
}

const COLUMNS: Column[] = [
  { id: 'thumb', label: '', width: '76px' },
  { id: 'name', label: 'Name', width: 'minmax(140px, 1fr)', sort: 'name' },
  { id: 'versions', label: 'Versions', width: '76px', align: 'right', sort: 'versions', wide: true },
  { id: 'length', label: 'Length', width: '60px', align: 'right', sort: 'length' },
  { id: 'cost', label: 'Cost', width: '72px', align: 'right', sort: 'cost', wide: true },
  { id: 'status', label: 'Status', width: '160px' },
  { id: 'updated', label: 'Changed', width: '96px', sort: 'updated', wide: true },
  { id: 'actions', label: '', width: '40px' }
]
// Both templates as variables; the grid takes the one its container's width calls for.
const GRID_STYLE = {
  '--edit-cols': COLUMNS.map((c) => c.width).join(' '),
  '--edit-cols-narrow': COLUMNS.filter((c) => !c.wide)
    .map((c) => c.width)
    .join(' ')
} as CSSProperties
const GRID = '[grid-template-columns:var(--edit-cols-narrow)] @min-[50rem]/edits:[grid-template-columns:var(--edit-cols)]'
const WIDE_CELL = 'hidden @min-[50rem]/edits:block'

/**
 * Every edit as one row, like Generate's clip table: poster, name with where it came from, versions, length, spent,
 * what is running or new, last change, and ✕. A click (or Enter) opens it; the column headers sort.
 */
function EditTable({
  edits,
  sort,
  onSort,
  onOpen,
  onDelete
}: {
  edits: EditSummary[]
  sort: EditSort
  onSort: (sort: EditSort) => void
  onOpen: (id: string) => void
  onDelete: (edit: EditSummary) => void
}) {
  return (
    <div role="table" aria-label="Edits" aria-rowcount={edits.length + 1} className="pb-5">
      <div
        role="row"
        className={`sticky top-0 z-10 grid h-8 items-center border-b border-line bg-bg/95 px-5 text-[11px] text-muted backdrop-blur ${GRID}`}
        style={GRID_STYLE}
      >
        {COLUMNS.map((c) => {
          const active = c.sort === sort
          return (
            <div
              key={c.id}
              role="columnheader"
              aria-sort={c.sort ? (active ? (c.sort === 'name' ? 'ascending' : 'descending') : 'none') : undefined}
              className={`min-w-0 px-2 ${c.align === 'right' ? 'text-right' : ''} ${c.wide ? WIDE_CELL : ''}`}
            >
              {c.sort ? (
                <button
                  type="button"
                  onClick={() => onSort(c.sort as EditSort)}
                  title={
                    c.sort === 'name'
                      ? 'Sort by name, A–Z'
                      : c.sort === 'updated'
                        ? 'Last changed first'
                        : `Sort by ${c.label.toLocaleLowerCase('en')}, highest first`
                  }
                  className={`inline-flex max-w-full items-center gap-1 truncate transition hover:text-text ${active ? 'text-text' : ''}`}
                >
                  {c.label}
                  {active && <span aria-hidden>{c.sort === 'name' ? '↑' : '↓'}</span>}
                </button>
              ) : (
                <span className="truncate">{c.label}</span>
              )}
            </div>
          )
        })}
      </div>
      {edits.map((e) => (
        <EditRow key={e.id} edit={e} onOpen={() => onOpen(e.id)} onDelete={() => onDelete(e)} />
      ))}
    </div>
  )
}

function EditRow({ edit, onOpen, onDelete }: { edit: EditSummary; onOpen: () => void; onDelete: () => void }) {
  const { counts, running, runningText, title } = useEditStatus(edit)
  return (
    <div
      role="row"
      tabIndex={0}
      title={title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
      className={`group grid h-12 cursor-pointer items-center border-b border-line/50 px-5 outline-none transition hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-muted ${GRID}`}
      style={GRID_STYLE}
    >
      <div role="cell" className="px-2">
        <div className="flex h-9 w-[60px] items-center justify-center overflow-hidden rounded bg-black">
          {edit.posterPath ? (
            <img src={mediaUrl(edit.posterPath)} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            <FilmIcon size={14} className="text-muted/50" />
          )}
        </div>
      </div>
      <div role="cell" className="min-w-0 px-2">
        <p className="truncate">{edit.name}</p>
        <p className="flex items-center gap-1 truncate text-[11px] text-muted">
          {edit.origin.kind === 'import' && <CameraIcon size={10} className="shrink-0" />}
          <span className="truncate">
            {originLabel(edit.origin)}
            {edit.origin.missing && ' (gone)'}
          </span>
        </p>
      </div>
      <div role="cell" className={`px-2 text-right tabular-nums text-muted ${WIDE_CELL}`}>
        {edit.versionCount > 1 ? edit.versionCount : 'Original'}
      </div>
      <div role="cell" className="px-2 text-right tabular-nums text-muted">
        {formatLength(edit.duration)}
      </div>
      <div role="cell" className={`px-2 text-right tabular-nums text-muted ${WIDE_CELL}`}>
        {edit.totalCostUsd > 0 ? formatPrice(edit.totalCostUsd) : '–'}
      </div>
      <div role="cell" className="flex min-w-0 items-center gap-1.5 px-2 text-[12px]">
        {running ? (
          <>
            <Spinner size={11} className="shrink-0 text-muted" />
            <span className="truncate text-muted">{runningText}</span>
          </>
        ) : counts.failed > 0 ? (
          <span className="truncate text-[#ffb3b5]">Failed</span>
        ) : counts.unseen > 0 ? (
          <NewChip label={counts.unseen === 1 ? 'New version' : `${counts.unseen} new`} />
        ) : (
          <span className="text-muted/60">–</span>
        )}
      </div>
      <div role="cell" className={`truncate px-2 text-[12px] text-muted ${WIDE_CELL}`}>
        {formatWhen(edit.updatedAt)}
      </div>
      <div role="cell" className="flex justify-end">
        <DeleteButton edit={edit} onDelete={onDelete} className="hover:bg-line" />
      </div>
    </div>
  )
}
