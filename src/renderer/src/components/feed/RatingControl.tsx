import { useState, type KeyboardEvent } from 'react'
import { ratingLabel } from '@shared/rating'
import { MAX_STARS, THUMBS_DOWN, type RatingValue } from '@shared/types'

interface Props {
  /** The grade: -1 (thumbs down) or 1–3 stars; undefined when not rated. */
  value?: number
  /** Omit for a read-only display. Clicking the current grade again clears it (null). */
  onChange?: (rating: RatingValue | null) => void
  /** sm is the compact one, for table rows and cards; lg is the drawer's. */
  size?: 'sm' | 'md' | 'lg'
  /** Read-only: show only the grade itself – 👎, or the filled stars – for small badges. */
  filledOnly?: boolean
  className?: string
}

const SIZE = { sm: 'text-[12px]', md: 'text-[15px]', lg: 'text-[22px]' } as const
const GAP = { sm: 'mx-[3px]', md: 'mx-1', lg: 'mx-1.5' } as const

const STARS: RatingValue[] = Array.from({ length: MAX_STARS }, (_, i) => (i + 1) as RatingValue)

const THUMB = '👎'

/** The emoji sits a little smaller than the stars, so the row reads as one line. */
const thumbGlyph = 'inline-block text-[0.85em] leading-none'

/** The next grade up or down the scale thumbs down < ★ < ★★ < ★★★; from no grade, up is one star and down thumbs down. */
function step(value: number | undefined, up: boolean): RatingValue {
  if (up) return value === undefined || value === THUMBS_DOWN ? 1 : (Math.min(MAX_STARS, value + 1) as RatingValue)
  return value === undefined || value <= 1 ? THUMBS_DOWN : ((value - 1) as RatingValue)
}

/**
 * A grade: 👎 (thumbs down) and one to three stars. Interactive, it previews on hover and works from the keyboard as a
 * slider (← → or ↓ ↑ step through the grades, 1–3 and − choose one, 0, Delete or Backspace clear it); clicking the
 * grade that is set clears it. Read-only (no onChange) it shows the same row, or only the grade with filledOnly.
 */
export default function RatingControl({ value, onChange, size = 'sm', filledOnly, className = '' }: Props) {
  const [hover, setHover] = useState<RatingValue>()
  const label = ratingLabel(value)

  if (!onChange) {
    const down = value === THUMBS_DOWN
    const stars = down ? 0 : (value ?? 0)
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={`inline-flex shrink-0 items-center leading-none ${SIZE[size]} ${className}`}
      >
        {(!filledOnly || down) && (
          <span className={`${thumbGlyph} ${down ? '' : 'opacity-35 grayscale'}`}>{THUMB}</span>
        )}
        {!filledOnly && <span className={`${GAP[size]} h-[0.8em] w-px bg-line`} />}
        {(!filledOnly || stars > 0) && (
          <span className="inline-flex tracking-[-0.05em]">
            {STARS.filter((n) => !filledOnly || n <= stars).map((n) => (
              <span key={n} className={n <= stars ? 'text-amber-400' : 'text-muted/40'}>
                ★
              </span>
            ))}
          </span>
        )}
      </span>
    )
  }

  const shown = hover ?? value
  // A previewed grade (hovering) is lighter than the one that is set.
  const previewing = hover !== undefined && hover !== value
  const set = (n: RatingValue) => onChange(n === value ? null : n)
  const change = (n: RatingValue | null) => {
    if (n !== (value ?? null)) onChange(n)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let handled = true
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') change(step(value, true))
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') change(step(value, false))
    else if (e.key === 'Home') change(THUMBS_DOWN)
    else if (e.key === 'End') change(MAX_STARS as RatingValue)
    else if (/^[1-3]$/.test(e.key)) set(Number(e.key) as RatingValue)
    else if (e.key === '-') set(THUMBS_DOWN)
    else if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') change(null)
    else handled = false
    // Handled keys stay here: the drawer's ← → step between clips, the table's keys move the selection.
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const down = shown === THUMBS_DOWN
  const stars = down ? 0 : (shown ?? 0)

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Your rating"
      aria-valuemin={THUMBS_DOWN}
      aria-valuemax={MAX_STARS}
      aria-valuenow={value ?? 0}
      aria-valuetext={label}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(undefined)}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex shrink-0 items-center rounded leading-none outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60 ${SIZE[size]} ${className}`}
    >
      <button
        type="button"
        tabIndex={-1}
        onMouseEnter={() => setHover(THUMBS_DOWN)}
        onClick={() => set(THUMBS_DOWN)}
        title={value === THUMBS_DOWN ? 'Remove the rating' : ratingLabel(THUMBS_DOWN)}
        className="px-[1px] transition"
      >
        <span
          className={`${thumbGlyph} transition ${
            !down ? 'opacity-35 grayscale' : previewing ? 'opacity-75' : ''
          }`}
        >
          {THUMB}
        </span>
      </button>
      <span aria-hidden className={`${GAP[size]} h-[0.8em] w-px bg-line`} />
      {STARS.map((n) => (
        <button
          key={n}
          type="button"
          tabIndex={-1}
          onMouseEnter={() => setHover(n)}
          onClick={() => set(n)}
          title={n === value ? 'Remove the rating' : ratingLabel(n)}
          className={`px-[1px] transition-colors ${
            n > stars ? 'text-muted/40' : previewing ? 'text-amber-300/80' : 'text-amber-400'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  )
}
