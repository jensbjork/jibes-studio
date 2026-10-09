import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatTimecode, frameCaptions, isPaidOperation, operationLabel, toSrt } from '@shared/edit-plan'
import { generationTitle } from '@shared/generation-label'
import type {
  AudioCatalog,
  Edit,
  EditJob,
  EditMedia,
  EditOperation,
  EditPlan,
  EditRunResult,
  EditSummary,
  EditTimeline,
  EditVersion,
  Generation,
  Sequence,
  SendTarget,
  SeparationStatus,
  Transcript
} from '@shared/types'
import * as db from '../../db'
import * as store from '../../sequence-store'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import { isStoryboardId } from '../storyboard-rows'
import { AssetIndex, errorText, localTime, q, requireLibrary, seconds } from '../studio'
import {
  EDIT_DEFAULT_MODELS,
  agentOpName,
  operationInput,
  operationOutput,
  operationSummary,
  toEditOperation,
  type OperationInput
} from './edit-input'
import { READ_ONLY, WRITE, defineTool, priceValue, usd, type LabeledImage, type ToolContext } from './kit'
import { URL_WAIT_MS, stageFiles, uploadSource, urlSource, type FileSource } from './sources'

// Redigera for agents: edits (one film changed into versions), their versions, transcripts and audio models, the
// free operations, plans of paid ones, the edit's own audio (from uploads, URLs or library clips) and stopping a
// paid job. Everything goes through the edit service's own handlers (edits:*, audio:*), so an agent gets exactly the
// checks, versions and change events the window gets. Paid operations – and resuming a stopped one – are only ever
// asked for (request_edit_operation in editor-paid.ts); removing edits or versions, or cleaning versions up, only
// through request_delete, which the user approves.

// ── Shared steps ─────────────────────────────────────────────────────────────

