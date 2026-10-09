import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { queryGenerations, summarizeGenerations } from '@shared/generation-filter'
import { generationTitle } from '@shared/generation-label'
import {
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  type EditRecipe,
  type Generation,
  type GenerationFilter,
  type GenerationReview,
  type Learning,
  type PromptInput,
  type SavedPrompt
} from '@shared/types'
import * as db from '../../db'
import { extractAudio, extractFrameAtOrAfter, probe } from '../../ffmpeg'
import { agentUploadsDir, fromStoredPath, safeName } from '../../paths'
import * as store from '../../sequence-store'
import { studioGuide } from '../guide'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import { clampTime, framesAt, lastFrameTime, referenceAudioBlock, requireVideoFile, spreadTimes, videoLength } from '../media'
import { boardIndex, isStoryboardId, transitionPair } from '../storyboard-rows'
import {
  AssetIndex,
  MODES,
  StillIndex,
  addedBy,
  audioClipsInfo,
  audioOf,
  audioRole,
  audioWindow,
  canonical,
  errorText,
  loadModels,
  localTime,
  modelInfo,
  paramsInfo,
  q,
  referenceAudioOf,
  referenceSummary,
  requireLibrary,
  seconds,
  usableModels
} from '../studio'
import { agentOpName, operationOutput } from './edit-input'
import { READ_ONLY, WRITE, defineTool, priceValue, type LabeledAudio, type LabeledImage, type ToolContext } from './kit'
import { URL_WAIT_MS, originOf, stageFiles, uploadSource, urlSource, type FileSource } from './sources'

// The library: the guide, assets (characters, environments, products, outfits, poses) with their photos and audio
// clips – added by agents too, from uploads, URLs, stills, other photos, frames and clips' sound – models, the prompt
// library and the generations feed.

const KIND_PLURALS: Record<AssetKind, string> = {
  character: 'karaktärerna',
  environment: 'miljöerna',
  product: 'produkterna',
  outfit: 'kläderna',
  pose: 'poserna'
}
const KIND_DEFINITE: Record<AssetKind, string> = {
  character: 'karaktären',
  environment: 'miljön',
  product: 'produkten',
  outfit: 'klädseln',
  pose: 'posen'
}

/** The asset service's own refusal for audio on other kinds (assets.ts noAudioReason). */
const NO_AUDIO_KIND = 'Bara karaktärer (röst) och miljöer (ljudmiljö) kan ha ljud.'

/** Kinds whose assets can have audio clips (a character's voice, an environment's soundscape). */
const AUDIO_KINDS: ReadonlySet<AssetKind> = new Set(['character', 'environment'])

export const assetKind = z.enum(ASSET_KINDS)

/** Case- and accent-tolerant text match for the query parameters. */
export function matches(query: string | undefined, ...fields: (string | undefined)[]): boolean {
  const needle = query?.trim().toLocaleLowerCase('sv')
  if (!needle) return true
  return fields.some((f) => f?.toLocaleLowerCase('sv').includes(needle))
}

function assetSummary(a: Asset, index: AssetIndex): Record<string, unknown> {
  const outfit = a.defaultOutfitId ? index.get(a.defaultOutfitId) : undefined
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    description: a.description,
    image_count: a.images.length,
    image_ids: a.images.map((i) => i.id),
    ...(AUDIO_KINDS.has(a.kind) ? { audio: audioClipsInfo(a) } : {}),
    ...(a.kind === 'character'
      ? { default_outfit_id: a.defaultOutfitId ?? null, default_outfit_name: outfit?.name }
      : {})
  }
}

/**
 * Takes: which sequence and clip a generation belongs to – or, for a take of a storyboard's transition, which
 * storyboard and transition, and the two boards it goes between.
 */
export function takeOf(g: Generation): Record<string, unknown> | undefined {
  if (!g.segmentId) return undefined
  const sequence = store.sequenceOfSegment(g.segmentId)
  if (!sequence) return undefined
  const number = store.listSegmentRows(sequence.id).findIndex((r) => r.id === g.segmentId) + 1
  if (isStoryboardId(sequence.id)) {
    const pair = transitionPair(g.segmentId)
    const from = pair?.from ? boardIndex(pair.from) + 1 : 0
    const to = pair?.to ? boardIndex(pair.to) + 1 : 0
    return {
      storyboard_id: sequence.id,
      storyboard_name: sequence.name,
      transition_id: g.segmentId,
      transition_number: number || undefined,
      ...(from ? { from_board_number: from } : {}),
      ...(to ? { to_board_number: to } : {})
    }
  }
  return { sequence_id: sequence.id, sequence_name: sequence.name, segment_id: g.segmentId, clip_number: number || undefined }
}

/** A review as the tools show it. */
export function reviewInfo(r: GenerationReview): Record<string, unknown> {
  return {
    review_id: r.id,
    generation_id: r.generationId,
    author: r.author,
    ...(r.rating !== undefined ? { rating: r.rating } : {}),
    tags: r.tags,
    note: r.note,
    updated: localTime(r.updatedAt)
  }
}

/** A learning as the tools show it. */
export function learningInfo(l: Learning): Record<string, unknown> {
  return {
    learning_id: l.id,
    title: l.title,
    insight: l.insight,
    ...(l.model ? { model: l.model } : {}),
    tags: l.tags,
    evidence: l.evidence,
    author: l.author,
    pinned: l.pinned,
    updated: localTime(l.updatedAt)
  }
}

/** The learnings get_studio_guide shows: every pinned one, then the most recently updated ones. */
export function guideLearnings(learnings: readonly Learning[], recent = 10): Learning[] {
  const pinned = learnings.filter((l) => l.pinned)
  const others = learnings
    .filter((l) => !l.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, recent)
  return [...pinned, ...others]
}

