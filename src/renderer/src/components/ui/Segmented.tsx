import type { ReactNode } from 'react'
import { rovingKeyDown } from './roving'

export interface SegmentedOption<T> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

interface Props<T extends string | number> {
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel: string
  /** radiogroup (a setting: Cards | Table, ×1–×4) or tablist (switches what is shown under it). */
  role?: 'radiogroup' | 'tablist'
  /** Equal columns across the whole width (Generate's mode switch). */
  fill?: boolean
  /** A visible label before the control ("Agent:", "Address:"); the control keeps ariaLabel. */
  label?: ReactNode
  /** ← → only after the control was reached with the keyboard (the Editor, where they otherwise move the player). */
  keyboardOnly?: boolean
  /** On the outermost element (the label's row when there is a label). */
  className?: string
}

/**
 * Choose one of a few options: a bordered track with the chosen option raised. One Tab stop; ← → (Home, End) move
 * and choose. The one look of every switch of this kind – Cards | Table, ×1–×4, Generate's mode, a source switch.
 */
export default function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  role = 'radiogroup',
  fill,
  label,
  keyboardOnly,
  className = ''
}: Props<T>) {
  const values = options.map((o) => o.value)
  // The Tab stop: the chosen option, or the first one that can be chosen while the chosen one can't.
  const stop = (options.find((o) => o.value === value && !o.disabled) ?? options.find((o) => !o.disabled))?.value
  const track = (
    <div
      role={role}
      aria-label={ariaLabel}
      onKeyDown={(e) => rovingKeyDown(e, values, value, onChange, { keyboardOnly })}
      className={`${fill ? 'grid min-w-0 flex-1 auto-cols-fr grid-flow-col' : 'inline-flex shrink-0'} h-7 items-stretch rounded-md border border-line bg-panel p-0.5 ${
        label ? '' : className
      }`}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role={role === 'tablist' ? 'tab' : 'radio'}
            aria-checked={role === 'radiogroup' ? on : undefined}
            aria-selected={role === 'tablist' ? on : undefined}
            data-roving-id={String(o.value)}
            tabIndex={o.value === stop ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => !on && onChange(o.value)}
            className={`flex min-w-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 text-[12px] outline-none transition focus-visible:ring-1 focus-visible:ring-muted disabled:opacity-40 ${
              on ? 'bg-raised text-text shadow-sm shadow-black/40' : 'text-muted enabled:hover:text-text'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
  if (!label) return track
  return (
    <div className={`flex min-w-0 items-center gap-2 ${className}`}>
      <span aria-hidden className="shrink-0 text-muted">
        {label}
      </span>
      {track}
    </div>
  )
}

export { Segmented }
