import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { kindOfModelId, referenceVideosOf } from '@shared/models'
import { generationTitle } from '@shared/generation-label'
import { ratingLabel } from '@shared/rating'
import { endsOnFirstFrameOf, startsOnLastFrameOf } from '@shared/seams'
import {
  THUMBS_DOWN,
  type ExportSummary,
  type Generation,
  type GenerationReview,
  type Learning,
  type LearningInput,
  type Segment,
  type Sequence,
  type Storyboard
} from '@shared/types'
import * as db from '../../db'
import { FILE_MANAGER } from '../../platform'
import { agentAuthor } from '../../reviews'
import * as store from '../../sequence-store'
import { extractFrames } from '../../ffmpeg'
import { imageBlock, jpegBlock } from '../images'
import { callService } from '../local-ipc'
import {
  FRAME_WIDTH,
  MAX_FRAME_WIDTH,
  MAX_SOUNDTRACK_SECONDS,
  clampTime,
  framesAt,
  lastFrameTime,
  referenceAudioBlock,
  requireVideoFile,
  soundtrack,
  spreadTimes,
  videoLength
} from '../media'
import {
  AssetIndex,
  audioTokenMap,
  audioWindow,
  describePicture,
  errorText,
  localTime,
  paramsInfo,
  q,
  referenceSummary,
  requireLibrary,
  seconds,
  tokenMap,
  videoTokenMap
} from '../studio'
import { READ_ONLY, WRITE, defineTool, priceValue, type LabeledAudio, type LabeledImage, type ToolContext } from './kit'
import { isStoryboardId } from '../storyboard-rows'
import { learningInfo, minStarsInput, ratingInput, recipeInfo, reviewInfo, sourceFields, takeOf } from './library'
import { continues, endsOnNext, isUsableTake, loadSequence, ownTake, selectedTake } from './sequences'
import { boardNumbers, selectedTakeOf } from './storyboards'

// Looking back at results to write better prompts: agents look at finished clips, sequences and exported films
// (frames, the references they were made from, their sound), record honest reviews, and distil what generalises
// into learnings that every later session reads first (get_studio_guide, list_learnings). Nothing here spends
// money; reviews and learnings are the user's data, so agents only change what they wrote themselves, and removing
// one – their own or another agent's – is a request_delete the user approves (delete.ts).

/** Tags agents (and the user) review with; free text is allowed too. */
export const REVIEW_TAGS = [
  'prompt-followed',
  'prompt-ignored',
  'identity-drift',
  'wrong-outfit',
  'wrong-pose',
  'bad-motion',
  'good-motion',
  'camera-good',
  'camera-wrong',
  'artifacts',
  'voice-match',
  'voice-mismatch',
  'continuity-good',
  'continuity-break',
  'lighting-good',
  'lighting-wrong'
] as const

/** What to look for, returned with every review_* answer so the agent's review covers what matters. */
const CLIP_CHECKLIST = [
  'Action: does what the prompt describes happen, in that order, within the clip? (prompt-followed / prompt-ignored)',
  "Identity: does each character look like their reference photos – face, hair, age, build? (identity-drift)",
  'Outfit, pose and place: compare with the outfit, pose and environment references. (wrong-outfit / wrong-pose)',
  'Camera and light: shot size, angle and movement, light and mood as asked? (camera-good / camera-wrong, lighting-good / lighting-wrong)',
  'Motion and quality: natural movement, no warped hands or faces, no flicker or melting. (good-motion / bad-motion / artifacts)',
  "Sound (include_audio): does the voice match @AudioN's timbre and pacing, are spoken lines right? (voice-match / voice-mismatch)",
  'Then add_review with an honest grade (-1 = thumbs down, or 1–3 stars) and tags, and save_learning for anything that would help the next prompt.'
]

/** Added to CLIP_CHECKLIST for a take of a storyboard transition. */
const TRANSITION_CHECK =
  "Transition: does the clip start exactly on the first board's picture and end exactly on the second (compare the first and last frames with the start and end images)? Is the way between them one natural, continuous shot? (prompt-followed / bad-motion / continuity-break)"

const CONTINUITY_CHECKLIST = [
  'At every cut: do the same people look the same (face, hair, outfit) on both sides? (continuity-good / continuity-break)',
  "A clip that continues from the previous one must start exactly where it ended (and one made to end on the next clip's first frame must end exactly there): same position, place, light – compare the last frame before the cut with the first after it.",
  'Is the order of events readable, without jumps in time of day, weather or location that the story did not ask for?',
  'Review the takes behind a weak clip with review_generation and add_review; save_learning for patterns (e.g. what keeps an outfit stable across clips).'
]

/** Frames at most per answer: plenty to judge a film, few enough for the agent's context. */
const MAX_FILM_FRAMES = 24
const MAX_SEQUENCE_FRAMES = 30

/** Continuity in a storyboard's film: neighbouring transitions share a board's picture at every cut. */
const STORYBOARD_CONTINUITY_CHECKLIST = [
  "At every cut the film passes through a board's picture: the last frame of the transition before it and the first frame of the transition after it should both be that picture. Compare them – a jump means one of the takes didn't reach (or didn't start on) the picture.",
  'Do the same people look the same (face, hair, outfit) all through the film? (continuity-good / continuity-break)',
  'Does each transition move naturally from one milestone to the next, without a visible jump in the middle? (good-motion / bad-motion)',
  'Review the takes behind a weak transition with review_generation and add_review; rewrite its prompt (update_transition) and ask for a new take; save_learning for patterns.'
]
/** How close a cut's frames are taken to the cut. */
const BEFORE_CUT = 0.08
const AFTER_CUT = 0.04

const tagList = z
  .array(z.string().min(1).max(40))
  .max(12)
  .describe(`Short kebab-case tags. Suggested: ${REVIEW_TAGS.join(', ')}. Others are allowed.`)

/** Trimmed, lower-cased, without empties or repeats. */
function cleanTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of tags ?? []) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-')
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** The name the agent's reviews and learnings are recorded under (never the user's own 'user'). */
function authorName(ctx: ToolContext): string {
  return agentAuthor(ctx.clientName())
}

const sameName = (a: string, b: string): boolean =>
  a.normalize('NFC').toLocaleLowerCase('sv') === b.normalize('NFC').toLocaleLowerCase('sv')

