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

// The frame every tool is built in: input validated by zod (the SDK answers malformed input itself), the
// answer as compact JSON plus pictures, errors as tool errors the agent can read, and an entry in the
// activity log for every call.

/** What a session's tools share. */
export interface ToolContext {
  bridge: FormBridge
  approvals: ApprovalStore
  promptLanguage(): PromptLanguage
  /** The agent's name, as shown in the activity log and on approval requests. */
  clientName(): string
  /** The client's protocol version knows audio content (2025-03-26 and later). */
  audioContent(): boolean
  /** False once the session has ended or the connection was switched off; nothing is asked of the user then. */
  connected(): boolean
  /** `readOnly`: a call that changes nothing (a poll), which the log may fold into an earlier identical one. */
  record(entry: { tool: string; summary: string; ok: boolean; approvalId?: string; readOnly?: boolean }): void
}

export interface LabeledImage {
  /** Says what the picture is, e.g. "Anna – foto 2 (image_id …)". */
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
  /** What the call does, in Swedish, for the activity log ("satte prompten"). */
  summary: (args: ShapeOutput<S>) => string
}

const MAX_SUMMARY = 160

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat
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
    try {
      const out = await run(args)
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
  if (!state || typeof state !== 'object' || !state.params) throw new Error('Studio-fönstret svarade inte som väntat.')
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
  if (v === undefined) return 'okänt pris'
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
export const referenceItem = z.object({
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

/** The "Ta med beskrivningar" switch, as set_form, validate_prompt, add_segment and update_segment take it. */
export const includeDescriptionsInput = z
  .boolean()
  .optional()
  .describe(
    "Append the descriptions of the referenced assets to the prompt as a References legend (Studio's \"Ta med beskrivningar\"). Default true; false sends the prompt alone."
  )

/** Assets whose description is left out of the References legend, as the same tools take them. */
export const excludedDescriptionsInput = z
  .array(z.string())
  .max(50)
  .optional()
  .describe(
    "Asset ids whose descriptions are NOT appended (the others still are). Replaces the list; [] appends all of them again."
  )