/**
 * The learnings for the guide, or [] when there is no library (the guide works without one). With a model, only
 * that model's and the general ones, chosen among themselves: the most recent learnings about other models must
 * not crowd out older ones about this one.
 */
export async function learningsForGuide(model?: string): Promise<Learning[]> {
  try {
    requireLibrary()
    return guideLearnings(await callService<Learning[]>('learnings:list', model ? { model } : undefined))
  } catch {
    return []
  }
}

/**
 * The generations the user hasn't looked at yet (finished or failed, with a row in the library's `unseen` table).
 * Agents can read it but never change it: only the user marks things seen.
 */
export function unseenGenerationIds(): Set<string> {
  try {
    return new Set(
      db.getDb().prepare('SELECT generation_id FROM unseen WHERE generation_id IS NOT NULL').pluck().all() as string[]
    )
  } catch {
    // A library from before the table existed: everything counts as seen.
    return new Set()
  }
}

/** seen_by_user for a finished (or failed) generation; nothing for one still on its way. */
function seenField(g: Pick<Generation, 'id' | 'status'>, unseen: ReadonlySet<string>): Record<string, unknown> {
  return g.status === 'completed' || g.status === 'failed' ? { seen_by_user: !unseen.has(g.id) } : {}
}

/** Days → the filter's `since` (epoch ms). */
function sinceDays(days: number | undefined): number | undefined {
  return days === undefined ? undefined : Date.now() - days * 24 * 60 * 60 * 1000
}

/**
 * Where a generation came from, and how it is named: Venice's generations by their prompt, the user's own clips
 * (imports) by their file name and Redigera's versions by "<edit> v3" (generationTitle), so neither is listed as
 * an empty prompt.
 */
export function sourceFields(g: Generation): Record<string, unknown> {
  const source = g.source ?? 'generated'
  return {
    source,
    ...(source !== 'generated' || g.title ? { title: generationTitle(g) } : {}),
    ...(g.parentId ? { parent_id: g.parentId } : {}),
    ...(g.editId ? { edit_id: g.editId } : {})
  }
}

/** How an import or a version was made, as get_generation shows it (ids only, like the recipe itself). */
export function recipeInfo(r: EditRecipe): Record<string, unknown> {
  return {
    op: r.op === 'original' || r.op === 'import' ? r.op : agentOpName(r.op),
    label: r.label,
    ...(r.number ? { version: `v${r.number}` } : {}),
    ...(r.baseId ? { base_version_id: r.baseId } : {}),
    ...(r.operation ? { operation: operationOutput(r.operation) } : {}),
    ...(r.costUsd ? { cost_usd: priceValue(r.costUsd) } : {}),
    timing: r.timing,
    ...(r.takeId ? { ai_take_id: r.takeId } : {}),
    ...(r.cuts?.length ? { cuts: r.cuts.map(seconds) } : {}),
    // A version's added sound layers (the layer op's layer_id works on this version as its base).
    ...(r.mix?.layers?.length
      ? {
          layers: r.mix.layers.map((l) => ({
            layer_id: l.id,
            kind: l.kind,
            label: l.label,
            start: seconds(l.at),
            end: seconds(l.at + l.length),
            gain_db: l.gainDb
          }))
        }
      : {}),
    ...(r.import
      ? {
          import: {
            file_name: r.import.name,
            megabytes: Math.round(r.import.bytes / 1e5) / 10,
            ...(r.import.workingCopy.length ? { working_copy_because: r.import.workingCopy } : {}),
            ...(r.import.fit ? { fit: r.import.fit } : {})
          }
        }
      : {}),
    ...(r.export ? { export: { export_id: r.export.exportId, sequence_name: r.export.sequenceName } } : {})
  }
}

// ── Sources of photos and sound ──────────────────────────────────────────────

const imageSourceInput = z.union([
  uploadSource,
  urlSource,
  z.object({ still_id: z.string() }).strict(),
  z.object({ asset_image_id: z.string().describe('A photo of another asset (image_id).') }).strict(),
  z.object({ generation_id: z.string(), time: z.number().min(0).describe('Seconds into the clip.') }).strict()
])

const audioSourceInput = z.union([
  uploadSource,
  urlSource,
  z
    .object({
      generation_id: z.string().describe('A finished clip (or own clip, or version) whose sound to use.'),
      start: z.number().min(0).optional().describe('Seconds into the clip; default 0.'),
      end: z.number().positive().optional().describe('Seconds into the clip; default its end.')
    })
    .strict(),
  z.object({ edit_media_id: z.string().describe("Audio of an edit (get_edit's media).") }).strict()
])

const isFileSource = (s: object): s is FileSource => 'upload_id' in s || 'url' in s

/** How many added photos add_asset_images shows, and how big. */
const MAX_RETURNED_PHOTOS = 6
const THUMB_SIDE = 384

/** A finished clip's video, or a Swedish refusal. */
function finishedVideo(generationId: string): { g: Generation; file: string } {
  const g = db.getGeneration(generationId)
  if (!g) throw new Error(`Det finns ingen generering med id ${generationId}.`)
  if (g.status !== 'completed' || !g.filePath || !existsSync(g.filePath)) {
    throw new Error('Genereringen har ingen färdig video att ta bild eller ljud ur.')
  }
  return { g, file: g.filePath }
}

/** One frame of a finished clip as a PNG in `dir`, named after the clip and the moment, for a new photo. */
async function frameFile(generationId: string, time: number, dir: string): Promise<string> {
  const { g, file } = finishedVideo(generationId)
  const at = clampTime(time, await videoLength(file, g.videoDuration))
  const name = `${safeName(generationTitle(g, 40), { fallback: 'Klipp' })} ${at.toFixed(1).replace('.', ',')} s`
  return extractFrameAtOrAfter(file, join(dir, `${safeName(name, { fallback: 'Bildruta' })}.png`), at)
}

