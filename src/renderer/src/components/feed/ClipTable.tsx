import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { generationTitle, sourceBadge } from '@shared/generation-label'
import { workKey, type Generation, type VideoModel } from '@shared/types'
import { formatUsd, mediaUrl } from '../../lib/media'
import { markSeen, useIsUnseen, useSeenWhenVisible } from '../../lib/work'
import AssetAvatar from '../assets/AssetAvatar'
import { KIND_TONE } from '../pickers/assetKinds'
import { formatWhen } from '../prompts/prompt-utils'
import type { SortKey } from './feedFilter'
import { STATUS_LABEL, clipSeconds, formatClipLength, isPending, progressOf, reviewCountText } from './feedText'
import { ReviewIcon } from './icons'
import { assetsOf, type LibraryIndex } from './references'
import StarRating from './StarRating'
import { Spinner, StatusDot } from '../work/StatusMark'

interface Props {
  /** Filtered and sorted. */
  generations: Generation[]
  models: readonly VideoModel[]
  index: LibraryIndex
  sort: SortKey
  onSort: (sort: SortKey) => void
  selectedId?: string
  onSelect: (id: string) => void
  /** The clip shown in the detail drawer, if it is open. */
  openId?: string
  onOpen: (id: string) => void
  onClose: () => void
  onRate: (g: Generation, rating: number | null) => void
  /** The focusable list, so the search field can hand the keyboard over. */
  bodyRef: RefObject<HTMLDivElement | null>
  /** Changes with the filters and the order: the list then starts over at its top (or at the selected row). */
  resetKey: string
}

const ROW = 48
const HEADER = 32
/** Rows rendered beyond the visible ones, so fast scrolling doesn't show blank rows. */
const OVERSCAN = 8

type ColumnId = 'thumb' | 'prompt' | 'assets' | 'model' | 'length' | 'resolution' | 'cost' | 'status' | 'rating' | 'created'

interface Column {
  id: ColumnId
  label: string
  /** CSS grid track. */
  width: string
  /** The table must be at least this wide (px) for the column to show; less important columns go first. */
  minTable?: number
  align?: 'right'
  /** Clicking the header sorts by it; 'created' toggles between newest and oldest. */
  sort?: SortKey
}

const COLUMNS: Column[] = [
  { id: 'thumb', label: '', width: '76px' },
  { id: 'prompt', label: 'Prompt / namn', width: 'minmax(160px, 1fr)' },
  { id: 'assets', label: 'Tillgångar', width: '88px', minTable: 720 },
  { id: 'model', label: 'Modell', width: '136px', minTable: 980 },
  { id: 'length', label: 'Längd', width: '60px', minTable: 640, align: 'right', sort: 'length' },
  { id: 'resolution', label: 'Upplösn.', width: '68px', minTable: 1100 },
  { id: 'cost', label: 'Kostnad', width: '68px', minTable: 560, align: 'right', sort: 'cost' },
  { id: 'status', label: 'Status', width: '124px' },
  { id: 'rating', label: 'Betyg', width: '86px', sort: 'rating' },
  { id: 'created', label: 'Skapad', width: '92px', minTable: 800, sort: 'newest' }
]

function visibleColumns(width: number): Column[] {
  return COLUMNS.filter((c) => !c.minTable || width >= c.minTable)
}

/**
 * Every clip as one row: a table that stays fast with thousands of clips, since only the rows in view (plus a
 * few) are rendered. ↑/↓ move, Enter opens the clip in the drawer, space opens or closes it, Esc closes it;
 * while the drawer is open it follows the selected row.
 */
