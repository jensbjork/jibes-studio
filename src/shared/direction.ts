// How a director directs a generation (GenerationParams.director): what is sent, decided here in pure shared code so
// main's submissions, the window's mirror of them (price, checks, "Added to the prompt", the approval dialog) and the
// agents' tools all agree.
//
//   <the user's prompt>
//
//   References:
//   - Anna (@Image1): …
//
//   Direction (Noir):
//   - Editing: slow, deliberate cuts with lingering holds; cut on a look or a sound
//   - Look: high-contrast black and white, deep inky shadows, fine film grain
//   - Camera: …
//   - Style frames (@Image2, @Image3): match their look – grade, light, texture – never their people, places or objects.
//   - @Video1: follow its camera movement only – not its people or places.
//
// - The parts written (DIRECTION_PARTS order) become one line each, in the prompt language's words ("Regi (Noir):",
//   "Klippning:" … in Swedish; the texts themselves are sent as written – the ready-made ones are English). Sound only
//   for a clip made with sound. The section comes after the References legend and must fit the model's prompt limit:
//   the user's prompt and the legend win, and parts are left out from the end (sound first) when it doesn't fit; the
//   style lines stay as long as anything is appended (composeDirection).
// - `avoid` joins the negative prompt after the clip's own, deduplicated phrase by phrase (withDirection).
// - Style frames (the director's photos) go after the clip's own reference images, only in reference-to-video mode and
//   only as many as the model still takes; never with a clip continuing from the previous clip in reference mode (the
//   frame it starts on must stay the last picture, and its look already carries over). Style videos go after the clip's
//   own reference videos with models that take them (Seedance 2.x reference-to-video), within the family's count and
//   seconds. The section explains both, so the prompt checks count them as explained (explainedReferences).
// - Applying it twice changes nothing: what is there already is found by its path, so a take's stored params (which
//   record what was sent, the director's id with it) can be sent again as they are.
//
// Create image… (stills) gets the look, light and framing as plain English text and `avoid` as its negative prompt
// (imageDirection): image prompts never carry tokens.

import { CONTINUATION_FRAME_PLACEHOLDER } from './continuation'
import { directorPreset } from './directors'
import { pathKey } from './generation-filter'
import {
  durationSeconds,
  kindOfModelId,
  maxReferenceImages,
  referenceVideoLimits,
  referenceVideosOf,
  referenceVideoWindow,
  sanitizeReferenceVideos,
  supportsReferenceVideos,
  videosAreReferences
} from './models'
import { isExtractedFrame } from './seams'
import {
  DIRECTION_PARTS,
  DIRECTOR_PRESET_PREFIX,
  type Asset,
  type ComposedDirection,
  type Direction,
  type DirectionLine,
  type DirectionPart,
  type GenerationParams,
  type PromptLanguage,
  type ReferenceVideo,
  type VideoModel
} from './types'

export { DIRECTOR_PRESETS, directorPreset } from './directors'

// ── Directors and their ids ──────────────────────────────────────────────────

/** A director as what is sent reads it: from the library (an asset of kind 'director') or a ready-made one. */
export interface ResolvedDirector {
  /** What params, sequences and storyboards carry: the asset's id, or the ready-made one's ("preset:noir"). */
  id: string
  name: string
  /** A ready-made director (shared/directors.ts): read-only, without style frames or videos. */
  preset: boolean
  direction: Direction
  /** The style frames: the director's photos (absolute paths), in order. */
  styleFrames: string[]
  /** The style videos (absolute paths, with their windows), in order. */
  styleVideos: ReferenceVideo[]
}

/** What resolveDirector reads of an asset (the window's and main's Asset both fit). */
export type DirectorSource = Pick<Asset, 'id' | 'kind' | 'name'> & {
  images?: readonly { path: string }[]
  direction?: Direction
}

/** Whether an id names a ready-made director ("preset:…"), known or not. */
export function isDirectorPresetId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(DIRECTOR_PRESET_PREFIX)
}

