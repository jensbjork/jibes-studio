import { randomUUID } from 'node:crypto'
import { NEEDS_CONSENT, type ApprovalImageRequest, type ApprovalRequest, type GenerationParams } from '@shared/types'
import { errorText } from './studio'

// Paid generations an agent asked for. Nothing reaches Venice until the user approves the request in Studio;
// main then submits exactly what the request describes, through the same code paths as the window.

/** What submitting an approved request led to: the generations it started, or the still it made. */
export type ApprovalOutcome = string[] | { generationIds?: string[]; stillId?: string; notice?: string }

/** How long a request waits for the user before it lapses. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000

/** More than this many unanswered requests and the agent is told to wait for the user. */
const MAX_PENDING = 10

/** Decided requests kept for the activity drawer and get_approval. */
const MAX_DECIDED = 50

export interface ApprovalPlan {
  kind: ApprovalRequest['kind']
  client: string
  note?: string
  params?: GenerationParams
  /**
   * The prompt exactly as it is sent – params.prompt with the References legend composed from the assets'
   * descriptions at request time – and that legend alone, when something is appended. The dialog shows them;
   * verify refuses when the prompt would be composed differently by now.
   */
  composedPrompt?: string
  descriptionLegend?: string
  /**
   * 'generate-all': each clip's legend at request time (ApprovalRequest.clipLegends), for the dialog to compare;
   * verify compares the clips' composed prompts.
   */
  clipLegends?: Record<string, string>
  image?: ApprovalImageRequest
  sequenceId?: string
  sequenceName?: string
  segmentIds?: string[]
  clipNumbers?: number[]
  priceUsd?: number
  /** Identifies what would be generated; an identical pending request is reused instead of asking twice. */
  fingerprint: string
  /** What it generates (e.g. a clip): a newer request for the same target replaces a pending older one. */
  target?: string
  /**
   * ApprovalStore.epoch() when the tool call began reading what it asks for. When every pending request has
   * lapsed since (the connection was switched off, the token changed, the library was switched), the call
   * belongs to what was ended and no request is made.
   */
  epoch?: number
  /**
   * `params` as they are now: the files moved since the request was made ("Städa upp", an asset renamed) followed
   * to where they are (db.followRewrites), as verify reads them. A pending request is listed with these, so the
   * dialog shows the pictures and composes the legend from the files as they are, and doesn't take a move for an
   * edited description.
   */
  paramsNow?: () => GenerationParams
  /** Throws (in Swedish) when what would be generated is no longer what the user is shown. Run before submitting. */
  verify?: () => void | Promise<void>
  /** Submits it; resolves with the ids of the generations it started (or the still it made). */
  execute: () => Promise<ApprovalOutcome>
}

interface Entry {
  request: ApprovalRequest
  plan: ApprovalPlan
  timer?: NodeJS.Timeout
  /** Being submitted right now (between the user's OK and Venice's answer). */
  executing: boolean
}

export class ApprovalStore {
  /** In creation order. */
  private readonly entries = new Map<string, Entry>()
  /** Counts expireAll calls; see ApprovalPlan.epoch. */
  private generation = 0

  /** `created`: a new request, not a change to one the user has seen. */
  constructor(private readonly onChange: (request: ApprovalRequest, created: boolean) => void) {}

  /**
   * Creates a pending request, or returns the pending one that asks for exactly the same thing. A pending
   * request for the same target (an older version of the clip, say) lapses in favour of the new one.
   */
  create(plan: ApprovalPlan): { request: ApprovalRequest; reused: boolean } {
    if (plan.epoch !== undefined && plan.epoch !== this.generation) {
      throw new Error(
        'Agentanslutningen stängdes av, token byttes eller biblioteket byttes medan förfrågan förbereddes, så den skickades inte till användaren. Fråga igen om det fortfarande ska genereras.'
      )
    }
    for (const entry of this.entries.values()) {
      if (entry.request.status === 'pending' && entry.plan.fingerprint === plan.fingerprint) {
        return { request: { ...entry.request }, reused: true }
      }
    }
    if (plan.target) {
      for (const entry of this.entries.values()) {
        if (entry.request.status === 'pending' && !entry.executing && entry.plan.target === plan.target) {
          this.finish(entry, { status: 'expired', error: 'Ersatt av en nyare förfrågan om samma sak.' })
        }
      }
    }
    const pending = [...this.entries.values()].filter((e) => e.request.status === 'pending').length
    if (pending >= MAX_PENDING) {
      throw new Error(
        `Det finns redan ${pending} förfrågningar som väntar på användaren. Vänta på svaret innan du ber om fler.`
      )
    }

    const now = Date.now()
    const request: ApprovalRequest = {
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      client: plan.client,
      note: plan.note?.trim() || undefined,
      kind: plan.kind,
      params: plan.params,
      ...(plan.composedPrompt !== undefined
        ? { composedPrompt: plan.composedPrompt, descriptionLegend: plan.descriptionLegend }
        : {}),
      ...(plan.clipLegends ? { clipLegends: plan.clipLegends } : {}),
      image: plan.image,
      sequenceId: plan.sequenceId,
      sequenceName: plan.sequenceName,
      segmentIds: plan.segmentIds,
      clipNumbers: plan.clipNumbers,
      priceUsd: plan.priceUsd,
      status: 'pending'
    }
    const entry: Entry = { request, plan, executing: false }
    entry.timer = setTimeout(() => this.lapse(entry), APPROVAL_TTL_MS)
    entry.timer.unref?.()
    this.entries.set(request.id, entry)
    this.prune()
    this.emit(entry, true)
    return { request: { ...request }, reused: false }
  }

