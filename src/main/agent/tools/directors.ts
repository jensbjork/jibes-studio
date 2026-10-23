import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  composeDirection,
  DIRECTION_PART_LABELS,
  effectiveDirectorId,
  isDirectorPresetId,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  resolvedDirectorOf,
  sanitizeDirection,
  type ResolvedDirector
} from '@shared/direction'
import { DIRECTOR_PRESETS } from '@shared/directors'
import { DIRECTION_PARTS, type Asset, type Direction, type GenerationParams, type PromptLanguage } from '@shared/types'
import { allDirectors, libraryDirector } from '../../directors'
import { callService } from '../local-ipc'
import { AssetIndex, requireLibrary, seconds } from '../studio'
import { READ_ONLY, WRITE, defineTool, videoReferenceItem, type ToolContext } from './kit'
import { resolveVideoReference } from './sources'

// Directors: a way of making a film (editing, look, camera, light, framing, rhythm, performance, sound, avoid, style
// frames and videos, defaults) that directs a generation, a sequence or a storyboard. The library's own are assets of
// kind "director" (list_assets / get_asset / create_asset / update_asset, style frames with add_asset_images); the
// ready-made ones are read-only and copied into the library to be changed (copy_director_preset). Shared rules:
// shared/direction.ts.

const q = (text: string): string => `“${text}”`

/** A direction as the tools take it: every field optional; with update_asset null removes a field. */
export const directionInput = z
  .object({
    editing: z.string().nullable().optional().describe('Pace, shot length, cuts (hard, match, jump), long takes.'),
    look: z.string().nullable().optional().describe('Grade, contrast, grain, film stock, era, palette.'),
    camera: z.string().nullable().optional().describe('Movement (handheld, Steadicam, locked off, dolly), lenses, angles.'),
    light: z.string().nullable().optional().describe('High or low key, practicals, neon, daylight, hard or soft.'),
    framing: z.string().nullable().optional().describe('The shot sizes it favours and their order, symmetry, headroom.'),
    rhythm: z.string().nullable().optional().describe('Tempo, slow motion, speed ramps, stillness.'),
    performance: z.string().nullable().optional().describe('How the actors play: naturalistic and subtle, or stylised.'),
    sound: z
      .string()
      .nullable()
      .optional()
      .describe('Silence, ambience, score, diegetic sound. Sent only with a clip made with sound.'),
    avoid: z.string().nullable().optional().describe('What it never does ("shaky zooms, lens flares"): added to the negative prompt.'),
    shot_seconds: z
      .number()
      .min(MIN_SHOT_SECONDS)
      .max(MAX_SHOT_SECONDS)
      .nullable()
      .optional()
      .describe(
        'The average shot length (2–15 s): the length of new clips in a sequence it directs (the nearest the model offers) and of the clips a song is split into.'
      ),
    continuity: z
      .enum(['cut', 'flow'])
      .nullable()
      .optional()
      .describe(
        'Between a sequence\'s shots: "cut" (new clips start a new shot) or "flow" (new clips continue from the previous clip\'s last frame). null: the sequence\'s own default.'
      ),
    defaults: z
      .object({
        model: z.string().optional(),
        aspect_ratio: z.string().optional(),
        resolution: z.string().optional()
      })
      .strict()
      .nullable()
      .optional()
      .describe('What choosing the director sets in the Generate form, a sequence or a storyboard (each only when the model offers it).')
  })
  .strict()

export type DirectionInput = z.infer<typeof directionInput>

/** A direction with what an agent gave applied: given fields replace, null removes; the style videos stay. */
export function mergedDirection(current: Direction | undefined, input: DirectionInput): Direction {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  const set = (key: string, value: unknown): void => {
    if (value === undefined) return
    if (value === null) delete out[key]
    else out[key] = value
  }
  for (const part of [...DIRECTION_PARTS, 'avoid'] as const) set(part, input[part])
  set('shotSeconds', input.shot_seconds)
  set('continuity', input.continuity)
  if (input.defaults !== undefined) {
    set(
      'defaults',
      input.defaults === null
        ? null
        : {
            ...(input.defaults.model ? { model: input.defaults.model } : {}),
            ...(input.defaults.aspect_ratio ? { aspectRatio: input.defaults.aspect_ratio } : {}),
            ...(input.defaults.resolution ? { resolution: input.defaults.resolution } : {})
          }
    )
  }
  return sanitizeDirection(out)
}

