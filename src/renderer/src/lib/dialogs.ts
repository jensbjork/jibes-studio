import { useEffect, useRef } from 'react'
import { focusedWithKeyboard, trackFocusOrigin } from './focusOrigin'

// Overlays and the keys behind them. The rule every full-screen overlay (fixed inset-0) follows: it is portaled to
// the body, it has no-drag (it covers the title bar's drag region) and it sets aria-modal="true" (role="dialog", or
// "alertdialog" for a question). The window's own shortcuts (⌘K, ⌘F, ⌘,) look for that mark and leave a view behind
// an overlay alone.

/** What an open overlay is marked with. */
export const MODAL_SELECTOR = '[aria-modal="true"], [role="alertdialog"]'

/** Whether a modal overlay is open: the window's shortcuts then do nothing. */
export function isModalOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector(MODAL_SELECTOR)
}

/** A text field (or select) has the key: its own arrows, Space and letters stay its own. */
export function isTextTarget(t: EventTarget | null): boolean {
  return (
    t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  )
}

export interface ViewerKeys {
  onClose: () => void
  /** ← (the previous image, film or clip). */
  onPrev?: () => void
  /** → */
  onNext?: () => void
  /** Space (play or pause). */
  onSpace?: () => void
  /** False while something on top of the viewer (a dialog it opened) has the keys. */
  enabled?: boolean
}

/**
 * The keys of a full-screen viewer or preview (images, films, the sequence preview): Esc closes it, ← → step and
 * Space plays. Listened to before anything else on the page (capture phase), so a list or player behind the viewer
 * never sees them. With ⌘, ⌃, ⌥ or ⇧ held, in a text field, or on a focused video, audio element or slider, ← → and
 * Space are left alone; so is Space on a button reached with the keyboard (it presses it). Esc always closes, except inside an open question or menu of the viewer's
 * own (a confirm, a ⋯ menu), which it closes instead.
 */
export function useViewerKeys({ onClose, onPrev, onNext, onSpace, enabled = true }: ViewerKeys): void {
  const handlers = useRef({ onClose, onPrev, onNext, onSpace })
  handlers.current = { onClose, onPrev, onNext, onSpace }
  useEffect(() => {
    if (!enabled) return
    trackFocusOrigin()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const h = handlers.current
      const target = e.target
      if (e.key === 'Escape') {
        if (target instanceof Element && target.closest('[data-confirm], [role="menu"]')) return
        e.preventDefault()
        e.stopPropagation()
        h.onClose()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTextTarget(target)) return
      // A player's own controls (a focused video or audio element, a slider) keep their arrows and Space.
      if (target instanceof Element && target.closest('video, audio, [role="slider"]')) return
      let handler: (() => void) | undefined
      if (e.key === 'ArrowLeft') handler = h.onPrev
      else if (e.key === 'ArrowRight') handler = h.onNext
      else if (e.key === ' ') {
        const pressable = target instanceof Element && !!target.closest('button, a[href], [role="button"]')
        if (pressable && focusedWithKeyboard(target)) return
        handler = h.onSpace
      }
      if (!handler) return
      e.preventDefault()
      e.stopPropagation()
      handler()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled])
}
