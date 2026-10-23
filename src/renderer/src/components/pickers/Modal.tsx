import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MODAL_SELECTOR } from '../../lib/dialogs'
import { focusedWithKeyboard, refocused, trackFocusOrigin } from '../../lib/focusOrigin'

// Followed from the start, so a dialog knows how the element it gives the focus back to had got it.
trackFocusOrigin()

/** What Tab can land on inside the dialog. */
const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])'

interface Props {
  title: string
  subtitle?: string
  onClose: () => void
  /** Buttons, right-aligned in the bottom bar. */
  footer?: ReactNode
  maxWidth?: number
  children: ReactNode
}

/**
 * Centered dialog over a dimmed backdrop; Escape or a click on the backdrop closes it. It takes the focus as it opens
 * (the panel itself, unless a field inside asked for it with autoFocus – never a confirm button), keeps Tab inside,
 * and gives the focus back to where it was when it closes.
 */
export default function Modal({ title, subtitle, onClose, footer, maxWidth = 460, children }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const subtitleId = useId()
  // Where the focus was before the dialog opened, and whether the keyboard took it there: read while rendering,
  // before a field inside takes it with autoFocus.
  const [before] = useState(() => {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return { el, byKeyboard: focusedWithKeyboard(el) }
  })

  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true })
    return () => {
      // Only when the focus went down with the dialog: never taken from what the closing action focused.
      const lost = !document.activeElement || document.activeElement === document.body
      if (lost && before.el?.isConnected) refocused(before.el, before.byKeyboard)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Not when a popover inside it took the key (it marks it handled), and only the topmost of nested dialogs.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const open = document.querySelectorAll(MODAL_SELECTOR)
      if (open.length && open[open.length - 1] !== panel.current) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Tab and ⇧Tab go round the dialog's own controls. Keys from a popover it opened (in a portal of its own) are left
  // to that popover.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const box = panel.current
    if (e.key !== 'Tab' || !box || !box.contains(e.target as Node)) return
    const stops = [...box.querySelectorAll<HTMLElement>(TABBABLE)].filter(
      (el) => el.tabIndex >= 0 && el.getClientRects().length > 0
    )
    if (!stops.length) {
      e.preventDefault()
      return
    }
    const first = stops[0]
    const last = stops[stops.length - 1]
    const at = document.activeElement
    if (e.shiftKey && (at === first || at === box)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      // mousedown (not click) so a text selection that ends on the backdrop doesn't close the dialog.
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className="flex max-h-full w-full flex-col rounded-xl border border-line bg-panel text-text shadow-2xl outline-none"
        style={{ maxWidth }}
      >
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && (
            <p id={subtitleId} className="mt-0.5 text-muted">
              {subtitle}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line p-4">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
