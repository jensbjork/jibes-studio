import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Popover from '../pickers/Popover'
import { CloseIcon, PlusIcon } from '../sequences/icons'

// The list on the left of Characters, Environments, Products, Outfits, Poses, Sequences, Storyboards and Editor, the
// same in all of them: the view's name with "＋ New …", a search field, and one row per item – its picture, name, a
// line about it and what runs there or is new. The ✕ on a row asks in the row itself before anything is deleted.
// ↑ ↓ move between the rows, Enter opens one, ⌘F goes to the search.

export interface SideListItem {
  id: string
  name: string
}

/** What a row gets from the list: whether it is the open one, and its two actions. */
export interface SideRowControl {
  id: string
  active: boolean
  onSelect: () => void
  /** The ✕: the row turns into the question. */
  onAskDelete: () => void
}

interface Props<T extends SideListItem> {
  /** The view's name, at the top. */
  title: string
  /** "New sequence". */
  createLabel: string
  createTitle?: string
  creating?: boolean
  /** "＋ New …" creates at once … */
  onCreate?: () => void
  /** … or opens this under the button (a form, or a menu of ways to start); close() closes it. */
  createPanel?: { width?: number; label?: string; popup?: 'dialog' | 'menu'; render: (close: () => void) => ReactNode }
  /** Under the heading, above the search (Mark all as seen). */
  headerExtra?: ReactNode
  /** In the view's order; undefined until the first load has arrived. */
  items?: readonly T[]
  selectedId?: string
  onSelect: (id: string) => void
  searchPlaceholder: string
  /** What the search looks in besides the name (a description, where a film came from). */
  searchText?: (item: T) => string
  /** In the list while there is nothing at all. */
  emptyText: ReactNode
  renderRow: (item: T, control: SideRowControl) => ReactNode
  /** The question; "Delete “name”?" when left out. */
  deleteQuestion?: (item: T) => string
  /** One line under the question: what deleting does. */
  deleteNote: (item: T) => ReactNode
  /**
   * Deletes; an error it throws is shown in the row, which stays asking. `next` is the row that takes its place (the
   * one below, else above, among those the search shows), for the view to open when the open one goes.
   */
  onDelete: (item: T, next: T | undefined) => Promise<void>
}

// How long an unanswered question stays (not while the pointer is on it, it is deleting, or it shows an error).
const QUESTION_MS = 8000

const fold = (text: string) => text.toLocaleLowerCase('en')

const rowSelector = (id: string) => `[data-side-row="${CSS.escape(id)}"]`

