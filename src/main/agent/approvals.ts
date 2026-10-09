import { randomUUID } from 'node:crypto'
import {
  NEEDS_CONSENT,
  type ApprovalDeleteItem,
  type ApprovalDeleteRequest,
  type ApprovalEditRequest,
  type ApprovalImageRequest,
  type ApprovalRequest,
  type GenerationParams,
  type SequenceKind
} from '@shared/types'
import { errorText } from './studio'

// What an agent asked for that needs the user's OK: paid generations (videos, pictures, Redigera's paid operations,
// designed voices) and removals ('delete'). Nothing reaches Venice, and nothing is removed, until the user approves
// the request in Studio; main then carries out exactly what the request describes, through the same code paths as
// the window.

/**
 * What carrying out an approved request led to: the generations it started, or the still it made – or, for a
 * Redigera request, the job it started and the version it made (merged into the request's `edit`) – or, for a
 * 'delete' request, every item with its outcome.
 */
export type ApprovalOutcome =
  | string[]
  | {
      generationIds?: string[]
      stillId?: string
      notice?: string
      edit?: Pick<ApprovalEditRequest, 'jobId' | 'resultId'>
      /** 'delete': the request's items with `outcome` set (written into request.delete.items). */
      deleteItems?: ApprovalDeleteItem[]
      /**
       * Nothing was carried out (a 'delete' request where nothing could be removed): the request ends `failed` with
       * this error rather than `approved`; deleteItems keep their outcomes either way.
       */
      failedError?: string
    }

/** A request being carried out right now (between the user's OK and its outcome), for Pågår och klart. */
export interface ExecutingApproval {
  id: string
  kind: ApprovalRequest['kind']
  /** The agent that asked. */
  client: string
  startedAt: number
  sequenceId?: string
  segmentIds?: string[]
  /** Swedish: what is being done, e.g. "Klipp 3 i ”Strandscen”", "Ta bort 3 saker i ”Sommar”". */
  summary: string
}

/**
 * Thrown by a plan's verify when what the request would carry out has changed since it was made (a 'delete' request's
 * items): it can never be approved as shown again, so it lapses ('expired', with this message) wherever the change is
 * found – the dialog's live check, get_approval, a new request for the same things, or the user's OK. Any other error
 * from verify only stands in the way for now (a run going on) and the request stays pending.
 */
export class ApprovalLapsed extends Error {}

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
  /** 'edit' and 'voice-design': what Redigera (or Karaktärer → Röst) will do, as the dialog shows it. */
  edit?: ApprovalEditRequest
  /** 'delete': what will be removed, as the dialog shows it. */
  delete?: ApprovalDeleteRequest
  sequenceId?: string
  /** 'storyboard' when sequenceId is a storyboard (a 'segment' request is then one of its transitions). */
  sequenceKind?: SequenceKind
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
  /**
   * Throws (in Swedish) when what would be carried out is no longer what the user is shown. Run before executing,
   * and – for a 'delete' request – whenever the open dialog checks it again (ApprovalStore.check), so it must not
   * change anything.
   */
  verify?: () => void | Promise<void>
  /** Carries it out; resolves with what that led to (see ApprovalOutcome). */
  execute: () => Promise<ApprovalOutcome>
}

interface Entry {
  request: ApprovalRequest
  plan: ApprovalPlan
  timer?: NodeJS.Timeout
  /** Being carried out right now (between the user's OK and the outcome, e.g. Venice's answer). */
  executing: boolean
  /** When it started being carried out. */
  startedAt?: number
}

/** "Klipp 3 i ”Strandscen”": what a request being carried out does, for Pågår och klart. */
function executingSummary(r: ApprovalRequest): string {
  const named = r.sequenceName ? ` i ”${r.sequenceName}”` : ''
  const storyboard = r.sequenceKind === 'storyboard'
  switch (r.kind) {
    case 'generation':
      return 'En video från Generera'
    case 'segment': {
      const n = r.clipNumbers?.[0]
      const what = storyboard ? (n ? `Övergång ${n}` : 'En övergång') : n ? `Klipp ${n}` : 'Ett klipp'
      return `${what}${named}`
    }
    case 'generate-all':
      return `Generera saknade${named}`
    case 'image': {
      const board = r.image?.assignToBoard
      if (board) return `Bild till ruta ${board.boardNumber}${named}`
      const slot = r.image?.assignTo
      if (slot) return `Bild till klipp ${slot.clipNumber}${named}`
      return r.sequenceName ? `Bild${named}` : 'Bild'
    }
    case 'edit':
      return r.edit?.editName ? `”${r.edit.editName}” – ${r.edit.summary}` : (r.edit?.summary ?? 'En ändring i Redigera')
    case 'voice-design':
      return r.edit?.summary ?? 'En ny röst'
    case 'delete':
      return r.delete?.summary ?? 'Tar bort det agenten bad om'
  }
}

export class ApprovalStore {
  /** In creation order. */
  private readonly entries = new Map<string, Entry>()
  /** Counts expireAll calls; see ApprovalPlan.epoch. */
  private generation = 0

  /**
   * `onChange`: a request was made or changed (`created`: a new one, not a change to one the user has seen).
   * `onExecuting`: a request started or stopped being carried out (Pågår och klart lists it meanwhile).
   */
  constructor(
    private readonly onChange: (request: ApprovalRequest, created: boolean) => void,
    private readonly onExecuting?: () => void
  ) {}

