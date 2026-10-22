import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { paramsForSubmit } from '@shared/models'
import type { AgentFormState, GenerationParams, PromptLanguage } from '@shared/types'
import type { ApprovalStore } from '../approvals'
import type { FormBridge } from '../bridge'
import type { AudioBlock, ImageBlock } from '../images'
import { callService } from '../local-ipc'
import { errorText } from '../studio'
import type { UploadStore } from '../uploads'

// The frame every tool is built in: input validated by zod (the SDK answers malformed input itself), the
// answer as compact JSON plus pictures, errors as tool errors the agent can read, and an entry in the
// activity log for every call.

/** What a session's tools share. */
export interface ToolContext {
  bridge: FormBridge
  approvals: ApprovalStore
  /** Files agents send (begin_upload), shared by every session. */
  uploads: UploadStore
  promptLanguage(): PromptLanguage
  /** The agent's name, as shown in the activity log and on approval requests. */
  clientName(): string
  /** Where the agent connects from (its own machine as Studio sees it: loopback for an agent on this Mac). */
  peer(): string
  /** "http://<host>:<port>" as the agent reached Studio, for upload URLs; undefined when it can't be told. */
  baseUrl(): string | undefined
  /** Studio's agent port, which a URL fetch never goes to. */
  agentPort(): number | undefined
  /** The client's protocol version knows audio content (2025-03-26 and later). */
  audioContent(): boolean
  /** False once the session has ended or the connection was switched off; nothing is asked of the user then. */
  connected(): boolean
  /** `readOnly`: a call that changes nothing (a poll), which the log may fold into an earlier identical one. */
  record(entry: { tool: string; summary: string; ok: boolean; approvalId?: string; readOnly?: boolean }): void
}

export interface LabeledImage {
  /** Says what the picture is, e.g. "Anna – photo 2 (image_id …)". */
  label: string
  image: ImageBlock
}

export interface LabeledAudio {
  /** Says what the sound is, e.g. "@Audio1 = Anna's voice, 0.0–8.0 s". */
  label: string
  audio: AudioBlock
}

export interface ToolOutput {
  /** Serialized as compact JSON. */
  data: unknown
  images?: LabeledImage[]
  /** MCP audio content (MP3), each after its label; clients that can't play it simply ignore it. */
  audio?: LabeledAudio[]
  /** The activity log's summary when it depends on the result (e.g. the asset's name). */
  summary?: string
  approvalId?: string
}

interface ToolSpec<S extends ZodRawShapeCompat> {
  title: string
  description: string
  input: S
  annotations: ToolAnnotations
  /** What the call does, for the activity log: a past-tense phrase that follows the agent's name ("set the prompt"). */
  summary: (args: ShapeOutput<S>) => string
}

const MAX_SUMMARY = 160

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat
}

/** What runs when the tool call in progress has answered (see afterCall). */
const callScope = new AsyncLocalStorage<(() => void | Promise<void>)[]>()

/**
 * Runs `cleanup` once the tool call in progress has answered (or failed), e.g. to throw away the uploads a URL source
 * was staged as once the call has copied them in. Outside a tool call there is no end to wait for, and nothing runs
 * (what it would clean up expires by itself).
 */
export function afterCall(cleanup: () => void | Promise<void>): void {
  callScope.getStore()?.push(cleanup)
}

/** Registers one tool on the session's server. */
export function defineTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  spec: ToolSpec<S>,
  run: (args: ShapeOutput<S>) => Promise<ToolOutput>
): void {
  const handler = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
    let summary = name
    try {
      summary = spec.summary(args)
    } catch {
      // A summary is only for the log; the call itself goes ahead.
    }
    const readOnly = spec.annotations.readOnlyHint === true
    const cleanups: (() => void | Promise<void>)[] = []
    try {
      const out = await callScope.run(cleanups, () => run(args))
      ctx.record({
        tool: name,
        summary: shorten(out.summary ?? summary),
        ok: true,
        approvalId: out.approvalId,
        readOnly
      })
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(out.data) }]
      for (const { label, image } of out.images ?? []) content.push({ type: 'text', text: label }, image)
      const audio = out.audio ?? []
      if (audio.length && !ctx.audioContent()) {
        content.push({
          type: 'text',
          text: `(${audio.length === 1 ? 'One audio clip was' : `${audio.length} audio clips were`} left out: this MCP client's protocol version has no audio content.)`
        })
      } else {
        for (const { label, audio: block } of audio) content.push({ type: 'text', text: label }, block)
      }
      return { content }
    } catch (err) {
      const message = errorText(err)
      ctx.record({ tool: name, summary: shorten(`${summary} – ${message}`), ok: false, readOnly })
      return { isError: true, content: [{ type: 'text', text: message }] }
    } finally {
      for (const cleanup of cleanups.splice(0)) {
        try {
          await cleanup()
        } catch (err) {
          console.warn(`A cleanup after ${name} failed:`, err)
        }
      }
    }
  }
  server.registerTool(
    name,
    { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
    // The SDK's callback type can't be resolved for a generic shape; handler's own signature is the checked one.
    handler as never
  )
}

// ── Shared steps ─────────────────────────────────────────────────────────────

