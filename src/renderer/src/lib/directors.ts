// Directors as the window shows them: the user's own (assets of kind 'director') and the ready-made ones
// (shared/directors.ts), the wording of each part of a direction, and how a direction is summed up in a line. What a
// director sends with a clip (the Direction section, the negative prompt, the style references) is the shared
// direction.ts's, which the form, the sequences and the approval dialog all go through. Pure: no React.

import {
  effectiveDirectorId,
  resolveDirector,
  withDirection,
  type DirectionFacts,
  type ResolvedDirector
} from '@shared/direction'
import { DIRECTOR_PRESETS, directorPreset } from '@shared/directors'
import {
  DIRECTOR_PRESET_PREFIX,
  type Asset,
  type Direction,
  type DirectionPart,
  type DirectorPreset,
  type GenerationParams
} from '@shared/types'

/** A director's id is a ready-made one's ("preset:noir"), not an asset's. */
export function isPresetId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DIRECTOR_PRESET_PREFIX)
}

/** One director, own or ready-made, as the lists, pickers and chips show it. */
export interface DirectorEntry {
  /** The asset's id, or the ready-made one's ("preset:…"). */
  id: string
  name: string
  /** One line: what it is good for. */
  description: string
  direction: Direction
  /** Ready-made: read-only, copied into the library to be changed. */
  preset: boolean
  /** The user's own: the asset (its photos are the style frames). */
  asset?: Asset
}

/** The ready-made directors, in their order. */
export function presetEntries(): DirectorEntry[] {
  return DIRECTOR_PRESETS.map(presetEntry)
}

function presetEntry(p: DirectorPreset): DirectorEntry {
  return { id: p.id, name: p.name, description: p.description, direction: p.direction, preset: true }
}

function ownEntry(a: Asset): DirectorEntry {
  return { id: a.id, name: a.name, description: a.description, direction: a.direction ?? {}, preset: false, asset: a }
}

/** The user's own directors (by name), then the ready-made ones. `assets`: the library, any kinds. */
export function directorEntries(assets: readonly Asset[]): DirectorEntry[] {
  const own = assets
    .filter((a) => a.kind === 'director')
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map(ownEntry)
  return [...own, ...presetEntries()]
}

/** The director with this id (own or ready-made); undefined when it doesn't exist (any more). */
export function directorById(id: string | null | undefined, assets: readonly Asset[]): DirectorEntry | undefined {
  if (!id) return undefined
  if (isPresetId(id)) {
    const p = directorPreset(id)
    return p && presetEntry(p)
  }
  const a = assets.find((x) => x.id === id && x.kind === 'director')
  return a && ownEntry(a)
}

// ── The parts ────────────────────────────────────────────────────────────────

/** The text fields of a direction, in the editor's order: the Direction section's parts, then what it avoids. */
export type DirectionField = DirectionPart | 'avoid'

export const DIRECTION_FIELDS: readonly DirectionField[] = [
  'editing',
  'look',
  'camera',
  'light',
  'framing',
  'rhythm',
  'performance',
  'sound',
  'avoid'
]

export interface FieldCopy {
  label: string
  /** What the part is about: its label's tooltip (and what a screen reader hears with the field). */
  hint: string
  /** A short rule shown beside the label, where the part works differently from the others. */
  note?: string
  placeholder: string
  /** The building-block group (shared/prompt-blocks.ts) its quick-add chip opens, where there is one. */
  blocks?: string
}

export const FIELD_COPY: Record<DirectionField, FieldCopy> = {
  editing: {
    label: 'Editing',
    hint: 'Pace, shot length, cuts, long takes',
    placeholder: 'Unhurried; long takes, hard cuts on movement, no dissolves…'
  },
  look: {
    label: 'Look',
    hint: 'Grade, contrast, grain, era, palette',
    placeholder: 'Muted teal and amber grade, soft contrast, fine 35mm grain…',
    blocks: 'style'
  },
  camera: {
    label: 'Camera',
    hint: 'Movement, lenses, angles',
    placeholder: 'Handheld at shoulder height, 35mm lens, follows the subject…',
    blocks: 'camera'
  },
  light: {
    label: 'Light',
    hint: 'Key, sources, hard or soft',
    placeholder: 'Low key, practical lamps in frame, hard side light…',
    blocks: 'light'
  },
  framing: {
    label: 'Framing',
    hint: 'Shot sizes and their order, composition',
    placeholder: 'Wide to establish, then medium shots and close-ups; centred, symmetric…',
    blocks: 'framing'
  },
  rhythm: {
    label: 'Rhythm',
    hint: 'Tempo, slow motion, speed ramps, stillness',
    placeholder: 'Slow and deliberate, moments of stillness, no slow motion…',
    blocks: 'motion'
  },
  performance: {
    label: 'Performance',
    hint: 'How the actors play',
    placeholder: 'Naturalistic and understated, small gestures, glances instead of words…'
  },
  sound: {
    label: 'Sound',
    hint: 'Music, ambience, silence',
    note: 'Only for clips with sound',
    placeholder: 'Only natural ambient sound, no score…',
    blocks: 'sound'
  },
  avoid: {
    label: 'Avoid',
    hint: 'What it never does',
    note: 'Added to the negative prompt',
    placeholder: 'Shaky zooms, lens flares, oversaturated colours…',
    blocks: 'avoid'
  }
}

