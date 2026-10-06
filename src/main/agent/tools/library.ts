import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ASSET_KINDS, type Asset, type AssetKind, type Generation, type PromptInput, type SavedPrompt } from '@shared/types'
import * as db from '../../db'
import { extractFrame, probe } from '../../ffmpeg'
import * as store from '../../sequence-store'
import { studioGuide } from '../guide'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import {
  AssetIndex,
  MODES,
  canonical,
  errorText,
  loadModels,
  localTime,
  modelInfo,
  paramsInfo,
  q,
  requireLibrary,
  usableModels
} from '../studio'
import { READ_ONLY, WRITE, defineTool, priceValue, type LabeledImage, type ToolContext } from './kit'

// The library: the guide, assets (characters, environments, outfits), models, the prompt library and the
// generations feed.

const KIND_PLURALS: Record<AssetKind, string> = { character: 'karaktärerna', environment: 'miljöerna', outfit: 'kläderna' }
const KIND_DEFINITE: Record<AssetKind, string> = { character: 'karaktären', environment: 'miljön', outfit: 'klädseln' }

const assetKind = z.enum(ASSET_KINDS as [AssetKind, ...AssetKind[]])

/** Case- and accent-tolerant text match for the query parameters. */
function matches(query: string | undefined, ...fields: (string | undefined)[]): boolean {
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
    ...(a.kind === 'character'
      ? { default_outfit_id: a.defaultOutfitId ?? null, default_outfit_name: outfit?.name }
      : {})
  }
}

/** Takes of a sequence: which sequence and clip a generation belongs to. */
function takeOf(g: Generation): Record<string, unknown> | undefined {
  if (!g.segmentId) return undefined
  const sequence = store.sequenceOfSegment(g.segmentId)
  if (!sequence) return undefined
  const clip = store.listSegmentRows(sequence.id).findIndex((r) => r.id === g.segmentId) + 1
  return { sequence_id: sequence.id, sequence_name: sequence.name, segment_id: g.segmentId, clip_number: clip || undefined }
}

