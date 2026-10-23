import type { KeyboardEvent, RefObject } from 'react'
import { isSubmitKey } from './platform'

// The keys of a list beside a search field: the side lists (Sequences, Storyboards, Editor, Characters…, Directors),
// Prompts and Learnings, the same in all of them. The rows carry data-side-row={id} and can take the focus (buttons).
//   In the list: ↑ ↓ (Home, End) move to a row and open it – the selection follows the focus. ↑ from the first row
//   goes back to the search. ⌘↵ runs the view's primary action on the row (Prompts: generate with it); ⌫ or Delete
//   asks to delete it (⌘⌫ too).
//   In the search: ↓ goes to the open row (or the first), Enter opens the first match, Esc clears the search.

export interface ListKeys {
  /** The rows the list shows, in their order (what the search leaves). */
  ids: readonly string[]
  /** The rows that match the search, when the list also keeps rows that don't (the open one): Enter's choice. */
  matchIds?: readonly string[]
  /** The open row. */
  selectedId?: string
  onSelect: (id: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** The element that holds the rows (and gets onListKeyDown). */
  listRef: RefObject<HTMLElement | null>
  /** Esc in a search with text in it. */
  onClearSearch?: () => void
  /** ⌘↵ on a row. */
  onModEnter?: (id: string) => void
  /** ⌫ / Delete on a row: ask to delete it. */
  onDelete?: (id: string) => void
}

const rowSelector = (id: string) => `[data-side-row="${CSS.escape(id)}"]`

export function useListKeys({
  ids,
  matchIds = ids,
  selectedId,
  onSelect,
  searchRef,
  listRef,
  onClearSearch,
  onModEnter,
  onDelete
}: ListKeys): {
  onSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  onListKeyDown: (e: KeyboardEvent<HTMLElement>) => void
} {
  const row = (id: string) => listRef.current?.querySelector<HTMLElement>(rowSelector(id)) ?? null

  /** Focuses a row and opens it (unless it is the open one already). */
  const go = (id: string): void => {
    row(id)?.focus()
    if (id !== selectedId) onSelect(id)
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      if (!e.currentTarget.value || !onClearSearch) return
      e.preventDefault()
      onClearSearch()
    } else if (e.key === 'ArrowDown') {
      const target = selectedId && ids.includes(selectedId) ? selectedId : ids[0]
      if (!target) return
      e.preventDefault()
      go(target)
    } else if (e.key === 'Enter') {
      if (!matchIds[0]) return
      e.preventDefault()
      onSelect(matchIds[0])
    }
  }

  // Only from a row itself: a button inside the row (the ✕) and a question in its place keep their keys.
  const onListKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement
    const id = target.getAttribute('data-side-row')
    if (id === null) return
    if (isSubmitKey(e)) {
      if (!onModEnter) return
      e.preventDefault()
      onModEnter(id)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // ⌘⌫ is the Mac's own "move to Trash", so it counts; with ⌥, ⇧ or ⌃ it is something else.
      if (!onDelete || e.altKey || e.shiftKey || e.ctrlKey) return
      e.preventDefault()
      onDelete(id)
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const at = ids.indexOf(id)
    if (e.key === 'ArrowUp' && at <= 0) {
      searchRef.current?.focus()
      return
    }
    const next =
      e.key === 'ArrowDown' ? ids[at + 1] : e.key === 'ArrowUp' ? ids[at - 1] : e.key === 'Home' ? ids[0] : ids.at(-1)
    if (next !== undefined) go(next)
  }

  return { onSearchKeyDown, onListKeyDown }
}
