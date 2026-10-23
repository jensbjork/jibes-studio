import { useId, type ReactNode } from 'react'
import { variantsText } from '@shared/variants'
import { formatUsd } from '../lib/media'
import { shortcut } from '../lib/platform'
import { withVariants } from '../lib/variants'
import { Banner } from './ui/Banner'
import { buttonClass } from './ui/button'
import VariantPicker from './VariantPicker'

interface Props {
  /** The button's words: "Generate", "Generate take", "Generate new take" (with ×N added for variants). */
  label: string
  /** How many variants one click sends, and the picker's choice. */
  count: number
  onCount: (count: number) => void
  /** What the click costs, every variant together; "$–" while unknown. Shown even while blocked. */
  total?: number
  /** Why it can't be sent now ("Add your Venice API key in Settings", "Write a prompt"): listed under the button. */
  problems?: readonly string[]
  /**
   * The click while blocked, which keeps the button clickable: the missing API key, when it is the only problem,
   * opens Settings → Venice.
   */
  onBlockedClick?: () => void
  /** Sending: the button waits and says so. */
  submitting?: boolean
  /** What went wrong with the last send, above the button. */
  error?: string
  onDismissError?: () => void
  /** Above everything (a notice, settings that set the price). */
  above?: ReactNode
  onSubmit: () => void
  /** The line under the button: "⌘↵ to generate". */
  verb?: string
}

/**
 * The bottom of every paid form (Generate, a sequence clip, a storyboard transition): ×1–×4 and the button with its
 * price, and one small line under it – what stands in the way, or the shortcut. The button never swaps its words for
 * the reason it is blocked.
 */
export default function GenerateBar({
  label,
  count,
  onCount,
  total,
  problems = [],
  onBlockedClick,
  submitting = false,
  error,
  onDismissError,
  above,
  onSubmit,
  verb = 'generate'
}: Props) {
  const lineId = useId()
  const blocked = problems.length > 0
  const words = withVariants(label, count)
  return (
    <div>
      {above}
      {error && (
        <Banner tone="error" onDismiss={onDismissError} className="mb-3 max-h-32 overflow-auto">
          {error}
        </Banner>
      )}
      <div className="flex items-stretch gap-2">
        <VariantPicker count={count} onChange={onCount} each={total === undefined ? undefined : total / count} />
        <button
          type="button"
          onClick={blocked ? onBlockedClick : onSubmit}
          disabled={submitting || (blocked && !onBlockedClick)}
          aria-describedby={lineId}
          title={blocked ? undefined : `${words} (${shortcut('⌘↵')})`}
          className={`${buttonClass('primary', 'lg')} min-w-0 flex-1`}
        >
          <span className="min-w-0 flex-1 truncate text-left">{submitting ? 'Sending…' : words}</span>
          <span className="shrink-0 tabular-nums text-white group-disabled:text-muted">{formatUsd(total)}</span>
        </button>
      </div>
      <p id={lineId} className="mt-2 text-center text-[11px] leading-relaxed text-muted">
        {blocked
          ? problems.join(' · ')
          : `${shortcut('⌘↵')} to ${verb}${count > 1 ? ` ${variantsText(count)}` : ''}`}
      </p>
    </div>
  )
}
