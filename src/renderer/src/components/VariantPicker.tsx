import { VARIANT_COUNTS, variantsPrice } from '@shared/variants'
import { formatUsd } from '../lib/media'
import Segmented from './ui/Segmented'

interface Props {
  count: number
  onChange: (count: number) => void
  /** The price of one take, for each choice's tooltip. */
  each?: number
  className?: string
}

/**
 * ×1 ×2 ×3 ×4 beside a Generate button: how many takes of the same settings it sends at once. Each is its own
 * generation (Venice picks a new seed each time) at the full price; the button shows the total. One Tab stop, ← →
 * to choose. As tall as the button beside it.
 */
export default function VariantPicker({ count, onChange, each, className = '' }: Props) {
  return (
    <Segmented
      value={count}
      onChange={onChange}
      ariaLabel="Variants"
      className={`h-auto! self-stretch ${className}`}
      options={VARIANT_COUNTS.map((n) => {
        const price = each === undefined ? '' : ` · ${formatUsd(variantsPrice(each, n))}`
        return {
          value: n,
          label: <span className="tabular-nums">×{n}</span>,
          title:
            n === 1
              ? `One take${price}`
              : `${n} takes of the same settings at once – each its own generation, with its own seed${price}`
        }
      })}
    />
  )
}
