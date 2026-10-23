import type { ReactNode } from 'react'
import { buttonClass } from './button'

interface Props {
  /** In a round tile above the title. */
  icon?: ReactNode
  title: string
  /** One paragraph: what goes here and why. */
  text?: ReactNode
  /** The one way in, as the primary button. */
  action?: { label: string; onClick: () => void; disabled?: boolean }
  /** The other ways in, as text links, on a small line at the bottom. */
  footnote?: ReactNode
  /** Under the text (a form to start with). */
  children?: ReactNode
}

/**
 * What a view shows while it has nothing: centred in the space it is given (a flex column). The window's drag bar
 * above it stays the view's own.
 */
export default function EmptyState({ icon, title, text, action, footnote, children }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-10 pb-12 text-center">
      {icon && (
        <div className="mb-5 flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-raised text-2xl text-muted">
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold">{title}</h2>
      {text && <p className="mt-2 max-w-md leading-relaxed text-muted">{text}</p>}
      {children && <div className="mt-6">{children}</div>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className={`mt-6 ${buttonClass('primary', 'lg')}`}
        >
          {action.label}
        </button>
      )}
      {footnote && <p className="mt-4 max-w-md text-[11px] leading-relaxed text-muted">{footnote}</p>}
    </div>
  )
}

export { EmptyState }