  get(id: string): ApprovalRequest | undefined {
    const entry = this.entries.get(id)
    return entry && this.view(entry)
  }

  /** Pending requests and the most recently decided ones, oldest first. */
  list(): ApprovalRequest[] {
    return [...this.entries.values()].map((e) => this.view(e))
  }

  /** A copy of the request as it is shown: a pending one with its params following moved files (paramsNow). */
  private view(entry: Entry): ApprovalRequest {
    const request = { ...entry.request }
    if (request.status === 'pending' && entry.plan.paramsNow) {
      try {
        request.params = entry.plan.paramsNow()
      } catch {
        // Shown as it was made; verify still reads the files as they are.
      }
    }
    return request
  }

  /**
   * The user's answer. Approving submits the generation; the request comes back approved, or failed with the
   * reason. When Venice asks for consent first, this rejects with that NEEDS_CONSENT error and the request
   * stays pending, so it can be approved again once the consent is given.
   */
  async resolve(id: string, approve: boolean, reason?: string): Promise<ApprovalRequest> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Förfrågan finns inte längre.')
    if (entry.executing) throw new Error('Förfrågan behandlas redan.')
    if (entry.request.status !== 'pending') return { ...entry.request }
    if (!approve) {
      this.finish(entry, { status: 'declined', reason: reason?.trim() || undefined })
      return { ...entry.request }
    }
    if (Date.now() > (entry.request.expiresAt ?? Infinity)) {
      this.lapse(entry)
      return { ...entry.request }
    }

    entry.executing = true
    try {
      await entry.plan.verify?.()
      const outcome = await entry.plan.execute()
      const { generationIds, stillId, notice } = Array.isArray(outcome) ? { generationIds: outcome } : outcome
      this.finish(entry, {
        status: 'approved',
        generationIds: generationIds?.length ? generationIds : undefined,
        stillId,
        notice
      })
    } catch (err) {
      const message = errorText(err)
      // Stays pending: the user accepts the consent in the window and approves again.
      if (message.startsWith(NEEDS_CONSENT)) throw err instanceof Error ? err : new Error(message)
      this.finish(entry, { status: 'failed', error: message })
    } finally {
      entry.executing = false
    }
    return { ...entry.request }
  }

  /** Marks the start of a tool call that may ask for approval; see ApprovalPlan.epoch. */
  epoch(): number {
    return this.generation
  }

  /**
   * Every pending request lapses, e.g. when the library is switched or the connection is turned off, and so
   * does every request still being prepared (see ApprovalPlan.epoch).
   */
  expireAll(reason: string): void {
    this.generation++
    for (const entry of this.entries.values()) {
      if (entry.request.status === 'pending' && !entry.executing) this.finish(entry, { status: 'expired', error: reason })
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer)
  }

  private lapse(entry: Entry): void {
    if (entry.request.status !== 'pending' || entry.executing) return
    this.finish(entry, { status: 'expired', error: 'Förfrågan gick ut efter 30 minuter utan svar.' })
  }

  private finish(entry: Entry, patch: Partial<ApprovalRequest>): void {
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.request = { ...entry.request, ...patch }
    this.prune()
    this.emit(entry)
  }

  /** Forgets the oldest decided requests beyond MAX_DECIDED. */
  private prune(): void {
    const decided = [...this.entries.values()].filter((e) => e.request.status !== 'pending')
    for (const entry of decided.slice(0, Math.max(0, decided.length - MAX_DECIDED))) {
      this.entries.delete(entry.request.id)
    }
  }

  private emit(entry: Entry, created = false): void {
    try {
      this.onChange({ ...entry.request }, created)
    } catch (err) {
      console.warn('Could not broadcast an approval request:', err)
    }
  }
}
