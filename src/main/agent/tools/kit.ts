import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { paramsForSubmit } from '@shared/models'
import type { AgentFormState, GenerationParams, PromptLanguage } from '@shared/types'
import type { ApprovalStore } from '../approvals'
import type { FormBridge } from '../bridge'
import type { ImageBlock } from '../images'
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

export interface ToolOutput {
  /** Serialized as compact JSON. */
  data: unknown
  images?: LabeledImage[]
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
