import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  subtitle?: string
  onClose: () => void
  /** Buttons, right-aligned in the bottom bar. */
  footer?: ReactNode
  maxWidth?: number
  children: ReactNode
}

/** Centered dialog over a dimmed backdrop; Escape or a click on the backdrop closes it. */
export default function Modal({ title, subtitle, onClose, footer, maxWidth = 460, children }: Props) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      // mousedown (not click) so a text selection that ends on the backdrop doesn't close the dialog.
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-full w-full flex-col rounded-xl border border-line bg-panel text-text shadow-2xl"
        style={{ maxWidth }}
      >
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-muted">{subtitle}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line p-4">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