/** A generation the tools review: it must exist. */
function requireGeneration(id: string): Generation {
  requireLibrary()
  const g = db.getGeneration(id)
  if (!g) throw new Error(`The generation ${id} doesn't exist (any more). Use list_generations to see the ones there are.`)
  return g
}

async function listExports(): Promise<ExportSummary[]> {
  requireLibrary()
  return callService<ExportSummary[]>('exports:list')
}

async function requireExport(id: string): Promise<ExportSummary> {
  const exp = (await listExports()).find((e) => e.id === id)
  if (!exp) throw new Error(`There is no exported film with id ${id}. Use list_exports to see the ones there are.`)
  if (!exp.exists) throw new Error(`The film is no longer on disk (moved or deleted in ${FILE_MANAGER}?).`)
  return exp
}

interface LearningQuery {
  query?: string
  model?: string
  tag?: string
  author?: string
  limit?: number
}

async function listLearnings(query: LearningQuery = {}): Promise<Learning[]> {
  requireLibrary()
  return callService<Learning[]>('learnings:list', query)
}

/**
 * A learning the agent wrote itself and the user hasn't pinned (one the user has edited is the user's), for
 * update_learning. Studio enforces the same rules; checking first gives the agent a message that says whose it is
 * and what to do instead.
 */
async function requireOwnLearning(ctx: ToolContext, id: string): Promise<Learning> {
  const learning = (await listLearnings()).find((l) => l.id === id)
  if (!learning) throw new Error(`There is no learning with id ${id}. Use list_learnings to see the ones there are.`)
  if (!sameName(learning.author, authorName(ctx))) {
    throw new Error(
      `The learning ${q(learning.title)} was written by ${learning.author === 'user' ? 'the user (or has been changed by the user)' : learning.author}, and you can only change your own. Save a new learning with save_learning if you have something to add.`
    )
  }
  if (learning.pinned) {
    throw new Error(
      `The user has pinned the learning ${q(learning.title)}, so agents can't change it. Save a new learning with save_learning if the results say otherwise, and say what it changes.`
    )
  }
  return learning
}

/** The reference pictures (and sounds) a generation was made from, for comparing with what came out. */
async function referenceMedia(
  g: Generation,
  index: AssetIndex,
  withAudio: boolean
): Promise<{ images: LabeledImage[]; audio: LabeledAudio[]; missing: string[] }> {
  const images: LabeledImage[] = []
  const audio: LabeledAudio[] = []
  const missing: string[] = []
  const p = g.params
  const mode = kindOfModelId(p.model)
  const picture = async (path: string, label: string): Promise<void> => {
    const block = await imageBlock(path, FRAME_WIDTH)
    if (block) images.push({ label, image: block })
    else missing.push(label)
  }
  if (mode === 'reference-to-video') {
    const tokens = tokenMap(p.referenceImages, index)
    for (const [i, path] of (p.referenceImages ?? []).entries()) {
      const t = tokens[i]
      const what = t.asset_name ? `${t.asset_name} (${t.kind}), photo ${t.photo_number}` : (t.file ?? 'a picture')
      await picture(path, `Reference ${t.token} = ${what}`)
    }
    if (withAudio) {
      for (const [i, ref] of (p.referenceAudios ?? []).entries()) {
        const t = audioTokenMap([ref], index)[0]
        const window = audioWindow(ref, index)
        const who = t.asset_name ? `${t.asset_name}'s ${t.role}` : (t.file ?? 'a sound')
        const label = `Reference @Audio${i + 1} = ${who} (window ${seconds(window.start)}–${seconds(window.start + window.length)} s)`
        try {
          audio.push({ label, audio: await referenceAudioBlock(ref.path, window) })
        } catch (err) {
          missing.push(`${label}: ${errorText(err)}`)
        }
      }
    }
    // A reference video: one frame from the middle of the window it was sent, with the window.
    for (const [i, t] of videoTokenMap(referenceVideosOf(p)).entries()) {
      const ref = referenceVideosOf(p)[i]
      const at = t.start + t.length / 2
      const label = `Reference ${t.token} = a reference video (${t.title ?? t.file}, window ${t.start}–${seconds(t.start + t.length)} s), frame at ${seconds(at)} s`
      try {
        const [frame] = await extractFrames(ref.path, [at], FRAME_WIDTH)
        if (frame) images.push({ label, image: jpegBlock(frame.jpeg) })
        else missing.push(label)
      } catch {
        missing.push(label)
      }
    }
  } else if (mode === 'image-to-video') {
    if (p.startImage) {
      const what = describePicture(p.startImage, index)
      await picture(
        p.startImage,
        what.asset_name
          ? `Start image (the clip's first frame was meant to be this) = ${what.asset_name} (${what.kind}), photo ${what.photo_number}`
          : "Start image (the clip's first frame was meant to be this)"
      )
    }
    if (p.endImage) await picture(p.endImage, 'End image (the clip was meant to end on this)')
  }
  return { images, audio, missing }
}

/** A grade in the activity line: "thumbs down", "2 stars". */
const gradeText = (rating: number): string => ratingLabel(rating).toLocaleLowerCase('en')

/** The take's reviews and the user's rating, as the review tools show them. */
async function reviewsOf(generationId: string): Promise<{ rating: number | null; reviews: Record<string, unknown>[] }> {
  const list = await callService<GenerationReview[]>('reviews:list', generationId).catch(() => [] as GenerationReview[])
  return { rating: list.find((r) => r.author === 'user')?.rating ?? null, reviews: list.map(reviewInfo) }
}

// ── Film cuts ────────────────────────────────────────────────────────────────

interface FilmClip {
  clip_number: number
  segment_id: string
  generation_id: string
  continue_from_previous: boolean
  end_from_next: boolean
  prompt: string
  /** The take's title when it is the user's own film or an Editor version (its clip may have no prompt). */
  title?: string
  /** Seconds in the film. */
  start: number
  end: number
}

/** A transition of a storyboard's film: the clip between two boards' pictures. */
interface FilmTransition {
  transition_number: number
  transition_id: string
  from_board: number
  to_board: number
  generation_id: string
  prompt: string
  /** Seconds in the film. */
  start: number
  end: number
}

