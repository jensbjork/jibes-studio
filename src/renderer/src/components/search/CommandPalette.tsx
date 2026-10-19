import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { mediaUrl } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { isModOnly, shortcut } from '../../lib/platform'
import { SearchIcon } from '../feed/icons'
import { Spinner } from '../work/StatusMark'
import { commandEntries, GROUPS, libraryEntries, recentEntries, type Entry, type PaletteActions } from './entries'
import { excerpt, flatten, matchRanges, queryTokens, type Range } from './match'
import { rank, type ResultGroup } from './rank'
import { usePaletteData } from './usePaletteData'

// ⌘K: one field that searches the whole window – its places and actions, and everything in the library: assets,
// prompts, sequences and their clips, storyboards with their boards and transitions, edits, clips, images and films –
// and opens the result where the rest of the app opens it. Grouped and ranked as you type (rank.ts); ↑ ↓ and Enter,
// or the mouse; Esc closes. Opens from anywhere, text fields included, except over a dialog waiting for an answer.

/** A dialog that waits for an answer: ⌘K doesn't open over it (it would navigate away underneath). */
const MODAL = '[aria-modal="true"], [role="alertdialog"]'

/**
 * ⌘K (Ctrl+K on Windows). Not used by the views (⌘F searches a list, ⌘⇧F is focus mode, ⌘↵ sends) or the default
 * menu.
 */
function isPaletteShortcut(e: KeyboardEvent): boolean {
  return isModOnly(e) && e.key.toLowerCase() === 'k'
}

let openPalette: (() => void) | undefined

/** Opens the palette, as ⌘K does (the sidebar's search button). */
export function openCommandPalette(): void {
  openPalette?.()
}

interface Props {
  /** Navigates like the sidebar (an open panel beside it closes). */
  navigate: Navigate
  onOpenPanel: (panel: 'agent' | 'work') => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

export default function CommandPalette(props: Props) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  // Where the focus was, to go back to when the palette is dismissed.
  const returnFocus = useRef<HTMLElement | null>(null)

  const show = useCallback(() => {
    if (openRef.current || document.querySelector(MODAL)) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openRef.current = true
    setOpen(true)
  }, [])

  const close = useCallback((restoreFocus: boolean) => {
    openRef.current = false
    setOpen(false)
    const target = returnFocus.current
    returnFocus.current = null
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    openPalette = show
    return () => {
      if (openPalette === show) openPalette = undefined
    }
  }, [show])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isPaletteShortcut(e)) return
      if (!openRef.current && document.querySelector(MODAL)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (openRef.current) close(true)
      else show()
    }
    // Capture phase on the window: wherever the focus is (a prompt field too), before any view's own keys.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [show, close])

  return open ? <Palette {...props} onClose={close} /> : null
}

interface Option {
  key: string
  entry: Entry
}

function Palette({
  navigate,
  onOpenPanel,
  sidebarCollapsed,
  onToggleSidebar,
  onClose
}: Props & { onClose: (restoreFocus: boolean) => void }) {
  const { data, loading } = usePaletteData(true)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  // The row Enter opens, by key so it stays put while more of the library arrives; undefined: the first row.
  const [activeKey, setActiveKey] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (i: number) => `${baseId}-option-${i}`

  const commands = useMemo(() => commandEntries(sidebarCollapsed), [sidebarCollapsed])
  const library = useMemo(() => libraryEntries(data), [data])
  const entries = useMemo(() => [...commands, ...library], [commands, library])
  const recent = useMemo(() => recentEntries(library), [library])
  const groups = useMemo(() => rank(entries, recent, deferredQuery), [entries, recent, deferredQuery])
  const tokens = useMemo(() => queryTokens(deferredQuery), [deferredQuery])
  const options = useMemo<Option[]>(
    () => groups.flatMap((g) => g.hits.map((h) => ({ key: `${g.id}:${h.entry.key}`, entry: h.entry }))),
    [groups]
  )
  const found = options.findIndex((o) => o.key === activeKey)
  const activeIndex = options.length ? Math.max(0, found) : -1

  // The active row in view; the first one with its group's heading.
  useEffect(() => {
    if (activeIndex <= 0) listRef.current?.scrollTo({ top: 0 })
    else document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, options])

  const actions: PaletteActions = { navigate, openPanel: onOpenPanel, toggleSidebar: onToggleSidebar }
  const choose = (entry: Entry) => {
    onClose(!!entry.keepsFocus)
    entry.run(actions)
  }

  const move = (delta: number) => {
    if (!options.length) return
    const next = (activeIndex + delta + options.length) % options.length
    setActiveKey(options[next].key)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // The views' own keys (a list's ⌘F, the Editor's player, a popover's Esc) stay out while the palette is open.
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        move(e.key === 'ArrowDown' ? 1 : -1)
        break
      case 'PageDown':
      case 'PageUp':
        e.preventDefault()
        if (options.length) {
          const step = e.key === 'PageDown' ? 8 : -8
          setActiveKey(options[Math.min(options.length - 1, Math.max(0, activeIndex + step))].key)
        }
        break
      case 'Enter':
        e.preventDefault()
        if (activeIndex !== -1) choose(options[activeIndex].entry)
        break
      case 'Escape':
        e.preventDefault()
        onClose(true)
        break
      case 'Tab':
        // The field is the palette's only stop.
        e.preventDefault()
        break
    }
  }

  const searching = deferredQuery.trim() !== ''
  const status = !searching
    ? ''
    : options.length
      ? `${options.length} ${options.length === 1 ? 'result' : 'results'}`
      : loading
        ? 'Searching…'
        : 'No results'
  let index = 0

  return createPortal(
    <div
      // no-drag: the views' title-bar drag regions lie under it.
      className="no-drag fixed inset-0 z-[70] flex items-start justify-center bg-black/50 px-6 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(true)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Studio"
        onKeyDown={(e) => e.stopPropagation()}
        className="flex max-h-[min(580px,calc(100vh-14vh-24px))] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-line bg-panel text-text shadow-2xl shadow-black/60"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <SearchIcon size={15} className="shrink-0 text-muted" />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-label="Search Studio"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex !== -1 ? optionId(activeIndex) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveKey(undefined)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search Studio or jump to a view…"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted/70"
          />
          {loading && <Spinner size={12} className="text-muted" />}
          <kbd className="shrink-0 rounded border border-line px-1.5 py-px font-sans text-[10px] text-muted">esc</kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto p-1.5">
          {groups.map((group) => (
            <Group key={group.id} group={group} idPrefix={baseId}>
              {group.hits.map(({ entry }) => {
                const i = index++
                return (
                  <Row
                    key={entry.key}
                    id={optionId(i)}
                    entry={entry}
                    tokens={tokens}
                    active={i === activeIndex}
                    onHover={() => {
                      if (i !== activeIndex) setActiveKey(options[i].key)
                    }}
                    onPick={() => choose(entry)}
                  />
                )
              })}
            </Group>
          ))}
          {searching && !options.length && (
            <p className="px-4 py-8 text-center text-muted">
              {loading ? 'Searching…' : `Nothing in Studio matches “${deferredQuery.trim()}”.`}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>
            <Key>↑</Key>
            <Key>↓</Key> to move
          </span>
          <span>
            <Key>↵</Key> to open
          </span>
          <span>
            <Key>esc</Key> to close
          </span>
          <span className="ml-auto">
            <Key>{shortcut('⌘K')}</Key> from anywhere
          </span>
        </div>
        <span className="sr-only" aria-live="polite">
          {status}
        </span>
      </div>
    </div>,
    document.body
  )
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-1 inline-block min-w-4 rounded border border-line px-1 text-center font-sans text-[10px] leading-4 text-muted">
      {children}
    </kbd>
  )
}

