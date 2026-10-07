import { useState, type KeyboardEvent } from 'react'
import { ratingText } from './feedText'

interface Props {
  value?: number
  /** Omit for a read-only display. Clicking the current rating again clears it (null). */
  onChange?: (rating: number | null) => void
  size?: 'sm' | 'md' | 'lg'
  /** Read-only: hide the empty stars, showing only the filled ones (compact badges). */
  filledOnly?: boolean
  className?: string
}

const SIZE = { sm: 'text-[12px]', md: 'text-[15px]', lg: 'text-[22px]' } as const

/** One to five stars. Interactive stars preview on hover and work with the arrow keys. */
export default function StarRating({ value, onChange, size = 'sm', filledOnly, className = '' }: Props) {
  const [hover, setHover] = useState<number>()
  const shown = hover ?? value ?? 0

  if (!onChange) {
    const count = filledOnly ? (value ?? 0) : 5
    return (
      <span
        role="img"
        aria-label={ratingText(value)}
        title={ratingText(value)}
        className={`inline-flex shrink-0 leading-none tracking-[-0.05em] ${SIZE[size]} ${className}`}
      >
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={i < (value ?? 0) ? 'text-amber-400' : 'text-muted/40'}>
            ★
          </span>
        ))}
      </span>
    )
  }

  const set = (n: number) => onChange(n === value ? null : n)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      onChange(Math.min(5, (value ?? 0) + 1))
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      const next = (value ?? 0) - 1
      onChange(next >= 1 ? next : null)
    } else if (/^[1-5]$/.test(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      set(Number(e.key))
    } else if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      e.stopPropagation()
      onChange(null)
    }
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Ditt betyg"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={value ?? 0}
      aria-valuetext={ratingText(value)}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(undefined)}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex shrink-0 rounded leading-none outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60 ${SIZE[size]} ${className}`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          tabIndex={-1}
          onMouseEnter={() => setHover(n)}
          onClick={() => set(n)}
          title={n === value ? 'Ta bort betyget' : `${n} av 5`}
          // A previewed rating (hovering) is lighter than the one that is set.
          className={`px-[1px] transition-colors ${
            n > shown ? 'text-muted/40' : hover !== undefined && hover !== value ? 'text-amber-300/80' : 'text-amber-400'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  )
}
