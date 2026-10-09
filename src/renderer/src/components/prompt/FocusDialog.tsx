import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** "Prompt", "Vad händer?", "Undvik"… */
  title: string
  /** A line under the title: what the field is for. */
  subtitle?: string
  onClose: () => void
  children: ReactNode
}

/**
 * Fokusläge: the same field, large, over a dimmed window – room to read and write a long prompt. Esc or "Klar"
 * goes back; the text is the same text (every change is saved as it is typed).
 */
export default function FocusDialog({ title, subtitle, onClose, children }: Props) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 px-8 py-10"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} – fokusläge`}
        className="flex w-full max-w-4xl flex-col rounded-xl border border-line bg-panel text-text shadow-2xl"
      >
        <div className="flex items-start gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-muted">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            title="Tillbaka (esc)"
            className="shrink-0 rounded-md border border-line px-3 py-1.5 text-text transition hover:bg-raised"
          >
            Klar
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  )
}
