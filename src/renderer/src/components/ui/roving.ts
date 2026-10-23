import type { KeyboardEvent } from 'react'
import { focusedWithKeyboard, trackFocusOrigin } from '../../lib/focusOrigin'

// Arrow keys in a group of choices (tabs, a segmented control, a row of tiles), as in a native radio group: the
// group is one Tab stop – the chosen item has tabIndex 0, the others -1 – and ← → (↑ ↓ too for a vertical group)
// move to the next item and choose it, round the ends; Home and End go to the first and the last. The items carry
// data-roving-id={id}; disabled ones are skipped.

// Followed from the start, so keyboardOnly knows how the item with the focus got it.
trackFocusOrigin()

export interface RovingOptions {
  /**
   * Only while the item was reached with the keyboard (Tab). In the Editor, ← → after a click on a tab belong to the
   * player.
   */
  keyboardOnly?: boolean
  /** ↑ ↓ as well as ← →: a list of choices one under the other. */
  vertical?: boolean
}

/**
 * The group's onKeyDown: `ids` are the items in order, `current` the chosen one, `pick` chooses another. Keys with a
 * modifier (⌥← moves an item elsewhere) and keys from anything but an item are left alone.
 */
export function rovingKeyDown<T>(
  e: KeyboardEvent<HTMLElement>,
  ids: readonly T[],
  current: T,
  pick: (id: T) => void,
  opts: RovingOptions = {}
): void {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  const back = e.key === 'ArrowLeft' || (!!opts.vertical && e.key === 'ArrowUp')
  const forward = e.key === 'ArrowRight' || (!!opts.vertical && e.key === 'ArrowDown')
  if (!back && !forward && e.key !== 'Home' && e.key !== 'End') return
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-roving-id]')
  if (!item || !e.currentTarget.contains(item)) return
  if (opts.keyboardOnly && !focusedWithKeyboard(e.target)) return

  const element = (id: T) =>
    e.currentTarget.querySelector<HTMLElement>(`[data-roving-id="${CSS.escape(String(id))}"]`)
  const usable = (id: T) => {
    const el = element(id)
    return !!el && !el.matches(':disabled, [aria-disabled="true"]')
  }
  const n = ids.length
  if (!n) return
  e.preventDefault()
  // From the item that has the focus (it may not be the chosen one yet), else from the chosen one.
  const focused = ids.findIndex((id) => String(id) === item.dataset.rovingId)
  const at = focused !== -1 ? focused : Math.max(0, ids.indexOf(current))
  const order =
    e.key === 'Home'
      ? ids.map((_, i) => i)
      : e.key === 'End'
        ? ids.map((_, i) => n - 1 - i)
        : ids.map((_, i) => (at + (forward ? i + 1 : n - i - 1)) % n)
  const next = order.map((i) => ids[i]).find(usable)
  if (next === undefined) return
  element(next)?.focus()
  if (next !== current) pick(next)
}
