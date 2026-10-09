import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// The collapsed sidebar's tooltips: the row's name and, below it, what is going on there ("Sekvenser" /
// "2 tagningar genereras · 1 ny tagning"). Native titles show late and plain; these appear 250 ms after the
// pointer settles, at once on keyboard focus, beside the rail, and go away with Esc.

const HOVER_DELAY_MS = 250

interface Anchor {
  top: number
  left: number
}

interface TriggerProps {
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onPointerDown: () => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: () => void
}

/**
 * Tooltip for one rail button. `enabled` is false while the sidebar is expanded (the row shows its label and
 * carries a plain `title` instead). Spread `trigger` on the button and render `tooltip` anywhere.
 */
export function useRailTooltip(
  enabled: boolean,
  label: string,
  status?: string
): { trigger: Partial<TriggerProps>; tooltip: ReactNode } {
  const [anchor, setAnchor] = useState<Anchor>()
  const timer = useRef<number | undefined>(undefined)
  const id = useId()

  const clear = (): void => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
  }
  const hide = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    setAnchor(undefined)
  }, [])

  const place = (el: HTMLElement): Anchor => {
    const rect = el.getBoundingClientRect()
    // Beside the rail, whatever its width is right now (it may still be animating).
    const rail = el.closest('aside')?.getBoundingClientRect().right ?? rect.right
    return { top: rect.top + rect.height / 2, left: rail + 8 }
  }

  useEffect(() => {
    if (!enabled) hide()
  }, [enabled, hide])
  useEffect(() => () => clear(), [])

  // Esc hides it; a scroll of the rail would leave it pointing at the wrong row, so that hides it too.
  useEffect(() => {
    if (!anchor) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [anchor, hide])

  if (!enabled) return { trigger: {}, tooltip: null }

  const trigger: TriggerProps = {
    onPointerEnter: (e) => {
      clear()
      const el = e.currentTarget
      timer.current = window.setTimeout(() => {
        timer.current = undefined
        if (el.isConnected) setAnchor(place(el))
      }, HOVER_DELAY_MS)
    },
    onPointerLeave: hide,
    onPointerDown: hide,
    onFocus: (e) => {
      // Only for keyboard focus: a click focuses the button too, and the tooltip would pop up under the pointer.
      // (The target, not currentTarget: the trigger may be a wrapper around the focused button.)
      if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) setAnchor(place(e.currentTarget))
    },
    onBlur: hide
  }

  const tooltip = anchor
    ? createPortal(
        <div
          id={id}
          role="tooltip"
          style={{ top: anchor.top, left: anchor.left }}
          className="pointer-events-none fixed z-50 max-w-[280px] -translate-y-1/2 rounded-md border border-line bg-raised px-2.5 py-1.5 shadow-lg shadow-black/40"
        >
          <div className="text-[12px] text-text">{label}</div>
          {status && <div className="mt-0.5 text-[11px] leading-snug text-muted">{status}</div>}
        </div>,
        document.body
      )
    : null

  return { trigger, tooltip }
}

// ── The rows of the sidebar and its rail ─────────────────────────────────────
// Shared by the sidebar's rows, Pågår och klart and the agent's row, so every icon lines up.

/** Fades labels, headings and inline marks out while the rail collapses (and in as it expands). */
export function fade(collapsed: boolean): string {
  return `transition-opacity duration-150 motion-reduce:transition-none ${collapsed ? 'opacity-0' : 'opacity-100'}`
}

/**
 * One sidebar row: 36 px high, the 16 px icon box always centred at x = 36 (aside px-3 + row pl-4 expanded; in the
 * rail a 40 px button 4 px in, with pl-3), so nothing moves sideways as the sidebar collapses. `tall` lets a row
 * with two lines of text grow.
 */
export function rowClass(active: boolean, collapsed: boolean, tall = false): string {
  const size = collapsed ? 'mx-1 h-9 w-10 pl-3' : `w-full pl-4 pr-2 ${tall ? 'min-h-9 py-1.5' : 'h-9'}`
  // --row-bg: badges on the icon (StatusMark variant="badge") cut their ring out of the row's own background.
  const tone = active
    ? 'bg-raised text-text [--row-bg:var(--color-raised)]'
    : 'text-muted hover:bg-raised/60 hover:text-text'
  return `relative flex shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap rounded-md text-left transition-colors ${size} ${tone}`
}

/** The 16 px icon box of a row (em-sized icons draw at about 15 px in it); badges are placed against it. */
export function IconBox({ children }: { children: ReactNode }) {
  return <span className="relative flex h-4 w-4 shrink-0 items-center justify-center text-[14.5px]">{children}</span>
}
