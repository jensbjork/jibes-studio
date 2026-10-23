import { useEffect, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { buttonClass } from '../ui/button'

// Small pieces shared by the Storyboards view's components and their neighbours: a popover's second level and the
// question before throwing work away. Banners, menu rows, the name field and the button styles live in components/ui
// now and are re-exported here, so the older imports keep working.

export { Banner, FloatingBanner, noticeTones } from '../ui/Banner'
export { menuRow, onMenuKeyDown } from '../ui/menu'
export { NameInput } from '../ui/NameInput'

/** buttonClass('primary'): the accent button. */
export const primaryButton = buttonClass('primary')
/** buttonClass('secondary'): bordered. */
export const secondaryButton = buttonClass('secondary')
/** buttonClass('ghost'): muted, a background on hover. */
export const ghostButton = buttonClass('ghost')

/** A popover's second level (the library, the storyboard's pictures) with a way back to the menu. */
export function SubView({ title, onBack, children }: { title?: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-1.5 py-1">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text"
        >
          ‹ Back
        </button>
        {title && <span className="truncate text-[11px] text-muted">{title}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * A question in front of the storyboard before a change that throws work away (asked only when it would). Cancel
 * has the focus: the change may have come from a stray click or key.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const textId = useId()
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return createPortal(
    // no-drag: the overlay covers the view's title-bar drag region.
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        className="w-full max-w-md rounded-xl border border-line bg-panel shadow-2xl"
      >
        <div className="p-5">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <p id={textId} className="mt-2 leading-relaxed text-muted">
            {children}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line p-4">
          <button type="button" autoFocus onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className={primaryButton}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
