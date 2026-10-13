import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** The element the panel is attached to; clicks on it don't count as "outside". */
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** Which anchor edge the panel lines up with. */
  align?: 'start' | 'end'
  width?: number
  /** Upper bound; the panel shrinks to the space available on screen. */
  maxHeight?: number
  label?: string
  children: ReactNode
}

interface Placement {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

const GAP = 6
const MARGIN = 8

/**
 * Floating panel anchored to a button. Rendered in a portal with fixed positioning so it isn't
 * clipped by scrolling sidebars or card overflow.
 */
export default function Popover({
  anchorRef,
  open,
  onClose,
  align = 'start',
  width = 320,
  maxHeight = 440,
  label,
  children
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<Placement>()

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined)
      return
    }
    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.min(width, vw - 2 * MARGIN)
      const left = Math.max(MARGIN, Math.min(align === 'start' ? r.left : r.right - w, vw - w - MARGIN))
      const below = vh - r.bottom - GAP - MARGIN
      const above = r.top - GAP - MARGIN
      // Open downwards unless the space below is cramped and there's more room above.
      if (below >= Math.min(maxHeight, 260) || below >= above) {
        setPlace({ top: r.bottom + GAP, left, width: w, maxHeight: Math.min(maxHeight, below) })
      } else {
        setPlace({ bottom: vh - r.top + GAP, left, width: w, maxHeight: Math.min(maxHeight, above) })
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, align, width, maxHeight])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Marked as handled: a dialog underneath listening on the same node (Modal) leaves it alone.
      e.preventDefault()
      onClose()
      anchorRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      className="no-drag fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-panel text-text shadow-2xl shadow-black/60"
      style={{
        top: place?.top,
        bottom: place?.bottom,
        left: place?.left ?? 0,
        width: place?.width ?? width,
        maxHeight: place?.maxHeight ?? maxHeight,
        // Transparent (not visibility: hidden) until it has measured where it fits, which happens before the
        // first paint anyway: a hidden element can't take focus, so autoFocus inside the panel would miss.
        opacity: place ? 1 : 0,
        pointerEvents: place ? undefined : 'none'
      }}
    >
      {children}
    </div>,
    document.body
  )
}