/**
 * Clip `i`'s take was made from the previous clip's last frame as it is now, so the export drops its first frame
 * (sequence-export's repeatsPreviousFrame; a length not measured yet counts as a match).
 */
function repeatsPrevious(sequence: Sequence, i: number): boolean {
  if (!continues(sequence, i)) return false
  const take = selectedTake(sequence.segments[i])
  const previous = sequence.segments[i - 1]
  const previousTake = selectedTake(previous)
  return !!take && !!previousTake && startsOnLastFrameOf(take, previousTake, previous.trimEnd)
}

/** Allowed difference between the film's length and the cut computed from the sequence as it is now. */
const CUT_TOLERANCE = (length: number): number => Math.max(0.35, length * 0.02)

/**
 * Where each clip of an exported film starts and ends, worked out from its sequence as it is now – only when that
 * is plausibly still the cut that was exported: every clip has a finished selected take made before the export,
 * and the trimmed takes add up to the film's length. Otherwise undefined, with why.
 */
async function filmClips(exp: ExportSummary, length: number): Promise<{ clips?: FilmClip[]; note?: string }> {
  if (!exp.sequenceId) return { note: 'The sequence this film was exported from has been deleted, so its cuts are unknown.' }
  if (isStoryboardId(exp.sequenceId)) return { note: 'The film was exported from a storyboard.' }
  let sequence: Sequence
  try {
    sequence = await loadSequence(exp.sequenceId)
  } catch {
    return { note: 'The sequence this film was exported from could not be read, so its cuts are unknown.' }
  }
  const clips: FilmClip[] = []
  let at = 0
  for (const [i, segment] of sequence.segments.entries()) {
    const take = selectedTake(segment)
    if (!take || !isUsableTake(take)) {
      return { note: `Clip ${i + 1} of the sequence has no finished selected take now, so the film's cuts can't be matched to it.` }
    }
    if (take.completedAt && take.completedAt > exp.createdAt + 1000) {
      return { note: 'The sequence has takes newer than this film, so its current cut is not the exported one.' }
    }
    const takeLength = await videoLength(take.filePath!, take.videoDuration).catch(() => undefined)
    if (takeLength === undefined) return { note: `Clip ${i + 1}'s take could not be read, so the film's cuts are unknown.` }
    const continuing = continues(sequence, i)
    const ending = endsOnNext(sequence, i)
    // The export drops the first frame of a clip whose take was made from the previous clip's last one (it repeats
    // that picture); ~1/48 s.
    const start = repeatsPrevious(sequence, i) ? Math.max(segment.trimStart, 0.02) : segment.trimStart
    // …and the last frame of a clip whose take was made to end on the next clip's first one, unless the next clip
    // already drops that picture as its own first frame (sequence-export's dropsLastFrame); ~1.5 frames before the end.
    const next = sequence.segments[i + 1]
    const nextTake = next && selectedTake(next)
    const nextDropsFirst = !!next && repeatsPrevious(sequence, i + 1) && !(next.trimStart > 0)
    const end =
      ending && nextTake && endsOnFirstFrameOf(take, nextTake, next.trimStart) && !nextDropsFirst
        ? Math.min(takeLength - segment.trimEnd, takeLength - 0.06)
        : takeLength - segment.trimEnd
    const span = Math.max(0, end - start)
    clips.push({
      clip_number: i + 1,
      segment_id: segment.id,
      generation_id: take.id,
      continue_from_previous: continuing,
      end_from_next: ending,
      prompt: segment.params.prompt,
      ...(ownTake(take) ? { title: generationTitle(take) } : {}),
      start: Math.round(at * 1000) / 1000,
      end: Math.round((at + span) * 1000) / 1000
    })
    at += span
  }
  if (!clips.length) return { note: 'The sequence has no clips now, so the cuts of the film are unknown.' }
  if (Math.abs(at - length) > CUT_TOLERANCE(length)) {
    return {
      note: `The sequence's current cut is ${seconds(at)} s but the film is ${seconds(length)} s, so it has changed since the export and the cuts are unknown.`
    }
  }
  // Takes of equal length can be swapped without changing the film's length, so say when that could have happened.
  return sequence.updatedAt > exp.createdAt + 1000
    ? {
        clips,
        note: 'The sequence was changed after this export; its current cut has the same length as the film, so the cut times are likely right, but the clips listed may not be exactly the ones exported.'
      }
    : { clips }
}

/**
 * Where each transition of a film exported from a storyboard starts and ends, from the storyboard as it is now –
 * only when that is plausibly still the exported cut (as filmClips). The export drops the first frame of every
 * transition after the first: it repeats the board picture the transition before it ended on.
 */
async function storyboardFilmClips(
  exp: ExportSummary,
  length: number
): Promise<{ clips?: FilmTransition[]; note?: string }> {
  let storyboard: Storyboard
  try {
    storyboard = await callService<Storyboard>('storyboards:get', exp.sequenceId)
  } catch {
    return { note: 'The storyboard this film was exported from could not be read, so its cuts are unknown.' }
  }
  const rows = new Map(store.listSegmentRows(storyboard.id).map((r) => [r.id, r]))
  const clips: FilmTransition[] = []
  let at = 0
  for (const [i, t] of storyboard.transitions.entries()) {
    const take = selectedTakeOf(t)
    if (!take || !isUsableTake(take)) {
      return { note: `Transition ${i + 1} of the storyboard has no finished selected take now, so the film's cuts can't be matched to it.` }
    }
    if (take.completedAt && take.completedAt > exp.createdAt + 1000) {
      return { note: 'The storyboard has takes newer than this film, so its current cut is not the exported one.' }
    }
    const takeLength = await videoLength(take.filePath!, take.videoDuration).catch(() => undefined)
    if (takeLength === undefined) return { note: `Transition ${i + 1}'s take could not be read, so the film's cuts are unknown.` }
    const row = rows.get(t.id)
    const trimStart = row?.trim_start ?? 0
    // ~1/48 s: the repeated board picture at the start of every transition after the first.
    const start = i > 0 ? Math.max(trimStart, 0.02) : trimStart
    const end = takeLength - (row?.trim_end ?? 0)
    const span = Math.max(0, end - start)
    const { from, to } = boardNumbers(storyboard, t)
    clips.push({
      transition_number: i + 1,
      transition_id: t.id,
      from_board: from,
      to_board: to,
      generation_id: take.id,
      prompt: t.params.prompt,
      start: Math.round(at * 1000) / 1000,
      end: Math.round((at + span) * 1000) / 1000
    })
    at += span
  }
  if (!clips.length) return { note: 'The storyboard has no transitions now, so the cuts of the film are unknown.' }
  if (Math.abs(at - length) > CUT_TOLERANCE(length)) {
    return {
      note: `The storyboard's current cut is ${seconds(at)} s but the film is ${seconds(length)} s, so it has changed since the export and the cuts are unknown.`
    }
  }
  return storyboard.updatedAt > exp.createdAt + 1000
    ? {
        clips,
        note: 'The storyboard was changed after this export; its current cut has the same length as the film, so the cut times are likely right, but the transitions listed may not be exactly the ones exported.'
      }
    : { clips }
}