/** The window's Generate form, and where the user is in Studio. */
export async function readForm(ctx: ToolContext): Promise<AgentFormState> {
  const state = await ctx.bridge.send<AgentFormState>('get_form')
  if (!state || typeof state !== 'object' || !state.params) throw new Error('The Studio window didn\'t answer as expected.')
  return state
}

const QUOTE_TIMEOUT_MS = 8000

/** Venice's price in USD for the params (free to ask); undefined when it can't be had in time. */
export async function quote(params: GenerationParams): Promise<number | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUOTE_TIMEOUT_MS)
  })
  try {
    const price = await Promise.race([
      callService<number>('video:quote', paramsForSubmit(params)).catch(() => undefined),
      timeout
    ])
    return typeof price === 'number' && Number.isFinite(price) ? price : undefined
  } finally {
    clearTimeout(timer)
  }
}

/** "$0.42", the way Studio shows prices. */
export function usd(v: number | undefined): string {
  if (v === undefined) return 'unknown price'
  return `$${v.toFixed(v < 0.1 ? 3 : 2)}`
}

/** Rounded to cents (a tenth of a cent below a dime), for the JSON answers. */
export function priceValue(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 1000) / 1000
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

// ── Shared input shapes ──────────────────────────────────────────────────────

/** One asset's references, as set_references, validate_prompt, add_segment and update_segment take them. */
export const assetReferenceItem = z.object({
  asset_id: z.string().describe('An asset id from list_assets.'),
  image_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Only these photos, in this order (image_ids from list_assets/get_asset). All the asset's photos when left out; [] for none of them (e.g. to use only a character's voice)."
    ),
  audio_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Only these audio clips of the asset (audio_ids from list_assets/get_asset), in this order, as @AudioN references. Only for models with audio_input."
    ),
  include_voice: z
    .boolean()
    .optional()
    .describe(
      "When no audio_ids are given: add the asset's first audio clip (a character's voice, an environment's soundscape). Default: true for characters when the model takes reference audio, false otherwise; a default voice shorter than 2 s is left out and reported in not_added_audio."
    )
})

/**
 * A reference video (@VideoN, Seedance 2.x reference-to-video): a finished generation's film (a take, a clip from the
 * feed, an own clip, a version), an exported film or a ready video upload (copied into "Reference images" first), and
 * the window of it that is sent. A reference only: its action, camera movement and style – never footage to edit.
 */
export const videoReferenceItem = z
  .object({
    video: z
      .union([
        z.object({ generation_id: z.string().describe('A finished generation (list_generations, a take).') }).strict(),
        z.object({ export_id: z.string().describe('An exported film (list_exports).') }).strict(),
        z.object({ upload_id: z.string().describe('A ready video upload (begin_upload kind "video").') }).strict()
      ])
      .describe('The film: {generation_id}, {export_id} or {upload_id}.'),
    start: z.number().min(0).optional().describe('Seconds into the film where the window starts. Default 0.'),
    length: z
      .number()
      .positive()
      .optional()
      .describe(
        "Seconds of the film that are sent (at least 2; at most 15 on Seedance 2.0, 30 on 2.5, and the videos together no more). Default: 5 s, or what is left of the film."
      )
  })
  .strict()

/**
 * A reference: an asset's photos (and audio), one loose picture – a still, or an uploaded picture (made a still in
 * "Reference images" first, so the form or clip never points into the scratch folder) – or a reference video. A loose
 * picture has no description, so nothing is appended to the prompt for it.
 */
export const referenceItem = z.union([
  assetReferenceItem,
  z.object({ still_id: z.string().describe('A still (list_stills): one picture, no description.') }).strict(),
  z
    .object({ upload_id: z.string().describe('A ready image upload (begin_upload): one picture, no description.') })
    .strict(),
  videoReferenceItem
])

/** The "Include descriptions" switch, as set_form, validate_prompt, add_segment and update_segment take it. */
export const includeDescriptionsInput = z
  .boolean()
  .optional()
  .describe(
    "Append the descriptions of the referenced assets to the prompt as a References legend (Studio's \"Include descriptions\"). Default true; false sends the prompt alone."
  )

/** Assets whose description is left out of the References legend, as the same tools take them. */
export const excludedDescriptionsInput = z
  .array(z.string())
  .max(50)
  .optional()
  .describe(
    "Asset ids whose descriptions are NOT appended (the others still are). Replaces the list; [] appends all of them again."
  )

/** Who wears which outfit ("worn by"), as set_form, add_segment and update_segment take it. */
export const outfitWearersInput = z
  .array(
    z
      .object({
        outfit_asset_id: z.string().describe('An outfit among the references.'),
        character_asset_id: z
          .string()
          .nullable()
          .optional()
          .describe("The character among the references who wears it; null: nobody; left out: Studio's default again.")
      })
      .strict()
  )
  .max(20)
  .optional()
  .describe(
    "Who wears each outfit among the references. The References legend says it after the prompt (\"Red dress (@Image3), worn by Anna (@Image1)\") – you needn't write it. By default an outfit is worn by the character whose default outfit it is, else by the only character among the references. Only the outfits you list change."
  )
