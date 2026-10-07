import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  ImageModel,
  SegmentFramePreview,
  SegmentImageSlot,
  Sequence,
  SequenceSummary,
  Still,
  StillParams,
  Storyboard,
  StoryboardSummary
} from '@shared/types'
import * as db from '../../db'
import { DEFAULT_EDIT_MODEL, DEFAULT_IMAGE_MODEL } from '../../images'
import { frameStartAtOrAfter } from '../../ffmpeg'
import { getImageSafeMode } from '../../settings'
import * as store from '../../sequence-store'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import { isStoryboardId } from '../storyboard-rows'
import { AssetIndex, StillIndex, errorText, imageRef, localTime, q, requireLibrary, seconds } from '../studio'
import {
  READ_ONLY,
  WRITE,
  defineTool,
  priceValue,
  quote,
  usd,
  type LabeledImage,
  type ToolContext
} from './kit'
import { assertNotRunning, asSent, clipInfo, continues, loadClip, loadSequence } from './sequences'
import { loadStoryboard } from './storyboards'

// Stills – the pictures of a sequence (its clips' keyframes) or of a storyboard (its boards): generated with an
// image model, added by the user, or frames saved from clips – and the image models that make them; a sequence
// clip's automatic start and end frames, and setting a clip up to be redone between its neighbours. Everything
// here is free; making a picture is request_image_generation (paid.ts), which asks the user.

// ── Stills ───────────────────────────────────────────────────────────────────

const pathKey = (path: string): string => path.normalize('NFC')

/** Where a still is used: a sequence clip's start or end image, or a storyboard board's picture. */
export type StillUse =
  | { sequence_id: string; sequence_name: string; segment_id: string; clip_number: number; slot: SegmentImageSlot }
  | { storyboard_id: string; storyboard_name: string; board_id: string; board_number: number }

/** The sequences and storyboards stills belong to and are used by. */
export interface StillOwners {
  sequences: { id: string; name: string }[]
  storyboards: Storyboard[]
  /** Name and kind of every sequence and storyboard, by id. */
  byId: Map<string, { name: string; storyboard: boolean }>
}

/** Every sequence and storyboard (a storyboard with its boards, for where its pictures are used). */
export async function loadStillOwners(): Promise<StillOwners> {
  const [sequenceList, storyboardList] = await Promise.all([
    callService<SequenceSummary[]>('sequences:list'),
    // Where stills are used is extra information: a listing doesn't fail for want of it.
    callService<StoryboardSummary[]>('storyboards:list').catch(() => [] as StoryboardSummary[])
  ])
  const sequences = sequenceList.filter((s) => !isStoryboardId(s.id)).map((s) => ({ id: s.id, name: s.name }))
  // One at a time: few storyboards, and each read is a small database query.
  const storyboards: Storyboard[] = []
  for (const summary of storyboardList) {
    const storyboard = await callService<Storyboard>('storyboards:get', summary.id).catch(() => undefined)
    if (storyboard) storyboards.push(storyboard)
  }
  const byId = new Map<string, { name: string; storyboard: boolean }>()
  for (const s of sequences) byId.set(s.id, { name: s.name, storyboard: false })
  for (const s of storyboards) byId.set(s.id, { name: s.name, storyboard: true })
  return { sequences, storyboards, byId }
}

/**
 * Where every picture is used, by file path: each sequence clip's explicit start and end image (the automatic
 * frames from neighbours aren't files yet) and each storyboard board's picture.
 */
export function imageUses(owners: Pick<StillOwners, 'sequences' | 'storyboards'>): Map<string, StillUse[]> {
  const uses = new Map<string, StillUse[]>()
  const add = (path: string | undefined, use: StillUse): void => {
    if (!path) return
    const key = pathKey(path)
    uses.set(key, [...(uses.get(key) ?? []), use])
  }
  for (const sequence of owners.sequences) {
    store.listSegmentRows(sequence.id).forEach((row, i) => {
      const params = store.parseParams(row.params)
      const base = { sequence_id: sequence.id, sequence_name: sequence.name, segment_id: row.id, clip_number: i + 1 }
      add(params.startImage, { ...base, slot: 'start' })
      add(params.endImage, { ...base, slot: 'end' })
    })
  }
  for (const storyboard of owners.storyboards) {
    storyboard.boards.forEach((board, i) =>
      add(board.imagePath, {
        storyboard_id: storyboard.id,
        storyboard_name: storyboard.name,
        board_id: board.id,
        board_number: i + 1
      })
    )
  }
  return uses
}