/** A library director as what is sent reads it. */
export function resolvedDirectorOf(asset: DirectorSource): ResolvedDirector {
  const direction = sanitizeDirection(asset.direction)
  return {
    id: asset.id,
    name: asset.name,
    preset: false,
    direction,
    styleFrames: (asset.images ?? []).map((img) => img.path).filter((p) => typeof p === 'string' && p !== ''),
    styleVideos: direction.videos ?? []
  }
}

/**
 * The director an id names: a ready-made one, or an asset of kind 'director' among `assets`; undefined for none
 * (undefined, null, '', an unknown ready-made id, a deleted director or an asset of another kind).
 */
export function resolveDirector(
  id: string | null | undefined,
  assets: readonly DirectorSource[]
): ResolvedDirector | undefined {
  if (typeof id !== 'string' || !id) return undefined
  if (isDirectorPresetId(id)) {
    const preset = directorPreset(id)
    return preset
      ? {
          id: preset.id,
          name: preset.name,
          preset: true,
          direction: sanitizeDirection(preset.direction),
          styleFrames: [],
          styleVideos: []
        }
      : undefined
  }
  const asset = assets.find((a) => a && a.id === id && a.kind === 'director')
  return asset ? resolvedDirectorOf(asset) : undefined
}

/**
 * The director that directs a clip: its own (`own`, GenerationParams.director) when it names one, none for null,
 * else the sequence's or storyboard's (`owner`); undefined for none.
 */
export function effectiveDirectorId(
  own: string | null | undefined,
  owner?: string | null | undefined
): string | undefined {
  if (own === null) return undefined
  if (typeof own === 'string' && own) return own
  return typeof owner === 'string' && owner ? owner : undefined
}

/** A director id from the window, an agent or JSON: a non-empty string, null (none), or undefined (left out). */
export function sanitizeDirectorId(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// ── The direction itself ─────────────────────────────────────────────────────

/** The shot length (Direction.shotSeconds) a director may ask for, in seconds. */
export const MIN_SHOT_SECONDS = 2
export const MAX_SHOT_SECONDS = 15
/** The longest text a part (or `avoid`) keeps; longer text is cut. */
export const MAX_DIRECTION_TEXT = 1000
/** The most style videos a director keeps (Seedance 2.5 takes 10 reference videos in all). */
export const MAX_STYLE_VIDEOS = 10

/** "@" and its full-width form: a director's text never carries reference tokens. */
const AT_SIGNS = /[@＠]/g

/** Text as a direction keeps it: one line, single spaces, no "@", at most MAX_DIRECTION_TEXT characters. */
function directionText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const clean = value.replace(AT_SIGNS, '').replace(/\s+/g, ' ').trim()
  return clean.length > MAX_DIRECTION_TEXT ? clean.slice(0, MAX_DIRECTION_TEXT).trimEnd() : clean
}

/**
 * A direction from the window, an agent or JSON, as it is stored: every text part one line without "@" (empty parts
 * left out), shotSeconds a whole number of seconds within 2–15, continuity 'cut' or 'flow', the style videos as
 * reference videos (at most MAX_STYLE_VIDEOS, no path twice), defaults only as non-empty strings. Never throws.
 */