/** The film's owner as the tools name it: the sequence or the storyboard it was exported from. */
function exportOwner(e: ExportSummary): Record<string, unknown> {
  if (e.sequenceId && isStoryboardId(e.sequenceId)) return { storyboard_id: e.sequenceId, storyboard_name: e.sequenceName }
  return { sequence_id: e.sequenceId ?? null, sequence_name: e.sequenceName }
}

// ── Sequences ────────────────────────────────────────────────────────────────

/** Names of the assets a clip refers to (photos or audio). */
function assetNames(segment: Segment, index: AssetIndex): Set<string> {
  const names = new Set<string>()
  for (const t of tokenMap(segment.params.referenceImages, index)) if (t.asset_name) names.add(t.asset_name)
  for (const t of audioTokenMap(segment.params.referenceAudios, index)) if (t.asset_name) names.add(t.asset_name)
  return names
}

/** What to compare at the cut between clip `i` and the next one. */
function continuityHint(sequence: Sequence, i: number, index: AssetIndex): string {
  const a = sequence.segments[i]
  const b = sequence.segments[i + 1]
  const usable = (s: Segment): boolean => isUsableTake(selectedTake(s))
  const head = `Clip ${i + 1} → ${i + 2}:`
  if (!usable(a) || !usable(b)) {
    const missing = [usable(a) ? undefined : i + 1, usable(b) ? undefined : i + 2].filter(Boolean)
    return `${head} clip ${missing.join(' and ')} has no finished selected take yet, so this cut can't be judged.`
  }
  if (continues(sequence, i + 1) && endsOnNext(sequence, i)) {
    return `${head} the clips share the picture at the cut (clip ${i + 2} continues from clip ${i + 1}, which was made to end on clip ${i + 2}'s first frame) – the last frame of clip ${i + 1} and the first frame of clip ${i + 2} should be the same picture, and the motion should carry on.`
  }
  if (continues(sequence, i + 1)) {
    return `${head} clip ${i + 2} continues from clip ${i + 1}'s last frame – the last frame of clip ${i + 1} and the first frame of clip ${i + 2} should be the same picture (people, position, place, light), and the motion should carry on.`
  }
  if (endsOnNext(sequence, i)) {
    return `${head} clip ${i + 1} was made to end on clip ${i + 2}'s first frame – the last frame of clip ${i + 1} and the first frame of clip ${i + 2} should be the same picture (people, position, place, light), and the motion should carry on across the cut.`
  }
  const shared = [...assetNames(a, index)].filter((n) => assetNames(b, index).has(n))
  return shared.length
    ? `${head} a new shot with ${shared.join(', ')} in both – check that they look the same on both sides of the cut (face, hair, outfit) and that the place and light fit the story.`
    : `${head} a new shot with no references in common – check that the cut reads as intended (a new place, time or point of view).`
}