/** The still's owner as the tools name it: its sequence or its storyboard, or none (Referensbilder). */
function ownerInfo(sequenceId: string | undefined, owners: StillOwners): Record<string, unknown> {
  if (!sequenceId) return { sequence_id: null }
  const owner = owners.byId.get(sequenceId)
  if (owner?.storyboard) return { storyboard_id: sequenceId, storyboard_name: owner.name }
  return { sequence_id: sequenceId, ...(owner ? { sequence_name: owner.name } : {}) }
}

const SOURCE_LABEL: Record<Still['source'], string> = {
  generated: 'generated with an image model',
  upload: 'a picture the user added',
  frame: 'a frame saved from a clip'
}

/** A still as the tools show it. */
export function stillInfo(
  still: Still,
  assets: AssetIndex,
  stills: StillIndex,
  owners: StillOwners,
  uses?: ReadonlyMap<string, StillUse[]>
): Record<string, unknown> {
  const p = still.params ?? {}
  const references = (p.referenceImages ?? []).map((path, i) => {
    const ref = imageRef(path, assets, stills)
    // A still's references are the inputs it was made from, not a clip's slot.
    delete ref.kind
    return { image: i + 1, ...ref }
  })
  const usedBy = uses?.get(pathKey(still.path)) ?? []
  return {
    still_id: still.id,
    source: still.source,
    source_text: SOURCE_LABEL[still.source],
    file: basename(still.path),
    ...ownerInfo(still.sequenceId, owners),
    created: localTime(still.createdAt),
    ...(still.prompt ? { prompt: still.prompt } : {}),
    ...(p.negativePrompt ? { negative_prompt: p.negativePrompt } : {}),
    ...(still.model ? { model: still.model } : {}),
    ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}),
    ...(p.resolution ? { resolution: p.resolution } : {}),
    ...(p.quality ? { quality: p.quality } : {}),
    ...(references.length ? { references } : {}),
    ...(still.costUsd !== undefined ? { cost_usd: priceValue(still.costUsd) } : {}),
    ...(uses ? { used_by: usedBy } : {})
  }
}

// ── Automatic frames ─────────────────────────────────────────────────────────

/** A clip's start and end frames as the tools show them, with their pictures. */
export async function framePreview(
  segmentId: string,
  clipNumber: number,
  assets: AssetIndex,
  stills: StillIndex
): Promise<{ data: Record<string, unknown>; images: LabeledImage[] }> {
  const preview = await callService<SegmentFramePreview>('segments:previewFrames', segmentId)
  const images: LabeledImage[] = []
  const side = async (
    slot: SegmentImageSlot,
    frame: SegmentFramePreview['start'] | SegmentFramePreview['end']
  ): Promise<Record<string, unknown> | null> => {
    if (!frame) return null
    const automatic = frame.source === 'previous' || frame.source === 'next'
    const from = frame.fromClip
    const what =
      frame.source === 'previous'
        ? `the last frame of clip ${from ?? clipNumber - 1}`
        : frame.source === 'next'
          ? `the first frame of clip ${from ?? clipNumber + 1}`
          : 'a chosen picture'
    const at = frame.time !== undefined ? ` (t = ${seconds(frame.time).toFixed(1)} s in that take)` : ''
    const image = await imageBlock(frame.path)
    if (image) images.push({ label: `Clip ${clipNumber} – ${slot} image: ${what}${at}`, image })
    return {
      ...(automatic
        ? { kind: frame.source, from_clip: from, ...(frame.time !== undefined ? { time: seconds(frame.time) } : {}) }
        : imageRef(frame.path, assets, stills)),
      ...(image ? {} : { note: 'The picture could not be read.' })
    }
  }
  return {
    data: {
      start: await side('start', preview.start),
      end: await side('end', preview.end),
      problems: preview.problems
    },
    images
  }
}

// ── Image models ─────────────────────────────────────────────────────────────

/** Venice's image models; the text-to-image ones first, then those that combine references. */
export async function loadImageModels(): Promise<ImageModel[]> {
  try {
    return await callService<ImageModel[]>('images:models')
  } catch (err) {
    throw new Error(`Kunde inte hämta bildmodellerna från Venice: ${errorText(err)}`)
  }
}

/**
 * The model a picture is made with when none is named, as the stills service picks it: Seedream (the family
 * Seedance belongs to) for its kind, else the first online one.
 */