/** A direction as the tools show it. */
export function directionInfo(direction: Direction | undefined): Record<string, unknown> {
  const d = direction ?? {}
  const parts: Record<string, string> = {}
  for (const part of [...DIRECTION_PARTS, 'avoid'] as const) if (d[part]) parts[part] = d[part]!
  return {
    ...parts,
    ...(d.shotSeconds !== undefined ? { shot_seconds: d.shotSeconds } : {}),
    ...(d.continuity ? { continuity: d.continuity } : {}),
    ...(d.defaults
      ? {
          defaults: {
            ...(d.defaults.model ? { model: d.defaults.model } : {}),
            ...(d.defaults.aspectRatio ? { aspect_ratio: d.defaults.aspectRatio } : {}),
            ...(d.defaults.resolution ? { resolution: d.defaults.resolution } : {})
          }
        }
      : {})
  }
}

/** The Direction section a director adds to a prompt, without a limit or references: for list_directors. */
function sectionPreview(director: ResolvedDirector, language: PromptLanguage): string {
  const params: GenerationParams = { model: '', prompt: '…', duration: '8s', audio: true }
  return composeDirection(params, director, { language }).section.replace(/^\n+/, '')
}

/** A director as list_directors and get_asset show it. */
export function directorInfo(director: ResolvedDirector, language?: PromptLanguage): Record<string, unknown> {
  return {
    director_id: director.id,
    name: director.name,
    ready_made: director.preset,
    direction: directionInfo(director.direction),
    style_frame_count: director.styleFrames.length,
    style_videos: director.styleVideos.map((v, i) => ({
      number: i + 1,
      file: basename(v.path),
      start: seconds(v.start ?? 0),
      length: seconds(v.length ?? 0)
    })),
    ...(language ? { section_preview: sectionPreview(director, language) } : {})
  }
}

/** A director's name and id, as clips, sequences and the form name it. */
export function directorRef(id: string | null | undefined): { director_id: string; director_name: string } | null {
  const director = libraryDirector(id)
  return director ? { director_id: director.id, director_name: director.name } : null
}

/**
 * Who directs a clip, as get_sequence shows it: its own director, the sequence's (or storyboard's) it follows, or
 * none – with `director_choice` saying which ("own", "sequence", "none").
 */
export function clipDirectorInfo(own: string | null | undefined, owner: string | undefined): Record<string, unknown> {
  const effective = effectiveDirectorId(own, owner)
  const choice = own === null ? 'none' : typeof own === 'string' && own ? 'own' : 'sequence'
  return { director_choice: choice, director: directorRef(effective) }
}

/**
 * A clip's director as the tools take it: a director's id, null for none (even where the sequence has one), or
 * "sequence" to follow the sequence's (or storyboard's) – the default for a new clip.
 */
export const clipDirectorInput = z
  .string()
  .nullable()
  .optional()
  .describe(
    'Who directs the clip: a director_id (list_directors), null for no director even where the sequence has one, or "sequence" to follow the sequence\'s director (the default).'
  )

/** The params with a clip's director choice applied (see clipDirectorInput); refused for a director that doesn't exist. */
export function withClipDirector(params: GenerationParams, value: string | null | undefined): GenerationParams {
  if (value === undefined) return params
  const { director: _, ...rest } = params
  if (value === 'sequence') return rest
  if (value === null) return { ...rest, director: null }
  if (!libraryDirector(value)) throw new Error(unknownDirector(value))
  return { ...rest, director: value }
}

/** Why a director id names nothing. */
export function unknownDirector(id: string): string {
  return isDirectorPresetId(id)
    ? `There is no ready-made director ${id}. The ready-made ones are ${DIRECTOR_PRESETS.map((p) => p.id).join(', ')}.`
    : `There is no director with id ${id}. list_directors shows the library's own and the ready-made ones.`
}

/** A director id an agent gave for a sequence, a storyboard or the form: null for none, else one that exists. */
export function directorInput(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  if (!libraryDirector(value)) throw new Error(unknownDirector(value))
  return value
}