export function registerReviewTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'review_generation',
    {
      title: 'Review a generation',
      description:
        "Look closely at what a finished generation – or the user's own clip, or a version made in the Editor – actually became, to learn how prompts translate into video: returns its prompt (and sent_prompt, the prompt as Venice got it with the descriptions of its referenced assets appended, when that differs; an own clip or a version has its source, title and recipe instead), settings, the reference token maps, price, the user's rating (-1 = thumbs down, 1–3 = stars) and every review so far, then `frames` frames evenly spaced from the first to the last (JPEG, 512 px wide, each captioned \"t = 2.4 s\"), followed by the reference images it was made from (include_references) so you can compare identity, outfit, pose and place – and with include_audio the clip's own sound (MP3, up to 30 s from audio_start) plus the reference voice windows (@AudioN), for clients that take audio. Afterwards record what you saw with add_review, and anything that generalises with save_learning. Free; changes nothing.",
      input: {
        generation_id: z.string(),
        frames: z.number().int().min(1).max(12).default(6).describe('How many frames, first to last. Default 6.'),
        include_references: z
          .boolean()
          .default(true)
          .describe('Also return the reference images (or start image) it was made from. Default true.'),
        include_audio: z
          .boolean()
          .default(false)
          .describe("Also return the clip's sound (up to 30 s from audio_start) and its reference audio windows as MP3 audio. Default false."),
        audio_start: z
          .number()
          .min(0)
          .default(0)
          .describe('With include_audio: where the sound starts, in seconds – to hear a long version past its first 30 s.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'reviewed a generation'
    },
    async ({ generation_id, frames, include_references, include_audio, audio_start }) => {
      const g = requireGeneration(generation_id)
      const index = await AssetIndex.load()
      const { rating, reviews } = await reviewsOf(g.id)
      const data: Record<string, unknown> = {
        id: g.id,
        ...sourceFields(g),
        status: g.status,
        created: localTime(g.createdAt),
        model: g.model,
        prompt: g.prompt,
        // An import or an Editor version: how it was made instead of a prompt.
        ...(g.recipe ? { recipe: recipeInfo(g.recipe) } : {}),
        // What Venice actually got, when the descriptions of its references were appended to the prompt.
        ...(g.sentPrompt && g.sentPrompt !== g.prompt ? { sent_prompt: g.sentPrompt } : {}),
        ...(g.params.negativePrompt ? { negative_prompt: g.params.negativePrompt } : {}),
        params: paramsInfo(g.params, index),
        price_usd: priceValue(g.quote),
        take_of: takeOf(g),
        rating,
        reviews,
        ...(g.error ? { error: g.error } : {})
      }
      const summary = `reviewed the ${g.source && g.source !== 'generated' ? 'video' : 'generation'} ${q(generationTitle(g, 40))}`
      if (g.status !== 'completed') {
        data.note =
          g.status === 'failed'
            ? 'The generation failed, so there is no video to look at; the error says why.'
            : 'The generation is not finished yet; poll get_generation until it is completed.'
        return { data, summary }
      }
      const images: LabeledImage[] = []
      const audio: LabeledAudio[] = []
      // Without its video (moved away in Finder, say) the review still has the prompt, references and reviews.
      let file: string | undefined
      let length = 0
      try {
        file = requireVideoFile(g.filePath, 'The generation')
        length = await videoLength(file, g.videoDuration)
        data.video_seconds = seconds(length)
        const times = spreadTimes(0, lastFrameTime(length), frames).map((t) => clampTime(t, length))
        images.push(
          ...(await framesAt(
            file,
            times,
            (caption, i) =>
              `${caption} – frame ${i + 1} of ${times.length}${i === times.length - 1 && times.length > 1 ? ' (last frame)' : ''}, clip ${seconds(length)} s`
          ))
        )
        // To the millisecond: a time passed back (save_frame_as_still, get_frames) must give this very frame.
        data.frame_times = times.map((t) => Math.round(t * 1000) / 1000)
      } catch (err) {
        data.frames_error = errorText(err)
      }
      if (include_audio && file) {
        try {
          const from = Math.min(audio_start, Math.max(0, length - 1))
          const sound = await soundtrack(file, from, length - from)
          if (sound) {
            audio.push({
              label: `The clip's sound, ${seconds(from)}–${seconds(Math.min(length, from + MAX_SOUNDTRACK_SECONDS))} s`,
              audio: sound
            })
            if (from + MAX_SOUNDTRACK_SECONDS < length) {
              data.audio_note = `The sound is ${seconds(length)} s long; ask again with audio_start ${seconds(from + MAX_SOUNDTRACK_SECONDS)} for the next part.`
            }
          } else data.audio_note = 'The clip has no sound track.'
        } catch (err) {
          data.audio_error = errorText(err)
        }
      }
      if (include_references || include_audio) {
        const refs = await referenceMedia(g, index, include_audio)
        if (include_references) images.push(...refs.images)
        audio.push(...refs.audio)
        if (refs.missing.length) data.references_not_returned = refs.missing
      }
      data.how_to_review =
        g.segmentId && (data.take_of as Record<string, unknown> | undefined)?.storyboard_id
          ? [TRANSITION_CHECK, ...CLIP_CHECKLIST]
          : CLIP_CHECKLIST
      data.suggested_tags = REVIEW_TAGS
      return { data, images, audio, summary }
    }
  )

  defineTool(
    server,
    ctx,
    'get_frames',
    {
      title: 'Get frames',
      description:
        'Specific frames of a finished generation (generation_id) or an exported film (export_id), at the times you give in seconds (times past the end give the last frame), as JPEG images captioned "t = 2.4 s". Use it to look closer at a moment you noticed with review_generation or review_export, e.g. a cut or a gesture. Free; changes nothing.',
      input: {
        generation_id: z.string().optional(),
        export_id: z.string().optional().describe('An export_id from list_exports.'),
        times: z.array(z.number().min(0)).min(1).max(12).describe('Seconds into the video, e.g. [0, 2.5, 7.9].'),
        width: z
          .number()
          .int()
          .min(256)
          .max(MAX_FRAME_WIDTH)
          .default(FRAME_WIDTH)
          .describe(`Frame width in pixels (256–${MAX_FRAME_WIDTH}). Default ${FRAME_WIDTH}.`)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: ({ times }) => `looked at ${times.length === 1 ? 'a frame' : `${times.length} frames`}`
    },
    async ({ generation_id, export_id, times, width }) => {
      if (!generation_id === !export_id) throw new Error('Give either generation_id or export_id.')
      let file: string
      let length: number
      let what: string
      if (generation_id) {
        const g = requireGeneration(generation_id)
        if (g.status !== 'completed') throw new Error('The generation isn\'t finished, so it has no frames yet.')
        file = requireVideoFile(g.filePath, 'The generation')
        length = await videoLength(file, g.videoDuration)
        what = `Generation ${g.id}`
      } else {
        const exp = await requireExport(export_id!)
        file = exp.path
        length = await videoLength(file, exp.duration)
        what = `Film ${exp.sequenceName ? `"${exp.sequenceName}"` : basename(exp.path)}`
      }
      const clamped = [...new Set(times.map((t) => Math.round(clampTime(t, length) * 1000) / 1000))]
      const images = await framesAt(file, clamped, (caption) => `${what} – ${caption}`, width)
      return {
        data: {
          video_seconds: seconds(length),
          times: clamped,
          ...(clamped.length < times.length ? { note: 'Times past the end (or repeated) were merged into the last frame.' } : {}),
          frames_returned: images.length
        },
        images
      }
    }
  )

  defineTool(
    server,
    ctx,
    'list_exports',
    {
      title: 'List exported films',
      description:
        "Films exported from sequences and storyboards (newest first): export_id, the sequence or storyboard it came from (if it still exists), the file, when it was made, its length, its cuts (where the clips meet, in seconds; recorded since the Editor came, so older films have none) and whether the file is still on disk. Look at one with review_export or get_frames; change it with create_edit({export_id}).",
      input: {
        sequence_id: z.string().optional().describe('Only films exported from this sequence.'),
        storyboard_id: z.string().optional().describe('Only films exported from this storyboard.'),
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listed the exported films'
    },
    async ({ sequence_id, storyboard_id, limit }) => {
      const owner = storyboard_id ?? sequence_id
      const list = (await listExports()).filter((e) => !owner || e.sequenceId === owner)
      return {
        data: {
          count: list.length,
          exports: list.slice(0, limit).map((e) => ({
            export_id: e.id,
            ...exportOwner(e),
            file: basename(e.path),
            created: localTime(e.createdAt),
            ...(e.duration !== undefined ? { seconds: seconds(e.duration) } : {}),
            // Where the clips meet in the film, recorded at export (older exports don't have them).
            ...(e.cuts ? { cuts: e.cuts.map(seconds) } : {}),
            exists: e.exists
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'review_export',
    {
      title: 'Review an exported film',
      description:
        "Look at a whole exported film (of a sequence or a storyboard) to judge continuity across its cuts. When the film still matches its sequence or storyboard (same selected takes and trims), you get the clips – a storyboard's transitions – with their place in the film, frames_per_clip frames inside every clip, and the last frame before and the first frame after every cut, each captioned with its time in the film (\"t = 8.0 s\"); otherwise frames evenly spread over the film and a note why the cuts are unknown. Compare across the cuts: faces, outfits, place, light, and whether continuing clips really continue. include_audio adds up to 30 s of the film's sound from audio_start. Review weak clips further with review_generation; record what you learn with add_review and save_learning. Free; changes nothing.",
      input: {
        export_id: z.string().describe('An export_id from list_exports.'),
        frames_per_clip: z.number().int().min(1).max(4).default(2).describe('Frames inside each clip (1–4). Default 2.'),
        include_cut_frames: z.boolean().default(true).describe('The last frame before and first frame after every cut. Default true.'),
        include_audio: z.boolean().default(false),
        audio_start: z.number().min(0).default(0).describe('With include_audio: where the sound starts, in seconds.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'reviewed a film'
    },
    async ({ export_id, frames_per_clip, include_cut_frames, include_audio, audio_start }) => {
      const exp = await requireExport(export_id)
      const length = await videoLength(exp.path, exp.duration)
      const fromStoryboard = !!exp.sequenceId && isStoryboardId(exp.sequenceId)
      const film: { clips?: (FilmClip | FilmTransition)[]; note?: string } = fromStoryboard
        ? await storyboardFilmClips(exp, length)
        : await filmClips(exp, length)
      const note = film.note
      // One shape for the frames below: a clip of a sequence, or a transition of a storyboard (named so).
      const clips = film.clips?.map((c) =>
        'transition_number' in c
          ? { number: c.transition_number, start: c.start, end: c.end }
          : { number: c.clip_number, start: c.start, end: c.end }
      )
      const word = fromStoryboard ? 'transition' : 'clip'
      const Word = fromStoryboard ? 'Transition' : 'Clip'
      const wanted: { t: number; label: string }[] = []
      const data: Record<string, unknown> = {
        export_id: exp.id,
        ...exportOwner(exp),
        file: basename(exp.path),
        created: localTime(exp.createdAt),
        seconds: seconds(length)
      }
      // The frames at the cuts come first (continuity is what a film review is for), then frames inside the clips.
      const cutFrames = include_cut_frames && clips ? 2 * (clips.length - 1) : 0
      const room = MAX_FILM_FRAMES - cutFrames
      const perClip = clips && room >= 0 ? Math.min(frames_per_clip, Math.floor(room / clips.length)) : 0
      if (film.clips) {
        data.cuts_from = fromStoryboard ? 'storyboard' : 'sequence'
        data[fromStoryboard ? 'transitions' : 'clips'] = film.clips.map((c) => ({ ...c, start: seconds(c.start), end: seconds(c.end) }))
      } else {
        data.cuts_from = 'unknown'
      }
      if (clips && room >= 0 && perClip + cutFrames > 0) {
        for (const c of clips) {
          // Inside the clip, away from the cuts (those have frames of their own).
          const margin = Math.min(0.25, (c.end - c.start) / 4)
          for (const t of spreadTimes(c.start + margin, c.end - margin, perClip)) {
            wanted.push({ t: clampTime(t, length), label: `${Word} ${c.number}` })
          }
          if (include_cut_frames && c.number < clips.length) {
            wanted.push({
              t: clampTime(c.end - BEFORE_CUT, length),
              label: `Cut ${c.number}→${c.number + 1}: last frame of ${word} ${c.number}`
            })
            wanted.push({
              t: clampTime(c.end + AFTER_CUT, length),
              label: `Cut ${c.number}→${c.number + 1}: first frame of ${word} ${c.number + 1}`
            })
          }
        }
        const fewer =
          perClip === 0
            ? 'Only the frames at the cuts, so the answer stays readable; get_frames shows more.'
            : perClip < frames_per_clip
              ? `Fewer frames per clip (${perClip}) so the answer stays readable; get_frames shows more.`
              : undefined
        const notes = [note, fewer].filter(Boolean)
        if (notes.length) data.note = notes.join(' ')
      } else {
        const count = Math.min(MAX_FILM_FRAMES, Math.max(4, frames_per_clip * Math.max(1, Math.round(length / 8))))
        for (const t of spreadTimes(0, lastFrameTime(length), count)) wanted.push({ t: clampTime(t, length), label: 'Film' })
        data.note = clips
          ? [
              note,
              `The film has ${clips.length} ${word}s – too many cuts to show each one; frames are evenly spread instead. Use get_frames around the cuts (${word}s lists where they are).`
            ]
              .filter(Boolean)
              .join(' ')
          : note
      }
      // Each time once, in film order; frames that coincide share one picture.
      const byTime = new Map<number, string[]>()
      for (const w of wanted.sort((a, b) => a.t - b.t)) {
        const key = Math.round(w.t * 1000) / 1000
        byTime.set(key, [...(byTime.get(key) ?? []), w.label])
      }
      const times = [...byTime.keys()]
      const images = await framesAt(exp.path, times, (caption, i) => `${caption} – ${byTime.get(times[i])!.join(' / ')}`)
      data.frames_returned = images.length
      const audio: LabeledAudio[] = []
      if (include_audio) {
        try {
          const from = Math.min(audio_start, Math.max(0, length - 1))
          const sound = await soundtrack(exp.path, from, length - from)
          if (sound) {
            audio.push({
              label: `The film's sound, ${seconds(from)}–${seconds(Math.min(length, from + MAX_SOUNDTRACK_SECONDS))} s`,
              audio: sound
            })
          } else data.audio_note = 'The film has no sound track.'
        } catch (err) {
          data.audio_error = errorText(err)
        }
      }
      data.how_to_review = fromStoryboard ? STORYBOARD_CONTINUITY_CHECKLIST : CONTINUITY_CHECKLIST
      return {
        data,
        images,
        audio,
        summary: `reviewed the film ${q(exp.sequenceName ?? basename(exp.path))}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'review_sequence',
    {
      title: 'Review a sequence',
      description:
        "Look at a sequence clip by clip to judge it as a film before (or after) exporting: for every clip its notes, prompt, references, whether it continues from the previous one or ends on the next one's first frame, and its selected take with rating and review count, plus frames_per_clip frames of that take from its first to its last frame (within the trims), captioned with the time in the take. Ends with continuity hints for every cut: what should match across it. Use review_generation for a closer look at one take and add_review / save_learning for what you find. Free; changes nothing.",
      input: {
        sequence_id: z.string(),
        frames_per_clip: z.number().int().min(2).max(6).default(3).describe('Frames per clip, first and last included (2–6). Default 3.')
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'reviewed a sequence'
    },
    async ({ sequence_id, frames_per_clip }) => {
      requireLibrary()
      if (isStoryboardId(sequence_id)) {
        throw new Error(
          'This is a storyboard, not a sequence. Review its transitions one by one with review_generation (get_storyboard lists the takes) and an exported film with review_export.'
        )
      }
      const sequence = await loadSequence(sequence_id)
      const index = await AssetIndex.load()
      const count = sequence.segments.length
      const perClip = count ? Math.max(2, Math.min(frames_per_clip, Math.floor(MAX_SEQUENCE_FRAMES / count))) : 0
      // With very many clips only the first ones get frames; the rest are still described.
      const framedClips = perClip ? Math.min(count, Math.floor(MAX_SEQUENCE_FRAMES / perClip)) : 0
      const images: LabeledImage[] = []
      const clips: Record<string, unknown>[] = []
      for (const [i, segment] of sequence.segments.entries()) {
        const take = selectedTake(segment)
        const info: Record<string, unknown> = {
          clip_number: i + 1,
          segment_id: segment.id,
          ...(segment.notes?.trim() ? { notes: segment.notes } : {}),
          continue_from_previous: continues(sequence, i),
          end_from_next: endsOnNext(sequence, i),
          prompt: segment.params.prompt,
          references: referenceSummary(segment.params, index)
        }
        if (!take || !isUsableTake(take)) {
          info.selected_take = take ? { generation_id: take.id, status: take.status, ...(take.fileMissing ? { file_missing: true } : {}) } : null
          clips.push(info)
          continue
        }
        const { rating, reviews } = await reviewsOf(take.id)
        info.selected_take = {
          generation_id: take.id,
          ...(ownTake(take) ? { source: take.source, title: generationTitle(take), own_clip: true } : {}),
          video_seconds: take.videoDuration !== undefined ? seconds(take.videoDuration) : undefined,
          ...(segment.trimStart || segment.trimEnd ? { trim_start: segment.trimStart, trim_end: segment.trimEnd } : {}),
          rating,
          review_count: reviews.length
        }
        clips.push(info)
        if (i >= framedClips) continue
        try {
          const length = await videoLength(take.filePath!, take.videoDuration)
          const first = clampTime(segment.trimStart, length)
          // The last frame the cut shows: just before the end trim, like the end of the take itself.
          const last = clampTime(lastFrameTime(Math.max(0, length - segment.trimEnd)), length)
          const times = spreadTimes(first, Math.max(first, last), perClip)
          images.push(
            ...(await framesAt(take.filePath!, times, (caption, k) => {
              const which = k === 0 ? 'first frame' : k === times.length - 1 ? 'last frame' : `frame ${k + 1}`
              return `Clip ${i + 1} – ${which}, ${caption} of the take`
            }))
          )
        } catch (err) {
          info.frames_error = errorText(err)
        }
      }
      return {
        data: {
          sequence_id: sequence.id,
          name: sequence.name,
          clip_count: count,
          frames_per_clip: perClip,
          ...(framedClips < count ? { note: `Frames for the first ${framedClips} clips only; use review_generation for the others.` } : {}),
          clips,
          continuity: sequence.segments.slice(0, -1).map((_, i) => continuityHint(sequence, i, index)),
          how_to_review: CONTINUITY_CHECKLIST
        },
        images,
        summary: `reviewed the sequence ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_review',
    {
      title: 'Add review',
      description:
        "Records your review of a generation, under your name, next to the user's own rating and other agents' reviews (Studio shows them in the clip's details). Be honest and specific: a grade – rating -1 (thumbs down: the prompt wasn't followed, or it is unusable) or 1–3 stars (1 = usable with clear flaws, 2 = good with small flaws, 3 = exactly what the prompt asked for) – tags from the suggested vocabulary, and a note that says what worked and what didn't, naming tokens and moments (\"@Image2's outfit turned blue after t = 4 s; the dolly-in worked\"). Look first with review_generation. Each call adds a new review; to remove one (a review about the wrong generation, say), ask the user with request_delete. Free.",
      input: {
        generation_id: z.string(),
        rating: ratingInput.optional().describe('-1 = thumbs down (bad), 1–3 = stars'),
        tags: tagList.optional(),
        note: z.string().min(1).max(2000).describe('What you saw, in any language.')
      },
      annotations: WRITE,
      summary: ({ rating }) => (rating ? `reviewed a generation (${gradeText(rating)})` : 'reviewed a generation')
    },
    async ({ generation_id, rating, tags, note }) => {
      const g = requireGeneration(generation_id)
      const review = await callService<GenerationReview>(
        'reviews:add',
        g.id,
        { rating, tags: cleanTags(tags), note: note.trim() },
        ctx.clientName()
      )
      return {
        data: reviewInfo(review),
        summary: `reviewed ${q(generationTitle(g, 40))}${rating ? ` (${gradeText(rating)})` : ''}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'list_reviews',
    {
      title: 'List reviews',
      description:
        "Reviews of generations, newest first: the user's own (author \"user\": their rating and note – the most important signal of what they like) and agents'. Filter by generation_id, by author, by tag (e.g. \"identity-drift\" to see when characters drift), or by grade (min_rating for stars, thumbs_down for a thumbs down). Each review outside a single generation comes with that generation's prompt and model, so you can see which prompts got which verdicts.",
      input: {
        generation_id: z.string().optional(),
        author: z.string().optional().describe('"user" for the user\'s own reviews, or an agent\'s name.'),
        tag: z.string().optional(),
        min_rating: minStarsInput
          .optional()
          .describe('Only reviews with at least this many stars (1–3); a thumbs down (-1) never passes.'),
        thumbs_down: z.boolean().optional().describe('true: only reviews that gave a thumbs down (-1).'),
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'read the reviews'
    },
    async ({ generation_id, author, tag, min_rating, thumbs_down, limit }) => {
      requireLibrary()
      const scope = generation_id ? requireGeneration(generation_id).id : undefined
      const all = await callService<GenerationReview[]>('reviews:list', scope, author?.trim() ? { author: author.trim() } : {})
      const wantedTag = tag ? cleanTags([tag])[0] : undefined
      const list = all.filter(
        (r) =>
          (!wantedTag || r.tags.some((t) => sameName(t, wantedTag))) &&
          // Tumme ner is -1, below every star.
          (!min_rating || (r.rating ?? 0) >= min_rating) &&
          (!thumbs_down || r.rating === THUMBS_DOWN)
      )
      const generations = new Map<string, Generation | undefined>()
      const about = (id: string): Record<string, unknown> | undefined => {
        if (generation_id) return undefined
        if (!generations.has(id)) generations.set(id, db.getGeneration(id))
        const g = generations.get(id)
        return g
          ? {
              prompt: g.prompt,
              ...(g.source && g.source !== 'generated' ? { source: g.source, title: generationTitle(g) } : {}),
              model: g.model,
              created: localTime(g.createdAt)
            }
          : undefined
      }
      return {
        data: {
          count: list.length,
          reviews: list.slice(0, limit).map((r) => ({ ...reviewInfo(r), ...(about(r.generationId) ? { generation: about(r.generationId) } : {}) }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'save_learning',
    {
      title: 'Save learning',
      description:
        "Records a learning: a short, general insight about prompting that should change how prompts are written from now on, distilled from reviewed results – e.g. title \"Outfit token after the character\", insight \"Seedance 2.5: naming the outfit right after the character's tokens keeps the outfit; when the outfit token comes first it drifts.\" Give the model it applies to (leave it out if it holds for every model), tags, and evidence: the generation ids it is based on. Learnings are listed in Studio (Prompts → Learnings) and at the end of get_studio_guide for every later session, so write them for a reader who wasn't there; check list_learnings first and update your own learning instead of saving a duplicate. Free.",
      input: {
        title: z.string().min(1).max(120),
        insight: z.string().min(1).max(2000),
        model: z.string().optional().describe('A model id from list_models; leave out for every model.'),
        tags: z.array(z.string().min(1).max(40)).max(12).optional(),
        evidence: z.array(z.string()).max(50).optional().describe('Generation ids the learning is based on.')
      },
      annotations: WRITE,
      summary: ({ title }) => `saved the learning ${q(title)}`
    },
    async ({ title, insight, model, tags, evidence }) => {
      requireLibrary()
      const input: LearningInput = {
        title: title.trim(),
        insight: insight.trim(),
        model: model?.trim() || undefined,
        tags: cleanTags(tags),
        evidence: evidence ?? []
      }
      const saved = await callService<Learning>('learnings:save', input, ctx.clientName())
      return { data: learningInfo(saved), summary: `saved the learning ${q(saved.title)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'update_learning',
    {
      title: 'Update learning',
      description:
        'Changes one of your own learnings (the ones whose author is your name): only the fields you pass change; model null makes it apply to every model; evidence replaces the list (pass the old ids plus the new ones to add). Use it when new results confirm, refine or contradict what you wrote. Learnings by the user or other agents cannot be changed, nor can yours once the user has pinned it or edited it (an edited one becomes the user\'s) – save a new one instead. To remove one of yours that results proved wrong, ask the user with request_delete. Free.',
      input: {
        learning_id: z.string(),
        title: z.string().min(1).max(120).optional(),
        insight: z.string().min(1).max(2000).optional(),
        model: z.string().nullable().optional(),
        tags: z.array(z.string().min(1).max(40)).max(12).optional(),
        evidence: z.array(z.string()).max(50).optional()
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'changed a learning'
    },
    async ({ learning_id, title, insight, model, tags, evidence }) => {
      const current = await requireOwnLearning(ctx, learning_id)
      // Fields left out stay as they are (Studio keeps model, tags, evidence and pinned when they aren't given).
      const input: LearningInput = {
        id: current.id,
        title: title?.trim() ?? current.title,
        insight: insight?.trim() ?? current.insight,
        ...(model !== undefined ? { model: model?.trim() || null } : {}),
        ...(tags ? { tags: cleanTags(tags) } : {}),
        ...(evidence ? { evidence } : {})
      }
      const saved = await callService<Learning>('learnings:save', input, ctx.clientName())
      return { data: learningInfo(saved), summary: `changed the learning ${q(saved.title)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'list_learnings',
    {
      title: 'List learnings',
      description:
        "The learnings recorded so far (by the user and by agents): pinned first, then the most recently updated. Read them before you write new prompts – they are what earlier sessions found out about what works. Filter with query (every word must appear in the title, insight, model or tags), model (learnings for that model plus the general ones), tag or author. Each has its evidence (generation ids – look at them with review_generation).",
      input: {
        query: z.string().optional(),
        model: z.string().optional().describe('Learnings for this model and the ones for every model.'),
        tag: z.string().optional(),
        author: z.string().optional().describe('"user" for the user\'s own, or an agent\'s name.'),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'read the learnings'
    },
    async ({ query, model, tag, author, limit }) => {
      // Studio filters (every word of the query in title, insight, model or tags; a model's learnings plus the
      // general ones) and orders them: pinned first, then the most recently changed.
      const list = await listLearnings({
        query: query?.trim() || undefined,
        model: model?.trim() || undefined,
        tag: tag?.trim() || undefined,
        author: author?.trim() || undefined
      })
      return {
        data: {
          count: list.length,
          your_name: authorName(ctx),
          learnings: list.slice(0, limit).map(learningInfo)
        }
      }
    }
  )
}