export function defaultImageModel(models: readonly ImageModel[], withReferences: boolean): ImageModel | undefined {
  const usable = models.filter((m) => !m.offline && m.edit === withReferences)
  const preferred = withReferences ? DEFAULT_EDIT_MODEL : DEFAULT_IMAGE_MODEL
  return usable.find((m) => m.id === preferred) ?? usable[0]
}

export function registerStillTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'list_image_models',
    {
      title: 'List image models',
      description:
        "Venice's image models that request_image_generation can use, with the price of one picture at the default settings, and whether the user's \"Säkert läge för bilder\" (safe_mode: Venice blurs adult content) is on. takes_references: false are text-to-image models (prompt only; negative_prompt allowed); true are models that combine up to max_input_images reference pictures (characters, outfits, places, poses, stills) into a new picture. The defaults are marked: Seedream (seedream-v5-pro, and seedream-v5-pro-edit with references), the same family as the Seedance video models.",
      input: {
        takes_references: z
          .boolean()
          .optional()
          .describe('Only the models that take references (true) or only the text-to-image ones (false).')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listade bildmodellerna'
    },
    async ({ takes_references }) => {
      const models = (await loadImageModels()).filter(
        (m) => !m.offline && (takes_references === undefined || m.edit === takes_references)
      )
      const text = defaultImageModel(models, false)
      const edit = defaultImageModel(models, true)
      const prices = await Promise.all(
        models.map((m) =>
          imageQuote({
            model: m.id,
            prompt: 'price check',
            // An edit model is priced with one reference, the base picture (quoting reads no files).
            ...(m.edit ? { referenceImages: ['/price-check.png'] } : {})
          })
        )
      )
      const safeMode = getImageSafeMode()
      return {
        data: {
          default_text_to_image: text?.id ?? null,
          default_with_references: edit?.id ?? null,
          // Read-only for agents: only the user switches it, in Inställningar → Bilder.
          safe_mode: safeMode,
          safe_mode_note: safeMode
            ? '"Säkert läge för bilder" is on: Venice blurs adult content in the pictures it makes. Only the user can switch it off (Inställningar → Bilder).'
            : '"Säkert läge för bilder" is off: Venice does not blur adult content.',
          models: models.map((m, i) => ({
            id: m.id,
            name: m.name,
            takes_references: m.edit,
            ...(m.edit ? { max_input_images: m.maxInputImages } : {}),
            aspect_ratios: m.aspectRatios,
            resolutions: m.resolutions,
            ...(m.qualities.length ? { qualities: m.qualities } : {}),
            default: m.id === text?.id || m.id === edit?.id,
            price_usd: priceValue(prices[i])
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'list_stills',
    {
      title: 'List stills',
      description:
        "The stills of a sequence or a storyboard (or all of them, without an id), newest first: pictures generated with request_image_generation, pictures the user added and frames saved from clips. Each has its still_id, source, prompt and model (generated ones), the references it was made from, the sequence or storyboard it belongs to, and used_by – the sequence clips that use it as their start or end image and the storyboard boards that show it. With include_thumbnails (default true) the newest ones come as small images. Use a still as a board's picture (update_board({image: {still_id}})), as a clip's start or end image (update_segment({start_image: {still_id}})), or as a reference of a new picture (reference_still_ids).",
      input: {
        sequence_id: z.string().optional().describe('Only the stills of this sequence.'),
        storyboard_id: z.string().optional().describe('Only the stills of this storyboard.'),
        include_thumbnails: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(30)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listade stillbilderna'
    },
    async ({ sequence_id, storyboard_id, include_thumbnails, limit }) => {
      requireLibrary()
      if (sequence_id && storyboard_id) throw new Error('Ange sequence_id eller storyboard_id, inte båda.')
      // A storyboard's id given as sequence_id is taken as meant: its stills are what was asked for.
      const ownerId = storyboard_id ?? sequence_id
      const owner = !ownerId
        ? undefined
        : storyboard_id || isStoryboardId(ownerId)
          ? await loadStoryboard(ownerId)
          : await loadSequence(ownerId)
      const [all, assets, owners] = await Promise.all([StillIndex.load(), AssetIndex.load(), loadStillOwners()])
      const uses = imageUses(owners)
      const list = all.stills
        .filter((s) => !owner || s.sequenceId === owner.id)
        .sort((a, b) => b.createdAt - a.createdAt)
      const shown = list.slice(0, limit)
      const images: LabeledImage[] = []
      if (include_thumbnails) {
        for (const still of shown.slice(0, THUMBNAILS)) {
          const image = await imageBlock(still.path, THUMB_SIDE)
          if (image) images.push({ label: `Still ${still.id} (${still.source})`, image })
        }
      }
      const storyboard = !!owner && isStoryboardId(owner.id)
      return {
        data: {
          ...(owner
            ? storyboard
              ? { storyboard_id: owner.id, storyboard_name: owner.name }
              : { sequence_id: owner.id, sequence_name: owner.name }
            : {}),
          count: list.length,
          stills: shown.map((s) => stillInfo(s, assets, all, owners, uses)),
          ...(include_thumbnails && shown.length > THUMBNAILS
            ? { note: `Thumbnails of the ${THUMBNAILS} newest; get_still shows any of them.` }
            : {})
        },
        images,
        summary: owner ? `listade stillbilderna i ${q(owner.name)}` : 'listade stillbilderna'
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_still',
    {
      title: 'Get still',
      description:
        'One still as an image (JPEG, at most 768 px), with its prompt, model, settings, the references it was made from, the sequence or storyboard it belongs to, and where it is used (sequence clips, storyboard boards). With include_references the reference pictures it was made from come too, in order (the first is the base picture). Free; changes nothing.',
      input: {
        still_id: z.string(),
        include_references: z.boolean().default(false)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en stillbild'
    },
    async ({ still_id, include_references }) => {
      const [stills, assets, owners] = await Promise.all([StillIndex.load(), AssetIndex.load(), loadStillOwners()])
      const still = stills.require(still_id)
      const images: LabeledImage[] = []
      const image = await imageBlock(still.path)
      if (image) images.push({ label: `Still ${still.id}`, image })
      if (include_references) {
        for (const [i, path] of (still.params?.referenceImages ?? []).entries()) {
          const ref = await imageBlock(path)
          if (ref) images.push({ label: `Reference image ${i + 1}${i === 0 ? ' (the base picture)' : ''}`, image: ref })
        }
      }
      return {
        data: {
          ...stillInfo(still, assets, stills, owners, imageUses(owners)),
          ...(image ? {} : { note: 'The picture could not be read (moved or deleted in Finder?).' })
        },
        images
      }
    }
  )

  defineTool(
    server,
    ctx,
    'save_frame_as_still',
    {
      title: 'Save a frame as a still',
      description:
        "Saves one frame of a finished clip (a generation) as a still of a sequence or a storyboard, e.g. to use it as a board's picture, a clip's start or end image or a reference of a new picture. time is seconds into the clip: the frame saved is the first one at or after it, the frame review_generation and get_frames show for that time, so a time from their frame_times / times (or a caption) saves exactly the frame you looked at; past the end gives the last frame. Without sequence_id or storyboard_id the still goes to the clip's own sequence or storyboard. Free. Returns the still and its picture.",
      input: {
        generation_id: z.string(),
        time: z.number().min(0).describe('Seconds into the clip.'),
        sequence_id: z.string().optional().describe("The sequence that gets the still; default the clip's own."),
        storyboard_id: z.string().optional().describe('The storyboard that gets the still instead.')
      },
      annotations: WRITE,
      summary: () => 'sparade en bildruta som stillbild'
    },
    async ({ generation_id, time, sequence_id, storyboard_id }) => {
      requireLibrary()
      if (sequence_id && storyboard_id) throw new Error('Ange sequence_id eller storyboard_id, inte båda.')
      const g = db.getGeneration(generation_id)
      if (!g) throw new Error(`Det finns ingen generering med id ${generation_id}.`)
      if (g.status !== 'completed') throw new Error('Genereringen är inte färdig, så den har inga bildrutor än.')
      const own = g.segmentId ? store.sequenceOfSegment(g.segmentId)?.id : undefined
      const asked = storyboard_id ?? sequence_id
      const target = asked ?? own
      if (storyboard_id || (sequence_id && isStoryboardId(sequence_id))) await loadStoryboard(asked!)
      else if (sequence_id) await loadSequence(sequence_id)
      // Agents see frames by input seeking (the first frame at or after a time); stills' saveFrame takes the frame
      // a paused player shows (the last one starting at or before it). Asked for the moment that frame starts, it
      // saves the frame the agent looked at.
      const at = g.filePath ? await frameStartAtOrAfter(g.filePath, time) : time
      const still = await callService<Still>('stills:saveFrame', generation_id, at, target)
      const [stills, assets, owners] = await Promise.all([StillIndex.load(), AssetIndex.load(), loadStillOwners()])
      const image = await imageBlock(still.path)
      const ownerName = target ? owners.byId.get(target)?.name : undefined
      return {
        data: stillInfo(still, assets, stills, owners),
        images: image ? [{ label: `Still ${still.id} – frame at t = ${seconds(time).toFixed(1)} s`, image }] : [],
        summary: `sparade en bildruta som stillbild${ownerName ? ` i ${q(ownerName)}` : ''}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'preview_segment_frames',
    {
      title: "Preview a clip's start and end frames",
      description:
        "The start and end images a clip would be generated with, as pictures: its chosen start/end image, or the automatic frames – the previous clip's last frame (continue_from_previous, at that clip's end trim) and the next clip's first frame (end_from_next, at that clip's start trim) – taken from the neighbours' selected takes as they are now. problems says what still stops them (e.g. a neighbour without a finished take). Free; changes nothing.",
      input: { segment_id: z.string() },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på start- och slutbilden för ett klipp'
    },
    async ({ segment_id }) => {
      const { sequence, index } = await loadClip(segment_id)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const preview = await framePreview(segment_id, index + 1, assets, stills)
      return {
        data: { segment_id, clip_number: index + 1, ...preview.data },
        images: preview.images,
        summary: `tittade på start- och slutbilden för klipp ${index + 1} i ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'bridge_segment',
    {
      title: 'Set a clip up to be redone between its neighbours',
      description:
        "Free. Prepares a new take of a clip that starts exactly where the previous clip ends and ends exactly where the next clip begins (\"Gör om mellan grannarna\"), so the neighbours stay untouched: turns on continue_from_previous and end_from_next (only the one that exists for the first or last clip), switches to the family's image-to-video model that takes an end image (keeping duration, prompt and audio) and drops the clip's references, which image-to-video can't take. Returns the clip, both frames as images, any problems and the price. Then rewrite the prompt for what happens between the frames (update_segment) and ask for request_segment_generation. The clip's existing takes are kept.",
      input: { segment_id: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ställde in ett klipp att göras om mellan grannarna'
    },
    async ({ segment_id }) => {
      const { sequence, segment } = await loadClip(segment_id)
      assertNotRunning(sequence)
      const hadReferences = !!segment.params.referenceImages?.length || !!segment.params.referenceAudios?.length
      const updated = await callService<Sequence>('segments:bridge', segment_id)
      const at = updated.segments.findIndex((s) => s.id === segment_id)
      if (at < 0) throw new Error('Klippet finns inte längre.')
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const bridged = updated.segments[at]
      const preview = await framePreview(segment_id, at + 1, assets, stills)
      const price = await quote(asSent(updated, at))
      const notes: string[] = []
      if (hadReferences && !bridged.params.referenceImages?.length) {
        notes.push(
          'Klippets referenser (bilder och röster) togs bort: bild-till-video tar inga referenser – utseendet kommer från start- och slutbilden.'
        )
      }
      if (bridged.params.prompt !== segment.params.prompt) {
        notes.push(
          'Prompten skickar inga referenser längre, så @-referenserna togs bort ur den. Skriv om den: beskriv i ord vad som händer mellan start- och slutbilden.'
        )
      }
      if (at === 0 && !continues(updated, at)) {
        notes.push(
          bridged.params.startImage
            ? 'Det första klippet har inget föregående klipp: det börjar på sin egen startbild (den första bildrutan i tagningen som var vald).'
            : 'Det första klippet har inget föregående klipp och ingen startbild än: välj en med update_segment({start_image}).'
        )
      }
      return {
        data: {
          ...clipInfo(updated, at, assets, stills),
          frames: preview.data,
          price_usd: priceValue(price),
          ...(notes.length ? { notes } : {}),
          next:
            'Look at the two frames, rewrite the prompt for what happens between them (update_segment), then request_segment_generation.'
        },
        images: preview.images,
        summary: `ställde in klipp ${at + 1} i ${q(updated.name)} att göras om mellan grannarna (${usd(price)})`
      }
    }
  )
}

/** How many thumbnails list_stills sends, and how big. */
const THUMBNAILS = 12
const THUMB_SIDE = 384

const QUOTE_TIMEOUT_MS = 8000

/** The price of one picture (free to ask); undefined when it can't be had in time. */
export async function imageQuote(params: StillParams): Promise<number | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUOTE_TIMEOUT_MS)
  })
  try {
    const price = await Promise.race([
      callService<number | undefined>('images:quote', params).catch(() => undefined),
      timeout
    ])
    return typeof price === 'number' && Number.isFinite(price) ? price : undefined
  } finally {
    clearTimeout(timer)
  }
}
