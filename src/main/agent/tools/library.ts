import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { queryGenerations, summarizeGenerations } from '@shared/generation-filter'
import {
  ASSET_KINDS,
  type Asset,
  type AssetKind,
  type Generation,
  type GenerationFilter,
  type GenerationReview,
  type Learning,
  type PromptInput,
  type SavedPrompt
} from '@shared/types'
import * as db from '../../db'
import * as store from '../../sequence-store'
import { studioGuide } from '../guide'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import { clampTime, framesAt, lastFrameTime, referenceAudioBlock, requireVideoFile, spreadTimes, videoLength } from '../media'
import {
  AssetIndex,
  MODES,
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
import { READ_ONLY, WRITE, defineTool, priceValue, type LabeledAudio, type LabeledImage, type ToolContext } from './kit'

// The library: the guide, assets (characters, environments, outfits, poses) with their photos and audio clips,
// models, the prompt library and the generations feed.

const KIND_PLURALS: Record<AssetKind, string> = {
  character: 'karaktärerna',
  environment: 'miljöerna',
  outfit: 'kläderna',
  pose: 'poserna'
}
const KIND_DEFINITE: Record<AssetKind, string> = {
  character: 'karaktären',
  environment: 'miljön',
  outfit: 'klädseln',
  pose: 'posen'
}

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

/** Takes of a sequence: which sequence and clip a generation belongs to. */
export function takeOf(g: Generation): Record<string, unknown> | undefined {
  if (!g.segmentId) return undefined
  const sequence = store.sequenceOfSegment(g.segmentId)
  if (!sequence) return undefined
  const clip = store.listSegmentRows(sequence.id).findIndex((r) => r.id === g.segmentId) + 1
  return { sequence_id: sequence.id, sequence_name: sequence.name, segment_id: g.segmentId, clip_number: clip || undefined }
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

/** Days → the filter's `since` (epoch ms). */
function sinceDays(days: number | undefined): number | undefined {
  return days === undefined ? undefined : Date.now() - days * 24 * 60 * 60 * 1000
}

export function registerLibraryTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_studio_guide',
    {
      title: 'Studio guide',
      description:
        "How Studio works and how to write video prompts that work in it. Read this once at the start of a session, before you prepare anything: it explains assets (characters, environments, outfits, poses) and their voices, the three modes, how reference images and audio become @Image1… and @Audio1… tokens in the prompt, sequences and continuation clips, storyboards with keyframes (start and end images, made with request_image_generation) and replacing a clip between its neighbours, the approval flow for paid generations, a detailed prompt-writing guide for Seedance-class video models, the review loop for learning from results – and ends with the learnings recorded so far (pinned ones and the most recent).",
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
        "Lists the user's library assets: characters (who is in the shot), environments (where it takes place), outfits (what a character wears) and poses (photos or sketches of how people stand and where, relative to each other). Each entry has its id, name, the user's description, how many photos it has and their image_ids (photo 1 first), for characters and environments their audio clips (a character's voice, an environment's soundscape: audio_id, duration and the reference window clip_start/clip_length that is sent), and for characters the default outfit. Use the ids with get_asset (to see the photos and hear the voice), set_references, add_segment and update_segment.",
      input: {
        kind: assetKind.optional().describe('Only this kind: "character", "environment", "outfit" or "pose". All kinds when left out.'),
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
        "One asset with its description and its photos as images (JPEG, at most 768 px), so you can see faces, garments, places and poses before choosing references. Each photo is labelled with its photo number and image_id; pass image_ids to set_references or add_segment to send only the best photos. Characters and environments list their audio clips (voice / soundscape) with the reference window that is sent to Venice; with include_audio you also get that window as audio (MP3) to listen to, if your client takes audio. For a character it also names the default outfit; for an outfit, the characters wearing it by default.",
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
          photos: asset.images.map((img, i) => ({ photo_number: i + 1, image_id: img.id, file: basename(img.path) })),
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
        'Creates a new character, environment, outfit or pose with a name and a description (looks, place, garments, or for a pose who stands where, body posture, distance and camera angle – whatever helps keep it consistent). Photos and audio clips (voices, soundscapes) can only be added by the user in Studio (tell them what would help). Returns the new asset.',
      input: {
        kind: assetKind.describe('"character", "environment", "outfit" or "pose".'),
        name: z.string().min(1).describe('Short name as the user would say it, e.g. "Anna", "Strandpromenaden" or "Kram".'),
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
        "Changes an asset's name, description and/or (characters only) default outfit. Fields you leave out stay as they are. Renaming also renames its folder in the user's library. default_outfit_id must be an outfit's id; null removes the default outfit.",
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
        "Moves or resizes the reference window of an asset's audio clip (a character's voice, an environment's soundscape): the part of the file that is sent to Venice when the clip is a reference. clip_start is seconds into the file, clip_length the window's length; Studio keeps it 2–15 s and inside the file (the answer shows the window it ended up with). All reference audio of one generation may be at most 15 s together, so shorten windows (e.g. to 5–7 s each) when several voices are used. Pick a part where the voice is clear and typical; listen with get_asset({include_audio: true, audio_id}). Clips can only be added or removed by the user in Studio.",
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
    'list_generations',
    {
      title: 'List generations',
      description:
        "Generations (clips) from the user's feed, filtered and sorted the way Studio's clip feed does it, with paging. Each has its status (queued, processing, completed, failed), prompt, settings, price, the user's rating (1–5) and how many reviews it has, a one-line-per-token summary of its references (\"@Image1 Anna (character) photo 1\", \"@Audio1 Anna (voice)\") and which sequence clip it is a take of. The answer also sums up the filtered set (count, cost, seconds). Use it to find clips to learn from: e.g. the best rated ones (sort \"rating\", min_rating 4), the ones of one character (asset_id), or completed clips nobody has reviewed (status \"completed\", has_reviews false) – then review_generation. get_generation and review_generation look at one.",
      input: {
        query: z.string().optional().describe('Words that must all appear in the prompt (or negative prompt).'),
        status: z.enum(['queued', 'processing', 'completed', 'failed', 'pending']).optional().describe('"pending" = queued or processing.'),
        model: z.string().optional().describe('Only this model id.'),
        asset_id: z.string().optional().describe("Only generations whose references use this asset's photos or audio."),
        min_rating: z.number().int().min(1).max(5).optional().describe("The user's rating is at least this many stars."),
        unrated: z.boolean().optional().describe('true: only clips the user has not rated.'),
        since_days: z.number().positive().max(3650).optional().describe('Only the last N days (e.g. 1 = today and yesterday evening, 7, 30).'),
        placement: z.enum(['standalone', 'sequence']).optional().describe('"standalone": not a take of a sequence clip; "sequence": takes.'),
        has_reviews: z
          .boolean()
          .optional()
          .describe("true: only clips with at least one review (the user's or an agent's); false: only clips nobody has reviewed."),
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
        sort: input.sort
      }
      // The same filter and order as Studio's clip feed (generations:list carries the ratings and review counts).
      const list = queryGenerations(await callService<Generation[]>('generations:list'), filter, index.assets)
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
        "One generation: status, error, timing, price, its settings with the reference token maps (@ImageN and @AudioN), which sequence clip it is a take of, the user's rating and every review, and – when completed – its poster frame as an image. Ask for `frames` to also get evenly spread frames from the video, captioned with their time (the last one is the clip's final frame, where a continuation clip would start). Poll this after an approval to follow progress. To judge a finished clip properly (frames next to the reference images, its sound), use review_generation.",
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
        status: g.status,
        created: localTime(g.createdAt),
        completed: localTime(g.completedAt),
        error: g.error,
        price_usd: priceValue(g.quote),
        video_seconds: g.videoDuration,
        file: g.filePath ? basename(g.filePath) : undefined,
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
        rating: reviews.find((r) => r.author === 'user')?.rating ?? null,
        reviews: reviews.map(reviewInfo)
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
