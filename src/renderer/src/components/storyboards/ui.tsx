import { useEffect, useId, type KeyboardEvent, type ReactNode } from 'react'
import { CloseIcon } from '../sequences/icons'

// Small pieces shared by the Storyboards view's components: banners, menu rows and button styles.

export const primaryButton =
  'flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent'
export const secondaryButton =
  'flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-line px-3 py-1.5 transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'
export const ghostButton =
  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent'

export const menuRow =
  'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left outline-none transition hover:bg-raised focus-visible:bg-raised disabled:pointer-events-none disabled:opacity-40'

/** ↑ / ↓ move between a menu's items (those marked data-menu-item), like a native menu. */
export function onMenuKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-menu-item]:not(:disabled)')]
  if (!items.length) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1
  items[next].focus()
}

const TONES = {
  error: 'border-accent/30 bg-accent/10 text-[#ffb3b5]',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
}

/** A message across the top of the storyboard (errors, a finished export), dismissable. */
export function Banner({
  tone,
  children,
  onDismiss
}: {
  tone: keyof typeof TONES
  children: ReactNode
  onDismiss?: () => void
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mx-4 mt-3 flex shrink-0 items-start gap-3 rounded-lg border px-3.5 py-2.5 text-[12px] leading-relaxed ${TONES[tone]}`}
    >
      <div className="min-w-0 flex-1 select-text">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} title="Stäng" className="mt-0.5 shrink-0 opacity-60 transition hover:opacity-100">
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  )
}

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
          ‹ Tillbaka
        </button>
        {title && <span className="truncate text-[11px] text-muted">{title}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * A question in front of the storyboard before a change that throws work away (asked only when it would). Avbryt
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
  return (
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
            Avbryt
          </button>
          <button type="button" onClick={onConfirm} className={primaryButton}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