/** The text of a field of a direction ('' when it isn't written). */
export function fieldText(direction: Direction | undefined, field: DirectionField): string {
  const text = direction?.[field]
  return typeof text === 'string' ? text : ''
}

/** The fields that are written, in order. */
export function writtenFields(direction: Direction | undefined): DirectionField[] {
  return DIRECTION_FIELDS.filter((f) => fieldText(direction, f).trim() !== '')
}

// ── Lines about a director ───────────────────────────────────────────────────

/** "1 style frame", "3 style frames". */
export function styleFrameCount(n: number): string {
  return `${n} style ${n === 1 ? 'frame' : 'frames'}`
}

/** "1 style video", "2 style videos". */
export function styleVideoCount(n: number): string {
  return `${n} style ${n === 1 ? 'video' : 'videos'}`
}

/** "3 style frames", "1 style video": what a director has of each, the ones it has none of left out. */
export function directorMediaCounts(frames: number, videos: number): string[] {
  return [frames ? styleFrameCount(frames) : '', videos ? styleVideoCount(videos) : ''].filter(Boolean)
}

/** What "between shots" is, in words: "Hard cuts", "Flows on", or nothing (the sequence's own). */
export function continuityText(continuity: Direction['continuity']): string | undefined {
  return continuity === 'cut' ? 'Hard cuts' : continuity === 'flow' ? 'Each shot flows on' : undefined
}

/**
 * One line about a director for a list row: its own description, else the parts it writes ("Look, camera,
 * light"), with its style frames and videos.
 */
export function directorSummary(entry: DirectorEntry): string {
  const media = directorMediaCounts(entry.asset?.images.length ?? 0, entry.direction.videos?.length ?? 0)
  const description = entry.description.trim()
  if (description) return [description, ...media].join(' · ')
  const parts = writtenFields(entry.direction).map((f) => FIELD_COPY[f].label.toLowerCase())
  const what = parts.length
    ? `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''}`
    : 'Nothing written yet'
  return [what, ...media].join(' · ')
}

/** "Model, aspect ratio and resolution" – which defaults a direction sets, for hints; undefined when none. */
export function defaultsText(direction: Direction | undefined, modelName?: (id: string) => string): string | undefined {
  const d = direction?.defaults
  if (!d) return undefined
  const parts = [
    d.model ? (modelName?.(d.model) ?? d.model) : '',
    d.aspectRatio ?? '',
    d.resolution ?? ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

// ── The library's directors, known to pure code ─────────────────────────────
// What a sequence clip sends (sequenceUtils' effectiveParams) is worked out in plain functions far from any React
// state. They read the user's own directors from here, as models.ts' rememberModelKinds does for the model list:
// every load of the library's assets (lib/hooks) records them, and the views that price or check a clip subscribe.

let knownDirectors: readonly Asset[] = []
const directorListeners = new Set<() => void>()

/** Records the user's own directors from a list of the library's assets (all kinds, or only directors). */
export function rememberDirectors(assets: readonly Asset[]): void {
  const directors = assets.filter((a) => a.kind === 'director')
  const same =
    directors.length === knownDirectors.length &&
    directors.every((a, i) => a.id === knownDirectors[i].id && a.updatedAt === knownDirectors[i].updatedAt)
  if (same) return
  knownDirectors = directors
  for (const listener of [...directorListeners]) listener()
}

/** The user's own directors as last loaded. */
export function directorAssets(): readonly Asset[] {
  return knownDirectors
}

/** Subscribes to directorAssets (for useSyncExternalStore). */
export function subscribeDirectors(listener: () => void): () => void {
  directorListeners.add(listener)
  return () => directorListeners.delete(listener)
}

// ── What a director sends ────────────────────────────────────────────────────

/**
 * The director that directs params: their own (params.director), none for null, else `owner`'s (a sequence's or a
 * storyboard's director; Generate has none). Resolved from the library or the ready-made ones, as main resolves it.
 */
export function directorOf(
  params: Pick<GenerationParams, 'director'>,
  assets: readonly Asset[],
  owner?: string
): ResolvedDirector | undefined {
  return resolveDirector(effectiveDirectorId(params.director, owner), assets)
}

/**
 * The params as they are sent with their director (shared withDirection: its `avoid` in the negative prompt, its style
 * frames and videos after the references) – what the window prices and checks, as main does. Unchanged without one.
 */
export function directedParams(
  params: GenerationParams,
  assets: readonly Asset[],
  owner?: string,
  facts?: DirectionFacts
): GenerationParams {
  return withDirection(params, directorOf(params, assets, owner), facts)
}

/** A director's name for a chip or a line ("a deleted director" when the id names none any more). */
export function directorName(id: string | undefined, assets: readonly Asset[]): string | undefined {
  if (!id) return undefined
  return directorById(id, assets)?.name ?? 'a deleted director'
}