/** [start, end) of a finished clip's sound as an .m4a in `dir`, for a new audio clip. */
async function soundOfClip(
  generationId: string,
  start: number | undefined,
  end: number | undefined,
  dir: string
): Promise<string> {
  const { g, file } = finishedVideo(generationId)
  const info = await probe(file)
  if (!info.hasAudio) throw new Error(`${q(generationTitle(g, 40))} har inget ljud.`)
  const from = Math.max(0, start ?? 0)
  const to = Math.min(info.duration, end ?? info.duration)
  if (!(to > from)) {
    throw new Error(
      `Utdraget är tomt: klippet är ${seconds(info.duration)} s, start ${seconds(from)} och slut ${seconds(to)}.`
    )
  }
  const out = join(dir, `${safeName(generationTitle(g, 40), { fallback: 'Ljud' })}.m4a`)
  await extractAudio(file, out, { start: from, end: to })
  return out
}

/** The file of an edit's audio media (a recorded library file, used where it is). */
function editMediaFile(mediaId: string): string {
  const row = db.getDb().prepare('SELECT file_path FROM edit_media WHERE id = ?').get(mediaId) as { file_path: string } | undefined
  if (!row) throw new Error(`Det finns inget ljud med media_id ${mediaId}. get_edit visar en redigerings ljud (media).`)
  const path = fromStoredPath(row.file_path)
  if (!existsSync(path)) throw new Error('Ljudfilen finns inte längre på disken.')
  return path
}

