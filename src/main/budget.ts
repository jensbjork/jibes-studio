// The spending budget (Settings → Spending): a paid submission that would take today's or this month's spending past
// the cap is refused with OVER_BUDGET unless the user confirmed it (GenerateOptions.confirmOverBudget). Every paid path
// calls assertWithinBudget with the full amount it is about to send (all variants). What counts against a cap is what
// the library records as paid in that period plus what is on its way (spending.ts); the caps are the profile's
// (settings.ts). Work the user has already said yes to – an agent's request they approved, a "Generate missing" run
// checked when it started – runs inside runConfirmed (requested-by.ts) and isn't asked about again.

import { hasBudget, overBudgetFor } from '@shared/budget'
import { OVER_BUDGET, type GenerationParams, type OverBudget } from '@shared/types'
import { isConfirmedHere } from './requested-by'
import { getBudget } from './settings'
import { spentSoFar } from './spending'

export { runConfirmed } from './requested-by'

/**
 * Where sending `amountUsd` more would take the spending past a cap, as things stand now; undefined within the budget
 * (or without one). For what an agent asks for: its answer and the approval dialog warn with it.
 */
export function overBudgetNow(amountUsd: number | undefined): OverBudget | undefined {
  const budget = getBudget()
  if (!hasBudget(budget)) return undefined
  return overBudgetFor(amountUsd, spentSoFar(), budget)
}

/** Throws `OVER_BUDGET:<OverBudget JSON>` when `amountUsd` would take the day or month past its cap, unless confirmed. */
export function assertWithinBudget(amountUsd: number | undefined, opts: { confirmed?: boolean } = {}): void {
  if (opts.confirmed || isConfirmedHere()) return
  const over = overBudgetNow(amountUsd)
  if (over) throw new Error(OVER_BUDGET + JSON.stringify(over))
}

/** Whether a call's options say the user confirmed going over the budget ({confirmOverBudget: true}). */
export function confirmedOf(opts: unknown): boolean {
  return !!opts && typeof opts === 'object' && (opts as { confirmOverBudget?: unknown }).confirmOverBudget === true
}

/**
 * The check at the start of a "Generate missing" run, with the run's total: `total` is only worked out (quotes are
 * network calls) when there is a budget and the run isn't already confirmed.
 */
export async function assertRunWithinBudget(total: () => Promise<number | undefined>, confirmed: boolean): Promise<void> {
  if (confirmed || isConfirmedHere() || !hasBudget(getBudget())) return
  assertWithinBudget(await total(), { confirmed })
}

/**
 * What one take of each of `list` costs together, by `quote` (each distinct setting quoted once). Takes Venice gives no
 * price for are left out; undefined when it gives none at all.
 */
export async function quoteTotal(
  list: readonly GenerationParams[],
  quote: (p: GenerationParams) => Promise<number>
): Promise<number | undefined> {
  const asked = new Map<string, Promise<number | undefined>>()
  const prices = await Promise.all(
    list.map((p) => {
      const key = JSON.stringify(p)
      let price = asked.get(key)
      if (!price) {
        price = quote(p).catch(() => undefined)
        asked.set(key, price)
      }
      return price
    })
  )
  const known = prices.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined
}