/** Resolves undefined when `p` takes longer than `ms` (or fails): for extras an answer can do without. */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([p.catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** One edit, with its versions, jobs, media and AI takes. */
export async function loadEdit(editId: string): Promise<Edit> {
  requireLibrary()
  try {
    return await callService<Edit>('edits:get', editId)
  } catch (err) {
    throw new Error(`${errorText(err)} list_edits visar vilka redigeringar som finns.`)
  }
}

/** The version an operation works on: the given one (it must belong to the edit), else the current one. */
export function baseVersion(edit: Edit, versionId: string | undefined): EditVersion {
  const id = versionId ?? edit.currentId
  const version = id ? edit.versions.find((v) => v.id === id) : undefined
  if (!version) {
    throw new Error(
      versionId
        ? `Versionen ${versionId} hör inte till redigeringen ${q(edit.name)}. get_edit visar dess versioner.`
        : `Redigeringen ${q(edit.name)} har ingen aktuell version.`
    )
  }
  return version
}

/** Whether this Mac separates voice and background; undefined when it can't be told in time. */
export const separation = (): Promise<SeparationStatus | undefined> =>
  within(callService<SeparationStatus>('audio:separation'), 5000)

/** Venice's audio models (cached in main for ten minutes); undefined when they can't be had in time. */
export const audioCatalog = (force = false): Promise<AudioCatalog | undefined> =>
  within(callService<AudioCatalog>('audio:models', force), 10_000)

/**
 * The agent's operation as the edit service takes it. Separation and the catalog are only asked for when a
 * default depends on them: the background of a voice operation, the voice changer when none is named.
 */
export async function editOperation(input: OperationInput): Promise<EditOperation> {
  const voiceOp = input.op === 'change_voice' || input.op === 'speak_lines'
  const sep = voiceOp && !input.background ? await separation() : undefined
  const changer =
    input.op === 'change_voice' && !input.model ? (await audioCatalog())?.voiceChangers[0]?.id : undefined
  return toEditOperation(input, { separation: sep?.available === true, voiceChanger: changer })
}

/** The plan of an operation on a version (free: frames, separation and free quotes only). */
export function planOperation(editId: string, op: EditOperation, baseId: string): Promise<EditPlan> {
  return callService<EditPlan>('edits:plan', editId, op, baseId)
}

/** "v3" */
export const versionName = (v: Pick<EditVersion, 'number'>): string => `v${v.number}`

function sourceText(g: Generation): string {
  return g.source ?? 'generated'
}

/** A version as the tools list it. */
export function versionInfo(v: EditVersion): Record<string, unknown> {
  const g = v.generation
  return {
    version_id: v.id,
    version: versionName(v),
    ...(v.parentId ? { parent_version_id: v.parentId } : {}),
    label: v.label,
    op: v.op === 'original' || v.op === 'import' ? v.op : agentOpName(v.op),
    ...(v.costUsd ? { cost_usd: priceValue(v.costUsd) } : {}),
    current: v.current,
    created: localTime(v.createdAt),
    ...(g.videoDuration !== undefined ? { seconds: seconds(g.videoDuration) } : {}),
    resolution: g.params.resolution,
    aspect_ratio: g.params.aspectRatio,
    source: sourceText(g),
    ...(g.filePath ? { file: basename(g.filePath) } : {}),
    ...(g.fileMissing ? { file_missing: true } : {}),
    ...(g.recipe?.takeId ? { ai_take_id: g.recipe.takeId } : {}),
    ...(g.recipe?.timing === 'changed' ? { timing_changed: true } : {}),
    // The sound layers added on top in this version (the layer op takes their ids on any version, not only the current).
    ...(g.source === 'edit' && g.recipe?.mix?.layers?.length
      ? {
          layers: g.recipe.mix.layers.map((l) => ({
            layer_id: l.id,
            kind: l.kind,
            label: l.label,
            start: seconds(l.at),
            end: seconds(l.at + l.length),
            gain_db: l.gainDb
          }))
        }
      : {}),
    ...(v.usedBy.length
      ? {
          used_by: v.usedBy.map((u) => ({
            sequence_id: u.sequenceId,
            sequence_name: u.sequenceName,
            segment_id: u.segmentId,
            clip_number: u.clipNumber
          }))
        }
      : {})
  }
}

/** A job (a paid operation running or done) as the tools show it. */
export function jobInfo(j: EditJob): Record<string, unknown> {
  return {
    job_id: j.id,
    op: j.op === 'design-voice' ? 'design_voice' : agentOpName(j.op),
    label: j.label,
    status: j.status,
    ...(j.baseId ? { base_version_id: j.baseId } : {}),
    ...(j.fraction !== undefined && j.status === 'running' ? { progress: Math.round(j.fraction * 100) / 100 } : {}),
    steps_done: j.stepsDone,
    steps_total: j.stepsTotal,
    ...(j.currentStep ? { current_step: j.currentStep } : {}),
    cost_usd: priceValue(j.costUsd),
    ...(j.quoteUsd !== undefined ? { quote_usd: priceValue(j.quoteUsd) } : {}),
    ...(j.error ? { error: j.error } : {}),
    ...(j.takeId ? { ai_take_id: j.takeId } : {}),
    ...(j.resultId ? { result_version_id: j.resultId } : {}),
    ...(j.canResume
      ? {
          can_resume: true,
          note: 'Stopped with parts left: ask the user to continue it with request_edit_operation({edit_id, resume_job_id}) (they approve the price of the parts left), or the user presses "Fortsätt" in Redigera.'
        }
      : {}),
    updated: localTime(j.updatedAt)
  }
}

function mediaInfo(m: EditMedia): Record<string, unknown> {
  return {
    media_id: m.id,
    kind: m.kind,
    label: m.label,
    ...(m.durationSeconds !== undefined ? { seconds: seconds(m.durationSeconds) } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.costUsd ? { cost_usd: priceValue(m.costUsd) } : {})
  }
}

const ORIGIN_WORDS: Record<EditSummary['origin']['kind'], string> = {
  generation: 'a clip from the feed (Generera)',
  take: 'a take of a sequence clip',
  export: 'an exported film',
  import: "the user's own film"
}

function originInfo(e: EditSummary): Record<string, unknown> {
  const o = e.origin
  return {
    kind: o.kind,
    what: ORIGIN_WORDS[o.kind],
    ...(o.generationId ? { generation_id: o.generationId } : {}),
    ...(o.exportId ? { export_id: o.exportId } : {}),
    ...(o.sequenceId
      ? isStoryboardId(o.sequenceId)
        ? { storyboard_id: o.sequenceId, storyboard_name: o.sequenceName }
        : { sequence_id: o.sequenceId, sequence_name: o.sequenceName }
      : {}),
    ...(o.segmentId ? { segment_id: o.segmentId, clip_number: o.clipNumber } : {}),
    ...(o.missing ? { missing: true } : {})
  }
}

/** An edit in a listing. */
function summaryInfo(e: EditSummary): Record<string, unknown> {
  return {
    edit_id: e.id,
    name: e.name,
    origin: originInfo(e),
    ...(e.currentId ? { current_version_id: e.currentId } : {}),
    version_count: e.versionCount,
    ...(e.duration !== undefined ? { seconds: seconds(e.duration) } : {}),
    running: e.running,
    total_cost_usd: priceValue(e.totalCostUsd),
    updated: localTime(e.updatedAt)
  }
}

/** A transcript's outline: enough to know whether there is one and which version it belongs to. */
function transcriptSummary(t: Transcript): Record<string, unknown> {
  return {
    generation_id: t.generationId,
    ...(t.inheritedFrom ? { inherited_from: t.inheritedFrom } : {}),
    ...(t.language ? { language: t.language } : {}),
    ...(t.model ? { model: t.model } : {}),
    line_count: t.segments.length,
    edited_lines: t.segments.filter((s) => s.edited).length,
    first_lines: t.segments.slice(0, 3).map((s) => `${formatTimecode(s.start)} ${s.text}`),
    updated: localTime(t.updatedAt)
  }
}

/** Where a version's layers and cuts are: the timeline (free, cached) when it answers in time, else its recipe. */
async function laneInfo(v: EditVersion): Promise<Record<string, unknown>> {
  const timeline = await within(callService<EditTimeline>('edits:timeline', v.id), 8000)
  const recipe = v.generation.recipe
  if (timeline) {
    return {
      cuts: timeline.cuts.map(seconds),
      cuts_from: timeline.cutsSource,
      has_audio: timeline.hasAudio,
      fps: timeline.fps,
      size: `${timeline.width}×${timeline.height}`,
      layers: timeline.layers.map((l) => ({
        layer_id: l.id,
        kind: l.kind,
        label: l.label,
        start: seconds(l.start),
        end: seconds(l.end),
        gain_db: l.gainDb
      })),
      ...(timeline.muted.length
        ? { muted: timeline.muted.map((m) => ({ start: seconds(m.start), end: seconds(m.end), target: m.target })) }
        : {})
    }
  }
  return {
    cuts: (recipe?.cuts ?? []).map(seconds),
    cuts_from: recipe?.cuts?.length ? 'recipe' : 'none',
    layers: (recipe?.mix.layers ?? []).map((l) => ({
      layer_id: l.id,
      kind: l.kind,
      label: l.label,
      start: seconds(l.at),
      end: seconds(l.at + l.length),
      gain_db: l.gainDb
    })),
    lanes_note: "The timeline wasn't ready in time; cuts and layers come from the version's recipe."
  }
}

/** An edit in full, as get_edit, create_edit and the write tools answer. */
async function editInfo(edit: Edit, detail: boolean): Promise<Record<string, unknown>> {
  const current = edit.versions.find((v) => v.id === edit.currentId)
  const data: Record<string, unknown> = {
    ...summaryInfo(edit),
    created: localTime(edit.createdAt),
    versions: edit.versions.map(versionInfo),
    jobs: edit.jobs.map(jobInfo),
    ...(edit.takes.length
      ? {
          ai_takes: edit.takes.map((t) => ({
            generation_id: t.id,
            status: t.status,
            model: t.model,
            prompt: t.prompt,
            ...(t.error ? { error: t.error } : {}),
            price_usd: priceValue(t.quote)
          }))
        }
      : {}),
    media: edit.media.map(mediaInfo)
  }
  if (!detail || !current) return data
  const [lanes, transcript, sep, catalog] = await Promise.all([
    laneInfo(current),
    within(callService<Transcript | null>('edits:transcript', current.id), 5000),
    separation(),
    audioCatalog()
  ])
  data.current_version = { version_id: current.id, version: versionName(current), ...lanes }
  data.transcript = transcript
    ? transcriptSummary(transcript)
    : 'None yet for the current version: request_edit_operation with {op: "transcribe"} makes one (about $0.01 a minute).'
  data.separation = sep
    ? { available: sep.available, ...(sep.quality ? { quality: sep.quality } : {}), ...(sep.message ? { message: sep.message } : {}) }
    : { available: false, message: 'Okänt just nu.' }
  data.voice_changer = catalog
    ? catalog.voiceChangers.length
      ? { available: true, models: catalog.voiceChangers.map((m) => m.id) }
      : { available: false, note: 'Venice lists no voice changer now: use transcribe + speak_lines instead of change_voice.' }
    : { available: false, note: "Venice's audio models couldn't be read just now." }
  return data
}

/** "segment_id" or "sequence_id" for send_edit_to_sequence, with the clip it went to. */
function clipNumberIn(sequence: Sequence | undefined, segmentId: string): number | undefined {
  const i = sequence?.segments.findIndex((s) => s.id === segmentId) ?? -1
  return i >= 0 ? i + 1 : undefined
}

const editIdInput = z.string().describe('An edit_id from list_edits.')
const baseVersionInput = z
  .string()
  .optional()
  .describe("The version to work on (get_edit's versions); default the current version.")

export function registerEditorTools(server: McpServer, ctx: ToolContext): void {
  // ── Read ──────────────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    'list_edits',
    {
      title: 'List edits (Redigera)',
      description:
        "The user's edits in Redigera, newest first: a film (a clip from the feed, a take, an exported film or the user's own film) being changed into versions. Each with its origin, current version, number of versions, length, whether a paid job is running and what it has cost so far. Open one with get_edit; start a new one with create_edit.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listade redigeringarna'
    },
    async () => {
      requireLibrary()
      const list = await callService<EditSummary[]>('edits:list')
      return { data: { count: list.length, edits: list.map(summaryInfo) }, summary: `listade redigeringarna (${list.length} st)` }
    }
  )

  defineTool(
    server,
    ctx,
    'get_edit',
    {
      title: 'Get edit',
      description:
        "One edit in Redigera: its versions as a tree (v1 is the untouched original; each version has its parent_version_id, the operation that made it, its cost and which sequence clips use it), which one is current, the paid jobs (running or done, with errors), the AI takes made for picture operations, the edit's audio media (reusable with add_audio media_id), every version's added sound layers (layer_id for the layer op), and for the current version its cut markers (Klippgränser), its layers and muted spans as the timeline draws them, and a summary of its transcript – plus whether this Mac can separate voice and background and whether Venice offers a voice changer. With include_thumbnails (default true) the poster frames of the current version and the original come as images. Look at a version itself with review_generation(version_id) – frames and, with include_audio and audio_start, its sound.",
      input: {
        edit_id: editIdInput,
        include_thumbnails: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en redigering'
    },
    async ({ edit_id, include_thumbnails }) => {
      const edit = await loadEdit(edit_id)
      const data = await editInfo(edit, true)
      const images: LabeledImage[] = []
      if (include_thumbnails) {
        const shown = new Set<string>()
        const current = edit.versions.find((v) => v.current)
        const original = edit.versions[0]
        for (const [v, what] of [
          [current, 'current version'],
          [original, 'original']
        ] as const) {
          if (!v || shown.has(v.id) || !v.generation.thumbPath) continue
          shown.add(v.id)
          const block = await imageBlock(v.generation.thumbPath)
          if (block) images.push({ label: `${versionName(v)} (${what}, version_id ${v.id}) – poster frame`, image: block })
        }
      }
      return { data, images, summary: `tittade på redigeringen ${q(edit.name)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'get_transcript',
    {
      title: 'Get transcript',
      description:
        "The transcript of a version (or any generation) with its lines – segment_id, start, end (seconds) and text – as JSON, or as SubRip subtitles with format \"srt\". A version whose timing equals its parent's inherits the parent's transcript (inherited_from). Use the segment_ids with speak_lines (replace a line) and change_voice (only those lines), and fix wrong words with update_transcript first. Venice gives no speaker labels. None yet: request_edit_operation with {op: \"transcribe\"}.",
      input: {
        generation_id: z.string().describe('A version_id (get_edit) or any generation_id.'),
        format: z.enum(['json', 'srt']).default('json')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'läste en transkription'
    },
    async ({ generation_id, format }) => {
      requireLibrary()
      const t = await callService<Transcript | null>('edits:transcript', generation_id)
      if (!t) {
        return {
          data: {
            generation_id,
            transcript: null,
            note: 'No transcript yet. request_edit_operation with {op: "transcribe"} on the edit makes one (paid, about $0.01 a minute).'
          }
        }
      }
      const head = {
        generation_id: t.generationId,
        ...(t.inheritedFrom ? { inherited_from: t.inheritedFrom } : {}),
        ...(t.language ? { language: t.language } : {}),
        ...(t.model ? { model: t.model } : {}),
        updated: localTime(t.updatedAt),
        line_count: t.segments.length
      }
      if (format === 'srt') return { data: { ...head, srt: toSrt(t.segments) } }
      return {
        data: {
          ...head,
          lines: t.segments.map((s) => ({
            segment_id: s.id,
            start: Math.round(s.start * 1000) / 1000,
            end: Math.round(s.end * 1000) / 1000,
            text: s.text,
            ...(s.edited ? { edited: true } : {})
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'plan_edit_operation',
    {
      title: 'Plan an edit operation (free)',
      description:
        "Checks an operation on a version exactly as Redigera's cards do and says what it would do and cost – without doing anything. Free; always call it first. Answers with the normalized operation (the range snapped to frames, cut markers and what the model allows, defaults filled in), paid, price_usd (the total of what Venice prices; undefined when it can't be priced), partial_price and price_note (e.g. billed per started minute, or a voice clone Venice doesn't price), the steps (parts) with their prices, notes, warnings (lip sync, real people, the old voice bleeding through, disk space) and problems (non-empty: it can't run as it is). For picture operations the frames come as images: regenerate's start and end frames (the frames before and after the range; the film's first frame when the range starts at 0), extend's start (the film's last frame), prompt_edit's first and last frame of the range; upscale has none. Free operations then go with apply_edit, paid ones with request_edit_operation (the user approves the price). Prompts are English.",
      input: {
        edit_id: editIdInput,
        base_version_id: baseVersionInput,
        operation: operationInput
      },
      annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },
      summary: () => 'planerade en ändring'
    },
    async ({ edit_id, base_version_id, operation }) => {
      const edit = await loadEdit(edit_id)
      const base = baseVersion(edit, base_version_id)
      const op = await editOperation(operation)
      const plan = await planOperation(edit.id, op, base.id)
      const images: LabeledImage[] = []
      const captions = frameCaptions(plan.operation)
      for (const [path, what] of [
        [plan.frames?.start, captions.start.en],
        [plan.frames?.end, captions.end.en]
      ] as const) {
        if (!path) continue
        const block = await imageBlock(path)
        if (block) images.push({ label: what, image: block })
      }
      return {
        data: {
          ...planInfo(plan, base),
          next: plan.problems.length
            ? 'Fix the problems first (or choose another range, model or version).'
            : plan.paid
              ? 'Paid: ask the user with request_edit_operation (same operation).'
              : 'Free: make it with apply_edit (same operation).'
        },
        images,
        summary: `planerade en ändring i ${q(edit.name)}: ${operationSummary(plan.operation, base.generation.videoDuration)}${plan.paid ? ` (${usd(plan.priceUsd)})` : ''}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'list_audio_models',
    {
      title: 'List audio models',
      description:
        "Venice's audio models for Redigera, with their voices, limits and prices: speech (text-to-speech for speak_lines: voices, max characters per line, price per 1000 characters, whether it clones a voice or takes a style prompt), music and effects (durations per model), transcription (price per minute; word or segment timestamps), voice_changers (speech-to-speech for change_voice; empty while Venice lists none) and voice_design (request_voice_design). Also whether this Mac can separate voice and background (separation: needed for the voice/background targets and to keep music under a new voice) and the default models. Exact prices for a given film come from plan_edit_operation (free).",
      input: {
        refresh: z.boolean().default(false).describe('Fetch the list again instead of the ten-minute cache.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },
      summary: () => 'listade ljudmodellerna'
    },
    async ({ refresh }) => {
      const [catalog, sep] = await Promise.all([callService<AudioCatalog>('audio:models', refresh), separation()])
      const notes: string[] = []
      if (!catalog.voiceChangers.length) {
        notes.push('Venice lists no voice changer right now, so change_voice is not available: transcribe, then speak_lines.')
      }
      if (!catalog.keyed) notes.push('Fetched without the API key: models only listed to keyed accounts are missing.')
      return {
        data: {
          keyed: catalog.keyed,
          fetched: localTime(catalog.fetchedAt),
          defaults: {
            transcribe: 'elevenlabs/scribe-v2',
            speech: EDIT_DEFAULT_MODELS.speech,
            clone_speech: EDIT_DEFAULT_MODELS.cloneSpeech,
            music: EDIT_DEFAULT_MODELS.music,
            effect: EDIT_DEFAULT_MODELS.effect,
            ...(catalog.voiceChangers[0] ? { voice_changer: catalog.voiceChangers[0].id } : {})
          },
          speech: catalog.speech.map((m) => ({
            id: m.id,
            name: m.name,
            voices: m.voices,
            ...(m.defaultVoice ? { default_voice: m.defaultVoice } : {}),
            custom_voice_id: m.customVoiceId,
            ...(m.cloning
              ? { clones_voices: { min_sample_seconds: m.cloning.minSampleSeconds, handle_days: m.cloning.retentionDays } }
              : {}),
            max_characters: m.maxCharacters,
            ...(m.usdPerThousandChars !== undefined ? { usd_per_1000_characters: priceValue(m.usdPerThousandChars) } : {}),
            style_prompt: m.stylePrompt,
            language_code: m.languageCode,
            ...(m.speed ? { speed: m.speed } : {})
          })),
          music: catalog.music.map(genInfo),
          effects: catalog.effects.map(genInfo),
          transcription: catalog.transcription.map((m) => ({
            id: m.id,
            name: m.name,
            usd_per_minute: priceValue(m.usdPerSecond * 60),
            timestamps: m.timestamps
          })),
          voice_changers: catalog.voiceChangers.map((m) => ({
            id: m.id,
            name: m.name,
            voices: m.voices,
            ...(m.defaultVoice ? { default_voice: m.defaultVoice } : {}),
            custom_voice_id: m.customVoiceId,
            max_seconds_per_part: m.maxSourceSeconds,
            background_noise_removal: m.backgroundNoiseRemoval
          })),
          voice_design: catalog.voiceDesign.map((m) => ({ id: m.id, name: m.name })),
          separation: sep
            ? { available: sep.available, ...(sep.quality ? { quality: sep.quality } : {}), ...(sep.message ? { message: sep.message } : {}) }
            : { available: false, message: 'Okänt just nu.' },
          ...(notes.length ? { notes } : {})
        }
      }
    }
  )

  // ── Write (free) ──────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    'create_edit',
    {
      title: 'Create an edit (Redigera)',
      description:
        "Opens a film in Redigera as a new edit, free: a finished generation (generation_id – a clip from the feed, a take of a sequence clip or storyboard transition, an imported own clip, or a version of another edit) or an exported film (export_id from list_exports; it is copied into the edit as v1). The original is never changed: every operation makes a new version. A film you have as a file: import it with import_own_clips first (target {feed: true}), then open its generation here. Answers with the edit (get_edit's fields) and, when there already are edits of the same film, a note naming them – reuse one instead of making another when that is what the user means.",
      input: {
        generation_id: z.string().optional().describe('A finished generation (list_generations, get_sequence…).'),
        export_id: z.string().optional().describe('An exported film (list_exports).'),
        name: z.string().min(1).max(120).optional().describe("The edit's name; default the film's title or prompt.")
      },
      annotations: WRITE,
      summary: () => 'skapade en redigering'
    },
    async ({ generation_id, export_id, name }) => {
      requireLibrary()
      if (!generation_id === !export_id) throw new Error('Ange antingen generation_id eller export_id.')
      if (generation_id) {
        const g = db.getGeneration(generation_id)
        if (!g) throw new Error(`Genereringen ${generation_id} finns inte (längre). list_generations visar vilka som finns.`)
        if (g.status !== 'completed') throw new Error('Bara en färdig generering kan redigeras.')
      }
      const existing = (await callService<EditSummary[]>('edits:list')).filter((e) =>
        generation_id
          ? e.origin.generationId === generation_id || e.generationIds.includes(generation_id)
          : e.origin.exportId === export_id
      )
      const edit = await callService<Edit>(
        'edits:create',
        generation_id ? { generationId: generation_id } : { exportId: export_id },
        name?.trim() || undefined
      )
      const others = existing.filter((e) => e.id !== edit.id)
      return {
        data: {
          ...(await editInfo(edit, false)),
          ...(others.length
            ? {
                note: `The same film already has ${others.length === 1 ? 'an edit' : `${others.length} edits`}: ${others.map((e) => `${q(e.name)} (${e.id})`).join(', ')}.`
              }
            : {})
        },
        summary: `skapade redigeringen ${q(edit.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'apply_edit',
    {
      title: 'Apply a free edit',
      description:
        "Makes a free operation on a version (default the current one) and saves the result as a new version (it becomes current when its base was current; otherwise a branch): trim, cut, fade, volume, mute, denoise, loudness, add_audio (media_id: audio already in the edit – add_edit_audio puts a sound you send there first; asset_audio_id: a library clip) or layer. Rendered on this Mac; nothing is paid. Paid operations are refused: plan them with plan_edit_operation and ask with request_edit_operation. Check first with plan_edit_operation; problems come back as an error and nothing is made. Answers with the new version.",
      input: {
        edit_id: editIdInput,
        base_version_id: baseVersionInput,
        operation: operationInput
      },
      annotations: WRITE,
      summary: () => 'ändrade en film i Redigera'
    },
    async ({ edit_id, base_version_id, operation }) => {
      const edit = await loadEdit(edit_id)
      const base = baseVersion(edit, base_version_id)
      const op = await editOperation(operation)
      const paidRefusal = `${operation.op} kostar pengar hos Venice och görs bara när användaren har godkänt det: planera med plan_edit_operation och be om lov med request_edit_operation.`
      if (isPaidOperation(op)) throw new Error(paidRefusal)
      const plan = await planOperation(edit.id, op, base.id)
      if (plan.paid) throw new Error(paidRefusal)
      if (plan.problems.length) throw new Error(plan.problems.join(' '))
      const result = await callService<EditRunResult>('edits:run', edit.id, op, { baseId: base.id })
      const after = await loadEdit(edit.id)
      const made = result.versionId ? after.versions.find((v) => v.id === result.versionId) : undefined
      // As the version list names it, in the log: "<agent> gjorde v3 av ”X”: Tonade in från svart 1,0 s".
      const what = operationLabel(plan.operation)
      return {
        data: {
          edit_id: after.id,
          ...(made ? { version: versionInfo(made) } : { result: result }),
          base_version_id: base.id,
          current_version_id: after.currentId,
          ...(plan.notes.length ? { notes: plan.notes } : {}),
          ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
          next: made ? `Look at it with review_generation({generation_id: "${made.id}", include_audio: true}).` : undefined
        },
        summary: `gjorde ${made ? versionName(made) : 'en ny version'} av ${q(edit.name)}: ${what}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'set_current_version',
    {
      title: 'Set current version',
      description:
        "Makes a version the edit's current one – what Redigera shows, what operations build on by default and what \"Skicka till\" sends. Free; nothing is deleted (an undo is choosing the parent again).",
      input: { edit_id: editIdInput, version_id: z.string().describe("One of get_edit's version_ids.") },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'valde en version'
    },
    async ({ edit_id, version_id }) => {
      const edit = await loadEdit(edit_id)
      const version = baseVersion(edit, version_id)
      const after = await callService<Edit>('edits:setCurrent', edit.id, version.id)
      return {
        data: { edit_id: after.id, current_version_id: after.currentId, version: versionName(version) },
        summary: `gjorde ${versionName(version)} aktuell i ${q(edit.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'rename_edit',
    {
      title: 'Rename edit',
      description: "Renames an edit; its folder under Redigeringar and its versions' titles follow.",
      input: { edit_id: editIdInput, name: z.string().min(1).max(120) },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ name }) => `döpte om en redigering till ${q(name)}`
    },
    async ({ edit_id, name }) => {
      const edit = await loadEdit(edit_id)
      const after = await callService<Edit>('edits:rename', edit.id, name.trim())
      return { data: { edit_id: after.id, name: after.name }, summary: `döpte om ${q(edit.name)} till ${q(after.name)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'update_transcript',
    {
      title: 'Update transcript',
      description:
        "Corrects the text of transcript lines (segment_ids from get_transcript), free – e.g. a misheard name before speak_lines or subtitles. Times stay as they are. An inherited transcript is copied to this version first, so its parent's stays as it was. Answers with the changed lines.",
      input: {
        generation_id: z.string().describe('The version (or generation) whose transcript to change.'),
        segments: z
          .array(z.object({ segment_id: z.string(), text: z.string().min(1).max(5000) }).strict())
          .min(1)
          .max(500)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ segments }) => `rättade ${segments.length === 1 ? 'en rad' : `${segments.length} rader`} i en transkription`
    },
    async ({ generation_id, segments }) => {
      requireLibrary()
      const t = await callService<Transcript>(
        'edits:updateTranscript',
        generation_id,
        segments.map((s) => ({ segmentId: s.segment_id, text: s.text.trim() }))
      )
      const changed = new Set(segments.map((s) => s.segment_id))
      return {
        data: {
          generation_id: t.generationId,
          updated: localTime(t.updatedAt),
          lines: t.segments
            .filter((s) => changed.has(s.id))
            .map((s) => ({ segment_id: s.id, start: s.start, end: s.end, text: s.text }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'send_edit_to_sequence',
    {
      title: 'Send a version to a sequence',
      description:
        "Puts a version into a sequence, free: with segment_id as a new take of that clip (selected), or with sequence_id as a new own clip (after after_segment_id, or at the end). The next clip can then continue from its last frame like from any clip. Not into storyboards, and not while \"Generera saknade\" runs there.",
      input: {
        version_id: z.string().describe("A version_id from get_edit."),
        segment_id: z.string().optional().describe('As a new, selected take of this clip.'),
        sequence_id: z.string().optional().describe('As a new clip in this sequence.'),
        after_segment_id: z.string().optional().describe('With sequence_id: after this clip; at the end when left out.')
      },
      annotations: WRITE,
      summary: () => 'skickade en version till en sekvens'
    },
    async ({ version_id, segment_id, sequence_id, after_segment_id }) => {
      requireLibrary()
      if (!segment_id === !sequence_id) throw new Error('Ange antingen segment_id (ny tagning) eller sequence_id (nytt klipp).')
      if (segment_id && after_segment_id) throw new Error('after_segment_id gäller bara tillsammans med sequence_id.')
      const owner = segment_id ? store.getSegmentRow(segment_id)?.sequence_id : sequence_id
      if (segment_id && !owner) throw new Error('Klippet finns inte längre.')
      if (owner && isStoryboardId(owner)) throw new Error('Versioner kan bara skickas till sekvenser, inte till storyboards.')
      const target: SendTarget = segment_id ? { segmentId: segment_id } : { sequenceId: sequence_id!, afterSegmentId: after_segment_id }
      const sent = await callService<{ sequenceId: string; segmentId: string }>('edits:send', version_id, target)
      const sequence = await within(callService<Sequence>('sequences:get', sent.sequenceId), 5000)
      const clip = clipNumberIn(sequence, sent.segmentId)
      const v = db.getGeneration(version_id)
      return {
        data: {
          sequence_id: sent.sequenceId,
          segment_id: sent.segmentId,
          ...(clip ? { clip_number: clip } : {}),
          as: segment_id ? 'take' : 'clip'
        },
        summary: `skickade ${v ? q(generationTitle(v, 40)) : 'en version'} till ${clip ? `klipp ${clip} i ` : ''}${sequence ? q(sequence.name) : 'en sekvens'}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_edit_audio',
    {
      title: 'Add audio to an edit',
      description:
        "Adds sound files to an edit's audio (Redigera's media: music, effects, lines) so apply_edit can lay them on a version with {op: \"add_audio\", media_id}. sources (1–6): {upload_id} (a ready audio upload), {url} (fetched like begin_upload({url}); waits at most 45 s in all) or {asset_audio_id} (a character's voice or an environment's sound from the library). Any sound longer than 0.05 s (a click or a whoosh too). Free; nothing is mixed yet. Answers each new media_id with its label (the file's name) and length.",
      input: {
        edit_id: editIdInput,
        sources: z
          .array(z.union([uploadSource, urlSource, z.object({ asset_audio_id: z.string() }).strict()]))
          .min(1)
          .max(6)
      },
      annotations: WRITE,
      summary: ({ sources }) =>
        `lade till ${sources.length === 1 ? 'ett ljud' : `${sources.length} ljud`} i en redigering`
    },
    async ({ edit_id, sources }) => {
      const edit = await loadEdit(edit_id)
      const deadline = Date.now() + URL_WAIT_MS
      const files = await stageFiles(
        ctx,
        'audio',
        sources.filter((s): s is FileSource => 'upload_id' in s || 'url' in s),
        deadline
      )
      const assets = sources.some((s) => 'asset_audio_id' in s) ? await AssetIndex.load() : undefined
      let next = 0
      const paths = sources.map((s) =>
        'asset_audio_id' in s ? assets!.requireAudio(s.asset_audio_id).audio.path : files[next++].path
      )
      const added = await callService<EditMedia[]>('edits:addAudio', edit.id, paths)
      return {
        data: {
          edit_id: edit.id,
          media: added.map((m) => ({
            media_id: m.id,
            label: m.label,
            ...(m.durationSeconds !== undefined ? { duration: seconds(m.durationSeconds) } : {})
          })),
          next: 'Lay it on a version with apply_edit({edit_id, operation: {op: "add_audio", media_id, start}}) – check with plan_edit_operation first.'
        },
        summary: `lade till ${added.length === 1 ? `ljudet ${q(added[0].label)}` : `${added.length} ljud`} i ${q(edit.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'cancel_edit_job',
    {
      title: 'Stop a paid edit job',
      description:
        "Stops a running paid job in Redigera (get_edit's jobs) like the user's Avbryt: no further parts are sent to Venice, so nothing more is paid. Parts already sent finish and are kept. A picture operation (regenerate, prompt_edit, extend, upscale) can't be stopped once its take is at Venice. Free.",
      input: { job_id: z.string().describe("A job_id from get_edit's jobs.") },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'stoppade ett jobb i Redigera'
    },
    async ({ job_id }) => {
      requireLibrary()
      const row = db.getDb().prepare('SELECT id, edit_id, status FROM media_jobs WHERE id = ?').get(job_id) as
        | { id: string; edit_id: string | null; status: string }
        | undefined
      if (!row) throw new Error('Det finns inget jobb med det id:t. get_edit visar en redigerings jobb.')
      if (row.status !== 'running') {
        return {
          data: { job_id, status: row.status, note: 'The job is not running.' },
          summary: 'försökte stoppa ett jobb som inte körde'
        }
      }
      await callService('edits:cancel', job_id)
      const edit = row.edit_id ? await loadEdit(row.edit_id).catch(() => undefined) : undefined
      const job = edit?.jobs.find((j) => j.id === job_id)
      return {
        data: {
          ...(job ? jobInfo(job) : { job_id, status: 'cancelled' }),
          note: 'No more parts are sent. Parts already at Venice finish and are kept.'
        },
        summary: edit ? `stoppade ${job ? q(job.label) : 'ett jobb'} i ${q(edit.name)}` : 'stoppade ett jobb'
      }
    }
  )
}

function genInfo(m: AudioCatalog['music'][number]): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    ...(m.durationControl
      ? { min_seconds: m.minSeconds, max_seconds: m.maxSeconds, default_seconds: m.defaultSeconds }
      : { duration_control: false, note: 'Picks its own length (up to about 3 min); trimmed to the range.' }),
    ...(m.durationOptions?.length ? { duration_options: m.durationOptions } : {}),
    instrumental: m.instrumental,
    loop: m.loop,
    prompt_limit: m.promptLimit
  }
}

/** A plan as the tools answer it (plan_edit_operation, request_edit_operation). */
export function planInfo(plan: EditPlan, base: EditVersion): Record<string, unknown> {
  return {
    base_version_id: base.id,
    base_version: versionName(base),
    operation: operationOutput(plan.operation),
    summary: operationSummary(plan.operation, base.generation.videoDuration),
    paid: plan.paid,
    ...(plan.paid ? { price_usd: priceValue(plan.priceUsd) ?? null } : {}),
    ...(plan.partialPrice ? { partial_price: true } : {}),
    ...(plan.priceNote ? { price_note: plan.priceNote } : {}),
    ...(plan.steps.length
      ? {
          steps: plan.steps.map((s) => ({
            label: s.label,
            ...(s.seconds !== undefined ? { seconds: seconds(s.seconds) } : {}),
            ...(s.priceUsd !== undefined ? { price_usd: priceValue(s.priceUsd) } : {})
          }))
        }
      : {}),
    ...(plan.resultSeconds !== undefined ? { result_seconds: seconds(plan.resultSeconds) } : {}),
    ...(plan.estimatedBytes !== undefined ? { estimated_mb: Math.round(plan.estimatedBytes / 1e5) / 10 } : {}),
    notes: plan.notes,
    warnings: plan.warnings,
    problems: plan.problems,
    ready: !plan.problems.length
  }
}
