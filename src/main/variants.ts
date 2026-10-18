// Sending several variants of one generation (GenerateOptions.count): 'video:generate', 'segments:generate' and
// 'transitions:generate' quote once, check the whole amount against the budget, and then send the variants here, one
// after another, the way "Generate missing" sends its takes.

import { NEEDS_CONSENT, type GenerateOptions, type Generation } from '@shared/types'
import { variantCountOf, variantOrdinal } from '@shared/variants'

/** Told of every take as Venice accepts it (an agent's approved request collects the ids it started). */
export type SentListener = (g: Generation) => void

/**
 * How a generation is sent, as main reads it from a call: GenerateOptions with its count checked (1–4) and, from an
 * in-process caller only, a listener for every take sent (a window's IPC call can't carry a function).
 */
export interface SendOptions {
  count: number
  confirmOverBudget: boolean
  onSent?: SentListener
}

/** The options of a generate call (see SendOptions); throws for a count that isn't 1–4. */
export function sendOptionsOf(value: unknown): SendOptions {
  const opts = (value && typeof value === 'object' ? value : {}) as GenerateOptions & { onSent?: unknown }
  const onSent = typeof opts.onSent === 'function' ? (opts.onSent as SentListener) : undefined
  return {
    count: variantCountOf(opts),
    confirmOverBudget: opts.confirmOverBudget === true,
    ...(onSent ? { onSent } : {})
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Sends `count` variants with `send`, one after another, and resolves with the takes in the order they were sent.
 * The first goes alone: when it is refused – a consent Venice asks for first (NEEDS_CONSENT), a clip that can't be
 * sent – nothing was sent, and the error comes back unchanged (the window asks for the consent and sends them all
 * again). A failure after that stops the rest: the takes already sent stay (they are paid for, and show in Activity as
 * usual), and the error says how many were sent. `onSent` hears of each take as Venice accepts it.
 */
export async function sendVariants(
  count: number,
  send: (index: number) => Promise<Generation>,
  onSent?: SentListener
): Promise<Generation[]> {
  const sent: Generation[] = []
  for (let i = 0; i < count; i++) {
    let take: Generation
    try {
      take = await send(i)
    } catch (err) {
      if (!sent.length) throw err
      throw new Error(partlySentText(sent.length, count, errorText(err)))
    }
    sent.push(take)
    try {
      onSent?.(take)
    } catch (err) {
      // Only bookkeeping (an approval's ids); the takes go on.
      console.warn('Could not report a variant that was sent:', err)
    }
  }
  return sent
}

/**
 * "2 of 4 variants were sent (they show in Activity); the 3rd couldn't be sent, and the rest weren't tried: …". A
 * consent asked for this late (it was given for the first) is said in words: its raw form would make the window ask
 * and send every variant again.
 */
export function partlySentText(sent: number, count: number, reason: string): string {
  const why = reason.includes(NEEDS_CONSENT) ? "Venice asked to accept the model's terms first." : reason
  const was = sent === 1 ? 'was' : 'were'
  const rest = count - sent > 1 ? ", and the rest weren't tried" : ''
  const failed = `the ${variantOrdinal(sent + 1)} couldn't be sent${rest}`
  return `${sent} of ${count} variants ${was} sent (they show in Activity); ${failed}: ${why}`
}
