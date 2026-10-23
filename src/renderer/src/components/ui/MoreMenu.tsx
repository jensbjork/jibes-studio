import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ipcErrorMessage } from '../../lib/hooks'
import { CheckIcon } from '../icons'
import Popover from '../pickers/Popover'
import { MoreIcon } from '../sequences/icons'
import { buttonClass } from './button'
import { firstMenuItem, menuRow, onMenuKeyDown } from './menu'

// The ⋯ of a header or an editor: the rarer actions, always in the same order – settings as radio sections, "Open
// folder", "Mark all as seen", the other rare items, a divider, then "Delete …", which asks inside the menu.

/** A click this soon after the question appeared is the second half of a double-click, not an answer. */
const ARM_MS = 400

/** What the confirm button says while the deleting runs. */
function busyLabel(confirmLabel = 'Delete'): string {
  return confirmLabel === 'Delete' ? 'Deleting…' : confirmLabel === 'Remove' ? 'Removing…' : `${confirmLabel}…`
}

/** The question "Delete …" asks in place of the menu. */
export interface MoreMenuConfirm {
  /** "Delete “Harbour walk”?" */
  question: string
  /** What deleting does, shown under the question. */
  note?: ReactNode
  /** "Delete" (the default), or "Remove" when the thing itself survives elsewhere. */
  confirmLabel?: string
  /** A promise keeps the question open ("Deleting…") until it settles; a rejection is shown in place. */
  onConfirm: () => void | Promise<void>
}

export interface MoreMenuControls {
  /** Closes the menu (and gives the focus back to ⋯). MenuItem and MenuRadio do this themselves. */
  close: () => void
  /** Turns the menu into the question; Cancel and Esc close it. */
  confirm: (spec: MoreMenuConfirm) => void
}

const MenuContext = createContext<MoreMenuControls | undefined>(undefined)

interface Props {
  /** The button's tooltip and the menu's name. */
  title?: string
  /** Which edge of ⋯ the menu lines up with. */
  align?: 'start' | 'end'
  width?: number
  /** The menu's rows (MenuItem, MenuRadio, MenuHeading, MenuDivider), given the menu's controls. */
  children: (menu: MoreMenuControls) => ReactNode
}

/**
 * ⋯ and its menu. ↑ ↓ (Home, End) move, Enter chooses, Esc closes and gives the focus back to ⋯. The rows close the
 * menu themselves; "Delete…" calls confirm() and the menu asks: the question, a visible note, [Cancel] [Delete], with
 * the focus on Cancel.
 */
export default function MoreMenu({ title = 'More options', align = 'end', width = 260, children }: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<MoreMenuConfirm>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const askedAt = useRef(0)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  const close = (): void => {
    if (busy) return
    const hadFocus = !!document.activeElement?.closest('[data-more-menu]')
    setOpen(false)
    setAsking(undefined)
    setError(undefined)
    if (hadFocus) anchor.current?.focus()
  }

  const controls: MoreMenuControls = {
    close,
    confirm: (spec) => {
      askedAt.current = Date.now()
      setError(undefined)
      setAsking(spec)
      setOpen(true)
    }
  }

  // The focus goes into the menu as it opens (the checked choice, else the first row).
  useEffect(() => {
    if (open && !asking) firstMenuItem(menuRef.current)?.focus()
  }, [open, asking])

  const answer = (): void => {
    if (!asking || busy || Date.now() - askedAt.current < ARM_MS) return
    let result: void | Promise<void>
    try {
      result = asking.onConfirm()
    } catch (e) {
      setError(ipcErrorMessage(e))
      return
    }
    if (!(result instanceof Promise)) {
      close()
      return
    }
    setBusy(true)
    setError(undefined)
    result.then(
      () => {
        if (!mounted.current) return
        setBusy(false)
        setOpen(false)
        setAsking(undefined)
        anchor.current?.focus()
      },
      (e: unknown) => {
        if (!mounted.current) return
        setBusy(false)
        setError(ipcErrorMessage(e))
      }
    )
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        className="no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
      >
        <MoreIcon size={14} />
      </button>
      <Popover anchorRef={anchor} open={open} onClose={close} align={align} width={width} label={title}>
        <div data-more-menu className="contents">
          {asking ? (
            <div className="p-3">
              <p className={`break-words ${asking.note ? 'mb-1' : 'mb-3'}`}>{asking.question}</p>
              {asking.note && <div className="mb-3 text-[12px] leading-relaxed text-muted">{asking.note}</div>}
              {error && (
                <p role="alert" className="mb-3 select-text break-words text-[12px] leading-relaxed text-danger">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-1.5">
                <button type="button" autoFocus disabled={busy} onClick={close} className={buttonClass('ghost', 'sm')}>
                  Cancel
                </button>
                <button type="button" disabled={busy} onClick={answer} className={buttonClass('danger', 'sm')}>
                  {busy ? busyLabel(asking.confirmLabel) : error ? 'Try again' : (asking.confirmLabel ?? 'Delete')}
                </button>
              </div>
            </div>
          ) : (
            <div ref={menuRef} role="menu" aria-label={title} onKeyDown={onMenuKeyDown} className="p-1">
              <MenuContext.Provider value={controls}>{children(controls)}</MenuContext.Provider>
            </div>
          )}
        </div>
      </Popover>
    </>
  )
}

export { MoreMenu }

/** A row of the menu: it closes the menu, then runs onSelect. */
export function MenuItem({
  icon,
  onSelect,
  disabled,
  danger,
  hint,
  title,
  children
}: {
  /** 13 px, muted, before the label. */
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  /** "Delete…": muted, red on hover. */
  danger?: boolean
  /** A second, muted line under the label. */
  hint?: ReactNode
  /** The tooltip, e.g. "Open the folder in Finder". */
  title?: string
  children: ReactNode
}) {
  const menu = useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item
      disabled={disabled}
      title={title}
      onClick={() => {
        menu?.close()
        onSelect()
      }}
      className={`${menuRow} ${hint ? 'flex-col items-start gap-0.5' : ''} ${
        danger ? 'text-muted hover:text-danger focus-visible:text-danger' : ''
      }`}
    >
      {hint ? (
        <>
          <span className="flex items-center gap-2">
            {icon && <span className="flex shrink-0 text-muted">{icon}</span>}
            {children}
          </span>
          <span className={`text-[11px] leading-snug text-muted ${icon ? 'pl-[21px]' : ''}`}>{hint}</span>
        </>
      ) : (
        <>
          {icon && <span className="flex shrink-0 text-muted">{icon}</span>}
          {children}
        </>
      )}
    </button>
  )
}

/** The line between the menu's groups (before "Delete…"). */
export function MenuDivider() {
  return <div role="separator" className="mx-2 my-1 border-t border-line" />
}

/** The heading of a radio section ("Format", "Export format"). */
export function MenuHeading({ children }: { children: ReactNode }) {
  return <p className="section-label px-2.5 pb-1 pt-1.5">{children}</p>
}

/** One choice of a radio section: a check when it is the chosen one, a muted hint on the right. */
export function MenuRadio({
  checked,
  onSelect,
  children,
  hint
}: {
  checked: boolean
  onSelect: () => void
  children: ReactNode
  hint?: ReactNode
}) {
  const menu = useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-menu-item
      onClick={() => {
        menu?.close()
        if (!checked) onSelect()
      }}
      className={menuRow}
    >
      <CheckIcon size={12} className={`shrink-0 text-accent ${checked ? '' : 'invisible'}`} />
      <span className="flex-1">{children}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </button>
  )
}
