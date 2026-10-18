import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { overBudgetText, usdText } from '@shared/budget'
import type { OverBudget } from '@shared/types'
import { answerBudgetQuestion, useBudgetQuestion } from '../lib/budget'

/**
 * "Over your budget": something paid would take today's or this month's spending past the budget (Settings →
 * Spending). Asked for every paid click that main refused with OVER_BUDGET (lib/budget.ts); "Send anyway" sends the same
 * thing again, confirmed. Mounted once in App, above every view and dialog: no key reaches what is underneath.
 */
export default function BudgetDialog() {
  const over = useBudgetQuestion()
  if (!over) return null
  // Keyed: a second question after the first starts with focus on Cancel again.
  return <Question key={JSON.stringify(over)} over={over} />
}

function Question({ over }: { over: OverBudget }) {
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Cancel has the focus: Enter alone never pays past the budget.
    cancel.current?.focus()
    // Before every other key handler (a dialog underneath listens on the document, a view on the window): Esc says
    // no, Tab stays between the two buttons, and no other key reaches what is underneath.
    const onKeyDown = (e: KeyboardEvent): void => {
      const box = dialog.current
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answerBudgetQuestion(false)
        return
      }
      if (e.key === 'Tab' && box) {
        const buttons = [...box.querySelectorAll<HTMLButtonElement>('button')]
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        e.preventDefault()
        e.stopPropagation()
        buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        return
      }
      if (!box?.contains(e.target as Node)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const period = over.period === 'day' ? 'Daily budget' : 'Monthly budget'
  return createPortal(
    <div
      className="no-drag fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8"
      onMouseDown={(e) => e.target === e.currentTarget && answerBudgetQuestion(false)}
    >
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="budget-question-title"
        aria-describedby="budget-question-text"
        className="w-full max-w-[440px] rounded-xl border border-line bg-panel text-text shadow-2xl"
      >
        <div className="px-5 pb-4 pt-5">
          <h2 id="budget-question-title" className="text-base font-semibold">
            Over your budget
          </h2>
          <p id="budget-question-text" className="mt-2 leading-relaxed text-text/90">
            {overBudgetText(over)} Send it anyway?
          </p>
          <BudgetMeter
            className="mt-4"
            label={period}
            spentUsd={over.spentUsd}
            pendingUsd={over.pendingUsd}
            amountUsd={over.amountUsd}
            capUsd={over.budgetUsd}
          />
          <p className="mt-3 text-[11px] text-muted">You can change the budget in Settings → Spending.</p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line p-4">
          <button
            ref={cancel}
            type="button"
            onClick={() => answerBudgetQuestion(false)}
            className="rounded-md border border-line px-4 py-2 transition hover:bg-raised"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => answerBudgetQuestion(true)}
            className="rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover"
          >
            Send anyway
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * How full a cap is: spent, on its way and (optionally) what is about to be sent, against the cap – a line marks the cap
 * when the total goes past it. Also used by Settings → Spending and the approval dialog's warning.
 */
export function BudgetMeter({
  label,
  spentUsd,
  pendingUsd = 0,
  amountUsd = 0,
  capUsd,
  className = ''
}: {
  label: string
  spentUsd: number
  pendingUsd?: number
  amountUsd?: number
  capUsd: number
  className?: string
}) {
  const total = spentUsd + pendingUsd + amountUsd
  // The scale: the cap, or the total when it goes past (the cap line then sits inside the bar).
  const scale = Math.max(capUsd, total, 0.01)
  const pct = (usd: number): string => `${Math.max(0, Math.min(100, (usd / scale) * 100))}%`
  const over = total > capUsd + 0.005
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          <span className={over ? 'text-[#ffb3b5]' : 'text-text'}>{usdText(total)}</span> of {usdText(capUsd)}
        </span>
      </div>
      <div
        className="relative mt-1.5 flex h-2 overflow-hidden rounded-full bg-raised"
        role="img"
        aria-label={`${usdText(spentUsd)} spent${pendingUsd ? `, ${usdText(pendingUsd)} on its way` : ''}${amountUsd ? `, ${usdText(amountUsd)} more` : ''} of a ${usdText(capUsd)} budget`}
      >
        <span className="h-full bg-muted/70" style={{ width: pct(spentUsd) }} />
        {pendingUsd > 0 && (
          <span
            className="h-full bg-muted/35"
            style={{
              width: pct(pendingUsd),
              backgroundImage:
                'repeating-linear-gradient(135deg, transparent 0 3px, rgba(255,255,255,0.12) 3px 5px)'
            }}
          />
        )}
        {amountUsd > 0 && <span className={`h-full ${over ? 'bg-accent' : 'bg-emerald-400/80'}`} style={{ width: pct(amountUsd) }} />}
        {over && (
          <span aria-hidden className="absolute inset-y-0 w-0.5 bg-text" style={{ left: `calc(${pct(capUsd)} - 1px)` }} />
        )}
      </div>
    </div>
  )
}
