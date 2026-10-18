import { useSyncExternalStore } from 'react'
import { OVER_BUDGET, type OverBudget } from '@shared/types'

// Sending something paid that would go over the budget (Settings → Spending): main refuses with OVER_BUDGET, the user
// is asked in the over-budget dialog (BudgetDialog, mounted once in App), and the same call is made again confirmed.
// Questions asked while one is open wait their turn.

/** The over-budget details of an IPC error, or undefined. */
export function overBudgetOf(error: unknown): OverBudget | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const at = message.indexOf(OVER_BUDGET)
  if (at === -1) return undefined
  try {
    return JSON.parse(message.slice(at + OVER_BUDGET.length)) as OverBudget
  } catch {
    return undefined
  }
}

interface Question {
  over: OverBudget
  answer: (yes: boolean) => void
}

let queue: readonly Question[] = []
const listeners = new Set<() => void>()

function setQueue(next: readonly Question[]): void {
  queue = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Asks the user whether to go over the budget; resolves with their answer. */
export function askOverBudget(over: OverBudget): Promise<boolean> {
  return new Promise<boolean>((resolve) => setQueue([...queue, { over, answer: resolve }]))
}

/** The question on screen (the oldest one waiting), for BudgetDialog. */
export function useBudgetQuestion(): OverBudget | undefined {
  return useSyncExternalStore(subscribe, () => queue[0]?.over)
}

/** The user's answer to the question on screen; the next one waiting is shown after it. */
export function answerBudgetQuestion(yes: boolean): void {
  const [first, ...rest] = queue
  if (!first) return
  setQueue(rest)
  first.answer(yes)
}

/**
 * Runs a paid call; when main says it would go over the budget, asks the user and runs it again confirmed. Resolves
 * undefined when the user said no. Other errors are thrown as they are.
 */
export async function withBudgetConfirm<T>(attempt: (confirmed: boolean) => Promise<T>): Promise<T | undefined> {
  try {
    return await attempt(false)
  } catch (e) {
    const over = overBudgetOf(e)
    if (!over) throw e
    return (await askOverBudget(over)) ? attempt(true) : undefined
  }
}
