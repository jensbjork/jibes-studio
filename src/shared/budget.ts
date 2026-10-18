// The spending budget (Settings → Spending): optional daily and monthly caps in USD, per profile. What counts against a
// cap is what Studio recorded as paid in that period plus what is on its way (pendingUsd); a paid submission that would
// take either past its cap needs the user's yes. Main (budget.ts), the window's dialogs and the approval dialog, and the
// agents' tools all decide it with overBudgetFor and say it with overBudgetText.

import type { BudgetSettings, OverBudget } from './types'

/** The highest cap Studio accepts, so a typo can't make one meaningless. */
export const MAX_BUDGET_USD = 100_000

/** Cents: what Venice bills in. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 100) / 100
}

/** A cap as stored: a finite number from 0 to MAX_BUDGET_USD in cents, else none. 0 means "ask before anything paid". */
export function capOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BUDGET_USD
    ? roundUsd(value)
    : undefined
}

/** Whether any cap is set. */
export function hasBudget(budget: BudgetSettings | undefined): boolean {
  return capOf(budget?.dailyUsd) !== undefined || capOf(budget?.monthlyUsd) !== undefined
}

/**
 * The budget a caller asked for, checked: each cap a number from 0 to MAX_BUDGET_USD (rounded to cents), or
 * null/undefined for none. Throws with a message for the user otherwise.
 */
export function normalizeBudget(raw: unknown): BudgetSettings {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') throw new Error('Invalid budget.')
  const r = (raw ?? {}) as Record<string, unknown>
  const out: BudgetSettings = {}
  for (const [key, name] of [
    ['dailyUsd', 'daily'],
    ['monthlyUsd', 'monthly']
  ] as const) {
    const v = r[key]
    if (v === undefined || v === null) continue
    const cap = capOf(v)
    if (cap === undefined) {
      throw new Error(`The ${name} budget must be an amount in dollars from 0 to ${MAX_BUDGET_USD.toLocaleString('en-US')}.`)
    }
    out[key] = cap
  }
  return out
}

/** What counts against the caps right now. */
export interface SpentSoFar {
  todayUsd: number
  monthUsd: number
  /** On its way: counted against both caps. */
  pendingUsd?: number
}

/** Nothing below this counts as going over (rounding). */
const SLACK_USD = 0.005

/**
 * The cap that sending `amountUsd` more would pass – the day's before the month's –, or undefined when it stays within
 * the budget (or there is none). An unknown price (undefined) passes a cap only when the spending is already at it.
 */
export function overBudgetFor(
  amountUsd: number | undefined,
  spent: SpentSoFar,
  budget: BudgetSettings | undefined
): OverBudget | undefined {
  const amount = amountUsd !== undefined && Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0
  const pending = spent.pendingUsd && spent.pendingUsd > 0 ? spent.pendingUsd : 0
  for (const [period, cap, used] of [
    ['day', capOf(budget?.dailyUsd), spent.todayUsd],
    ['month', capOf(budget?.monthlyUsd), spent.monthUsd]
  ] as const) {
    if (cap === undefined) continue
    const total = used + pending + amount
    const over = amount > 0 ? total > cap + SLACK_USD : total >= cap - SLACK_USD
    if (!over) continue
    return {
      amountUsd: roundUsd(amount),
      period,
      budgetUsd: cap,
      spentUsd: roundUsd(used),
      ...(pending > 0 ? { pendingUsd: roundUsd(pending) } : {})
    }
  }
  return undefined
}

/** How much a cap still leaves: cap − spent − on its way, never below 0; undefined without a cap. */
export function roomLeft(cap: number | undefined, used: number, pendingUsd = 0): number | undefined {
  const c = capOf(cap)
  return c === undefined ? undefined : roundUsd(Math.max(0, c - used - Math.max(0, pendingUsd)))
}

/** "$4.80", "$0.06", "$0.045": whole cents with two decimals, a price below a cent's precision with three. */
export function usdText(usd: number): string {
  const subCent = Math.abs(usd * 100 - Math.round(usd * 100)) > 1e-6
  return `$${usd.toFixed(subCent ? 3 : 2)}`
}

/**
 * "This costs $0.56 and takes today's spending past your budget of $5.00 ($4.80 spent)." – or, without a price, "Today's
 * spending is already at your budget of $5.00 ($5.10 spent)." What is on its way is named too. `subject` replaces
 * "This costs $0.56 and takes" for another sentence ("This takes"); the price is then left out.
 */
export function overBudgetText(o: OverBudget, subject?: string): string {
  const period = o.period === 'day' ? 'today’s' : 'this month’s'
  const spent = o.pendingUsd
    ? `${usdText(o.spentUsd)} spent, ${usdText(o.pendingUsd)} on its way`
    : `${usdText(o.spentUsd)} spent`
  if (!o.amountUsd) {
    const Period = o.period === 'day' ? 'Today’s' : 'This month’s'
    const unpriced = subject ? '' : ', and Venice gives no price for this in advance'
    return `${Period} spending is already at your budget of ${usdText(o.budgetUsd)} (${spent})${unpriced}.`
  }
  if (subject) return `${subject} ${period} spending past your budget of ${usdText(o.budgetUsd)} (${spent}).`
  return `This costs ${usdText(o.amountUsd)} and takes ${period} spending past your budget of ${usdText(o.budgetUsd)} (${spent}).`
}
