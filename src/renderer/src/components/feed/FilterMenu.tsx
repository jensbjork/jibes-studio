import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckIcon } from '../icons'
import Popover from '../pickers/Popover'
import { CloseIcon } from '../sequences/icons'
import { firstMenuItem, menuRow, onMenuKeyDown } from '../ui/menu'
import { ChevronDownIcon } from './icons'

export interface MenuOption<T> {
  id: T
  label: ReactNode
  /** Shown faintly at the end of the row, e.g. how many clips match. */
  hint?: ReactNode
  /** Plain text of the label, for the tooltip and the search. */
  text?: string
}

interface Props<T> {
  /** What the filter is about: "Status". Shown while nothing is chosen. */
  title: string
  /** What is chosen, as the button shows it: "Klara". */
  valueLabel?: string
  value?: T
  options: MenuOption<T>[]
  onChange: (value: T | undefined) => void
  /** The first row, which clears the filter. */
  allLabel?: string
  width?: number
  /** Content above the options (e.g. a search field); the options are then given by the caller. */
  header?: ReactNode
  empty?: ReactNode
  /** Called when the menu opens or closes. */
  onOpenChange?: (open: boolean) => void
}

/**
 * A toolbar filter: a button that opens a short list of choices. Once something is chosen the button turns
 * into a chip showing the choice, with ✕ to remove it.
 */
export default function FilterMenu<T extends string | number>({
  title,
  valueLabel,
  value,
  options,
  onChange,
  allLabel = 'All',
  width = 240,
  header,
  empty,
  onOpenChange
}: Props<T>) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpenState] = useState(false)
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  const close = useCallback(() => setOpen(false), [setOpen])
  const active = value !== undefined
  const headerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // The keyboard goes into the menu: the search field, else the chosen row. Done a frame after opening, since
  // the popover is invisible (and so not focusable) until it has measured where it fits; autoFocus would miss.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const target = headerRef.current?.querySelector<HTMLElement>('input') ?? firstMenuItem(menuRef.current)
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  const choose = (next: T | undefined) => {
    onChange(next)
    close()
    anchor.current?.focus()
  }

  return (
    <div
      className={`no-drag flex h-7 shrink-0 items-center rounded-full border text-[12px] transition ${
        active ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
      }`}
    >
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active ? `${title}: ${valueLabel ?? ''}` : `Filter by ${title.toLocaleLowerCase('en')}`}
        className={`flex h-full max-w-56 items-center gap-1 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-muted ${
          active ? 'pl-2.5 pr-1' : 'px-2.5'
        }`}
      >
        <span className="truncate">{active ? (valueLabel ?? title) : title}</span>
        {!active && <ChevronDownIcon size={11} className="shrink-0 opacity-70" />}
      </button>
      {active && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title={`Remove the ${title.toLocaleLowerCase('en')} filter`}
          className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-black/30 hover:text-text"
        >
          <CloseIcon size={9} />
        </button>
      )}

      <Popover anchorRef={anchor} open={open} onClose={close} width={width} label={title}>
        {header && <div ref={headerRef}>{header}</div>}
        <div ref={menuRef} role="menu" aria-label={title} onKeyDown={onMenuKeyDown} className="min-h-0 overflow-y-auto p-1">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!active}
            data-menu-item
            onClick={() => choose(undefined)}
            className={menuRow}
          >
            <Check on={!active} />
            <span className="min-w-0 flex-1 truncate">{allLabel}</span>
          </button>
          {options.map((o) => (
            <button
              key={String(o.id)}
              type="button"
              role="menuitemradio"
              aria-checked={o.id === value}
              data-menu-item
              title={o.text}
              onClick={() => choose(o.id)}
              className={menuRow}
            >
              <Check on={o.id === value} />
              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{o.label}</span>
              {o.hint !== undefined && <span className="shrink-0 text-[11px] text-muted tabular-nums">{o.hint}</span>}
            </button>
          ))}
          {!options.length && empty}
        </div>
      </Popover>
    </div>
  )
}

/** The chosen row's check, as in the ⋯ menus' radio sections. */
function Check({ on }: { on: boolean }) {
  return <CheckIcon size={12} className={`shrink-0 text-accent ${on ? '' : 'invisible'}`} />
}
