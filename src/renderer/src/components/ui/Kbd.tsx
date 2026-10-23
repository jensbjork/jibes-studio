import type { ReactNode } from 'react'

/**
 * A key cap ("↵", "Esc", "↑ ↓"). Only where keys are the subject: the command palette's footer and the Editor's
 * "select a part first" hint. Everywhere else a shortcut is plain text from shortcut(), in a tooltip "Label (⌘↵)".
 */
export default function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-block min-w-4 rounded border border-line px-1 text-center font-sans text-[11px] leading-4 text-muted">
      {children}
    </kbd>
  )
}

export { Kbd }
