import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type Ref
} from 'react'
import { gapMoves, indexForGap, nearestGap, previewPositions } from './reorder'

// Reordering a wrapped row of items (reference thumbnails, audio chips) by HTML5 drag and drop – with an
// insertion marker in the gap a drop would land in – and from the keyboard with ⌥← / ⌥→ on a focused item.
// The hook only says where things would go; the list itself is the parent's state, changed through onMove in
// one update, so a reorder is a single step for undo and for the prompt's tokens following along.

/** What can take focus inside an item, in DOM order (to put focus back on the same control after a move). */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export interface ReorderOptions {
  /**
   * The drag payload's private type (lower case: browsers lower-case it). Private, so dropping an item on a text
   * field pastes nothing, and a list only reacts to its own items.
   */
  type: string
  /** One stable key per item, in the current order; focus follows the key after a keyboard move. */
  keys: readonly string[]
  /** Moves the item at `from` to index `to` (0-based). Left out: the items can't be reordered. */
  onMove?: (from: number, to: number) => void
  /** What a screen reader hears after a move, e.g. "Bilden är nu @Image1, först av 4." */
  describeMove?: (from: number, to: number) => string
}

export interface Reorder {
  /** Whether the items can be reordered (an onMove, and more than one item). */
  enabled: boolean
  /** The item being dragged (its index), or -1. */
  dragging: number
  /** The gap a drop would land in (gap g sits before item g), when dropping there would move something. */
  gap: number | undefined
  /** Item i's index after the drop being shown, for live numbers while dragging (identity otherwise). */
  positions: number[]
  /**
   * The list element's drag handlers. Each returns true when the event was a drag of this kind of item (its own,
   * or another list's, which it refuses), so the caller can leave everything else (dropped files) to itself.
   */
  onDragOver: (e: DragEvent) => boolean
  onDrop: (e: DragEvent) => boolean
  onDragLeave: (e: DragEvent) => void
  /** Props for item i's element: dragging, ⌥← / ⌥→, and a ref for its place on screen. */
  itemProps: (i: number) => HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> }
  /** The last move, for an aria-live region. */
  announcement: string
}

export function useReorder({ type, keys, onMove, describeMove }: ReorderOptions): Reorder {
  const enabled = !!onMove && keys.length > 1
  const elements = useRef(new Map<string, HTMLElement>())
  // The dragged item is kept by key, so a list that changes mid-drag (an agent filling the form) can't make a
  // drop move another item. The ref is for the logic; the state only dims it, a frame later so the drag image
  // the browser takes at dragstart still shows it at full strength.
  const dragKey = useRef<string | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  // Where a drop would land now, with the item it is for: the marker and the live numbers come from this.
  const [target, setTarget] = useState<{ key: string; gap: number }>()
  const [announcement, setAnnouncement] = useState('')
  const pendingFocus = useRef<{ key: string; index: number; control: number; at: number } | null>(null)

  const own = (e: DragEvent): boolean => e.dataTransfer.types.includes(type)
  const from = (): number => (dragKey.current === null ? -1 : keys.indexOf(dragKey.current))

  const gapAt = (x: number, y: number): number | undefined =>
    nearestGap(
      keys.map((k) => elements.current.get(k)?.getBoundingClientRect()),
      x,
      y
    )?.gap

  const clear = (): void => {
    dragKey.current = null
    setDraggingKey(null)
    setTarget(undefined)
  }

  // Focus back on the moved item (on the same control in it): React may have moved the focused element in the
  // DOM, which blurs it. Only once the list shows the move (the parent's store may render it a beat later), and
  // only right after a keyboard move, so a late render never steals focus.
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    if (Date.now() - pending.at > 1000) {
      pendingFocus.current = null
      return
    }
    const item = elements.current.get(pending.key)
    if (!item || keys.indexOf(pending.key) === pending.index) return
    pendingFocus.current = null
    const control = pending.control === -1 ? undefined : item.querySelectorAll<HTMLElement>(FOCUSABLE)[pending.control]
    if (document.activeElement === (control ?? item)) return
    // The item first: a control shown only while its item has focus (a thumbnail's ✕) can't take focus before.
    if (item.tabIndex >= 0) item.focus({ preventScroll: true })
    control?.focus({ preventScroll: true })
  })

  const move = (i: number, to: number): void => {
    if (!onMove || to === i || to < 0 || to >= keys.length) return
    onMove(i, to)
    setAnnouncement(describeMove?.(i, to) ?? '')
  }

  const onDragOver = (e: DragEvent): boolean => {
    if (!own(e)) return false
    const i = from()
    if (i === -1 || !enabled) {
      // Another list's item: it can't be dropped here.
      e.dataTransfer.dropEffect = 'none'
      return true
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const g = gapAt(e.clientX, e.clientY)
    const next = g !== undefined && gapMoves(i, g) ? g : undefined
    const key = keys[i]
    const same = next === undefined ? !target : target?.key === key && target.gap === next
    if (!same) setTarget(next === undefined ? undefined : { key, gap: next })
    return true
  }

  const onDrop = (e: DragEvent): boolean => {
    if (!own(e)) return false
    const i = from()
    if (i !== -1 && enabled) {
      e.preventDefault()
      const g = gapAt(e.clientX, e.clientY)
      if (g !== undefined && gapMoves(i, g)) move(i, indexForGap(i, g))
    }
    clear()
    return true
  }

  const onDragLeave = (e: DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(undefined)
  }

  const itemProps = (i: number): HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> } => {
    const key = keys[i]
    return {
      ref: (el: HTMLElement | null) => {
        if (el) elements.current.set(key, el)
        else elements.current.delete(key)
      },
      ...(enabled
        ? {
            draggable: true,
            onDragStart: (e: DragEvent) => {
              // A drag that starts on a control inside the item (a slider, a text field) is that control's own.
              if (e.target !== e.currentTarget && (e.target as HTMLElement).closest?.('input, textarea, select')) return
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData(type, key)
              dragKey.current = key
              requestAnimationFrame(() => {
                if (dragKey.current === key) setDraggingKey(key)
              })
            },
            onDragEnd: clear,
            onKeyDown: (e: KeyboardEvent) => {
              if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              // ⌥← / ⌥→ belong to the item even at the ends, where they do nothing.
              e.preventDefault()
              e.stopPropagation()
              const to = e.key === 'ArrowLeft' ? i - 1 : i + 1
              if (to < 0 || to >= keys.length) return
              const item = elements.current.get(key)
              const active = document.activeElement
              const control =
                !item || active === item || !(active instanceof HTMLElement)
                  ? -1
                  : [...item.querySelectorAll<HTMLElement>(FOCUSABLE)].indexOf(active)
              pendingFocus.current = { key, index: i, control, at: Date.now() }
              move(i, to)
            }
          }
        : {})
    }
  }

  const moving = target ? keys.indexOf(target.key) : -1
  const gap = moving === -1 ? undefined : target?.gap
  const dimmed = draggingKey === null ? -1 : keys.indexOf(draggingKey)
  return {
    enabled,
    dragging: dimmed === -1 ? moving : dimmed,
    gap,
    positions: previewPositions(keys.length, moving, gap),
    onDragOver,
    onDrop,
    onDragLeave,
    itemProps,
    announcement
  }
}

/**
 * Stable keys for a list that may (rarely) hold the same value twice: the value, and for a repeat its
 * occurrence number, so every item keeps its own key when the list is reordered.
 */
export function occurrenceKeys(values: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return values.map((v) => {
    const n = seen.get(v) ?? 0
    seen.set(v, n + 1)
    return n ? `${v}\u0000${n}` : v
  })
}
