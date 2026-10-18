import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsentRequest, EditOperation, EditPlan, EditRunResult } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { parseConsent, stableJson } from '../sequences/sequenceUtils'
import { needsConfirm, priceCheck, type PriceCheck } from './editorUtils'

// Planning and running operations from the edit view. A plan is free (main's single check of an operation, with
// Venice's free quotes), debounced so typing doesn't spam it; running is what may cost money, and only ever starts
// from a click on a button that shows the plan's price — with one more question when the price is unknown, partly
// unknown, or above $5 (D5), and Venice's consent dialog when a model asks for it, like Generate.

/** How long a form must stay unchanged before it is planned (and priced) again. */
export const PLAN_DEBOUNCE_MS = 600

export interface PlanState {
  plan?: EditPlan
  /** A newer plan is on its way: the button waits for it, so the price it shows is the one that is sent. */
  planning: boolean
  error?: string
}

/**
 * The plan for an operation on a base version, kept fresh: re-planned 600 ms after the operation (or the base, or
 * `nonce`: anything else the plan depends on, such as a clone consent just given) last changed. Undefined op (or
 * enabled false) plans nothing.
 */
export function usePlan(
  editId: string,
  op: EditOperation | undefined,
  baseId: string | undefined,
  enabled = true,
  nonce: unknown = 0
): PlanState {
  const key = enabled && op ? stableJson({ op, baseId, nonce }) : ''
  const [state, setState] = useState<PlanState & { key: string }>({ key: '', planning: false })
  const latest = useRef(op)
  latest.current = op

  useEffect(() => {
    if (!key) {
      setState({ key: '', planning: false })
      return
    }
    let active = true
    setState((s) => ({ ...s, key, planning: true }))
    const timer = setTimeout(() => {
      const planned = latest.current
      if (!planned) return
      window.studio.planEditOperation(editId, planned, baseId).then(
        (plan) => active && setState({ key, plan, planning: false }),
        (e: unknown) => active && setState({ key, planning: false, error: ipcErrorMessage(e) })
      )
    }, PLAN_DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [key, editId])

  // The last plan stays on screen while the next one is made (the button is disabled meanwhile).
  return key ? { plan: state.plan, planning: state.planning || state.key !== key, error: state.error } : { planning: false }
}

/**
 * Plans for several alternatives at once (one per model, for the price on each choice), with the same debounce.
 * Results are in the order of `ops`; an alternative that couldn't be planned is undefined.
 */
export function usePlans(
  editId: string,
  ops: (EditOperation | undefined)[],
  baseId: string | undefined,
  enabled = true
): (EditPlan | undefined)[] {
  const key = enabled ? stableJson({ ops, baseId }) : ''
  const [plans, setPlans] = useState<{ key: string; plans: (EditPlan | undefined)[] }>({ key: '', plans: [] })
  const latest = useRef(ops)
  latest.current = ops

  useEffect(() => {
    if (!key) return
    let active = true
    const timer = setTimeout(() => {
      const list = latest.current
      void Promise.allSettled(
        list.map((op) => (op ? window.studio.planEditOperation(editId, op, baseId) : Promise.reject(new Error())))
      ).then((settled) => {
        if (!active) return
        setPlans({ key, plans: settled.map((s) => (s.status === 'fulfilled' ? s.value : undefined)) })
      })
    }, PLAN_DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [key, editId])

  // Older prices stay until new ones come; with another number of alternatives they don't line up any more.
  return plans.plans.length === ops.length ? plans.plans : ops.map(() => undefined)
}

/** What a run asks for: the operation, and the plan whose price the button showed (paid operations). */
export interface RunRequest {
  op: EditOperation
  plan?: EditPlan
  /** The version it works on; default the plan's base, else the current version. */
  baseId?: string
  /** "Regenerate section": what the consent dialog says will be sent. */
  label: string
}

export interface RunOutcome {
  ok: boolean
  result?: EditRunResult
  /** For the user; undefined when the user said no. */
  error?: string
}

/** What a paid click costs, for the question asked before it is sent. */
export interface PriceQuestion {
  /** "Regenerate section", "Continue: Changing voice". */
  label: string
  priceUsd?: number
  priceNote?: string
  check: PriceCheck
}

/** The question before a paid click whose price is unknown, partly unknown or above $5. */
export interface PendingConfirm extends PriceQuestion {
  answer: (yes: boolean) => void
}

/** Venice's terms for a model, with the run it interrupted. */
export interface PendingConsent {
  request: ConsentRequest
  run: RunRequest
  answer: (yes: boolean) => void
}

/** What a run needs from the outside world: main's IPC and the user's answers. */
export interface RunDeps {
  runOperation: (
    op: EditOperation,
    opts: { baseId?: string; expectedPriceUsd?: number; expectedPartial?: boolean }
  ) => Promise<EditRunResult>
  plan: (op: EditOperation, baseId?: string) => Promise<EditPlan>
  acceptConsent: (flow: string, version: string) => Promise<void>
  /** Resolves true when the price needs no question, or the user said yes. */
  confirmPrice: (question: PriceQuestion) => Promise<boolean>
  askConsent: (request: ConsentRequest, run: RunRequest) => Promise<boolean>
  /** The current version, the base when neither the request nor its plan names one. */
  currentId?: string
}

const CHANGED_DURING_CONSENT =
  'The action changed while the terms were shown. Check the price and press the button again.'

/**
 * One click's run. A plan with problems sends nothing; a paid plan asks about its price when it must (unknown,
 * partly unknown, above $5) and passes the price the user saw, so main refuses if it rose. Venice asking for consent
 * (409 needs_consent) opens the consent dialog; accepting plans again, and only the same work (an equal fingerprint)
 * is sent, still with the price the user confirmed as the ceiling: a price that rose (or appeared, after "unknown
 * price") meanwhile is refused by main and goes back to the button, which shows the new price and asks again.
 */
export async function executeRun(req: RunRequest, deps: RunDeps): Promise<RunOutcome> {
  const plan = req.plan
  if (plan?.problems.length) return { ok: false, error: plan.problems[0] }
  if (plan?.paid) {
    const question = { label: req.label, priceUsd: plan.priceUsd, priceNote: plan.priceNote, check: priceCheck(plan) }
    if (!(await deps.confirmPrice(question))) return { ok: false }
  }
  return send(req, deps)
}

/**
 * `confirmed`: the price the user confirmed before Venice's consent dialog (and whether it was unknown or left a part
 * out), which a retry keeps as its ceiling.
 */
async function send(
  req: RunRequest,
  deps: RunDeps,
  confirmed?: { usd: number; partial: boolean }
): Promise<RunOutcome> {
  const plan = req.plan
  const op = plan?.operation ?? req.op
  const baseId = req.baseId ?? plan?.baseId ?? deps.currentId
  // Main runs nothing paid without a price the user saw. An unknown price was confirmed as unknown (there is nothing to
  // compare), so it goes as 0; whether it was unknown or partial goes along, so main refuses a part without a price
  // that came in since (the button then asks the extra question).
  const seen = plan?.paid
    ? (confirmed ?? { usd: plan.priceUsd ?? 0, partial: plan.priceUsd === undefined || !!plan.partialPrice })
    : undefined
  try {
    const result = await deps.runOperation(op, {
      baseId,
      ...(seen ? { expectedPriceUsd: seen.usd, expectedPartial: seen.partial } : {})
    })
    return { ok: true, result }
  } catch (e) {
    const message = ipcErrorMessage(e)
    const request = parseConsent(message)
    if (!request) return { ok: false, error: message }
    if (!(await deps.askConsent(request, req))) return { ok: false }
    try {
      await deps.acceptConsent(request.flow, request.version)
    } catch (err) {
      return { ok: false, error: ipcErrorMessage(err) }
    }
    // The same work at the same price, or nothing: the base may have moved on, or the form changed meanwhile.
    let fresh: EditPlan
    try {
      fresh = await deps.plan(req.op, baseId)
    } catch (err) {
      return { ok: false, error: ipcErrorMessage(err) }
    }
    if (plan && fresh.fingerprint !== plan.fingerprint) return { ok: false, error: CHANGED_DURING_CONSENT }
    if (fresh.problems.length) return { ok: false, error: fresh.problems[0] }
    // The price the user said yes to stays the ceiling (not the fresh plan's, which main would compare with itself).
    return send({ ...req, plan: plan ? fresh : undefined }, deps, seen)
  }
}

/**
 * Runs operations for one edit (see executeRun), with the price question and the consent dialog as React state for
 * the workspace to show. The same operation can't be sent twice at once (two quick clicks, a click during a question).
 */
export function useRunner(editId: string, currentId: string | undefined) {
  const [confirm, setConfirm] = useState<PendingConfirm>()
  const [consent, setConsent] = useState<PendingConsent>()
  const busy = useRef(new Set<string>())
  const current = useRef(currentId)
  current.current = currentId

  /** Asks about the price when it needs asking (unknown, partly unknown, above $5); true right away otherwise. */
  const confirmPrice = useCallback(
    (question: PriceQuestion): Promise<boolean> =>
      needsConfirm(question.check)
        ? new Promise<boolean>((resolve) => setConfirm({ ...question, answer: resolve }))
        : Promise.resolve(true),
    []
  )

  const run = useCallback(
    async (req: RunRequest): Promise<RunOutcome> => {
      const key = stableJson(req.op)
      if (busy.current.has(key)) return { ok: false }
      busy.current.add(key)
      try {
        return await executeRun(req, {
          runOperation: (op, opts) => window.studio.runEditOperation(editId, op, opts),
          plan: (op, baseId) => window.studio.planEditOperation(editId, op, baseId),
          acceptConsent: (flow, version) => window.studio.acceptConsent(flow, version),
          confirmPrice,
          askConsent: (request, r) => new Promise<boolean>((resolve) => setConsent({ request, run: r, answer: resolve })),
          currentId: current.current
        })
      } finally {
        busy.current.delete(key)
      }
    },
    [editId, confirmPrice]
  )

  const answerConfirm = (yes: boolean) => {
    confirm?.answer(yes)
    setConfirm(undefined)
  }
  const answerConsent = (yes: boolean) => {
    consent?.answer(yes)
    setConsent(undefined)
  }

  return { run, confirmPrice, confirm, answerConfirm, consent, answerConsent }
}

export type Runner = ReturnType<typeof useRunner>