  /**
   * Creates a pending request, or returns the pending one that asks for exactly the same thing. A pending
   * request for the same target (an older version of the clip, say) lapses in favour of the new one.
   */
  create(plan: ApprovalPlan): { request: ApprovalRequest; reused: boolean } {
    if (plan.epoch !== undefined && plan.epoch !== this.generation) {
      throw new Error(
        'Agentanslutningen stängdes av, token byttes eller biblioteket byttes medan förfrågan förbereddes, så den skickades inte till användaren. Fråga igen om det fortfarande ska göras.'
      )
    }
    const same = this.findPending(plan.fingerprint)
    if (same) return { request: same, reused: true }
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
      ...(plan.edit ? { edit: plan.edit } : {}),
      ...(plan.delete ? { delete: plan.delete } : {}),
      sequenceId: plan.sequenceId,
      ...(plan.sequenceKind ? { sequenceKind: plan.sequenceKind } : {}),
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

  /** The pending request made with exactly this fingerprint (create would hand it back instead of asking again). */
  findPending(fingerprint: string): ApprovalRequest | undefined {
    for (const entry of this.entries.values()) {
      if (entry.request.status === 'pending' && entry.plan.fingerprint === fingerprint) return { ...entry.request }
    }
    return undefined
  }

  get(id: string): ApprovalRequest | undefined {
    const entry = this.entries.get(id)
    return entry && this.view(entry)
  }

  /** Pending requests and the most recently decided ones, oldest first. */
  list(): ApprovalRequest[] {
    return [...this.entries.values()].map((e) => this.view(e))
  }

  /** The requests being carried out right now, oldest first. */
  executing(): ExecutingApproval[] {
    const out: ExecutingApproval[] = []
    for (const entry of this.entries.values()) {
      if (!entry.executing) continue
      const r = entry.request
      out.push({
        id: r.id,
        kind: r.kind,
        client: r.client,
        startedAt: entry.startedAt ?? Date.now(),
        ...(r.sequenceId ? { sequenceId: r.sequenceId } : {}),
        ...(r.segmentIds?.length ? { segmentIds: [...r.segmentIds] } : {}),
        summary: executingSummary(r)
      })
    }
    return out
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
   * The live check of a pending 'delete' request (the open dialog's, get_approval's, a new request's): runs its verify
   * without carrying anything out. null while it can still be approved (and for every other kind, whose dialogs check
   * what they show themselves), else why not (Swedish). A request whose items changed lapses here ('expired').
   */
  async check(id: string): Promise<string | null> {
    const entry = this.entries.get(id)
    if (!entry) return 'Förfrågan finns inte längre.'
    if (entry.request.kind !== 'delete' || entry.request.status !== 'pending' || entry.executing) return null
    try {
      await entry.plan.verify?.()
      return null
    } catch (err) {
      const message = errorText(err)
      // Approved, declined or being carried out meanwhile: that stands.
      if (err instanceof ApprovalLapsed && entry.request.status === 'pending' && !entry.executing) {
        this.finish(entry, { status: 'expired', error: message })
      }
      return message
    }
  }

  /**
   * The user's answer. Approving carries the request out; it comes back approved, or failed with the reason. When
   * Venice asks for consent first, this rejects with that NEEDS_CONSENT error and the request stays pending, so it
   * can be approved again once the consent is given.
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
    entry.startedAt = Date.now()
    this.executingChanged()
    try {
      await entry.plan.verify?.()
      const outcome = await entry.plan.execute()
      const { generationIds, stillId, notice, edit, deleteItems, failedError } = Array.isArray(outcome)
        ? { generationIds: outcome, edit: undefined, deleteItems: undefined, failedError: undefined }
        : outcome
      // Every item's outcome is kept, also when nothing could be removed, so the dialog and get_approval say why.
      const removal =
        deleteItems && entry.request.delete ? { delete: { ...entry.request.delete, items: deleteItems } } : {}
      if (failedError) {
        this.finish(entry, { status: 'failed', error: failedError, ...(notice ? { notice } : {}), ...removal })
      } else {
        this.finish(entry, {
          status: 'approved',
          generationIds: generationIds?.length ? generationIds : undefined,
          stillId,
          notice,
          // The job it started and the version it made, for get_approval and the dialog.
          ...(edit && entry.request.edit ? { edit: { ...entry.request.edit, ...edit } } : {}),
          ...removal
        })
      }
    } catch (err) {
      const message = errorText(err)
      // Stays pending: the user accepts the consent in the window and approves again.
      if (message.startsWith(NEEDS_CONSENT)) throw err instanceof Error ? err : new Error(message)
      // Changed since it was asked for: it lapsed rather than failed (nothing was tried).
      this.finish(entry, { status: err instanceof ApprovalLapsed ? 'expired' : 'failed', error: message })
    } finally {
      entry.executing = false
      entry.startedAt = undefined
      this.executingChanged()
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

  /** Forgets the oldest decided requests beyond MAX_DECIDED (never one being carried out). */
  private prune(): void {
    const decided = [...this.entries.values()].filter((e) => e.request.status !== 'pending' && !e.executing)
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

  private executingChanged(): void {
    try {
      this.onExecuting?.()
    } catch (err) {
      // Only bookkeeping for the status panel; the request itself goes on.
      console.warn('Could not announce an approval being carried out:', err)
    }
  }
}
