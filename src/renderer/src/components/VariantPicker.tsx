import { VARIANT_COUNTS, variantsPrice } from '@shared/variants'
import { formatUsd } from '../lib/media'

interface Props {
  count: number
  onChange: (count: number) => void
  /** The price of one take, for each choice's tooltip. */
  each?: number
  className?: string
}

/**
 * ×1 ×2 ×3 ×4 beside a Generate button: how many takes of the same settings it sends at once. Each is its own
 * generation (Venice picks a new seed each time) at the full price; the button shows the total.
 */
export default function VariantPicker({ count, onChange, each, className = '' }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Variants"
      className={`flex shrink-0 items-stretch rounded-md border border-line bg-panel p-0.5 ${className}`}
    >
      {VARIANT_COUNTS.map((n) => {
        const on = n === count
        const price = each === undefined ? '' : ` · ${formatUsd(variantsPrice(each, n))}`
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(n)}
            title={
              n === 1
                ? `One take${price}`
                : `${n} takes of the same settings at once – each its own generation, with its own seed${price}`
            }
            className={`flex min-w-7 items-center justify-center rounded-[5px] px-1.5 text-[12px] tabular-nums outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
              on ? 'bg-raised text-text shadow-sm shadow-black/40' : 'text-muted hover:text-text'
            }`}
          >
            ×{n}
          </button>
        )
      })}
    </div>
  )
}