export function registerDirectorTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'list_directors',
    {
      title: 'List directors',
      description:
        "Every director there is: the user's own (assets of kind \"director\" – get_asset shows their style frames, update_asset changes them) and Studio's ready-made ones (ready_made: true, read-only: copy_director_preset makes a copy to change). A director is a way of making a film – editing, look, camera, light, framing, rhythm, performance, sound, what it avoids, style frames (pictures whose look to match) and style videos (camera movement to follow), and defaults (model, aspect ratio, resolution). When it directs a generation (set_form / add_segment / update_segment director, or a whole sequence or storyboard with update_sequence / update_storyboard), Studio appends its Direction section after the References legend (section_preview: as it reads in the user's prompt language), adds its avoid to the negative prompt and sends its style frames and videos with models that take them. Don't repeat any of it in the prompt.",
      input: {
        query: z.string().optional().describe('Only directors whose name contains this text.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listed the directors'
    },
    async ({ query }) => {
      const needle = query?.trim().toLocaleLowerCase('en')
      const directors = allDirectors().filter((d) => !needle || d.name.toLocaleLowerCase('en').includes(needle))
      return {
        data: {
          count: directors.length,
          directors: directors.map((d) => ({
            ...directorInfo(d, ctx.promptLanguage()),
            ...(d.preset ? { description: DIRECTOR_PRESETS.find((p) => p.id === d.id)?.description } : {})
          })),
          parts: DIRECTION_PARTS.map((p) => ({ part: p, label: DIRECTION_PART_LABELS[p] }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'copy_director_preset',
    {
      title: 'Copy a ready-made director',
      description:
        "Copies one of Studio's ready-made directors (list_directors, ready_made: true – e.g. \"preset:noir\") into the library as a director of the user's own, named \"<name> (copy)\" (\"Noir (copy)\", or \"Noir (copy) 2\" when taken), so it can be changed: update_asset({direction}), style frames with add_asset_images, style videos with add_director_videos. Returns the new director (its asset id is its director_id).",
      input: {
        preset_id: z.string().describe('A ready-made director\'s id ("preset:…").')
      },
      annotations: WRITE,
      summary: ({ preset_id }) => `copied the ready-made director ${preset_id}`
    },
    async ({ preset_id }) => {
      requireLibrary()
      if (!DIRECTOR_PRESETS.some((p) => p.id === preset_id)) throw new Error(unknownDirector(preset_id))
      const asset = await callService<Asset>('directors:copyPreset', preset_id)
      return {
        data: { asset_id: asset.id, ...directorInfo(resolvedDirectorOf(asset), ctx.promptLanguage()) },
        summary: `copied the ready-made director ${q(asset.name)} into the library`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_director_videos',
    {
      title: 'Add style videos to a director',
      description:
        "Adds style videos to one of the user's directors: films whose camera movement (only that – never their people or places) the director's generations follow, sent as reference videos to Seedance 2.x reference-to-video after the clip's own (as many as the model family still takes). videos (1–4): {video: {generation_id} | {export_id} | {upload_id} (a ready video upload, begin_upload kind \"video\"), start?, length?} – the window of the film that is sent (default the first 5 s; Studio keeps it 2–15 s). Copied into the director's folder (Directors/<name>/). Only the user removes a style video (in the director's editor in Studio). Returns the director.",
      input: {
        director_id: z.string().describe("One of the library's directors (an asset of kind \"director\")."),
        videos: z.array(videoReferenceItem).min(1).max(4)
      },
      annotations: WRITE,
      summary: ({ videos }) => `added ${videos.length === 1 ? 'a style video' : `${videos.length} style videos`}`
    },
    async ({ director_id, videos }) => {
      const index = await AssetIndex.load()
      const asset = index.require(director_id)
      if (asset.kind !== 'director') throw new Error(`${q(asset.name)} is not a director. list_directors shows them.`)
      // Each film resolved and measured first (an upload stays where it is staged: the director's folder gets the copy).
      const resolved = []
      for (const item of videos) resolved.push(await resolveVideoReference(ctx, item, false))
      const current = asset.direction ?? {}
      const updated = await callService<Asset>('assets:save', {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        description: asset.description,
        direction: { ...current, videos: [...(current.videos ?? []), ...resolved] }
      })
      return {
        data: { asset_id: updated.id, ...directorInfo(resolvedDirectorOf(updated), ctx.promptLanguage()) },
        summary: `added style videos to ${q(updated.name)}`
      }
    }
  )
}
