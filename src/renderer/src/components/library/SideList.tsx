import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { useCreateRequest } from '../../lib/createRequest'
import { ipcErrorMessage, useFindShortcut } from '../../lib/hooks'
import { useListKeys } from '../../lib/listKeys'
import { mediaUrl } from '../../lib/media'
import { shortcut } from '../../lib/platform'
import Popover from '../pickers/Popover'
import { CloseIcon, PlusIcon } from '../sequences/icons'
import { buttonClass } from '../ui/button'
import { CONFIRM_MS } from '../ui/ConfirmButton'

// The list on the left of Characters, Environments, Products, Outfits, Poses, Directors, Sequences, Storyboards and
// Editor, the same in all of them: the view's name with "＋ New", a search field, and one row per item – its picture,
// name, a line about it and what runs there or is new. The ✕ on a row asks in the row itself before anything is
// deleted. The keys (lib/listKeys): ↑ ↓ (Home, End) move to a row and open it, ↑ from the first goes back to the
// search, ⌫ or Delete asks to delete the row; in the search ↓ goes to the rows, Enter opens the first match and Esc
// clears it; ⌘F goes to the search from anywhere in the view.

/** The side list's width; Prompts and Learnings keep a wider column of their own. */
export const SIDE_LIST_WIDTH = 'w-60'

/** A click this soon after the question appeared is the second half of a double-click, not an answer. */
const ARM_MS = 400

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
  /**
   * What "New …" chosen in ⌘K does instead of pressing the button (Sequences: an empty sequence at once, though the
   * button offers a menu).
   */
  onCreateRequest?: () => void
  /** Under the heading, above the search (Mark all as seen). */
  headerExtra?: ReactNode
  /** In the view's order; undefined until the first load has arrived. */
  items?: readonly T[]
  selectedId?: string
  onSelect: (id: string) => void
  /** "Search sequences…" (from the title) when left out. */
  searchPlaceholder?: string
  /** What the search looks in besides the name (a description, where a film came from). */
  searchText?: (item: T) => string
  /**
   * A heading above each run of items with the same group (Directors: the user's own, then "Ready-made"); items keep
   * the view's order, so a group's items must be next to each other. No headings when left out.
   */
  groupOf?: (item: T) => string | undefined
  /** In the list while there is nothing at all; left out when the main pane already explains (its empty state). */
  emptyText?: ReactNode
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

const fold = (text: string) => text.toLocaleLowerCase('en')

const rowSelector = (id: string) => `[data-side-row="${CSS.escape(id)}"]`

