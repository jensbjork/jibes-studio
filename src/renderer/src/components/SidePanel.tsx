import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isModalOpen } from '../lib/dialogs'
import { focusedWithKeyboard, refocused } from '../lib/focusOrigin'
import { CloseIcon } from './sequences/icons'

interface Props {
  /** The dialog's name for assistive technology ("Activity", "Agent"). */
  label: string
  /** The heading in its header. */
  title: ReactNode
  /** Beside the heading, before ✕ (Activity's "Mark all as seen"). */
  headerExtra?: ReactNode
  /** Under the body, behind a rule (the Agent panel's way to its settings). */
  footer?: ReactNode
  onClose: () => void
  /** The body: a column that sizes to its content, its own part scrolling (min-h-0 flex-1 overflow-y-auto). */
  children: ReactNode
}

/**
 * The panel a sidebar status row opens (Activity, Agent): a 360 px card beside the sidebar, bottom-aligned with the
 * rows that open it, following the sidebar's width as it collapses. A dialog that takes the focus and gives it back
 * when it closes; a click anywhere outside or Esc closes it (Esc not while a dialog over it waits for an answer). The
 * view behind isn't dimmed, as with the app's other anchored popovers.
 */
export default function SidePanel({ label, title, headerExtra, footer, onClose, children }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  // Where the focus was (the sidebar row) and whether the keyboard took it there: read before the panel takes it.
  const [before] = useState(() => {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return { el, byKeyboard: focusedWithKeyboard(el) }
  })

  useEffect(() => {
    panel.current?.focus()
    return () => {
      if (before.el?.isConnected) refocused(before.el, before.byKeyboard)
    }
  }, [before])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Escape belongs to a dialog shown over the panel (e.g. an approval), not to the panel.
      if (e.key === 'Escape' && !isModalOpen()) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      {/* Clicking anywhere outside closes the panel (the sidebar stays usable: its row toggles it). */}
      <div className="no-drag fixed inset-y-0 left-[var(--sidebar-w)] right-0 z-30" onMouseDown={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className="no-drag fixed bottom-3 left-[calc(var(--sidebar-w)+8px)] z-40 flex max-h-[min(70vh,560px)] w-[360px] flex-col rounded-xl border border-line bg-panel shadow-2xl shadow-black/50 outline-none transition-[left] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="mr-auto font-semibold">{title}</h2>
          {headerExtra}
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="rounded p-1 text-muted transition hover:bg-raised hover:text-text"
          >
            <CloseIcon size={12} />
          </button>
        </div>
        {children}
        {footer && <div className="shrink-0 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </>
  )
}