function Group({ group, idPrefix, children }: { group: ResultGroup; idPrefix: string; children: ReactNode }) {
  const headingId = `${idPrefix}-group-${group.id}`
  const shown = group.hits.length
  const more =
    group.total > shown ? `${GROUPS[group.id].newestFirst ? 'newest ' : ''}${shown} of ${group.total}` : undefined
  return (
    <div role="group" aria-labelledby={headingId} className="pb-1">
      <div
        id={headingId}
        role="presentation"
        className="flex items-baseline justify-between gap-2 px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70"
      >
        <span>{group.label}</span>
        {more && <span className="font-normal normal-case tracking-normal">{more}</span>}
      </div>
      {children}
    </div>
  )
}

interface RowProps {
  id: string
  entry: Entry
  tokens: readonly string[]
  active: boolean
  onHover: () => void
  onPick: () => void
}

function Row({ id, entry, tokens, active, onHover, onPick }: RowProps) {
  const title = flatten(entry.title)
  const titleText = excerpt(title, matchRanges(title, tokens), 160)
  const detail = entry.detail ? flatten(entry.detail) : ''
  const detailRanges = detail ? matchRanges(detail, tokens) : []
  const second = detailRanges.length
    ? excerpt(detail, detailRanges, 180)
    : entry.meta
      ? { text: flatten(entry.meta), ranges: [] as Range[] }
      : undefined
  // Library items get a picture and a second line; places and actions are one quiet line.
  const rich = entry.thumb !== undefined || second !== undefined

  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      // The field keeps the focus (and the keys) while a row is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={`flex cursor-default items-center gap-3 rounded-md px-2.5 ${rich ? 'py-1.5' : 'h-8'} ${
        active ? 'bg-raised text-text' : 'text-text/90'
      }`}
    >
      {rich ? <Visual entry={entry} /> : <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted">{entry.icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">
            <Highlighted text={titleText.text} ranges={titleText.ranges} />
          </span>
          {entry.context && <span className="shrink-0 text-[11.5px] text-muted">{entry.context}</span>}
        </div>
        {second && (
          <div className="truncate text-[11.5px] text-muted">
            <Highlighted text={second.text} ranges={second.ranges} />
          </div>
        )}
      </div>
      {entry.hint && (
        <span className={`shrink-0 text-[11px] ${active ? 'text-muted' : 'text-muted/60'}`}>{entry.hint}</span>
      )}
    </div>
  )
}

/** A 32 px picture (an asset's cover, a clip's poster, an image), or the entry's icon in its place. */
function Visual({ entry }: { entry: Entry }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised text-muted">
      {entry.thumb && !failed ? (
        <img
          src={mediaUrl(entry.thumb)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        entry.icon
      )}
    </span>
  )
}

function Highlighted({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (!ranges.length) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={i} className="rounded-[3px] bg-accent/25 text-text">
        {text.slice(start, end)}
      </mark>
    )
    at = end
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