export default function SideList<T extends SideListItem>({
  title,
  createLabel,
  createTitle,
  creating = false,
  onCreate,
  createPanel,
  onCreateRequest,
  headerExtra,
  items,
  selectedId,
  onSelect,
  searchPlaceholder,
  searchText,
  groupOf,
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
  const askedAt = useRef(0)
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
    const t = setTimeout(() => closeQuestion(true), CONFIRM_MS)
    return () => clearTimeout(t)
  }, [asking, busy, error, held])

  // ⌘F (Ctrl+F on Windows): the search, while this view is the one on screen (only one view is mounted).
  useFindShortcut(searchRef)

  function closeQuestion(restoreFocus: boolean) {
    const id = asking
    const hadFocus = !!questionRef.current?.contains(document.activeElement)
    setAsking(undefined)
    setError(undefined)
    setHeld(false)
    if (restoreFocus && hadFocus && id) focusNext.current = id
  }

  const ask = (id: string) => {
    askedAt.current = Date.now()
    setAsking(id)
    setError(undefined)
    setHeld(false)
  }

  const confirm = async (item: T) => {
    if (busy || Date.now() - askedAt.current < ARM_MS) return
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

  const { onSearchKeyDown, onListKeyDown } = useListKeys({
    ids: visible.map((item) => item.id),
    selectedId,
    onSelect,
    searchRef,
    listRef,
    onClearSearch: () => setQuery(''),
    // ⌫ asks as the ✕ does, on the rows that have one (a ready-made director has none).
    onDelete: (id) => {
      if (rowElement(id)?.closest('li')?.querySelector('[data-side-delete]')) ask(id)
    }
  })

  const placeholder = searchPlaceholder ?? `Search ${title.toLowerCase()}…`
  const searchLabel = placeholder.replace(/…$/, '')

  const createAction = createPanel ? () => setCreateOpen((open) => !open) : onCreate
  // "New sequence", "New character" … chosen in ⌘K: the same as a press on the button, once the list has loaded.
  useCreateRequest(!!items && !creating, () =>
    onCreateRequest ? onCreateRequest() : createPanel ? setCreateOpen(true) : onCreate?.()
  )

  return (
    <aside className={`flex ${SIDE_LIST_WIDTH} shrink-0 flex-col border-r border-line`}>
      <ListHeader
        title={title}
        createLabel={createLabel}
        createTitle={createTitle}
        onCreate={createAction}
        disabled={creating}
        buttonRef={createButton}
        popup={createPanel ? { kind: createPanel.popup ?? 'dialog', open: createOpen } : undefined}
      />
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
            onKeyDown={onSearchKeyDown}
            placeholder={placeholder}
            aria-label={searchLabel}
            title={shortcut(`${searchLabel} (⌘F)`)}
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
          emptyText && <p className="px-2 py-2 text-[12px] leading-relaxed text-muted">{emptyText}</p>
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
          <ul ref={listRef} aria-label={title} onKeyDown={onListKeyDown} className="flex flex-col gap-0.5">
            {visible.map((item, i) => (
              <li key={item.id}>
                {groupOf && groupOf(item) !== undefined && (i === 0 || groupOf(visible[i - 1]) !== groupOf(item)) && (
                  <p className={`section-label px-1.5 pb-1 ${i === 0 ? 'pt-0.5' : 'pt-3'}`}>
                    {groupOf(item)}
                  </p>
                )}
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
                      <p role="alert" className="mb-2 select-text break-words text-[11px] leading-snug text-danger">
                        {error}
                      </p>
                    )}
                    {/* Cancel first and with the focus: a stray Enter or a double-click deletes nothing. */}
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        autoFocus
                        disabled={busy}
                        onClick={() => closeQuestion(true)}
                        className={buttonClass('ghost', 'inline')}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void confirm(item)}
                        className={buttonClass('danger', 'inline')}
                      >
                        {busy ? 'Deleting…' : error ? 'Try again' : 'Delete'}
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

/**
 * The top of a list column, inside the window's drag bar: the title (the view's name, or tabs) and "＋ New". The
 * button always reads "New"; its tooltip and accessible name say what it makes ("New sequence"). Prompts and
 * Learnings use it over their own list.
 */
export function ListHeader({
  title,
  createLabel,
  createTitle,
  onCreate,
  disabled,
  buttonRef,
  popup
}: {
  title: ReactNode
  /** "New sequence": the button's accessible name, and its tooltip unless createTitle says more. */
  createLabel: string
  createTitle?: string
  onCreate?: () => void
  disabled?: boolean
  buttonRef?: Ref<HTMLButtonElement>
  /** The button opens a popover (a form or a menu) rather than creating at once: its kind and whether it is open. */
  popup?: { kind: 'dialog' | 'menu'; open: boolean }
}) {
  return (
    <div className="drag flex h-12 shrink-0 items-center justify-between gap-2 pl-4 pr-2.5">
      {typeof title === 'string' ? <span className="min-w-0 truncate font-medium">{title}</span> : title}
      <button
        ref={buttonRef}
        type="button"
        onClick={onCreate}
        disabled={disabled}
        aria-haspopup={popup?.kind}
        aria-expanded={popup?.open}
        aria-label={createLabel}
        title={createTitle ?? createLabel}
        className="no-drag flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
      >
        <PlusIcon size={12} />
        New
      </button>
    </div>
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
  /** What the row's tooltip says after the name ("Own film", what runs there). */
  title?: string
  /** The ✕'s tooltip ("Delete sequence"); a row without one has no ✕ (a ready-made director can't be deleted). */
  deleteTitle?: string
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
        // The whole name first: the row cuts it short.
        title={title ? `${name} – ${title}` : name}
        className={`flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-muted ${
          highlight ? 'bg-accent/10 ring-1 ring-accent' : active ? 'bg-raised' : 'hover:bg-raised/60'
        }`}
      >
        {visual}
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${active ? 'text-text' : 'text-text/90'}`}>{name}</span>
          <span className="block truncate text-[11px] text-muted">{meta}</span>
        </span>
        {/*
          Steps aside where the ✕ takes its place: on hover, and while the row or the ✕ has the keyboard focus. Gone
          while nothing runs (StatusMark renders nothing), so the name gets the room.
        */}
        <span
          className={`flex h-6 min-w-6 shrink-0 items-center justify-end transition-opacity empty:hidden ${
            deleteTitle
              ? 'group-hover:opacity-0 group-has-[[data-side-row]:focus-visible]:opacity-0 group-has-[[data-side-delete]:focus]:opacity-0'
              : ''
          }`}
        >
          {status}
        </span>
      </button>
      {deleteTitle && (
        <button
          type="button"
          data-side-delete
          onClick={onAskDelete}
          title={deleteTitle}
          aria-label={`Delete ${name}`}
          // On a backing of the row's colour with a short fade before it: over the name, where the status was empty.
          className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded bg-raised text-muted opacity-0 transition before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-linear-to-l before:from-raised before:to-transparent before:content-[''] hover:text-danger focus:opacity-100 group-hover:opacity-100 group-has-[[data-side-row]:focus-visible]:opacity-100"
        >
          <CloseIcon size={11} />
        </button>
      )}
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
