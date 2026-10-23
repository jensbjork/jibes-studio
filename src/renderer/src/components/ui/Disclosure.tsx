import { useState, type ReactNode } from 'react'
import { DisclosureChevron } from '../icons'

interface Props {
  /** The line that opens and closes it. */
  summary: ReactNode
  children: ReactNode
  /** Open or closed from outside (with onToggle); left out, it keeps its own state from defaultOpen. */
  open?: boolean
  onToggle?: (open: boolean) => void
  defaultOpen?: boolean
  /** The body without the indented rule and the small muted text (a form, a field). */
  plain?: boolean
  className?: string
}

/**
 * Something folded away: a muted line with a chevron that turns, the body under it. The one disclosure of the app –
 * never the browser's ▶ marker or a text arrow.
 */
export default function Disclosure({ summary, children, open, onToggle, defaultOpen, plain, className = '' }: Props) {
  // The chevron follows this one details element, not any open one around it (a disclosure inside another).
  const [isOpen, setIsOpen] = useState(open ?? defaultOpen ?? false)
  const shown = open ?? isOpen
  return (
    <details
      open={open ?? defaultOpen}
      onToggle={(e) => {
        const now = e.currentTarget.open
        setIsOpen(now)
        onToggle?.(now)
      }}
      className={`group ${className}`}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-muted transition hover:text-text [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={shown} />
        {summary}
      </summary>
      <div
        className={
          plain ? 'mt-2' : 'mt-2 space-y-2 border-l border-line pl-3.5 text-[12px] leading-relaxed text-muted'
        }
      >
        {children}
      </div>
    </details>
  )
}

export { Disclosure }