export function sanitizeDirection(input: unknown): Direction {
  const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: Direction = {}
  for (const part of [...DIRECTION_PARTS, 'avoid'] as const) {
    const text = directionText(d[part])
    if (text) out[part] = text
  }
  if (typeof d.shotSeconds === 'number' && Number.isFinite(d.shotSeconds)) {
    out.shotSeconds = Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.round(d.shotSeconds)))
  }
  if (d.continuity === 'cut' || d.continuity === 'flow') out.continuity = d.continuity
  const videos = sanitizeReferenceVideos(d.videos)
  if (videos) {
    const seen = new Set<string>()
    const unique = videos.filter((v) => {
      const key = pathKey(v.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    out.videos = unique.slice(0, MAX_STYLE_VIDEOS)
  }
  const defaults = (d.defaults && typeof d.defaults === 'object' ? d.defaults : {}) as Record<string, unknown>
  const picked: NonNullable<Direction['defaults']> = {}
  for (const key of ['model', 'aspectRatio', 'resolution'] as const) {
    const value = defaults[key]
    if (typeof value === 'string' && value.trim()) picked[key] = value.trim()
  }
  if (Object.keys(picked).length) out.defaults = picked
  return out
}

/** Whether the director has anything to say in a prompt: a part, `avoid`, a style frame or a style video. */
export function directsAnything(director: ResolvedDirector | undefined): boolean {
  if (!director) return false
  const d = director.direction
  return (
    DIRECTION_PARTS.some((p) => !!d[p]) || !!d.avoid || director.styleFrames.length > 0 || director.styleVideos.length > 0
  )
}

// ── What is sent ─────────────────────────────────────────────────────────────

/** What withDirection needs to know beyond the params. */
export interface DirectionFacts {
  /**
   * The clip continues from the previous clip in reference mode (its last reference image is, or will be, the previous
   * clip's last frame): no style frames. Also recognised by itself when the frame (or its placeholder) is already the
   * last reference image.
   */
  continuationFrame?: boolean
}

/** Phrases of a negative prompt: comma- (or semicolon-, line-) separated, trimmed. */
function phrases(text: string | undefined): string[] {
  return (typeof text === 'string' ? text : '')
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** How phrases are compared: letter case, spacing and a closing full stop ignored. */
const phraseKey = (p: string): string => p.toLocaleLowerCase('en').replace(/\s+/g, ' ').replace(/[.\s]+$/u, '')

/**
 * The negative prompt with the director's `avoid` after the clip's own: each of its phrases that the clip's negative
 * prompt doesn't have already is added (", " between). The clip's own text is kept exactly; undefined when both are
 * empty.
 */
export function mergeAvoid(negativePrompt: string | undefined, avoid: string | undefined): string | undefined {
  const own = typeof negativePrompt === 'string' ? negativePrompt : ''
  const have = new Set(phrases(own).map(phraseKey))
  const added: string[] = []
  for (const p of phrases(directionText(avoid))) {
    const key = phraseKey(p)
    if (have.has(key)) continue
    have.add(key)
    added.push(p)
  }
  if (!added.length) return own.trim() ? own : negativePrompt
  const trimmed = own.trimEnd().replace(/[,;]+$/u, '')
  return trimmed.trim() ? `${trimmed}, ${added.join(', ')}` : added.join(', ')
}

/** Whether params are a continuation in reference mode: the last reference image is the previous clip's frame. */
function endsOnContinuationFrame(params: Pick<GenerationParams, 'referenceImages'>): boolean {
  const refs = Array.isArray(params.referenceImages) ? params.referenceImages : []
  const last = refs[refs.length - 1]
  return typeof last === 'string' && (last === CONTINUATION_FRAME_PLACEHOLDER || isExtractedFrame(last))
}

/** The seconds a reference video's window sends as far as can be told without the file (asked or the default). */
const windowSeconds = (v: ReferenceVideo): number => referenceVideoWindow(v).length

/** Allowance for windows stored to the millisecond. */
const SECONDS_EPSILON = 0.005

/**
 * The params as they are sent when `director` directs them (see the top of this file): `director` set to its id, its
 * `avoid` merged into the negative prompt, its style frames after the reference images and its style videos after the
 * reference videos, as far as the mode, the model and its limits allow. The prompt itself is untouched: the Direction
 * section is appended when the prompt is composed (prompt-compose.ts, ComposeExtras.director). No director: the params
 * as they are. Idempotent.
 */
export function withDirection(
  params: GenerationParams,
  director: ResolvedDirector | undefined,
  facts: DirectionFacts = {}
): GenerationParams {
  if (!director) return params
  const out: GenerationParams = { ...params, director: director.id }
  const negative = mergeAvoid(params.negativePrompt, director.direction.avoid)
  if (negative !== params.negativePrompt) out.negativePrompt = negative

  const model = params.model
  if (
    director.styleFrames.length &&
    kindOfModelId(model) === 'reference-to-video' &&
    !facts.continuationFrame &&
    !endsOnContinuationFrame(params)
  ) {
    const refs = (Array.isArray(params.referenceImages) ? params.referenceImages : []).filter(
      (p): p is string => typeof p === 'string' && p !== ''
    )
    const have = new Set(refs.map(pathKey))
    const max = maxReferenceImages(model)
    const added: string[] = []
    for (const frame of director.styleFrames) {
      const key = pathKey(frame)
      if (have.has(key)) continue
      if (refs.length + added.length >= max) break
      have.add(key)
      added.push(frame)
    }
    if (added.length) out.referenceImages = [...refs, ...added]
  }

  const limits = referenceVideoLimits(model)
  if (director.styleVideos.length && limits && supportsReferenceVideos(model) && videosAreReferences(params)) {
    const own = referenceVideosOf(params)
    const have = new Set(own.map((v) => pathKey(v.path)))
    let count = own.length
    let total = own.slice(0, limits.maxVideos).reduce((sum, v) => sum + windowSeconds(v), 0)
    const added: ReferenceVideo[] = []
    for (const video of director.styleVideos) {
      const key = pathKey(video.path)
      if (have.has(key)) continue
      if (count >= limits.maxVideos) break
      const seconds = windowSeconds(video)
      if (seconds < limits.minSeconds - SECONDS_EPSILON || seconds > limits.maxSeconds + SECONDS_EPSILON) continue
      if (total + seconds > limits.maxTotalSeconds + SECONDS_EPSILON) continue
      have.add(key)
      count++
      total += seconds
      added.push({ ...video })
    }
    if (added.length) out.referenceVideos = [...own, ...added]
  }
  return out
}

/**
 * The params without what the director added (for "Use again", which shows the clip's own references): its style
 * frames and videos taken out of the references (by path) and its `avoid` phrases off the end of the negative prompt
 * (where mergeAvoid put them; one the clip had itself stays). The director's id is kept, so choosing it again sends the
 * same.
 */
export function withoutDirection(params: GenerationParams, director: ResolvedDirector | undefined): GenerationParams {
  if (!director) return params
  const frames = new Set(director.styleFrames.map(pathKey))
  const videos = new Set(director.styleVideos.map((v) => pathKey(v.path)))
  const out: GenerationParams = { ...params }
  if (Array.isArray(params.referenceImages) && frames.size) {
    const refs = params.referenceImages.filter((p) => typeof p !== 'string' || !frames.has(pathKey(p)))
    out.referenceImages = refs.length ? refs : undefined
  }
  if (params.referenceVideos && videos.size) {
    const kept = referenceVideosOf(params).filter((v) => !videos.has(pathKey(v.path)))
    out.referenceVideos = kept.length ? kept : undefined
  }
  // mergeAvoid appends the phrases the clip didn't have: those at the end that are the director's go, the clip's own stay.
  const avoid = new Set(phrases(directionText(director.direction.avoid)).map(phraseKey))
  if (avoid.size && params.negativePrompt) {
    const all = phrases(params.negativePrompt)
    let end = all.length
    while (end > 0 && avoid.has(phraseKey(all[end - 1]))) end--
    if (end < all.length) out.negativePrompt = end ? all.slice(0, end).join(', ') : undefined
  }
  return out
}

/** The 1-based numbers of the director's style frames among the reference images params send (within the model's cap). */
export function styleFrameNumbers(params: GenerationParams, director: ResolvedDirector | undefined): number[] {
  if (!director?.styleFrames.length || kindOfModelId(params.model) !== 'reference-to-video') return []
  const frames = new Set(director.styleFrames.map(pathKey))
  const refs = (Array.isArray(params.referenceImages) ? params.referenceImages : []).slice(
    0,
    maxReferenceImages(params.model)
  )
  const out: number[] = []
  refs.forEach((p, i) => {
    if (typeof p === 'string' && frames.has(pathKey(p))) out.push(i + 1)
  })
  return out
}

/** The 1-based numbers of the director's style videos among the reference videos params send (within the family's count). */
export function styleVideoNumbers(params: GenerationParams, director: ResolvedDirector | undefined): number[] {
  const limits = referenceVideoLimits(params.model)
  if (!director?.styleVideos.length || !limits || !videosAreReferences(params)) return []
  const videos = new Set(director.styleVideos.map((v) => pathKey(v.path)))
  const out: number[] = []
  referenceVideosOf(params)
    .slice(0, limits.maxVideos)
    .forEach((v, i) => {
      if (videos.has(pathKey(v.path))) out.push(i + 1)
    })
  return out
}

// ── The Direction section ────────────────────────────────────────────────────

/** The section's words per prompt language. */
const WORDS: Record<
  PromptLanguage,
  {
    heading: (name: string) => string
    parts: Record<DirectionPart, string>
    frames: (tokens: string[]) => string
    video: (token: string) => string
  }
> = {
  en: {
    heading: (name) => (name ? `Direction (${name}):` : 'Direction:'),
    parts: {
      editing: 'Editing',
      look: 'Look',
      camera: 'Camera',
      light: 'Light',
      framing: 'Framing',
      rhythm: 'Rhythm',
      performance: 'Performance',
      sound: 'Sound'
    },
    frames: (tokens) =>
      tokens.length === 1
        ? `Style frame (${tokens[0]}): match its look – grade, light, texture – never its people, places or objects.`
        : `Style frames (${tokens.join(', ')}): match their look – grade, light, texture – never their people, places or objects.`,
    video: (token) => `${token}: follow its camera movement only – not its people or places.`
  },
  sv: {
    heading: (name) => (name ? `Regi (${name}):` : 'Regi:'),
    parts: {
      editing: 'Klippning',
      look: 'Bildkänsla',
      camera: 'Kamera',
      light: 'Ljus',
      framing: 'Bildutsnitt',
      rhythm: 'Rytm',
      performance: 'Skådespel',
      sound: 'Ljud'
    },
    frames: (tokens) =>
      tokens.length === 1
        ? `Stilbild (${tokens[0]}): matcha dess bildkänsla – färgsättning, ljus, textur – aldrig dess personer, platser eller föremål.`
        : `Stilbilder (${tokens.join(', ')}): matcha deras bildkänsla – färgsättning, ljus, textur – aldrig deras personer, platser eller föremål.`,
    video: (token) => `${token}: följ bara dess kamerarörelse – inte dess personer eller platser.`
  }
}

/** The part's label in the UI language (English), for the editor and notes. */
export const DIRECTION_PART_LABELS: Readonly<Record<DirectionPart, string>> = WORDS.en.parts

/** A name as the heading writes it: one line, no "@", no brackets that would close the heading's own. */
function headingName(name: string): string {
  return directionText(name).replace(/[()]/g, '').trim()
}

/** "image" / "images" for notes. */
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Options for composeDirection. */
export interface DirectionSectionOptions {
  /** The prompt language: the heading's and labels' words. Default 'en'. */
  language?: PromptLanguage
  /**
   * The characters left for the section (with its "\n\n" in front) within the model's prompt limit; undefined: no
   * limit. Parts are left out from the end to fit; with no room even for the heading and the style lines, nothing is.
   */
  room?: number
  /** Nothing is appended (a blank prompt): the lines are listed, none of them sent. */
  blank?: boolean
}

/**
 * The Direction section `director` adds to params as sent (withDirection's output, after paramsForSubmit): a line per
 * part written in DIRECTION_PARTS order – `sound` only when the clip has sound (params.audio true) – then the style
 * frames' line and a line per style video, with their tokens among the references sent. See ComposedDirection; '' as
 * the section when nothing is written for this generation, the prompt is blank, or not even the heading and style lines
 * fit `room`.
 */
export function composeDirection(
  sent: GenerationParams,
  director: ResolvedDirector,
  opts: DirectionSectionOptions = {}
): ComposedDirection {
  const language: PromptLanguage = opts.language === 'sv' ? 'sv' : 'en'
  const words = WORDS[language]
  const direction = director.direction
  const notes: string[] = []

  const parts: { part: DirectionPart; text: string }[] = []
  for (const part of DIRECTION_PARTS) {
    const value = directionText(direction[part])
    if (!value) continue
    if (part === 'sound' && sent.audio !== true) {
      notes.push("Sound isn't sent: the clip is made without sound.")
      continue
    }
    parts.push({ part, text: `${words.parts[part]}: ${value}` })
  }

  const frameNumbers = styleFrameNumbers(sent, director)
  const videoNumbers = styleVideoNumbers(sent, director)
  const frameTokens = frameNumbers.map((n) => `@Image${n}`)
  const videoTokens = videoNumbers.map((n) => `@Video${n}`)
  const style: DirectionLine[] = []
  if (frameTokens.length) {
    style.push({ part: 'styleFrames', text: words.frames(frameTokens), tokens: frameTokens, sent: false })
  }
  for (const token of videoTokens) style.push({ part: 'styleVideo', text: words.video(token), tokens: [token], sent: false })

  // What of the style references isn't sent, and why.
  const framesLeft = director.styleFrames.length - frameNumbers.length
  if (framesLeft > 0) {
    const kind = kindOfModelId(sent.model)
    notes.push(
      kind !== 'reference-to-video'
        ? `The style frames aren't sent: only reference-to-video models take reference images.`
        : endsOnContinuationFrame(sent)
          ? "The style frames aren't sent with a clip that starts on the previous clip's last frame."
          : `${plural(framesLeft, "style frame isn't", "style frames aren't")} sent: the model takes at most ${maxReferenceImages(sent.model)} reference images.`
    )
  }
  const videosLeft = director.styleVideos.length - videoNumbers.length
  if (videosLeft > 0) {
    const limits = referenceVideoLimits(sent.model)
    notes.push(
      !limits || !videosAreReferences(sent)
        ? "The style videos aren't sent: only Seedance 2.x reference-to-video takes reference videos."
        : `${plural(videosLeft, "style video isn't", "style videos aren't")} sent: ${limits.family} takes at most ${limits.maxVideos} reference videos of ${limits.minSeconds}–${limits.maxSeconds} s, ${limits.maxTotalSeconds} s together.`
    )
  }

  const heading = `\n\n${words.heading(headingName(director.name))}`
  const lineLength = (text: string): number => 3 + text.length // "\n- "
  const all: DirectionLine[] = [...parts.map((p) => ({ part: p.part, text: p.text, sent: false })), ...style]
  const empty = (dropped: boolean): ComposedDirection => ({
    directorId: director.id,
    name: headingName(director.name),
    section: '',
    lines: all,
    droppedParts: dropped ? parts.map((p) => p.part) : [],
    styleFrames: frameTokens,
    styleVideos: videoTokens,
    notes: dropped
      ? [...notes, "The direction isn't appended: the model's prompt limit leaves no room for it. Shorten the prompt."]
      : notes,
    dropped
  })
  if (!all.length || opts.blank) return empty(false)

  const room = typeof opts.room === 'number' && Number.isFinite(opts.room) ? opts.room : Infinity
  const fixed = heading.length + style.reduce((sum, l) => sum + lineLength(l.text), 0)
  if (fixed > room || (!style.length && parts.length && fixed + lineLength(parts[0].text) > room)) return empty(true)

  // Parts from the start while they fit; the rest are left out (from the end).
  let used = fixed
  let kept = 0
  for (const p of parts) {
    if (used + lineLength(p.text) > room) break
    used += lineLength(p.text)
    kept++
  }
  const droppedParts = parts.slice(kept).map((p) => p.part)
  if (droppedParts.length) {
    notes.push(
      `Left out to fit the model's prompt limit: ${droppedParts.map((p) => DIRECTION_PART_LABELS[p]).join(', ')}.`
    )
  }
  const lines: DirectionLine[] = [
    ...parts.map((p, i) => ({ part: p.part, text: p.text, sent: i < kept })),
    ...style.map((l) => ({ ...l, sent: true }))
  ]
  const section = heading + lines.filter((l) => l.sent).map((l) => `\n- ${l.text}`).join('')
  return {
    directorId: director.id,
    name: headingName(director.name),
    section,
    lines,
    droppedParts,
    styleFrames: frameTokens,
    styleVideos: videoTokens,
    notes,
    dropped: false
  }
}

// ── Stills (Create image…) ───────────────────────────────────────────────────

/**
 * What a director adds to a picture made for a storyboard's board or a sequence (Create image…): image prompts are
 * English and never carry tokens, so only its look, light and framing go along as plain text ("Look: …. Light: ….
 * Framing: …."), and its `avoid` as the negative prompt's addition. '' / undefined for what it doesn't have.
 */
export function imageDirection(director: ResolvedDirector | undefined): { text: string; avoid?: string } {
  if (!director) return { text: '' }
  const d = director.direction
  const text = (['look', 'light', 'framing'] as const)
    .map((part) => {
      const value = directionText(d[part]).replace(/[.\s]+$/u, '')
      return value ? `${WORDS.en.parts[part]}: ${value}.` : ''
    })
    .filter(Boolean)
    .join(' ')
  const avoid = directionText(d.avoid)
  return { text, ...(avoid ? { avoid } : {}) }
}

/**
 * An image prompt (and its negative prompt) with the director's look, light and framing appended after a blank line,
 * and its `avoid` merged into the negative prompt (imageDirection, mergeAvoid). Unchanged without a director.
 */
export function withImageDirection(
  prompt: string,
  negativePrompt: string | undefined,
  director: ResolvedDirector | undefined
): { prompt: string; negativePrompt?: string } {
  const { text, avoid } = imageDirection(director)
  const own = typeof prompt === 'string' ? prompt.trimEnd() : ''
  const merged = mergeAvoid(negativePrompt, avoid)
  return {
    prompt: text && own ? `${own}\n\n${text}` : typeof prompt === 'string' ? prompt : '',
    ...(merged ? { negativePrompt: merged } : {})
  }
}

// ── Defaults on choosing a director ──────────────────────────────────────────

/**
 * What choosing a director sets (Direction.defaults): the model when the list offers it, then the aspect ratio and the
 * resolution when that model offers them. Only what changes is returned; `models` is the video model list (an empty
 * list: nothing is checked, nothing set). The window's form, a sequence's and a storyboard's defaults all use it.
 */
export function directorDefaults(
  current: Pick<GenerationParams, 'model'> & Partial<Pick<GenerationParams, 'aspectRatio' | 'resolution'>>,
  direction: Direction | undefined,
  models: readonly Pick<VideoModel, 'id' | 'aspectRatios' | 'resolutions'>[]
): Partial<Pick<GenerationParams, 'model' | 'aspectRatio' | 'resolution'>> {
  const wanted = direction?.defaults
  if (!wanted || !models.length) return {}
  const out: Partial<Pick<GenerationParams, 'model' | 'aspectRatio' | 'resolution'>> = {}
  const chosen = wanted.model ? models.find((m) => m.id === wanted.model) : undefined
  if (chosen && chosen.id !== current.model) out.model = chosen.id
  const model = chosen ?? models.find((m) => m.id === current.model)
  if (!model) return out
  if (wanted.aspectRatio && wanted.aspectRatio !== current.aspectRatio && model.aspectRatios.includes(wanted.aspectRatio)) {
    out.aspectRatio = wanted.aspectRatio
  }
  if (wanted.resolution && wanted.resolution !== current.resolution && model.resolutions.includes(wanted.resolution)) {
    out.resolution = wanted.resolution
  }
  return out
}

/**
 * The duration a director's shot length asks for among a model's durations ("4s", "5s" …): the nearest one (the
 * shorter on a tie); undefined without a shot length or durations.
 */
export function shotDuration(shotSeconds: number | undefined, durations: readonly string[]): string | undefined {
  if (typeof shotSeconds !== 'number' || !Number.isFinite(shotSeconds) || !durations.length) return undefined
  let best: string | undefined
  let bestGap = Infinity
  for (const d of durations) {
    const seconds = durationSeconds(d)
    if (!(seconds > 0)) continue
    const gap = Math.abs(seconds - shotSeconds)
    if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) < 1e-9 && best !== undefined && seconds < durationSeconds(best))) {
      best = d
      bestGap = gap
    }
  }
  return best
}

/**
 * Whether a new clip of a sequence directed by this director continues from the previous clip: true for 'flow', false
 * for 'cut', undefined when the director leaves it to the sequence.
 */
export function continuesByDefault(direction: Direction | undefined): boolean | undefined {
  return direction?.continuity === 'flow' ? true : direction?.continuity === 'cut' ? false : undefined
}