export function registerLibraryTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_studio_guide',
    {
      title: 'Studio guide',
      description:
        "How Studio works and how to write video prompts that work in it. Read this once at the start of a session, before you prepare anything: it explains assets (characters, environments, products, outfits, poses) with their photos and voices – and how to add them (uploads or URLs), the three modes, how reference images and audio become @Image1… and @Audio1… tokens in the prompt, sequences and continuation clips, keyframes, storyboards (milestone pictures made with request_image_generation, with the transitions between them generated as clips), replacing a clip between its neighbours, the user's own clips, editing films into versions in Redigera (free operations, plans, paid voice, music and picture operations, designed and cloned voices), the approval flow for paid generations, a detailed prompt-writing guide for Seedance-class video models, the review loop for learning from results – deleting (always through request_delete, which the user approves), what is running and new (get_work_status) – and ends with the learnings recorded so far (pinned ones and the most recent).",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'läste guiden'
    },
    async () => ({ data: { guide: studioGuide(ctx.promptLanguage(), await learningsForGuide()) } })
  )

  defineTool(
    server,
    ctx,
    'list_assets',
    {
      title: 'List assets',
      description:
        "Lists the user's library assets: characters (who is in the shot), environments (where it takes place), products (a specific item to show in the film: a package, a bottle, a gadget), outfits (what a character wears) and poses (photos or sketches of how people stand and where, relative to each other). Each entry has its id, name, the user's description, how many photos it has and their image_ids (photo 1 first), for characters and environments their audio clips (a character's voice, an environment's soundscape: audio_id, duration and the reference window clip_start/clip_length that is sent; for a character's voice also clone_consent – whether the user allows cloning it for new spoken lines in Redigera, which only they can switch on), and for characters the default outfit. Use the ids with get_asset (to see the photos and hear the voice), set_references, add_segment and update_segment.",
      input: {
        kind: assetKind
          .optional()
          .describe('Only this kind: "character", "environment", "product", "outfit" or "pose". All kinds when left out.'),
        query: z.string().optional().describe('Only assets whose name or description contains this text (case-insensitive).')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: ({ kind }) => (kind ? `listade ${KIND_PLURALS[kind]}` : 'listade biblioteket')
    },
    async ({ kind, query }) => {
      const index = await AssetIndex.load()
      const assets = index.assets.filter((a) => (!kind || a.kind === kind) && matches(query, a.name, a.description))
      return { data: { count: assets.length, assets: assets.map((a) => assetSummary(a, index)) } }
    }
  )

  defineTool(
    server,
    ctx,
    'get_asset',
    {
      title: 'Get asset',
      description:
        "One asset with its description and its photos as images (JPEG, at most 768 px), so you can see faces, garments, places, products and poses before choosing references. Each photo is labelled with its photo number and image_id (added_by names the agent – and the host a fetched file came from – when an agent added it); pass image_ids to set_references or add_segment to send only the best photos. Characters and environments list their audio clips (voice / soundscape) with the reference window that is sent to Venice (and, for a voice, clone_consent); with include_audio you also get that window as audio (MP3) to listen to, if your client takes audio. For a character it also names the default outfit; for an outfit, the characters wearing it by default.",
      input: {
        asset_id: z.string().describe('The id from list_assets.'),
        include_images: z.boolean().default(true).describe('Return the photos as images. Default true.'),
        max_images: z.number().int().min(1).max(12).default(4).describe('How many photos to return, cover first. Default 4.'),
        include_audio: z
          .boolean()
          .default(false)
          .describe("Return an audio clip's reference window as MP3 audio content (the first clip unless audio_id is given). Default false."),
        audio_id: z.string().optional().describe('With include_audio: this clip instead of the first one.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en tillgång'
    },
    async ({ asset_id, include_images, max_images, include_audio, audio_id }) => {
      const index = await AssetIndex.load()
      const asset = index.require(asset_id)
      const images: LabeledImage[] = []
      if (include_images) {
        for (const [i, img] of asset.images.slice(0, max_images).entries()) {
          const block = await imageBlock(img.path)
          if (block) {
            images.push({ label: `${asset.name} (${asset.kind}) – photo ${i + 1}, image_id ${img.id}`, image: block })
          }
        }
      }
      const audio: LabeledAudio[] = []
      const data: Record<string, unknown> = {}
      const clips = audioOf(asset)
      if (include_audio || audio_id) {
        const clip = audio_id ? clips.find((a) => a.id === audio_id) : clips[0]
        if (audio_id && !clip) throw new Error(`Ljudklippet ${audio_id} hör inte till ${q(asset.name)}.`)
        if (!clip) {
          data.audio_note = `${asset.name} has no audio clip.`
        } else {
          try {
            const window = audioWindow(referenceAudioOf(clip), index)
            audio.push({
              label: `${asset.name} – ${audioRole(asset.kind)} clip ${clips.indexOf(clip) + 1} (audio_id ${clip.id}), reference window ${seconds(window.start)}–${seconds(window.start + window.length)} s of ${seconds(clip.duration)} s`,
              audio: await referenceAudioBlock(clip.path, window)
            })
          } catch (err) {
            data.audio_error = errorText(err)
          }
        }
      }
      const outfit = asset.defaultOutfitId ? index.get(asset.defaultOutfitId) : undefined
      const wornBy = asset.kind === 'outfit' ? index.assets.filter((a) => a.defaultOutfitId === asset.id) : []
      return {
        data: {
          ...assetSummary(asset, index),
          photos: asset.images.map((img, i) => ({
            photo_number: i + 1,
            image_id: img.id,
            file: basename(img.path),
            ...addedBy(img.origin)
          })),
          ...(asset.kind === 'character' && outfit ? { default_outfit: { id: outfit.id, name: outfit.name } } : {}),
          ...(asset.kind === 'outfit' ? { default_outfit_of: wornBy.map((a) => ({ id: a.id, name: a.name })) } : {}),
          images_returned: images.length,
          ...(include_audio || audio_id ? { audio_returned: audio.length } : {}),
          ...data
        },
        images,
        audio,
        summary: `tittade på ${KIND_DEFINITE[asset.kind]} ${q(asset.name)}${audio.length ? ' och lyssnade på ljudet' : ''}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'create_asset',
    {
      title: 'Create asset',
      description:
        'Creates a new character, environment, product, outfit or pose with a name and a description (looks, place, garments, for a product its brand, model, colours, material, size and what the packaging says, or for a pose who stands where, body posture, distance and camera angle – whatever helps keep it consistent). Then add photos with add_asset_images (from uploads, URLs, stills, other photos or frames of clips) and, for characters and environments, sound with add_asset_audio. Returns the new asset.',
      input: {
        kind: assetKind.describe('"character", "environment", "product", "outfit" or "pose".'),
        name: z
          .string()
          .min(1)
          .describe(
            'Short name as the user would say it, e.g. "Anna", "Strandpromenaden", "Kaffeburken" or "Kram" (a brand in a product\'s name when it helps).'
          ),
        description: z.string().default('').describe('Free text; written in Swedish or English as the user prefers.')
      },
      annotations: WRITE,
      summary: ({ kind, name }) => `skapade ${KIND_DEFINITE[kind]} ${q(name)}`
    },
    async ({ kind, name, description }) => {
      requireLibrary()
      const asset = await callService<Asset>('assets:save', { kind, name, description })
      return { data: assetSummary(asset, new AssetIndex([asset])) }
    }
  )

  defineTool(
    server,
    ctx,
    'update_asset',
    {
      title: 'Update asset',
      description:
        "Changes an asset's name, description and/or (characters only) default outfit. Fields you leave out stay as they are. Renaming also renames its folder in the user's library. default_outfit_id must be an outfit's id; null removes the default outfit. The name and description are appended to every prompt that sends the asset's photos or voice (the References legend), from the next generation on – so keep the description concrete and visual (what the photos can't say), and expect a pending approval that uses the asset to lapse when you change it.",
      input: {
        asset_id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        default_outfit_id: z.string().nullable().optional().describe("Characters only: an outfit's id, or null for none.")
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade en tillgång'
    },
    async ({ asset_id, name, description, default_outfit_id }) => {
      const index = await AssetIndex.load()
      const current = index.require(asset_id)
      const asset = await callService<Asset>('assets:save', {
        id: current.id,
        kind: current.kind,
        name: name ?? current.name,
        description: description ?? current.description,
        defaultOutfitId: default_outfit_id
      })
      const fresh = await AssetIndex.load()
      return { data: assetSummary(asset, fresh), summary: `ändrade ${q(asset.name)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'update_asset_audio',
    {
      title: 'Update audio clip window',
      description:
        "Moves or resizes the reference window of an asset's audio clip (a character's voice, an environment's soundscape): the part of the file that is sent to Venice when the clip is a reference. clip_start is seconds into the file, clip_length the window's length; Studio keeps it 2–15 s and inside the file (the answer shows the window it ended up with). All reference audio of one generation may be at most 15 s together, so shorten windows (e.g. to 5–7 s each) when several voices are used. Pick a part where the voice is clear and typical; listen with get_asset({include_audio: true, audio_id}). Add clips with add_asset_audio; removing one goes through request_delete (the user approves).",
      input: {
        audio_id: z.string().describe('The audio_id from list_assets or get_asset.'),
        clip_start: z.number().min(0).optional().describe('Seconds into the file.'),
        clip_length: z.number().positive().optional().describe('Seconds, 2–15.')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade ett ljudklipps fönster'
    },
    async ({ audio_id, clip_start, clip_length }) => {
      const index = await AssetIndex.load()
      const { asset } = index.requireAudio(audio_id)
      if (clip_start === undefined && clip_length === undefined) {
        throw new Error('Ange clip_start och/eller clip_length.')
      }
      const updated = await callService<Asset>('assets:updateAudio', audio_id, {
        ...(clip_start !== undefined ? { clipStart: clip_start } : {}),
        ...(clip_length !== undefined ? { clipLength: clip_length } : {})
      })
      const clip = audioOf(updated).find((a) => a.id === audio_id)
      const adjusted =
        clip &&
        ((clip_start !== undefined && Math.abs(clip.clipStart - clip_start) > 0.01) ||
          (clip_length !== undefined && Math.abs(clip.clipLength - clip_length) > 0.01))
      return {
        data: {
          asset_id: updated.id,
          asset_name: updated.name,
          audio: audioClipsInfo(updated),
          ...(adjusted
            ? { note: 'Studio adjusted the window to stay 2–15 s long and inside the file; see clip_start/clip_length.' }
            : {})
        },
        summary: `ändrade ljudfönstret för ${q(asset.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_asset_images',
    {
      title: 'Add photos to an asset',
      description:
        "Adds photos to an asset (any kind), after its photos (reorder_asset_images changes the order; photo 1 is the cover and is what a reference sends first). sources (1–12, in order): {upload_id} (a ready image upload, begin_upload), {url} (Studio fetches it like begin_upload({url}): public addresses or your own machine; the call waits at most 45 s for its URLs in all), {still_id} (a still), {asset_image_id} (a photo of another asset) or {generation_id, time} (that frame of a finished clip: the first frame at or after time, as review_generation and get_frames show it). Copied into the asset's folder (Karaktärer/<name>/ …) under the file's own name; the user sees you added them (\"Tillagd av …\"). All or nothing: one source that can't be used adds none. For a product, start with a clear packshot of the front with the label; then the sides, and one in a hand for the size. Returns the asset and the added photos (image_id, photo_number) as images.",
      input: {
        asset_id: z.string(),
        sources: z.array(imageSourceInput).min(1).max(12)
      },
      annotations: WRITE,
      summary: ({ sources }) => `lade till ${sources.length === 1 ? 'ett foto' : `${sources.length} foton`}`
    },
    async ({ asset_id, sources }) => {
      const index = await AssetIndex.load()
      const asset = index.require(asset_id)
      const deadline = Date.now() + URL_WAIT_MS
      // Everything is resolved (uploads ready, URLs fetched, stills and photos there, frames taken) before the
      // asset service is asked; it then copies all of them in one go or none.
      const files = await stageFiles(ctx, 'image', sources.filter(isFileSource), deadline)
      const stills = sources.some((s) => 'still_id' in s) ? await StillIndex.load() : undefined
      let frameDir: string | undefined
      try {
        const picked: { path: string; host?: string }[] = []
        let next = 0
        for (const source of sources) {
          if (isFileSource(source)) {
            picked.push(files[next++])
          } else if ('still_id' in source) {
            const still = stills!.require(source.still_id)
            if (!existsSync(still.path)) {
              throw new Error(`Stillbilden ${basename(still.path)} finns inte längre på disken.`)
            }
            picked.push({ path: still.path })
          } else if ('asset_image_id' in source) {
            picked.push({ path: index.requireImage(source.asset_image_id).path })
          } else {
            frameDir ??= await mkdtemp(join(agentUploadsDir(), 'frames-'))
            picked.push({ path: await frameFile(source.generation_id, source.time, frameDir) })
          }
        }
        const before = new Set(asset.images.map((i) => i.id))
        const updated = await callService<Asset>(
          'assets:addImages',
          asset.id,
          picked.map((p) => p.path),
          originOf(ctx, picked)
        )
        const added = updated.images.flatMap((img, i) => (before.has(img.id) ? [] : [{ img, number: i + 1 }]))
        const images: LabeledImage[] = []
        for (const { img, number } of added.slice(0, MAX_RETURNED_PHOTOS)) {
          const block = await imageBlock(img.path, THUMB_SIDE)
          if (block) images.push({ label: `${updated.name} – photo ${number} (image_id ${img.id})`, image: block })
        }
        return {
          data: {
            asset: assetSummary(updated, new AssetIndex([updated])),
            added: added.map(({ img, number }) => ({ image_id: img.id, photo_number: number })),
            ...(added.length < picked.length
              ? { note: 'Some sources were the same picture, so fewer photos were added than sources given.' }
              : {})
          },
          images,
          summary: `lade till ${added.length === 1 ? 'ett foto' : `${added.length} foton`} i ${KIND_DEFINITE[updated.kind]} ${q(updated.name)}`
        }
      } finally {
        if (frameDir) await rm(frameDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  defineTool(
    server,
    ctx,
    'reorder_asset_images',
    {
      title: "Reorder an asset's photos",
      description:
        "Changes the order of an asset's photos: the image_ids you name come first, in that order, the rest after them in their current order. Photo 1 is the cover – the picture lists show, and the one a reference sends first. Nothing is added or removed.",
      input: {
        asset_id: z.string(),
        image_ids: z.array(z.string()).min(1).describe('Photos of this asset (get_asset), in their new order.')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade ordningen på en tillgångs foton'
    },
    async ({ asset_id, image_ids }) => {
      const index = await AssetIndex.load()
      const asset = index.require(asset_id)
      const own = new Set(asset.images.map((i) => i.id))
      const stray = image_ids.filter((id) => !own.has(id))
      if (stray.length) {
        throw new Error(`${stray.join(', ')} är inte foton av ${q(asset.name)}. get_asset visar dess image_ids.`)
      }
      const updated = await callService<Asset>('assets:reorderImages', asset.id, image_ids)
      return {
        data: {
          asset_id: updated.id,
          image_ids: updated.images.map((i) => i.id),
          cover_image_id: updated.images[0]?.id ?? null
        },
        summary: `ändrade ordningen på fotona av ${q(updated.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_asset_audio',
    {
      title: 'Add sound clips to an asset',
      description:
        "Adds audio clips to a character (Röst: its voice) or an environment (Ljudmiljö: the place's sound), after its clips; reorder_asset_audio changes the order (clip 1 is the one a reference sends by default). sources (1–6): {upload_id} (a ready audio upload), {url} (fetched like begin_upload({url}); the call waits at most 45 s for its URLs in all), {generation_id, start?, end?} (the sound of a finished clip, seconds into it, cut out as its own file) or {edit_media_id} (audio of an edit in Redigera: get_edit's media). Each clip must be at least 1 s; a voice should be clear speech of one person (5–15 s is plenty – its reference window is 2–15 s, set with update_asset_audio). The user sees you added them. All or nothing. Returns the new clips (audio_id, duration, the reference window that is sent).",
      input: {
        asset_id: z.string(),
        sources: z.array(audioSourceInput).min(1).max(6)
      },
      annotations: WRITE,
      summary: ({ sources }) => `lade till ${sources.length === 1 ? 'ett ljudklipp' : `${sources.length} ljudklipp`}`
    },
    async ({ asset_id, sources }) => {
      const index = await AssetIndex.load()
      const asset = index.require(asset_id)
      if (!AUDIO_KINDS.has(asset.kind)) throw new Error(NO_AUDIO_KIND)
      const deadline = Date.now() + URL_WAIT_MS
      const files = await stageFiles(ctx, 'audio', sources.filter(isFileSource), deadline)
      let cutDir: string | undefined
      try {
        const picked: { path: string; host?: string }[] = []
        let next = 0
        for (const source of sources) {
          if (isFileSource(source)) {
            picked.push(files[next++])
          } else if ('edit_media_id' in source) {
            picked.push({ path: editMediaFile(source.edit_media_id) })
          } else {
            cutDir ??= await mkdtemp(join(agentUploadsDir(), 'sound-'))
            picked.push({ path: await soundOfClip(source.generation_id, source.start, source.end, cutDir) })
          }
        }
        const before = new Set(audioOf(asset).map((a) => a.id))
        const updated = await callService<Asset>(
          'assets:addAudio',
          asset.id,
          picked.map((p) => p.path),
          originOf(ctx, picked)
        )
        const clips = audioClipsInfo(updated)
        const added = clips.filter((c) => !before.has(c.audio_id as string))
        return {
          data: { asset_id: updated.id, asset_name: updated.name, added, audio: clips },
          summary: `lade till ${added.length === 1 ? 'ett ljudklipp' : `${added.length} ljudklipp`} till ${KIND_DEFINITE[updated.kind]} ${q(updated.name)}`
        }
      } finally {
        if (cutDir) await rm(cutDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  defineTool(
    server,
    ctx,
    'reorder_asset_audio',
    {
      title: "Reorder an asset's audio clips",
      description:
        "Changes the order of a character's or environment's audio clips: the audio_ids you name come first, in that order, the rest after them. Clip 1 is the one that comes along by default when the asset is a reference (a character's voice). Nothing is added or removed.",
      input: {
        asset_id: z.string(),
        audio_ids: z.array(z.string()).min(1).describe('Clips of this asset (get_asset), in their new order.')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade ordningen på en tillgångs ljudklipp'
    },
    async ({ asset_id, audio_ids }) => {
      const index = await AssetIndex.load()
      const asset = index.require(asset_id)
      const own = new Set(audioOf(asset).map((a) => a.id))
      const stray = audio_ids.filter((id) => !own.has(id))
      if (stray.length) {
        throw new Error(`${stray.join(', ')} är inte ljudklipp av ${q(asset.name)}. get_asset visar dess audio_id.`)
      }
      const updated = await callService<Asset>('assets:reorderAudio', asset.id, audio_ids)
      return {
        data: { asset_id: updated.id, audio: audioClipsInfo(updated) },
        summary: `ändrade ordningen på ljudklippen av ${q(updated.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'list_models',
    {
      title: 'List video models',
      description:
        "Venice's video models Studio can use, with their mode (kind), allowed durations, resolutions and aspect ratios, how many reference images they take, whether they take reference audio (audio_input: voices and sounds as @Audio1…, max_reference_audios), whether they make audio, and their prompt length limit. The default model (Seedance 2.5 reference-to-video) is marked default: true. Use these exact values with set_form, add_segment and update_segment.",
      input: {
        kind: z.enum(MODES).optional().describe('Only models of this mode.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },
      summary: () => 'listade modellerna'
    },
    async ({ kind }) => {
      const models = usableModels(await loadModels()).filter((m) => !kind || m.kind === kind)
      return { data: { models: models.map(modelInfo) } }
    }
  )

  defineTool(
    server,
    ctx,
    'list_prompts',
    {
      title: 'List saved prompts',
      description:
        "The user's prompt library: prompts they saved, favourites first, with title, body, negative prompt, tags and how often they used them. Good for learning their style or reusing a prompt (put it into the form with set_form).",
      input: {
        query: z.string().optional().describe('Only prompts whose title, body or tags contain this text.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'läste promptbiblioteket'
    },
    async ({ query }) => {
      requireLibrary()
      const prompts = (await callService<SavedPrompt[]>('prompts:list')).filter((p) =>
        matches(query, p.title, p.body, p.tags.join(' '))
      )
      return {
        data: {
          count: prompts.length,
          prompts: prompts.slice(0, 100).map((p) => ({
            id: p.id,
            title: p.title,
            body: p.body,
            negative_prompt: p.negativePrompt,
            tags: p.tags,
            favorite: p.favorite,
            use_count: p.useCount
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'save_prompt',
    {
      title: 'Save prompt',
      description:
        "Saves a prompt to the user's prompt library so they can reuse it later. @ImageN and @AudioN tokens are stored as written (in canonical form); remember that they only make sense with the same references in the same order.",
      input: {
        title: z.string().default('').describe('Short title; left empty, Studio uses the first words of the body.'),
        body: z.string().min(1).describe('The prompt.'),
        negative_prompt: z.string().optional(),
        tags: z.array(z.string()).default([]).describe('e.g. ["strand", "Anna"]')
      },
      annotations: WRITE,
      summary: ({ title, body }) => `sparade prompten ${q(title || body.slice(0, 40))}`
    },
    async ({ title, body, negative_prompt, tags }) => {
      requireLibrary()
      const input: PromptInput = {
        title,
        body: canonical(body) ?? body,
        negativePrompt: canonical(negative_prompt),
        tags,
        favorite: false
      }
      const saved = await callService<SavedPrompt>('prompts:save', input)
      return { data: { id: saved.id, title: saved.title }, summary: `sparade prompten ${q(saved.title)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'update_prompt',
    {
      title: 'Update saved prompt',
      description:
        "Changes a prompt in the user's prompt library (list_prompts gives the ids): only the fields you pass change; negative_prompt null clears it; tags replaces the list; favorite marks it a favourite (shown first). @ImageN / @AudioN tokens are stored in canonical form, as save_prompt does.",
      input: {
        prompt_id: z.string(),
        title: z.string().max(200).optional(),
        body: z.string().min(1).optional(),
        negative_prompt: z.string().nullable().optional(),
        tags: z.array(z.string().max(60)).max(12).optional(),
        favorite: z.boolean().optional()
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade en sparad prompt'
    },
    async ({ prompt_id, title, body, negative_prompt, tags, favorite }) => {
      requireLibrary()
      if ([title, body, negative_prompt, tags, favorite].every((v) => v === undefined)) {
        throw new Error('Ange det som ska ändras: title, body, negative_prompt, tags eller favorite.')
      }
      const current = (await callService<SavedPrompt[]>('prompts:list')).find((p) => p.id === prompt_id)
      if (!current) throw new Error('Prompten finns inte (längre). list_prompts visar vilka som finns.')
      // prompts:save with an id replaces every field, so the stored prompt is the base and only the given ones change.
      const input: PromptInput = {
        id: current.id,
        title: title ?? current.title,
        body: body !== undefined ? (canonical(body) ?? body) : current.body,
        negativePrompt:
          negative_prompt === null
            ? undefined
            : negative_prompt !== undefined
              ? canonical(negative_prompt) || undefined
              : current.negativePrompt,
        tags: tags ?? current.tags,
        favorite: favorite ?? current.favorite
      }
      const saved = await callService<SavedPrompt>('prompts:save', input)
      return {
        data: {
          id: saved.id,
          title: saved.title,
          body: saved.body,
          negative_prompt: saved.negativePrompt,
          tags: saved.tags,
          favorite: saved.favorite
        },
        summary: `ändrade prompten ${q(saved.title)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'list_generations',
    {
      title: 'List generations',
      description:
        "Generations (clips) from the user's feed, filtered and sorted the way Studio's clip feed does it, with paging. Each has its source (generated by Venice, an import – the user's own film – or an edit version made in Redigera, named by title), its status (queued, processing, completed, failed), prompt, settings, price, the user's rating (1–5) and how many reviews it has, a one-line-per-token summary of its references (\"@Image1 Anna (character) photo 1\", \"@Audio1 Anna (voice)\") and which sequence clip or storyboard transition it is a take of. The answer also sums up the filtered set (count, cost, seconds). Use it to find clips to learn from: e.g. the best rated ones (sort \"rating\", min_rating 4), the ones of one character (asset_id), or completed clips nobody has reviewed (status \"completed\", has_reviews false) – then review_generation. Finished and failed rows say seen_by_user (whether the user has played or opened it yet; unseen_only lists only the new ones) – read-only: only the user marks things seen. get_generation and review_generation look at one.",
      input: {
        query: z.string().optional().describe("Words that must all appear in the prompt, the negative prompt or the title (an own clip's file name, a version's \"<edit> v3\")."),
        source: z
          .enum(['generated', 'import', 'edit'])
          .optional()
          .describe('"generated": made by Venice; "import": the user\'s own clips (Egna klipp) – and copies of exported films opened in Redigera, which get_generation marks with recipe.export (made in Studio, not the user\'s footage); "edit": versions made in Redigera.'),
        status: z.enum(['queued', 'processing', 'completed', 'failed', 'pending']).optional().describe('"pending" = queued or processing.'),
        model: z.string().optional().describe('Only this model id.'),
        asset_id: z.string().optional().describe("Only generations whose references use this asset's photos or audio."),
        min_rating: z.number().int().min(1).max(5).optional().describe("The user's rating is at least this many stars."),
        unrated: z.boolean().optional().describe('true: only clips the user has not rated.'),
        since_days: z.number().positive().max(3650).optional().describe('Only the last N days (e.g. 1 = today and yesterday evening, 7, 30).'),
        placement: z
          .enum(['standalone', 'sequence'])
          .optional()
          .describe('"standalone": not a take of a sequence clip or storyboard transition; "sequence": takes of either.'),
        has_reviews: z
          .boolean()
          .optional()
          .describe("true: only clips with at least one review (the user's or an agent's); false: only clips nobody has reviewed."),
        unseen_only: z
          .boolean()
          .optional()
          .describe("true: only finished (or failed) clips the user hasn't looked at yet (Studio's \"Nya\")."),
        sort: z.enum(['newest', 'oldest', 'rating', 'cost', 'length']).default('newest'),
        limit: z.number().int().min(1).max(50).default(20).describe('How many to return. Default 20.'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (paging). Default 0.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listade genereringarna'
    },
    async (input) => {
      requireLibrary()
      const index = await AssetIndex.load()
      if (input.asset_id) index.require(input.asset_id)
      const filter: GenerationFilter = {
        query: input.query,
        status: input.status,
        model: input.model,
        assetId: input.asset_id,
        minRating: input.min_rating,
        unrated: input.unrated,
        since: sinceDays(input.since_days),
        placement: input.placement,
        hasReviews: input.has_reviews,
        sort: input.sort,
        source: input.source,
        ...(input.unseen_only ? { unseen: true } : {})
      }
      const unseen = unseenGenerationIds()
      // The same filter and order as Studio's clip feed (generations:list carries the ratings and review counts).
      const all = (await callService<Generation[]>('generations:list')).map((g) => ({ ...g, unseen: unseen.has(g.id) }))
      const list = queryGenerations(all, filter, index.assets)
      const page = list.slice(input.offset, input.offset + input.limit)
      const totals = summarizeGenerations(list)
      return {
        data: {
          total: list.length,
          offset: input.offset,
          returned: page.length,
          ...(input.offset + page.length < list.length ? { next_offset: input.offset + page.length } : {}),
          totals: {
            count: totals.count,
            cost_usd: priceValue(totals.costUsd),
            video_seconds: Math.round(totals.seconds)
          },
          generations: page.map((g) => ({
            id: g.id,
            created: localTime(g.createdAt),
            ...sourceFields(g),
            status: g.status,
            model: g.model,
            prompt: g.prompt,
            ...(g.params.negativePrompt ? { negative_prompt: g.params.negativePrompt } : {}),
            duration: g.params.duration,
            resolution: g.params.resolution,
            aspect_ratio: g.params.aspectRatio,
            ...(g.videoDuration ? { video_seconds: Math.round(g.videoDuration * 10) / 10 } : {}),
            price_usd: priceValue(g.quote),
            rating: g.rating ?? null,
            review_count: g.reviewCount ?? 0,
            references: referenceSummary(g.params, index),
            ...(g.error ? { error: g.error } : {}),
            ...seenField(g, unseen),
            ...(g.segmentId ? { take_of: takeOf(g) } : {})
          }))
        },
        summary: `listade genereringarna (${list.length} st)`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_generation',
    {
      title: 'Get generation',
      description:
        "One generation: its source (generated, import – the user's own film, with original_path when the file is a working copy – or edit, a version made in Redigera, with its edit_id, parent_id and recipe: the operation that made it), status, error, timing, price, its settings with the reference token maps (@ImageN and @AudioN), sent_prompt (the prompt exactly as Venice got it, with the descriptions of its referenced assets appended as a References legend – when that differs from the prompt), which sequence clip or storyboard transition it is a take of, the user's rating and every review, seen_by_user (whether the user has looked at it yet), and – when completed – its poster frame as an image. Ask for `frames` to also get evenly spread frames from the video, captioned with their time (the last one is the clip's final frame, where a continuation clip would start). Poll this after an approval to follow progress. To judge a finished clip properly (frames next to the reference images, its sound), use review_generation.",
      input: {
        generation_id: z.string(),
        include_thumbnail: z.boolean().default(true).describe('Return the poster frame when completed. Default true.'),
        frames: z
          .number()
          .int()
          .min(0)
          .max(6)
          .default(0)
          .describe('Extra frames from the finished video, first to last (0–6). Default 0.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en generering'
    },
    async ({ generation_id, include_thumbnail, frames }) => {
      requireLibrary()
      const g = db.getGeneration(generation_id)
      if (!g) throw new Error('Genereringen finns inte (längre).')
      const index = await AssetIndex.load()
      const reviews = await callService<GenerationReview[]>('reviews:list', g.id).catch(() => [])
      const images: LabeledImage[] = []
      const data: Record<string, unknown> = {
        id: g.id,
        ...sourceFields(g),
        status: g.status,
        created: localTime(g.createdAt),
        completed: localTime(g.completedAt),
        error: g.error,
        price_usd: priceValue(g.quote),
        video_seconds: g.videoDuration,
        file: g.filePath ? basename(g.filePath) : undefined,
        // An import with a working copy: the untouched original next to it (file is the working copy).
        ...(g.originalPath ? { original_path: g.originalPath } : {}),
        ...(g.recipe ? { recipe: recipeInfo(g.recipe) } : {}),
        ...(g.status === 'processing' && g.averageExecutionTime
          ? {
              progress: {
                elapsed_seconds: Math.round((g.executionDuration ?? 0) / 1000),
                typical_seconds: Math.round(g.averageExecutionTime / 1000)
              }
            }
          : {}),
        take_of: takeOf(g),
        params: paramsInfo(g.params, index),
        // What Venice actually got, when the descriptions of its references were appended to the prompt.
        ...(g.sentPrompt && g.sentPrompt !== g.params.prompt ? { sent_prompt: g.sentPrompt } : {}),
        rating: reviews.find((r) => r.author === 'user')?.rating ?? null,
        reviews: reviews.map(reviewInfo),
        ...seenField(g, unseenGenerationIds())
      }
      if (g.status === 'completed' && include_thumbnail && g.thumbPath) {
        const poster = await imageBlock(g.thumbPath)
        if (poster) images.push({ label: `Generation ${g.id} – poster frame`, image: poster })
      }
      if (g.status === 'completed' && frames > 0) {
        try {
          const file = requireVideoFile(g.filePath, 'Genereringen')
          const length = await videoLength(file, g.videoDuration)
          const times = spreadTimes(0, lastFrameTime(length), frames).map((t) => clampTime(t, length))
          images.push(
            ...(await framesAt(file, times, (caption, i) =>
              i === times.length - 1 && times.length > 1
                ? `Generation ${g.id} – ${caption} (last frame, of ${seconds(length)} s)`
                : `Generation ${g.id} – ${caption} (of ${seconds(length)} s)`
            ))
          )
        } catch (err) {
          data.frames_error = errorText(err)
        }
      }
      return { data, images }
    }
  )
}
