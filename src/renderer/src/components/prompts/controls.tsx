import { useEffect, useState } from 'react'
import { copyText } from './prompt-utils'

const buttonBase = 'rounded-md px-2.5 py-1.5 transition hover:bg-raised disabled:pointer-events-none disabled:opacity-40'

export const secondaryButton = `${buttonBase} text-muted hover:text-text`

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

export function CopyButton({ text, disabled }: { text: string; disabled?: boolean }) {
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
      title="Copy the prompt to the clipboard"
      className={`${buttonBase} ${copied ? 'text-emerald-400' : 'text-muted hover:text-text'}`}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

/** Two-step delete: the first click arms it, the second deletes. Disarms itself after a few seconds. */
export function ConfirmDeleteButton({
  onConfirm,
  confirmLabel = 'Delete prompt'
}: {
  onConfirm: () => void
  /** The second step's button. */
  confirmLabel?: string
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className={`${buttonBase} text-muted hover:text-accent`}>
        Delete
      </button>
    )
  }
  return (
    <span className="flex items-center gap-1">
      <button type="button" onClick={() => setArmed(false)} className={secondaryButton}>
        Cancel
      </button>
      <button
        type="button"
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
        className="rounded-md bg-accent/15 px-2.5 py-1.5 font-medium text-accent transition hover:bg-accent hover:text-white"
      >
        {confirmLabel}
      </button>
    </span>
  )
}
