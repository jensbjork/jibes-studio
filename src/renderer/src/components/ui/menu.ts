import type { KeyboardEvent } from 'react'

// The rows of a popover menu (role="menu") and its keys, shared by every ⋯ menu, take menu and filter menu.

export const menuRow =
  'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left outline-none transition hover:bg-raised focus-visible:bg-raised disabled:pointer-events-none disabled:opacity-40 aria-disabled:opacity-40'

/** The items ↑ ↓ can land on: marked data-menu-item, and not disabled either way. */
const ITEMS = '[data-menu-item]:not(:disabled):not([aria-disabled="true"])'

/**
 * ↑ / ↓ move between a menu's items (those marked data-menu-item), round the ends, like a native menu; Home and End
 * go to the first and the last. Disabled items are skipped.
 */
export function onMenuKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)]
  if (!items.length) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (at + 1) % items.length
          : (at <= 0 ? items.length : at) - 1
  items[next].focus()
}

/** The first item to give the focus when a menu opens: the checked choice if there is one, else the first. */
export function firstMenuItem(menu: HTMLElement | null): HTMLElement | null {
  return menu?.querySelector<HTMLElement>(`${ITEMS}[aria-checked="true"]`) ?? menu?.querySelector<HTMLElement>(ITEMS) ?? null
}