export default function ClipTable({
  generations,
  models,
  index,
  sort,
  onSort,
  selectedId,
  onSelect,
  openId,
  onOpen,
  onClose,
  onRate,
  bodyRef,
  resetKey
}: Props) {
  const [scrollTop, setScrollTop] = useState(0)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const [focused, setFocused] = useState(false)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const columns = visibleColumns(size.width)
  const template = columns.map((c) => c.width).join(' ')
  const bodyHeight = Math.max(0, size.height - HEADER)
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const last = Math.min(generations.length, Math.ceil((scrollTop + bodyHeight) / ROW) + OVERSCAN)
  const pageRows = Math.max(1, Math.floor(bodyHeight / ROW) - 1)

  const selectedIndex = selectedId ? generations.findIndex((g) => g.id === selectedId) : -1
  // Where the selected row was, so ↑/↓ move on from there after it drops out of the list (rated while filtering
  // on unrated clips, finished while filtering on running ones) instead of starting over at the top. New filters
  // or a new order (resetKey) forget it: the row is then simply not listed.
  const lastSelected = useRef({ resetKey, index: -1 })
  if (lastSelected.current.resetKey !== resetKey) lastSelected.current = { resetKey, index: -1 }
  if (selectedIndex >= 0) lastSelected.current.index = selectedIndex
  const droppedAt = selectedIndex < 0 && selectedId ? lastSelected.current.index : -1

  // New filters or order: back to the top, or to the selected row (centred) when it is still listed.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = selectedIndex < 0 ? 0 : Math.max(0, selectedIndex * ROW - (bodyHeight - ROW) / 2)
  }, [resetKey])

  // Keep the selected row in view when it moves (keyboard, drawer navigation).
  useEffect(() => {
    const el = bodyRef.current
    if (!el || selectedIndex < 0) return
    const top = selectedIndex * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + bodyHeight) el.scrollTop = top + ROW - bodyHeight
  }, [selectedIndex, bodyHeight])

  const go = (i: number) => {
    if (!generations.length) return
    const target = generations[Math.max(0, Math.min(generations.length - 1, i))]
    onSelect(target.id)
    if (openId) onOpen(target.id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in the rating stars or a button inside a row are theirs.
    if (e.target !== e.currentTarget) return
    const at = selectedIndex
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        // A dropped row's place is now held by the row after it.
        go(at >= 0 ? at + 1 : droppedAt >= 0 ? droppedAt : 0)
        break
      case 'ArrowUp':
        e.preventDefault()
        go(at >= 0 ? at - 1 : droppedAt >= 0 ? droppedAt - 1 : 0)
        break
      case 'PageDown':
        e.preventDefault()
        go(at + pageRows)
        break
      case 'PageUp':
        e.preventDefault()
        go(at - pageRows)
        break
      case 'Home':
        e.preventDefault()
        go(0)
        break
      case 'End':
        e.preventDefault()
        go(generations.length - 1)
        break
      case 'Enter':
        if (at >= 0) {
          e.preventDefault()
          onOpen(generations[at].id)
        }
        break
      case ' ':
        if (at >= 0) {
          e.preventDefault()
          if (openId === generations[at].id) onClose()
          else onOpen(generations[at].id)
        }
        break
      case 'Escape':
        if (openId) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
        break
    }
  }

  const headerSort = (c: Column) => {
    if (!c.sort) return
    if (c.id === 'created') onSort(sort === 'newest' ? 'oldest' : 'newest')
    else onSort(c.sort)
  }

  const sortedBy = (c: Column): 'ascending' | 'descending' | undefined => {
    if (c.id === 'created') return sort === 'newest' ? 'descending' : sort === 'oldest' ? 'ascending' : undefined
    return c.sort && c.sort === sort ? 'descending' : undefined
  }

  const rows = []
  for (let i = first; i < last; i++) {
    const g = generations[i]
    rows.push(
      <Row
        key={g.id}
        g={g}
        top={i * ROW}
        rowIndex={i}
        columns={columns}
        template={template}
        modelName={models.find((m) => m.id === g.model)?.name ?? g.model}
        index={index}
        selected={g.id === selectedId}
        focused={focused}
        open={g.id === openId}
        onClick={() => {
          bodyRef.current?.focus()
          onSelect(g.id)
          onOpen(g.id)
        }}
        onRate={onRate}
      />
    )
  }

  return (
    <div
      ref={bodyRef}
      role="grid"
      aria-label="Klipp"
      aria-rowcount={generations.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `clip-row-${generations[selectedIndex].id}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(e) => e.target === e.currentTarget && setFocused(true)}
      onBlur={(e) => e.target === e.currentTarget && setFocused(false)}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative h-full overflow-auto outline-none"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-10 grid items-center border-b border-line bg-bg/95 px-6 text-[11px] text-muted backdrop-blur"
        style={{ gridTemplateColumns: template, height: HEADER, minWidth: 0 }}
      >
        {columns.map((c) => {
          const direction = sortedBy(c)
          return (
            <div
              key={c.id}
              role="columnheader"
              aria-sort={direction ?? (c.sort ? 'none' : undefined)}
              className={`min-w-0 px-2 ${c.align === 'right' ? 'text-right' : ''}`}
            >
              {c.sort ? (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => headerSort(c)}
                  title={
                    c.id === 'created'
                      ? sort === 'newest'
                        ? 'Visa äldst först'
                        : 'Visa nyast först'
                      : `Sortera på ${c.label.toLocaleLowerCase('sv')}, högst först`
                  }
                  className={`inline-flex max-w-full items-center gap-1 truncate transition hover:text-text ${
                    direction ? 'text-text' : ''
                  }`}
                >
                  {c.label}
                  {direction && <span aria-hidden>{direction === 'descending' ? '↓' : '↑'}</span>}
                </button>
              ) : (
                <span className="truncate">{c.label}</span>
              )}
            </div>
          )
        })}
      </div>

      <div role="rowgroup" className="relative" style={{ height: generations.length * ROW }}>
        {rows}
      </div>
    </div>
  )
}

function Row({
  g,
  top,
  rowIndex,
  columns,
  template,
  modelName,
  index,
  selected,
  focused,
  open,
  onClick,
  onRate
}: {
  g: Generation
  top: number
  rowIndex: number
  columns: Column[]
  template: string
  modelName: string
  index: LibraryIndex
  selected: boolean
  focused: boolean
  open: boolean
  onClick: () => void
  onRate: (g: Generation, rating: number | null) => void
}) {
  const failed = g.status === 'failed'
  // Pågår och klart: a dot before the title while the clip (or its failure) is new; a failed row counts as seen
  // once it has been on screen for a moment.
  const key = workKey.generation(g.id)
  const unseen = useIsUnseen(key)
  const rowRef = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(rowRef, failed ? key : undefined)
  return (
    <div
      ref={rowRef}
      id={`clip-row-${g.id}`}
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={selected}
      onClick={onClick}
      className={`absolute inset-x-0 grid cursor-default items-center border-b border-line/40 px-6 transition-colors ${
        selected ? (focused ? 'bg-raised' : 'bg-raised/60') : 'hover:bg-raised/40'
      } ${open ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`}
      style={{ top, height: ROW, gridTemplateColumns: template }}
    >
      {columns.map((c) => (
        <div
          key={c.id}
          role="gridcell"
          className={`flex min-w-0 items-center px-2 ${c.align === 'right' ? 'justify-end' : ''}`}
        >
          <Cell
            column={c.id}
            g={g}
            failed={failed}
            unseen={unseen}
            modelName={modelName}
            index={index}
            onRate={onRate}
          />
        </div>
      ))}
    </div>
  )
}

function Cell({
  column,
  g,
  failed,
  unseen,
  modelName,
  index,
  onRate
}: {
  column: ColumnId
  g: Generation
  failed: boolean
  /** Finished (or failed) and not looked at yet. */
  unseen: boolean
  modelName: string
  index: LibraryIndex
  onRate: (g: Generation, rating: number | null) => void
}) {
  switch (column) {
    case 'thumb':
      return <RowThumb g={g} />
    case 'prompt': {
      const others = g.agentReviewCount
      const badge = sourceBadge(g)
      const title = generationTitle(g)
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          {unseen && (
            <span title={failed ? 'Misslyckades – inte sett än' : 'Ny – inte tittad på än'} className="flex shrink-0">
              <StatusDot failed={failed} />
            </span>
          )}
          {badge && (
            <span
              title={badge.description}
              className="shrink-0 rounded bg-raised px-1 py-px text-[10px] text-muted"
            >
              {badge.label}
            </span>
          )}
          <span className={`min-w-0 truncate ${failed ? 'text-muted' : ''}`} title={title}>
            {g.prompt || g.title ? title : <span className="text-muted">Ingen prompt</span>}
          </span>
          {others > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted" title={reviewCountText(others)}>
              <ReviewIcon size={11} />
              {others}
            </span>
          )}
        </span>
      )
    }
    case 'assets':
      return <AssetStack g={g} index={index} />
    case 'model':
      return (
        <span className="truncate text-[12px] text-muted" title={g.model || undefined}>
          {g.model ? modelName : g.source === 'edit' ? 'Redigerad film' : 'Eget klipp'}
        </span>
      )
    case 'length':
      return (
        <span className={`text-[12px] tabular-nums ${g.status === 'completed' ? '' : 'text-muted'}`}>
          {formatClipLength(clipSeconds(g))}
        </span>
      )
    case 'resolution':
      return <span className="text-[12px] text-muted">{g.params.resolution ?? '–'}</span>
    case 'cost':
      return (
        <span className={`text-[12px] tabular-nums ${failed ? 'text-muted line-through' : ''}`}>{formatUsd(g.quote)}</span>
      )
    case 'status':
      return <StatusCell g={g} />
    case 'rating':
      return g.status === 'completed' ? (
        <StarRating
          value={g.rating}
          onChange={(r) => {
            // Rating a clip is looking at it on purpose.
            markSeen([workKey.generation(g.id)])
            onRate(g, r)
          }}
          size="sm"
        />
      ) : (
        <span className="text-[12px] text-muted">–</span>
      )
    case 'created':
      return (
        <span className="truncate text-[12px] text-muted" title={new Date(g.createdAt).toLocaleString('sv-SE')}>
          {formatWhen(g.createdAt)}
        </span>
      )
  }
}

function RowThumb({ g }: { g: Generation }) {
  const [failedPath, setFailedPath] = useState<string>()
  const box = 'h-9 w-16 shrink-0 overflow-hidden rounded bg-black'
  if (g.thumbPath && failedPath !== g.thumbPath) {
    return (
      <img
        src={mediaUrl(g.thumbPath)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedPath(g.thumbPath)}
        className={`${box} object-cover`}
      />
    )
  }
  return (
    <span className={`${box} flex items-center justify-center text-[10px] text-muted`}>
      {isPending(g) ? <Spinner size={10} /> : g.status === 'failed' ? '✕' : ''}
    </span>
  )
}

/**
 * The status column in Pågår och klart's vocabulary: a spinner while it runs, an accent dot when it failed, a
 * quiet dot when done (emerald is kept for "new", shown before the title).
 */
function StatusCell({ g }: { g: Generation }) {
  const progress = progressOf(g)
  return (
    <span
      className={`flex min-w-0 items-center gap-1.5 text-[12px] ${g.status === 'failed' ? 'text-accent' : g.status === 'completed' ? 'text-muted' : ''}`}
      title={g.status === 'failed' ? (g.error ?? 'Misslyckades') : STATUS_LABEL[g.status]}
    >
      {isPending(g) ? (
        <Spinner size={10} />
      ) : (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${g.status === 'failed' ? 'bg-accent' : 'bg-muted/40'}`} />
      )}
      <span className="truncate">
        {STATUS_LABEL[g.status]}
        {g.status === 'processing' && progress !== undefined ? ` ${Math.round(progress * 100)} %` : ''}
      </span>
    </span>
  )
}

const MAX_AVATARS = 4

function AssetStack({ g, index }: { g: Generation; index: LibraryIndex }) {
  const assets = assetsOf(g, index)
  if (!assets.length) return <span className="text-[12px] text-muted">–</span>
  const shown = assets.slice(0, MAX_AVATARS)
  const names = assets.map((a) => a.name).join(', ')
  return (
    <span className="flex items-center" title={names}>
      {shown.map((a, i) => (
        <AssetAvatar
          key={a.id}
          asset={a}
          className={`h-6 w-6 rounded-full text-[10px] ring-2 ring-bg ${i ? '-ml-1.5' : ''} ${KIND_TONE[a.kind].text}`}
        />
      ))}
      {assets.length > MAX_AVATARS && (
        <span className="ml-1 text-[11px] text-muted">+{assets.length - MAX_AVATARS}</span>
      )}
    </span>
  )
}