/** Evenly spread frames of a finished video (first, …, last) as pictures; ffmpeg does the extracting. */
async function videoFrames(g: Generation, count: number): Promise<LabeledImage[]> {
  if (!g.filePath) return []
  const length = g.videoDuration ?? (await probe(g.filePath)).duration
  const dir = await mkdtemp(join(tmpdir(), 'studio-agent-frames-'))
  try {
    const out: LabeledImage[] = []
    for (let i = 0; i < count; i++) {
      // The last one is the clip's very last frame: what a continuation clip would start from.
      const last = count > 1 && i === count - 1
      const at = count === 1 ? length / 2 : last ? undefined : Math.max(0, (length * i) / (count - 1))
      const file = await extractFrame(g.filePath, join(dir, `frame-${i}.png`), at)
      const image = await imageBlock(file)
      if (!image) continue
      const when = at === undefined ? 'last frame' : `frame at ${at.toFixed(1)} s`
      out.push({ label: `Generation ${g.id} – ${when} of ${length.toFixed(1)} s`, image })
    }
    return out
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function registerLibraryTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_studio_guide',
    {
      title: 'Studio guide',
      description:
        "How Studio works and how to write video prompts that work in it. Read this once at the start of a session, before you prepare anything: it explains assets (characters, environments, outfits), the three modes, how reference images become @Image1…@ImageN tokens in the prompt, sequences and continuation clips, the approval flow for paid generations, and a detailed prompt-writing guide for Seedance-class video models.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'läste guiden'
    },
    async () => ({ data: { guide: studioGuide(ctx.promptLanguage()) } })
  )

  defineTool(
    server,
    ctx,
    'list_assets',
    {
      title: 'List assets',
      description:
        "Lists the user's library assets: characters (who is in the shot), environments (where it takes place) and outfits (what a character wears). Each entry has its id, name, the user's description, how many photos it has and their image_ids (photo 1 first), and for characters the default outfit. Use the ids with get_asset (to see the photos), set_references, add_segment and update_segment.",
      input: {
        kind: assetKind.optional().describe('Only this kind: "character", "environment" or "outfit". All kinds when left out.'),
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
        'One asset with its description and its photos as images (JPEG, at most 768 px), so you can see faces, garments and places before choosing references. Each photo is labelled with its photo number and image_id; pass image_ids to set_references or add_segment to send only the best photos. For a character it also names the default outfit; for an outfit, the characters wearing it by default.',
      input: {
        asset_id: z.string().describe('The id from list_assets.'),
        include_images: z.boolean().default(true).describe('Return the photos as images. Default true.'),
        max_images: z.number().int().min(1).max(12).default(4).describe('How many photos to return, cover first. Default 4.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en tillgång'
    },
    async ({ asset_id, include_images, max_images }) => {
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
      const outfit = asset.defaultOutfitId ? index.get(asset.defaultOutfitId) : undefined
      const wornBy = asset.kind === 'outfit' ? index.assets.filter((a) => a.defaultOutfitId === asset.id) : []
      return {
        data: {
          ...assetSummary(asset, index),
          photos: asset.images.map((img, i) => ({ photo_number: i + 1, image_id: img.id, file: basename(img.path) })),
          ...(asset.kind === 'character' && outfit ? { default_outfit: { id: outfit.id, name: outfit.name } } : {}),
          ...(asset.kind === 'outfit' ? { default_outfit_of: wornBy.map((a) => ({ id: a.id, name: a.name })) } : {}),
          images_returned: images.length
        },
        images,
        summary: `tittade på ${KIND_DEFINITE[asset.kind]} ${q(asset.name)}`
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
        'Creates a new character, environment or outfit with a name and a description (looks, place, garments – whatever helps keep it consistent). Photos can only be added by the user in Studio (tell them what pictures would help). Returns the new asset.',
      input: {
        kind: assetKind.describe('"character", "environment" or "outfit".'),
        name: z.string().min(1).describe('Short name as the user would say it, e.g. "Anna" or "Strandpromenaden".'),
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
    'list_models',
    {
      title: 'List video models',
      description:
        "Venice's video models Studio can use, with their mode (kind), allowed durations, resolutions and aspect ratios, how many reference images they take, whether they make audio, and their prompt length limit. The default model (Seedance 2.5 reference-to-video) is marked default: true. Use these exact values with set_form, add_segment and update_segment.",
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
        "Saves a prompt to the user's prompt library so they can reuse it later. @ImageN tokens are stored as written (in canonical form); remember that they only make sense with the same reference images in the same order.",
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
        'The latest generations (newest first) with their status (queued, processing, completed, failed), prompt, settings, price and error. Use get_generation to look at one, including its poster frame.',
      input: {
        limit: z.number().int().min(1).max(50).default(10).describe('How many, newest first. Default 10.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listade genereringarna'
    },
    async ({ limit }) => {
      requireLibrary()
      const list = (await callService<Generation[]>('generations:list')).slice(0, limit)
      return {
        data: {
          generations: list.map((g) => ({
            id: g.id,
            created: localTime(g.createdAt),
            status: g.status,
            model: g.model,
            prompt: g.prompt,
            duration: g.params.duration,
            resolution: g.params.resolution,
            aspect_ratio: g.params.aspectRatio,
            reference_images: g.params.referenceImages?.length ?? 0,
            price_usd: priceValue(g.quote),
            error: g.error,
            ...(g.segmentId ? { take_of: takeOf(g) } : {})
          }))
        }
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
        "One generation: status, error, timing, price, its settings with the reference token map, which sequence clip it is a take of, and – when completed – its poster frame as an image so you can judge the result. Ask for `frames` to also get evenly spread frames from the video (the last one is the clip's final frame, where a continuation clip would start). Poll this after an approval to follow progress.",
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
        params: paramsInfo(g.params, index)
      }
      if (g.status === 'completed' && include_thumbnail && g.thumbPath) {
        const poster = await imageBlock(g.thumbPath)
        if (poster) images.push({ label: `Generation ${g.id} – poster frame`, image: poster })
      }
      if (g.status === 'completed' && frames > 0) {
        try {
          images.push(...(await videoFrames(g, frames)))
        } catch (err) {
          data.frames_error = errorText(err)
        }
      }
      return { data, images }
    }
  )
}