export default function SideList<T extends SideListItem>({
  title,
  createLabel,
  createTitle,
  creating = false,
  onCreate,
  createPanel,
  headerExtra,
  items,
  selectedId,
  onSelect,
  searchPlaceholder,
  searchText,
  emptyText,
  renderRow,
  deleteQuestion,
  deleteNote,
  onDelete
}: Props<T>) {
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [asking, setAsking] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [held, setHeld] = useState(false)
  // Deleted here and gone at once, before the view's list has caught up.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const questionRef = useRef<HTMLDivElement>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  // A row to give the focus once it has rendered (after the question closes).
  const focusNext = useRef<string>(undefined)

  const q = fold(query.trim())
  const listed = items?.filter((item) => !deleted.has(item.id))
  const visible = !listed
    ? []
    : q
      ? listed.filter((item) => fold(item.name).includes(q) || (!!searchText && fold(searchText(item)).includes(q)))
      : listed

  const rowElement = (id: string) => listRef.current?.querySelector<HTMLElement>(rowSelector(id)) ?? null

  // The view's list has caught up with what was deleted here.
  useEffect(() => {
    if (!items || !deleted.size) return
    const left = [...deleted].filter((id) => items.some((item) => item.id === id))
    if (left.length < deleted.size) setDeleted(new Set(left))
  }, [items])

  // Something else opened an item the search hides (a new one, a link from another view): the search makes way. Not
  // when the open item was deleted here and the view moved on to its neighbour: the search stays as it was.
  const lastSelected = useRef(selectedId)
  const deleting = useRef<string>(undefined)
  useEffect(() => {
    const before = lastSelected.current
    if (selectedId === before) return
    lastSelected.current = selectedId
    if (before && before === deleting.current) return
    if (selectedId && q && !visible.some((item) => item.id === selectedId)) setQuery('')
  }, [selectedId])

  // The open item in view: when it changes, and once the list has arrived.
  const scrolledTo = useRef<string>(undefined)
  useEffect(() => {
    if (!selectedId || scrolledTo.current === selectedId) return
    const row = rowElement(selectedId)
    if (!row) return
    scrolledTo.current = selectedId
    row.scrollIntoView({ block: 'nearest' })
  })

  useEffect(() => {
    const id = focusNext.current
    if (!id) return
    focusNext.current = undefined
    rowElement(id)?.focus()
  })

  // A question about an item that went away meanwhile (deleted elsewhere, by an agent) goes with it.
  useEffect(() => {
    if (asking && items && !items.some((item) => item.id === asking)) closeQuestion(false)
  }, [items, asking])

  useEffect(() => {
    if (!asking || busy || error || held) return
    const t = setTimeout(() => closeQuestion(true), QUESTION_MS)
    return () => clearTimeout(t)
  }, [asking, busy, error, held])

  // ⌘F: the search, while this view is the one on screen (only one view is mounted) and no dialog is open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented || e.key.toLowerCase() !== 'f') return
      if (document.querySelector('[aria-modal="true"], [role="alertdialog"]')) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function closeQuestion(restoreFocus: boolean) {
    const id = asking
    const hadFocus = !!questionRef.current?.contains(document.activeElement)
    setAsking(undefined)
    setError(undefined)
    setHeld(false)
    if (restoreFocus && hadFocus && id) focusNext.current = id
  }

  const ask = (id: string) => {
    setAsking(id)
    setError(undefined)
    setHeld(false)
  }

  const confirm = async (item: T) => {
    const at = visible.findIndex((x) => x.id === item.id)
    const neighbor = visible[at + 1] ?? visible[at - 1]
    const hadFocus = !!questionRef.current?.contains(document.activeElement)
    deleting.current = item.id
    setBusy(true)
    setError(undefined)
    try {
      await onDelete(item, neighbor)
      setDeleted((s) => new Set(s).add(item.id))
      setAsking(undefined)
      setHeld(false)
      // Keyboard users carry on from the row that took its place.
      if (hadFocus && neighbor) focusNext.current = neighbor.id
    } catch (e) {
      deleting.current = undefined
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const focusFirstRow = () => {
    const target =
      (selectedId && visible.some((item) => item.id === selectedId) ? selectedId : undefined) ?? visible[0]?.id
    if (target) rowElement(target)?.focus()
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      setQuery('')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusFirstRow()
    } else if (e.key === 'Enter' && visible[0]) {
      e.preventDefault()
      onSelect(visible[0].id)
    }
  }

  // ↑ ↓ (Home, End) between the rows; ↑ from the first goes back to the search. Only from a row itself: the ✕ and
  // the question's buttons keep their keys.
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement
    if (!target.matches('[data-side-row]') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-side-row]') ?? [])]
    const at = rows.indexOf(target)
    let next: HTMLElement | null | undefined
    if (e.key === 'ArrowDown') next = rows[at + 1]
    else if (e.key === 'ArrowUp') next = at <= 0 ? searchRef.current : rows[at - 1]
    else if (e.key === 'Home') next = rows[0]
    else if (e.key === 'End') next = rows.at(-1)
    else return
    e.preventDefault()
    next?.focus()
  }

  const createAction = createPanel ? () => setCreateOpen((open) => !open) : onCreate

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line">
      <div className="drag flex h-12 shrink-0 items-center justify-between gap-2 pl-4 pr-2.5">
        <span className="min-w-0 truncate font-medium">{title}</span>
        <button
          ref={createButton}
          type="button"
          onClick={createAction}
          disabled={creating}
          aria-haspopup={createPanel ? (createPanel.popup ?? 'dialog') : undefined}
          aria-expanded={createPanel ? createOpen : undefined}
          title={createTitle}
          className="no-drag flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
        >
          <PlusIcon size={12} />
          {createLabel}
        </button>
      </div>
      {createPanel && (
        <Popover
          anchorRef={createButton}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          width={createPanel.width ?? 300}
          label={createPanel.label ?? createLabel}
        >
          {createOpen && createPanel.render(() => setCreateOpen(false))}
        </Popover>
      )}
      {headerExtra}

      <div className="shrink-0 px-2 pb-2">
        <div className="relative">
          <input
            ref={searchRef}
            type="text"
            role="searchbox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            spellCheck={false}
            className="w-full rounded-md border border-line bg-raised py-1.5 pl-2.5 pr-7 outline-none focus:border-muted"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              title="Clear search"
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
            >
              <CloseIcon size={9} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {listed?.length === 0 ? (
          <p className="px-2 py-2 text-[12px] leading-relaxed text-muted">{emptyText}</p>
        ) : listed && visible.length === 0 ? (
          <div className="px-2 py-2 text-[12px] leading-relaxed text-muted">
            <p className="break-words">No matches for “{query.trim()}”.</p>
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              className="mt-1 text-text underline-offset-2 hover:underline"
            >
              Clear search
            </button>
          </div>
        ) : (
          <ul ref={listRef} aria-label={title} onKeyDown={onListKey} className="flex flex-col gap-0.5">
            {visible.map((item) => (
              <li key={item.id}>
                {asking === item.id ? (
                  <div
                    ref={questionRef}
                    role="group"
                    aria-label={deleteQuestion?.(item) ?? `Delete “${item.name}”?`}
                    onMouseEnter={() => setHeld(true)}
                    onMouseLeave={() => setHeld(false)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape' || busy) return
                      e.preventDefault()
                      closeQuestion(true)
                    }}
                    className="rounded-md border border-accent/40 bg-raised p-2"
                  >
                    <p className="mb-1 line-clamp-2 break-words text-[12px]">
                      {deleteQuestion?.(item) ?? `Delete “${item.name}”?`}
                    </p>
                    <p className="mb-2 text-[11px] leading-snug text-muted">{deleteNote(item)}</p>
                    {error && (
                      <p role="alert" className="mb-2 select-text break-words text-[11px] leading-snug text-accent">
                        {error}
                      </p>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        autoFocus
                        disabled={busy}
                        onClick={() => void confirm(item)}
                        className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                      >
                        {busy ? 'Deleting…' : error ? 'Try again' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => closeQuestion(true)}
                        className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-line hover:text-text disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  renderRow(item, {
                    id: item.id,
                    active: item.id === selectedId,
                    onSelect: () => onSelect(item.id),
                    onAskDelete: () => ask(item.id)
                  })
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

interface RowProps {
  control: SideRowControl
  /** The picture first in the row (40 px high): an avatar, a cover, a poster. */
  visual: ReactNode
  name: string
  /** One line about it, under the name. */
  meta: ReactNode
  /** What runs there and what is new (a StatusMark); the ✕ takes its place on hover. */
  status?: ReactNode
  /** The row's tooltip. */
  title?: string
  /** The ✕'s tooltip ("Delete sequence"). */
  deleteTitle: string
  /** Lit up as a drop target. */
  highlight?: boolean
  /** Finder files dropped on the row (Characters and the other kinds). */
  dropHandlers?: Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>
}

/** One row of a SideList. */
export function SideListRow({
  control,
  visual,
  name,
  meta,
  status,
  title,
  deleteTitle,
  highlight = false,
  dropHandlers
}: RowProps) {
  const { id, active, onSelect, onAskDelete } = control
  return (
    <div className="group relative" {...dropHandlers}>
      <button
        type="button"
        data-side-row={id}
        onClick={onSelect}
        aria-current={active || undefined}
        title={title}
        className={`flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
          highlight ? 'bg-accent/10 ring-1 ring-accent' : active ? 'bg-raised' : 'hover:bg-raised/60'
        }`}
      >
        {visual}
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${active ? 'text-text' : 'text-text/90'}`}>{name}</span>
          <span className="block truncate text-[11px] text-muted">{meta}</span>
        </span>
        {/* Steps aside where the ✕ takes its place: on hover, and while the row or the ✕ has the keyboard focus. */}
        <span className="flex h-6 min-w-6 shrink-0 items-center justify-end transition-opacity group-hover:opacity-0 group-has-[[data-side-row]:focus-visible]:opacity-0 group-has-[[data-side-delete]:focus]:opacity-0">
          {status}
        </span>
      </button>
      <button
        type="button"
        data-side-delete
        onClick={onAskDelete}
        title={deleteTitle}
        aria-label={`Delete ${name}`}
        className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted opacity-0 transition hover:bg-line hover:text-accent focus:opacity-100 group-hover:opacity-100 group-has-[[data-side-row]:focus-visible]:opacity-100"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  )
}

/** A film's or a storyboard's picture in a row: 16:9 on black, or an icon while there is none. */
export function SideListThumb({ path, fallback }: { path?: string; fallback: ReactNode }) {
  return (
    <span className="flex h-10 w-[71px] shrink-0 items-center justify-center overflow-hidden rounded bg-black">
      {path ? (
        <img src={mediaUrl(path)} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        fallback
      )}
    </span>
  )
}
