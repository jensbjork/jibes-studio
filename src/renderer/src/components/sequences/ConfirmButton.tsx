import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Short question shown while armed, e.g. "Radera klippet?". */
  question: string
  confirmLabel?: string
  onConfirm: () => void
  className?: string
  title?: string
  disabled?: boolean
}

/** Destructive action with an inline second step; disarms itself after a few seconds. */
export default function ConfirmButton({
  children,
  question,
  confirmLabel = 'Radera',
  onConfirm,
  className = '',
  title,
  disabled
}: Props) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])

  if (!armed) {
    return (
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          setArmed(true)
        }}
        className={className}
      >
        {children}
      </button>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
      <span className="text-[11px] text-muted">{question}</span>
      <button
        type="button"
        autoFocus
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
        className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-accent-hover"
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-text"
      >
        Avbryt
      </button>
    </span>
  )
}
