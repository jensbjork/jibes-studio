import { statSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  ApprovalEditRequest,
  ApprovalRequest,
  EditJob,
  EditPlan,
  EditRunResult,
  Transcript,
  VoiceDesignRequest
} from '@shared/types'
import * as db from '../../db'
import { getJob } from '../../edit-store'
import type { ApprovalPlan } from '../approvals'
import { callService } from '../local-ipc'
import { AssetIndex, audioOf, localTime, q, requireLibrary } from '../studio'
import { operationInput, operationOutput, operationSummary, segmentIdsOf, type VoiceNames } from './edit-input'
import { baseVersion, editOperation, jobInfo, loadEdit, planInfo, planOperation, versionInfo, versionName, within } from './editor'
import { defineTool, priceValue, usd, type ToolContext } from './kit'

// The two paid requests of Redigera: a paid operation on a version (request_edit_operation) and a new voice for a
// character (request_voice_design). Like every paid tool they only create an approval request; the user's OK in
// Studio runs it, through the same edit service the window's buttons use, with the price the user saw as the
// ceiling (expectedPriceUsd: the service refuses when Venice's price rose by more than a cent).

const CHANGED =
  'har ändrats sedan agenten bad om lov, så förfrågan gäller inte längre. Be agenten fråga igen om det fortfarande ska göras.'

/** How much the price may rise between the request and the approval (Venice rounds to the cent). */
const PRICE_SLACK_USD = 0.01

/**
 * The plan's problem that only the user's clone consent solves ("Bocka i att du har rätt att använda rösten"): the
 * approval dialog asks for that consent itself, so it doesn't stop the request.
 */
const CONSENT_PROBLEM = /rätt att använda rösten/i

