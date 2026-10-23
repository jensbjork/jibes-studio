import { useEffect, useState, type ReactNode } from 'react'
import { buttonClass, type ButtonSize } from '../ui/button'
import { copyText } from './prompt-utils'

/** The quiet button of the prompt editors (Discard): buttonClass('ghost'). */
export const secondaryButton = buttonClass('ghost')

export function FavoriteButton({
  active,
  onToggle,
  className = ''
}: {
  active: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      aria-pressed={active}
      title={active ? 'Remove from favourites' : 'Mark as favourite'}
      className={`leading-none transition ${
        active ? 'text-amber-400 hover:text-amber-300' : 'text-muted hover:text-text'
      } ${className}`}
    >
      {active ? '★' : '☆'}
    </button>
  )
}

/**
 * "Copy" (bordered), "Copied ✓" for a moment after: the prompt editors' "Copy prompt" and "Copy learning", and the
 * prompt in Media's clip details.
 */
export function CopyButton({
  text,
  disabled,
  label = 'Copy',
  title = 'Copy the prompt to the clipboard',
  size = 'sm'
}: {
  text: string
  disabled?: boolean
  label?: string
  title?: string
  /** sm beside a heading (Media), md in an editor's row of actions. */
  size?: ButtonSize
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    await copyText(text)
    setCopied(true)
  }

  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      title={title}
      className={`${buttonClass('secondary', size)} ${copied ? 'text-success' : ''}`}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}

/** A field's label in the prompt editors: medium weight, with a short muted hint on the right ("Optional"). */
export function FieldLabel({ htmlFor, hint, children }: { htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-4">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="font-medium">
          {children}
        </label>
      ) : (
        <span className="font-medium">{children}</span>
      )}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  )
}