/** Which file a version is (device, inode, size, modification time): a path names a place, not a film. */
function fileIdentity(path: string | undefined): string {
  if (!path) return 'none'
  try {
    const s = statSync(path)
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/** The base version's file as the database has it now (a renamed edit moves its folder; the file stays itself). */
const baseIdentity = (baseId: string): string => fileIdentity(db.getGeneration(baseId)?.filePath)

/** A plan's price as part of a request's identity: "0.35", "0.12+" (a part unpriced), "unknown". */
function priceKey(plan: Pick<EditPlan, 'priceUsd' | 'partialPrice'>): string {
  return plan.priceUsd === undefined ? 'unknown' : `${plan.priceUsd}${plan.partialPrice ? '+' : ''}`
}

/** The price rose past what the user approves (unknown then and now is the same unknown). */
function priceRose(approved: number | undefined, now: number | undefined): boolean {
  if (approved === undefined) return now !== undefined
  return now === undefined || now > approved + PRICE_SLACK_USD
}

/**
 * The price the service may charge at most, as approved. A paid run always needs one; a price Venice couldn't give
 * (the user approved "okänt pris") is 0, so the run goes ahead while it is still unknown and is refused should a
 * price have appeared meanwhile (verify lapses the request in that case already).
 */
const approvedPrice = (priceUsd: number | undefined): number => priceUsd ?? 0

function requestApproval(ctx: ToolContext, epoch: number, plan: Omit<ApprovalPlan, 'epoch'>): ReturnType<ToolContext['approvals']['create']> {
  if (!ctx.connected()) throw new Error('Agentanslutningen är stängd, så förfrågan skickades inte till användaren.')
  return ctx.approvals.create({ ...plan, epoch })
}

function pendingAnswer(request: ApprovalRequest, reused: boolean): Record<string, unknown> {
  return {
    approval_id: request.id,
    status: request.status,
    price_usd: priceValue(request.priceUsd) ?? null,
    ...(request.edit?.partialPrice ? { partial_price: true } : {}),
    expires: localTime(request.expiresAt),
    ...(reused ? { reused: true } : {}),
    message: reused
      ? 'An identical request is already waiting for the user; this is that one.'
      : 'Waiting for the user to approve it in Studio. Tell them briefly what is waiting, then poll get_approval every 15–30 seconds.'
  }
}

/** The character a Röst clip belongs to, and whether the user lets it be cloned. */
function cloneSource(assets: AssetIndex, audioId: string): { assetName: string; consent: boolean } {
  const ref = assets.requireAudio(audioId)
  if (ref.asset.kind !== 'character') {
    throw new Error(`${q(ref.asset.name)} är ingen karaktär: bara en karaktärs röstklipp kan klonas.`)
  }
  return { assetName: ref.asset.name, consent: ref.audio.cloneConsent === true }
}

/** Voice designs approved in this session: the character's clips before, to name the new one in get_approval. */
const designs = new Map<string, { assetId: string; before: Set<string> }>()

export function registerEditorPaidTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'request_edit_operation',
    {
      title: 'Request a paid edit operation (needs approval)',
      description:
        "💰 Asks the user to approve a paid operation on a version of an edit (default the current one): transcribe, change_voice, speak_lines, music, effect, regenerate, prompt_edit, extend or upscale – the same operation input as plan_edit_operation, which you should call first. Nothing is sent to Venice or paid for until the user approves in Studio; the dialog shows the version's poster (and the frames a picture operation works from: regenerate's start and end frames, extend's last frame, prompt_edit's first and last frame of the range), what changes (prompt, old → new lines, the lines change_voice gives a new voice when you pass segment_ids, the voice), the parts and the price (with \"+\" and partial_price when a part has none, e.g. a voice clone: the user is asked once more then, as for an unknown price or one above $5). A voice cloned from a character's Röst clip needs the user's consent (clone_consent in list_assets): the dialog asks for it; you can't give it. Problems come back as an error and no request is made; free operations are refused (apply_edit). Returns immediately with {approval_id, status: \"pending\", price_usd}; follow it with get_approval (job progress, then the new version), then review the version with review_generation. The request lapses if the version's file, the plan (range, prompt, model, voice, lines) or the transcript lines it uses change before the user answers, or if Venice's price rises; a newer request for the same operation on the same version replaces a pending older one, and asking again for the very same thing at the same price returns the pending one (reused) – at another price it replaces it.",
      input: {
        edit_id: z.string().describe('An edit_id from list_edits.'),
        base_version_id: z.string().optional().describe("The version to work on (get_edit's versions); default the current one."),
        operation: operationInput,
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog (Swedish): why.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill redigera en film'
    },
    async ({ edit_id, base_version_id, operation, note }) => {
      const epoch = ctx.approvals.epoch()
      const edit = await loadEdit(edit_id)
      const base = baseVersion(edit, base_version_id)
      const op = await editOperation(operation)
      const plan = await planOperation(edit.id, op, base.id)
      if (!plan.paid) {
        throw new Error(`${operation.op} är gratis och behöver inget godkännande: gör det med apply_edit.`)
      }

      // A cloned voice: whose it is, and whether the user still has to say they may use it.
      const clone = op.op === 'speak-lines' && op.voice.kind === 'clone' ? op.voice.audioId : undefined
      const assets = clone ? await AssetIndex.load() : undefined
      const source = clone ? cloneSource(assets!, clone) : undefined
      const problems = plan.problems.filter((p) => !(source && !source.consent && CONSENT_PROBLEM.test(p)))
      if (problems.length) throw new Error(problems.join(' '))

      // The transcript lines it replaces or keeps to, as they are now: a line edited meanwhile is another line.
      const segmentIds = segmentIdsOf(plan.operation)
      const transcript =
        segmentIds.length || plan.operation.op === 'speak-lines'
          ? await callService<Transcript | null>('edits:transcript', base.id)
          : null
      if (segmentIds.length && !transcript) {
        throw new Error('Versionen har ingen transkription än, så repliker kan inte väljas. Transkribera den först (op: "transcribe").')
      }
      const transcriptStamp = segmentIds.length ? transcript!.updatedAt : undefined
      const lines =
        plan.operation.op === 'speak-lines'
          ? plan.operation.lines.map((l) => {
              const line = l.segmentId ? transcript?.segments.find((s) => s.id === l.segmentId) : undefined
              return { ...(line ? { old: line.text } : {}), new: l.text, at: line?.start ?? l.at ?? 0 }
            })
          : undefined
      // Change voice on chosen lines: the user sees which lines (whose voice) the agent picked before paying.
      const voiceLines =
        plan.operation.op === 'change-voice' && segmentIds.length
          ? (transcript?.segments ?? [])
              .filter((s) => segmentIds.includes(s.id))
              .sort((a, b) => a.start - b.start)
              .map((s) => ({ text: s.text, at: s.start }))
          : undefined

      const names: VoiceNames = { cloneOf: (id) => (id === clone ? source?.assetName : undefined) }
      const summary = operationSummary(plan.operation, base.generation.videoDuration, names)
      const identity = baseIdentity(base.id)
      const request: ApprovalEditRequest = {
        editId: edit.id,
        editName: edit.name,
        baseId: base.id,
        baseNumber: base.number,
        operation: plan.operation,
        summary,
        ...(plan.frames?.start || plan.frames?.end ? { frames: plan.frames } : {}),
        ...(lines ? { lines } : {}),
        ...(voiceLines?.length ? { voiceLines } : {}),
        ...(plan.steps.length ? { steps: plan.steps.map((s) => ({ label: s.label, priceUsd: s.priceUsd })) } : {}),
        ...(plan.priceNote ? { priceNote: plan.priceNote } : {}),
        ...(plan.partialPrice ? { partialPrice: true } : {}),
        ...(source && !source.consent ? { needsCloneConsent: { audioId: clone!, assetName: source.assetName } } : {})
      }

      /** Throws (Swedish) when what would run now is not what the user is shown. */
      const verify = async (): Promise<void> => {
        const now = await loadEdit(edit.id).catch(() => undefined)
        if (!now) throw new Error('Redigeringen finns inte längre, så förfrågan gäller inte.')
        if (!now.versions.some((v) => v.id === base.id)) {
          throw new Error(`Version ${versionName(base)} finns inte längre i ${q(now.name)}, så förfrågan gäller inte.`)
        }
        if (baseIdentity(base.id) !== identity) throw new Error(`Filmen i ${versionName(base)} ${CHANGED}`)
        if (transcriptStamp !== undefined) {
          const t = await callService<Transcript | null>('edits:transcript', base.id)
          if (t?.updatedAt !== transcriptStamp) throw new Error(`Transkriptionen ${CHANGED}`)
        }
        if (clone) {
          // The dialog asks for the consent and gives it before approving; anything else is a lapse.
          const assetsNow = await AssetIndex.load()
          if (!cloneSource(assetsNow, clone).consent) {
            throw new Error('Bocka i att du har rätt att använda rösten innan den klonas.')
          }
        }
        const again = await planOperation(edit.id, op, base.id)
        if (again.problems.length) throw new Error(again.problems.join(' '))
        if (again.fingerprint !== plan.fingerprint) throw new Error(`Det som skulle göras ${CHANGED}`)
        if (priceRose(plan.priceUsd, again.priceUsd)) {
          throw new Error(
            `Priset har ändrats sedan agenten frågade (${usd(plan.priceUsd)} → ${usd(again.priceUsd)}), så förfrågan gäller inte längre. Be agenten fråga igen.`
          )
        }
      }

      const { request: created, reused } = requestApproval(ctx, epoch, {
        kind: 'edit',
        client: ctx.clientName(),
        note,
        edit: request,
        priceUsd: plan.priceUsd,
        // The price is part of "the same request": asked again at another price (a quote that failed now works, Venice
        // changed it), the pending one is replaced (target) rather than handed back with its old price.
        fingerprint: `edit:${edit.id}:${base.id}:${plan.fingerprint}:${priceKey(plan)}`,
        // A newer request for the same kind of operation on the same version replaces one still waiting.
        target: `edit:${edit.id}:${base.id}:${plan.operation.op}`,
        verify,
        // The service runs exactly this operation on exactly this version, and refuses on its own when the price
        // rose past what was approved. A NEEDS_CONSENT error (Seedance) keeps the request pending.
        execute: async () => {
          const result = await callService<EditRunResult>('edits:run', edit.id, op, {
            baseId: base.id,
            expectedPriceUsd: approvedPrice(plan.priceUsd),
            // Unknown or partial as the user approved it (verify has already compared the work itself).
            expectedPartial: plan.priceUsd === undefined || !!plan.partialPrice
          })
          return {
            generationIds: result.takeId ? [result.takeId] : undefined,
            edit: { jobId: result.jobId, resultId: result.versionId }
          }
        }
      })
      // What will be done, then the request (whose price is the one the user is asked to approve).
      const { problems: _problems, ready: _ready, ...planned } = planInfo(plan, base)
      return {
        data: {
          edit_id: edit.id,
          ...planned,
          ...pendingAnswer(created, reused),
          ...(request.needsCloneConsent
            ? {
                clone_consent_needed: `The user hasn't confirmed they may use ${source!.assetName}'s voice; the dialog asks them to tick it before approving.`
              }
            : {})
        },
        approvalId: created.id,
        summary: `vill redigera ${q(edit.name)} ${versionName(base)}: ${summary} (${usd(plan.priceUsd)}${plan.partialPrice ? ' + en del utan pris' : ''}) – väntar på ditt OK`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'request_voice_design',
    {
      title: 'Request a designed voice (paid, needs approval)',
      description:
        "💰 Asks the user to approve making a new voice for a character with AI (\"Skapa röst med AI\", seed-audio, about $0.35): a description of the voice and a sample text it reads. Once approved and made, the result is added as a new Röst clip of the character (list_assets / get_asset show it; listen with include_audio) – the only way an agent can add an audio clip, and only with the user's OK. The voice can then be a reference voice (@AudioN) or, once the user allows cloning it, the voice of new lines (speak_lines with clone_audio_id). Write the description in English: age, gender, timbre, pace, accent, mood (\"A calm, deep male voice around fifty, slightly hoarse\"); the sample text in the language the character speaks. Returns {approval_id, status: \"pending\", price_usd}; follow it with get_approval. One design per character waits at a time: a newer request_voice_design for the same character replaces a pending one (it lapses as \"Ersatt av en nyare förfrågan om samma sak\"), so offer alternatives one after another rather than at once.",
      input: {
        asset_id: z.string().describe('A character (list_assets).'),
        description: z.string().min(3).max(1000).describe('The voice, in English.'),
        sample_text: z.string().min(1).max(1000).describe('What the voice says in the sample (the character’s language).'),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog (Swedish).')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill skapa en röst'
    },
    async ({ asset_id, description, sample_text, note }) => {
      const epoch = ctx.approvals.epoch()
      requireLibrary()
      const asset = (await AssetIndex.load()).require(asset_id)
      if (asset.kind !== 'character') throw new Error(`${q(asset.name)} är ingen karaktär: bara karaktärer har en röst.`)
      const req: VoiceDesignRequest = { assetId: asset.id, description: description.trim(), sampleText: sample_text.trim() }
      const plan = await callService<EditPlan>('voices:plan', req)
      if (plan.problems.length) throw new Error(plan.problems.join(' '))
      const summary = `Skapa en ny röst till ${asset.name}`
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'voice-design',
        client: ctx.clientName(),
        note,
        edit: {
          assetId: asset.id,
          assetName: asset.name,
          voiceDesign: req,
          summary,
          ...(plan.steps.length ? { steps: plan.steps.map((s) => ({ label: s.label, priceUsd: s.priceUsd })) } : {}),
          ...(plan.priceNote ? { priceNote: plan.priceNote } : {})
        },
        priceUsd: plan.priceUsd,
        fingerprint: `voice-design:${asset.id}:${plan.fingerprint}:${priceKey(plan)}`,
        // One voice design per character waits at a time: a newer request for the same character replaces it.
        target: `voice-design:${asset.id}`,
        verify: async () => {
          const now = (await AssetIndex.load()).get(asset.id)
          if (!now) throw new Error('Karaktären finns inte längre, så förfrågan gäller inte.')
          const again = await callService<EditPlan>('voices:plan', req)
          if (again.problems.length) throw new Error(again.problems.join(' '))
          if (again.fingerprint !== plan.fingerprint) throw new Error(`Rösten som skulle skapas ${CHANGED}`)
          if (priceRose(plan.priceUsd, again.priceUsd)) {
            throw new Error(
              `Priset har ändrats sedan agenten frågade (${usd(plan.priceUsd)} → ${usd(again.priceUsd)}), så förfrågan gäller inte längre. Be agenten fråga igen.`
            )
          }
        },
        execute: async () => {
          const before = new Set(audioOf((await AssetIndex.load()).require(asset.id)).map((a) => a.id))
          const job = await callService<EditJob>('voices:design', req, approvedPrice(plan.priceUsd))
          designs.set(job.id, { assetId: asset.id, before })
          return { edit: { jobId: job.id } }
        }
      })
      return {
        data: {
          ...pendingAnswer(request, reused),
          asset_id: asset.id,
          asset_name: asset.name,
          ...(plan.priceNote ? { price_note: plan.priceNote } : {}),
          ...(plan.notes.length ? { notes: plan.notes } : {}),
          ...(plan.warnings.length ? { warnings: plan.warnings } : {})
        },
        approvalId: request.id,
        summary: `vill skapa en ny röst till ${q(asset.name)} (${usd(plan.priceUsd)}) – väntar på ditt OK`
      }
    }
  )
}

/** A voice design job's state, read from the edit store (the job has no edit, so get_edit doesn't list it). */
function designJobState(jobId: string): { status: string; error?: string; cost?: number } | undefined {
  try {
    const job = getJob(jobId)
    return job ? { status: job.status, error: job.error, cost: job.cost || undefined } : undefined
  } catch {
    return undefined
  }
}

/** get_approval's fields for an 'edit' or 'voice-design' request: what it asks for, and what came of it. */
export async function editApprovalInfo(request: ApprovalRequest): Promise<Record<string, unknown>> {
  const e = request.edit
  if (!e) return {}
  if (request.kind === 'voice-design') {
    const data: Record<string, unknown> = {
      asset_id: e.assetId,
      asset_name: e.assetName,
      ...(e.voiceDesign ? { description: e.voiceDesign.description, sample_text: e.voiceDesign.sampleText } : {}),
      ...(e.jobId ? { job_id: e.jobId } : {})
    }
    if (request.status === 'approved' && e.jobId) {
      const state = designJobState(e.jobId)
      if (state) data.job = { status: state.status, ...(state.error ? { error: state.error } : {}), ...(state.cost ? { cost_usd: priceValue(state.cost) } : {}) }
      const known = designs.get(e.jobId)
      const asset = known ? await within(AssetIndex.load(), 5000).then((i) => i?.get(known.assetId)) : undefined
      const added = asset ? audioOf(asset).filter((a) => !known!.before.has(a.id)) : []
      if (added.length) {
        data.new_audio = added.map((a) => ({ audio_id: a.id, duration: Math.round(a.duration * 10) / 10 }))
        data.next = `Listen with get_asset({asset_id: "${asset!.id}", include_audio: true, audio_id: "${added[0].id}"}).`
      } else if (state?.status === 'running' || !state) {
        data.next = 'The voice is being made; poll get_approval again in 15–30 seconds.'
      }
    }
    return data
  }
  const data: Record<string, unknown> = {
    edit_id: e.editId,
    edit_name: e.editName,
    base_version_id: e.baseId,
    ...(e.baseNumber ? { base_version: `v${e.baseNumber}` } : {}),
    ...(e.operation ? { operation: operationOutput(e.operation) } : {}),
    summary: e.summary,
    ...(e.partialPrice ? { partial_price: true } : {}),
    ...(e.voiceLines?.length ? { lines_changed: e.voiceLines.map((l) => ({ at: Math.round(l.at * 10) / 10, text: l.text })) } : {}),
    ...(e.needsCloneConsent ? { clone_consent_needed: e.needsCloneConsent.assetName } : {}),
    ...(e.jobId ? { job_id: e.jobId } : {}),
    ...(e.resultId ? { result_version_id: e.resultId } : {})
  }
  if (request.status === 'approved' && e.editId) {
    const edit = await within(loadEdit(e.editId), 5000)
    const job = e.jobId ? edit?.jobs.find((j) => j.id === e.jobId) : undefined
    if (job) data.job = jobInfo(job)
    const resultId = job?.resultId ?? e.resultId
    const result = resultId ? edit?.versions.find((v) => v.id === resultId) : undefined
    if (result) {
      data.result_version = versionInfo(result)
      data.next = `Review it with review_generation({generation_id: "${result.id}", include_audio: true}).`
    } else if (job?.status === 'running') {
      data.next = 'Still running; poll get_approval (or get_edit) again in 15–30 seconds.'
    } else if (e.operation?.op === 'transcribe' && job?.status === 'completed') {
      data.next = `Read it with get_transcript({generation_id: "${e.baseId}"}).`
    }
  }
  return data
}
