import { basename } from 'node:path'
import {
  DEFAULT_MODEL,
  KINDS,
  MAX_REFERENCE_AUDIO_SECONDS,
  MIN_AUDIO_CLIP_SECONDS,
  imageToVideoVariant,
  isAudioClipTooShort,
  kindOfModelId,
  maxReferenceAudios,
  maxReferenceImages,
  paramsForSubmit,
  referenceAudioWindow,
  referenceVideoLimits,
  referenceVideosOf,
  referenceVideoWindow,
  supportsAudioInput,
  supportsEndImage,
  supportsReferenceVideos,
  type Kind,
  type ReferenceVideoLimits
} from '@shared/models'
import { outfitWearersAmong, withOutfitWearer } from '@shared/outfits'
import {
  composePrompt,
  describedAssets,
  explainedReferences,
  includesDescriptions,
  promptLimitOf,
  rememberPromptLimits,
  type ComposedPrompt
} from '@shared/prompt-compose'
import {
  blockingContinuationError,
  blockingPromptError,
  canonicalizeTokens,
  validateGenerationParams,
  type PromptIssue
} from '@shared/prompt-refs'
import {
  NEEDS_CONSENT,
  type Asset,
  type AssetAudio,
  type AssetFileOrigin,
  type AssetKind,
  type GenerationParams,
  type ReferenceAudio,
  type ReferenceVideo,
  type Still,
  type VideoModel
} from '@shared/types'
import * as db from '../db'
import { directParams } from '../directors'
import { generationTitle } from '@shared/generation-label'
import { composeSubmission } from '../jobs'
import { isLibraryReady, toStoredPath } from '../paths'
import { knownVideoDuration } from '../reference-videos'
import { activeServiceName, getPromptLanguage } from '../settings'
import { callService } from './local-ipc'

// What the agent tools share: the library check, looking up assets with their photos and audio clips, the token
// maps (@ImageN → which photo of which asset, @AudioN → which voice or soundscape), the model list and its
// options, and the prompt checks.

export const NO_LIBRARY =
  'Studio has no library open. The user needs to choose a library folder in Studio before you can work there.'

/** Throws unless a library is open; tools that read or change it call this first. */
export function requireLibrary(): void {
  if (!isLibraryReady()) throw new Error(NO_LIBRARY)
}

export const MODES = KINDS.map((k) => k.id) as [Kind, ...Kind[]]

/** "2026-10-06 19:42" in local time, the way the user reads times in Studio. */
export function localTime(ms: number | undefined): string | undefined {
  if (!ms) return undefined
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Seconds to one decimal, for answers and captions ("2.4"). */
export function seconds(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * A "generate all" run error as an agent should read it. A run stopped by Venice asking for consent carries the
 * raw consent request ("Clip 2: NEEDS_CONSENT:{…}") for the window, which asks the user and restarts the run.
 */
export function readableRunError(error: string | undefined): string | undefined {
  if (!error) return undefined
  const at = error.indexOf(NEEDS_CONSENT)
  if (at < 0) return error
  return `${error.slice(0, at)}Venice wants the user to accept the model's terms before the clip can be generated. That is done in Studio under Sequences (“Generate missing”).`
}

/** "Anna" → "“Anna”", for names in messages. */
export const q = (name: string): string => `“${name}”`

// ── Assets, their photos and their audio clips ───────────────────────────────

export interface PhotoRef {
  asset: Asset
  /** 1-based, as "photo 2" in Studio. */
  photoNumber: number
  imageId: string
}

export interface AudioRef {
  asset: Asset
  /** 1-based, in the asset's order (clip 1 is the one added by default). */
  clipNumber: number
  audio: AssetAudio
}

const pathKey = (path: string): string => path.normalize('NFC')

/** The clips of an asset; [] for kinds without audio (and for rows from before audio existed). */
export const audioOf = (asset: Asset): AssetAudio[] => asset.audio ?? []

/** What an asset's audio is to the model: a character's voice, an environment's soundscape. */
export function audioRole(kind: AssetKind | undefined): 'voice' | 'soundscape' | 'sound' {
  return kind === 'character' ? 'voice' : kind === 'environment' ? 'soundscape' : 'sound'
}

/** Every asset, found by id, by the path or id of one of its photos or audio clips. */
export class AssetIndex {
  private readonly byId = new Map<string, Asset>()
  private readonly byPath = new Map<string, PhotoRef>()
  private readonly byImageId = new Map<string, PhotoRef & { path: string }>()
  private readonly byAudioPath = new Map<string, AudioRef>()
  private readonly byAudioId = new Map<string, AudioRef>()

  constructor(readonly assets: Asset[]) {
    for (const asset of assets) {
      this.byId.set(asset.id, asset)
      asset.images.forEach((image, i) => {
        const ref = { asset, photoNumber: i + 1, imageId: image.id }
        this.byPath.set(pathKey(image.path), ref)
        this.byImageId.set(image.id, { ...ref, path: image.path })
      })
      audioOf(asset).forEach((audio, i) => {
        const ref = { asset, clipNumber: i + 1, audio }
        this.byAudioPath.set(pathKey(audio.path), ref)
        this.byAudioId.set(audio.id, ref)
      })
    }
  }

  static async load(): Promise<AssetIndex> {
    requireLibrary()
    return new AssetIndex(await callService<Asset[]>('assets:list'))
  }

  get(id: string): Asset | undefined {
    return this.byId.get(id)
  }

  require(id: string): Asset {
    const asset = this.byId.get(id)
    if (!asset) {
      throw new Error(
        `There is no character, environment, product, outfit, pose or director with id ${id}. Use list_assets to see what there is.`
      )
    }
    return asset
  }

  photo(path: string | undefined): PhotoRef | undefined {
    return path ? this.byPath.get(pathKey(path)) : undefined
  }

  /** A photo of any asset by its image_id; undefined when there is none. */
  image(imageId: string): (PhotoRef & { path: string }) | undefined {
    return this.byImageId.get(imageId)
  }

  /** A photo of any asset by its image_id. */
  requireImage(imageId: string): PhotoRef & { path: string } {
    const ref = this.byImageId.get(imageId)
    if (!ref) {
      throw new Error(
        `There is no image with id ${imageId} among the characters, environments, products, outfits and poses. The images' ids are in image_ids from list_assets or get_asset.`
      )
    }
    return ref
  }

  audio(path: string | undefined): AudioRef | undefined {
    return path ? this.byAudioPath.get(pathKey(path)) : undefined
  }

  audioById(id: string): AudioRef | undefined {
    return this.byAudioId.get(id)
  }

  requireAudio(id: string): AudioRef {
    const ref = this.byAudioId.get(id)
    if (!ref) {
      throw new Error(`There is no audio clip with id ${id}. The audio clips' ids are in audio from list_assets or get_asset.`)
    }
    return ref
  }
}

/** A picture as the agent sees it: which photo of which asset, or just a file name for other pictures. */
export interface PictureInfo {
  asset_id?: string
  asset_name?: string
  kind?: AssetKind
  photo_number?: number
  image_id?: string
  /** For pictures that aren't library photos (e.g. copied in from elsewhere). */
  file?: string
}

export function describePicture(path: string, index: AssetIndex): PictureInfo {
  const ref = index.photo(path)
  if (!ref) return { file: basename(path) }
  return {
    asset_id: ref.asset.id,
    asset_name: ref.asset.name,
    kind: ref.asset.kind,
    photo_number: ref.photoNumber,
    image_id: ref.imageId
  }
}

// ── Stills (the pictures of a sequence or a storyboard) ──────────────────────

/** Stills by id and by file path. */
export class StillIndex {
  private readonly byId = new Map<string, Still>()
  private readonly byPath = new Map<string, Still>()

  constructor(readonly stills: Still[]) {
    for (const still of stills) {
      this.byId.set(still.id, still)
      this.byPath.set(pathKey(still.path), still)
    }
  }

  /** Every still in the library: of every sequence and storyboard, and those that belong to none any more. */
  static async load(): Promise<StillIndex> {
    requireLibrary()
    return new StillIndex(await callService<Still[]>('stills:list'))
  }

  get(id: string): Still | undefined {
    return this.byId.get(id)
  }

  require(id: string): Still {
    const still = this.byId.get(id)
    if (!still) throw new Error(`There is no still image with id ${id}. list_stills shows which there are.`)
    return still
  }

  atPath(path: string | undefined): Still | undefined {
    return path ? this.byPath.get(pathKey(path)) : undefined
  }
}

/** A clip's start or end picture as the tools show it: which still or library photo it is. */
export function imageRef(path: string, assets: AssetIndex, stills: StillIndex): Record<string, unknown> {
  const still = stills.atPath(path)
  if (still) return { kind: 'image', still_id: still.id, still_source: still.source, file: basename(path), path }
  const photo = assets.photo(path)
  if (photo) {
    return {
      kind: 'image',
      asset_image_id: photo.imageId,
      asset_id: photo.asset.id,
      asset_name: photo.asset.name,
      asset_kind: photo.asset.kind,
      photo_number: photo.photoNumber,
      path
    }
  }
  return { kind: 'image', file: basename(path), path }
}

export type TokenEntry = { token: string } & PictureInfo

/** What each @ImageN points at: @Image1 is the first reference image, and so on. */
export function tokenMap(paths: readonly string[] | undefined, index: AssetIndex): TokenEntry[] {
  return (paths ?? []).map((path, i) => ({ token: `@Image${i + 1}`, ...describePicture(path, index) }))
}

/** A reference audio clip as the agent sees it: whose voice (or which place's sound), and the window sent. */
export interface AudioInfo {
  asset_id?: string
  asset_name?: string
  kind?: AssetKind
  /** voice (a character's), soundscape (an environment's) or sound. */
  role?: string
  clip_number?: number
  audio_id?: string
  /** For audio that isn't one of the library's clips. */
  file?: string
  /** The window that is sent: seconds into the file, and how long. */
  start: number
  length: number
}

/**
 * The window of a reference audio clip in seconds, as it is sent (the shared rule, with the file's duration when
 * it is one of the library's clips).
 */
export function audioWindow(ref: ReferenceAudio, index: AssetIndex): { start: number; length: number } {
  return referenceAudioWindow(ref, index.audio(ref.path)?.audio.duration)
}

export function describeAudio(ref: ReferenceAudio, index: AssetIndex): AudioInfo {
  const found = index.audio(ref.path)
  const { start, length } = audioWindow(ref, index)
  const window = { start: seconds(start), length: seconds(length) }
  if (!found) return { file: basename(ref.path), ...window }
  return {
    asset_id: found.asset.id,
    asset_name: found.asset.name,
    kind: found.asset.kind,
    role: audioRole(found.asset.kind),
    clip_number: found.clipNumber,
    audio_id: found.audio.id,
    ...window
  }
}

export type AudioTokenEntry = { token: string } & AudioInfo

/** What each @AudioN points at: @Audio1 is the first reference audio clip, and so on. */
export function audioTokenMap(audios: readonly ReferenceAudio[] | undefined, index: AssetIndex): AudioTokenEntry[] {
  return (audios ?? []).map((ref, i) => ({ token: `@Audio${i + 1}`, ...describeAudio(ref, index) }))
}

/** Total seconds of the audio windows that are sent. */
export function audioSeconds(audios: readonly ReferenceAudio[] | undefined, index: AssetIndex): number {
  return (audios ?? []).reduce((sum, ref) => sum + audioWindow(ref, index).length, 0)
}

/** An asset clip as a reference: its reference window, which is what Venice gets. */
export function referenceAudioOf(audio: AssetAudio): ReferenceAudio {
  return { path: audio.path, start: audio.clipStart, length: audio.clipLength }
}

/**
 * A reference video as the agent sees it (@VideoN, Seedance 2.x): which film it is – a generation (a take, a clip
 * from the feed, an own clip, a version: generation_id), an exported film (export_id) or a file copied in from an
 * upload – and the window that is sent.
 */
export interface VideoInfo {
  generation_id?: string
  export_id?: string
  /** A generation's title (its prompt, or an own clip's or version's name); an export's sequence. */
  title?: string
  file: string
  /** The window that is sent: seconds into the file, and how long. */
  start: number
  length: number
  /** The file's length, when Studio has measured it. */
  duration?: number
}

/** The generation or export whose file this is (by its stored path, letter case ignored), if any. */
function videoSource(path: string): { generationId?: string; exportId?: string; title?: string; duration?: number } {
  if (!db.isDbOpen()) return {}
  try {
    const stored = toStoredPath(path)
    const g = db
      .getDb()
      .prepare('SELECT id FROM generations WHERE file_path = ? COLLATE NOCASE LIMIT 1')
      .pluck()
      .get(stored) as string | undefined
    if (g) {
      const generation = db.getGeneration(g)
      return generation
        ? {
            generationId: generation.id,
            title: generationTitle(generation).slice(0, 120),
            ...(generation.videoDuration ? { duration: generation.videoDuration } : {})
          }
        : {}
    }
    const e = db
      .getDb()
      .prepare(
        `SELECT e.id, s.name FROM exports e LEFT JOIN sequences s ON s.id = e.sequence_id
         WHERE e.file_path = ? COLLATE NOCASE LIMIT 1`
      )
      .get(stored) as { id: string; name: string | null } | undefined
    return e ? { exportId: e.id, ...(e.name ? { title: e.name } : {}) } : {}
  } catch {
    return {}
  }
}

/** The window of a reference video in seconds, as it is sent (the shared rule, with the file's length when known). */
export function videoWindow(ref: ReferenceVideo): { start: number; length: number } {
  return referenceVideoWindow(ref, knownVideoDuration(ref.path) ?? videoSource(ref.path).duration)
}

export function describeVideo(ref: ReferenceVideo): VideoInfo {
  const source = videoSource(ref.path)
  const duration = knownVideoDuration(ref.path) ?? source.duration
  const { start, length } = referenceVideoWindow(ref, duration)
  return {
    ...(source.generationId ? { generation_id: source.generationId } : {}),
    ...(source.exportId ? { export_id: source.exportId } : {}),
    ...(source.title ? { title: source.title } : {}),
    file: basename(ref.path),
    start: seconds(start),
    length: seconds(length),
    ...(duration ? { duration: seconds(duration) } : {})
  }
}

export type VideoTokenEntry = { token: string } & VideoInfo

/** What each @VideoN points at: @Video1 is the first reference video, and so on. */
export function videoTokenMap(videos: readonly ReferenceVideo[] | undefined): VideoTokenEntry[] {
  return (videos ?? []).map((ref, i) => ({ token: `@Video${i + 1}`, ...describeVideo(ref) }))
}

/** Total seconds of the reference video windows that are sent. */
export function videoSeconds(videos: readonly ReferenceVideo[] | undefined): number {
  return (videos ?? []).reduce((sum, ref) => sum + videoWindow(ref).length, 0)
}

/** `added_by` for a photo or clip an agent added (the agent, and the host a fetched file came from); {} otherwise. */
export function addedBy(origin: AssetFileOrigin | undefined): Record<string, unknown> {
  return origin ? { added_by: { agent: origin.agent, ...(origin.host ? { host: origin.host } : {}) } } : {}
}

/** An asset's audio clips as the tools list them. */
export function audioClipsInfo(asset: Asset): Record<string, unknown>[] {
  return audioOf(asset).map((a, i) => ({
    audio_id: a.id,
    clip_number: i + 1,
    role: audioRole(asset.kind),
    file: basename(a.path),
    duration: seconds(a.duration),
    clip_start: seconds(a.clipStart),
    clip_length: seconds(a.clipLength),
    // Only a character's voice can be cloned for new lines, and only once the user ticked that they may use it.
    ...(asset.kind === 'character' ? { clone_consent: a.cloneConsent === true } : {}),
    ...addedBy(a.origin)
  }))
}

// ── Choosing references ──────────────────────────────────────────────────────

export interface AssetReferenceItem {
  asset_id: string
  /** Only these photos, in this order; [] for none of the asset's photos (e.g. only its voice). */
  image_ids?: string[]
  /** Only these audio clips, in this order. */
  audio_ids?: string[]
  /** Add the asset's first audio clip when no audio_ids are given. Default: characters yes, others no. */
  include_voice?: boolean
}

/**
 * One loose picture as a reference, already resolved to its file: a still's picture, or an upload made a still. It
 * has no description, so the References legend says nothing about it.
 */
export interface PictureReferenceItem {
  picture: string
}

/**
 * A reference video (@VideoN), already resolved to its file and window: a generation's or an export's film, or an
 * upload copied into Reference images (sources.ts resolvePictureReferences).
 */
export interface VideoReferenceItem {
  video: ReferenceVideo
}

export type ReferenceItem = AssetReferenceItem | PictureReferenceItem | VideoReferenceItem

/** What the references are chosen for: whether the model takes reference audio, and how much. */
export interface AudioTarget {
  /** The model's name for messages. */
  modelLabel: string
  audioInput: boolean
  /** maxReferenceAudios of the model. */
  maxAudios: number
  /** Audio already in place (the form's, when appending); counted against the limits. */
  existing?: readonly ReferenceAudio[]
  /** Whether the model takes reference videos (@VideoN: Seedance 2.x reference-to-video). */
  videoInput?: boolean
  /** Its family's reference video limits (referenceVideoLimits). */
  videoLimits?: ReferenceVideoLimits
  /** Reference videos already in place (the form's, when appending); counted against the limits. */
  existingVideos?: readonly ReferenceVideo[]
  /**
   * false: keep every clip asked for even past the model's limits, so a check (validate_prompt) reports the
   * proposal as it is rather than a trimmed one. Default true.
   */
  enforceLimits?: boolean
}

export interface ResolvedReferences {
  /** Photo paths in @Image order, without duplicates. */
  paths: string[]
  /** Audio windows in @Audio order (after any existing ones), without duplicates, within the limits. */
  audios: ReferenceAudio[]
  /** Clips that were asked for (or would have been added by default) but don't fit, and why. */
  skippedAudio: (AudioInfo & { reason: string })[]
  /** Reference videos in @Video order (after any existing ones), without duplicates, within the limits. */
  videos: ReferenceVideo[]
  /** Videos that were asked for but don't fit the model family's limits, and why. */
  skippedVideos: (VideoInfo & { reason: string })[]
  /** What was decided on the agent's behalf, e.g. a voice left out because the model takes none. */
  notes: string[]
}

function chosenImages(asset: Asset, item: AssetReferenceItem): Asset['images'] {
  if (item.image_ids === undefined) return asset.images
  return item.image_ids.map((imageId) => {
    const image = asset.images.find((img) => img.id === imageId)
    if (!image) {
      throw new Error(
        `The image ${imageId} doesn't belong to ${q(asset.name)}. The images' ids are in image_ids from list_assets or get_asset.`
      )
    }
    return image
  })
}

/**
 * The clips an item asks for. `tooShort` collects a voice that would have come along by default but is too short
 * for Venice to take: added, it would only make every check (and the paid call) refuse the form or the clip.
 */
function chosenAudio(
  asset: Asset,
  item: AssetReferenceItem,
  target: AudioTarget | undefined,
  notes: string[],
  tooShort: AssetAudio[]
): AssetAudio[] {
  const clips = audioOf(asset)
  if (item.audio_ids?.length) {
    const chosen = item.audio_ids.map((audioId) => {
      const clip = clips.find((a) => a.id === audioId)
      if (!clip) {
        throw new Error(
          `The audio clip ${audioId} doesn't belong to ${q(asset.name)}. The audio clips' ids are in audio from list_assets or get_asset.`
        )
      }
      return clip
    })
    if (target && !target.audioInput) {
      throw new Error(
        `${target.modelLabel} doesn't take audio references (@Audio1 …). Remove audio_ids, or choose a model with audio_input: true in list_models.`
      )
    }
    return chosen
  }
  const wanted = item.include_voice ?? asset.kind === 'character'
  if (!wanted || !clips.length) {
    if (item.include_voice === true && !clips.length) {
      notes.push(`${q(asset.name)} has no audio clip yet, so no sound was added.`)
    }
    return []
  }
  if (target && !target.audioInput) {
    if (item.include_voice === true) {
      throw new Error(
        `${target.modelLabel} doesn't take audio references (@Audio1 …). Set include_voice to false, or choose a model with audio_input: true in list_models.`
      )
    }
    notes.push(`The voice of ${q(asset.name)} was left out: ${target.modelLabel} doesn't take audio references.`)
    return []
  }
  // Asked for with include_voice: true it is passed on, and what takes it (the form, a clip's check) says why it
  // can't be sent.
  if (item.include_voice === undefined && isAudioClipTooShort(clips[0].clipLength)) {
    tooShort.push(clips[0])
    return []
  }
  return [clips[0]]
}

/**
 * The photos and audio clips for the given assets, in order: all of an asset's photos or the chosen ones, and its
 * chosen audio clips or (by default, for characters, when the model takes audio) its first voice clip. Audio that
 * would break the model's limits (count, MAX_REFERENCE_AUDIO_SECONDS in total) is left out and reported, unless
 * the target says not to enforce them. Without a target audio is resolved as asked, with no model checks. A
 * default voice shorter than MIN_AUDIO_CLIP_SECONDS is always left out and reported: no model takes it.
 */
export function resolveReferences(
  items: readonly ReferenceItem[],
  index: AssetIndex,
  target?: AudioTarget
): ResolvedReferences {
  const paths: string[] = []
  const audios: ReferenceAudio[] = []
  const skippedAudio: ResolvedReferences['skippedAudio'] = []
  const videos: ReferenceVideo[] = []
  const skippedVideos: ResolvedReferences['skippedVideos'] = []
  const notes: string[] = []
  const seenImages = new Set<string>()
  const limits = target && target.enforceLimits !== false ? target : undefined
  const existing = target?.existing ?? []
  const seenAudio = new Set(existing.map((a) => pathKey(a.path)))
  let count = existing.length
  let total = audioSeconds(existing, index)
  const existingVideos = target?.existingVideos ?? []
  const videoKey = (v: ReferenceVideo): string => {
    const w = videoWindow(v)
    return `${pathKey(v.path)}\u0000${seconds(w.start)}\u0000${seconds(w.length)}`
  }
  const seenVideos = new Set(existingVideos.map(videoKey))
  let videoCount = existingVideos.length
  let videoTotal = videoSeconds(existingVideos)
  const videoLimits = limits?.videoLimits

  for (const item of items) {
    if ('video' in item) {
      if (target && !target.videoInput) {
        throw new Error(
          `${target.modelLabel} doesn't take reference videos (@Video1 …). Choose a Seedance 2.x reference-to-video model (reference_videos: true in list_models), e.g. ${DEFAULT_MODEL['reference-to-video']}.`
        )
      }
      const key = videoKey(item.video)
      if (seenVideos.has(key)) continue
      seenVideos.add(key)
      const { length } = videoWindow(item.video)
      if (videoLimits && videoCount + 1 > videoLimits.maxVideos) {
        skippedVideos.push({
          ...describeVideo(item.video),
          reason: `${videoLimits.family} takes at most ${videoLimits.maxVideos} reference ${videoLimits.maxVideos === 1 ? 'video' : 'videos'}.`
        })
        continue
      }
      if (videoLimits && videoTotal + length > videoLimits.maxTotalSeconds + 1e-6) {
        skippedVideos.push({
          ...describeVideo(item.video),
          reason: `${videoLimits.family} takes at most ${videoLimits.maxTotalSeconds} s of reference video in all (this window is ${seconds(length)} s, ${seconds(videoTotal)} s are already chosen). Choose shorter windows with start / length.`
        })
        continue
      }
      videoCount++
      videoTotal += length
      videos.push(item.video)
      continue
    }
    if ('picture' in item) {
      const key = pathKey(item.picture)
      if (!seenImages.has(key)) {
        seenImages.add(key)
        paths.push(item.picture)
      }
      continue
    }
    const asset = index.require(item.asset_id)
    if (asset.kind === 'director') {
      throw new Error(
        `${q(asset.name)} is a director, not a reference: it directs a generation instead. Choose it with director on set_form, add_segment or update_segment, or for a whole sequence or storyboard with update_sequence / update_storyboard.`
      )
    }
    const images = chosenImages(asset, item)
    const tooShort: AssetAudio[] = []
    const clips = chosenAudio(asset, item, target, notes, tooShort)
    if (!images.length && !clips.length) {
      throw new Error(
        asset.images.length
          ? `${q(asset.name)} gives no references: image_ids is empty and no sound was chosen.`
          : `${q(asset.name)} has no images yet. Add images with add_asset_images first.`
      )
    }
    for (const clip of tooShort) {
      skippedAudio.push({
        ...describeAudio(referenceAudioOf(clip), index),
        reason: `The voice clip is only ${seconds(clip.clipLength)} s – the models only take audio clips of at least ${MIN_AUDIO_CLIP_SECONDS} s, so it wasn't added. Add a longer recording with add_asset_audio (or choose a longer reference window with update_asset_audio).`
      })
    }
    for (const image of images) {
      const key = pathKey(image.path)
      if (seenImages.has(key)) continue
      seenImages.add(key)
      paths.push(image.path)
    }
    for (const clip of clips) {
      const key = pathKey(clip.path)
      if (seenAudio.has(key)) continue
      seenAudio.add(key)
      const ref = referenceAudioOf(clip)
      if (limits && count + 1 > limits.maxAudios) {
        skippedAudio.push({ ...describeAudio(ref, index), reason: `The model takes at most ${limits.maxAudios} audio ${limits.maxAudios === 1 ? 'clip' : 'clips'}.` })
        continue
      }
      if (limits && total + clip.clipLength > MAX_REFERENCE_AUDIO_SECONDS + 1e-6) {
        skippedAudio.push({
          ...describeAudio(ref, index),
          reason: `The audio references may be at most ${MAX_REFERENCE_AUDIO_SECONDS} s together (this clip is ${seconds(clip.clipLength)} s, ${seconds(total)} s are already chosen). Shorten the clips' reference windows with update_asset_audio.`
        })
        continue
      }
      count++
      total += clip.clipLength
      audios.push(ref)
    }
  }
  return { paths, audios, skippedAudio, videos, skippedVideos, notes }
}

/** One photo of an asset (the chosen one, else its cover). */
export function assetPhotoPath(assetId: string, imageId: string | undefined, index: AssetIndex): string {
  const asset = index.require(assetId)
  if (!asset.images.length) {
    throw new Error(`${q(asset.name)} has no images yet. Add images with add_asset_images first.`)
  }
  if (!imageId) return asset.images[0].path
  const image = asset.images.find((img) => img.id === imageId)
  if (!image) throw new Error(`The image ${imageId} doesn't belong to ${q(asset.name)}.`)
  return image.path
}

// ── Models ───────────────────────────────────────────────────────────────────

/**
 * The active service's video models (cached in main for ten minutes). Their prompt limits are remembered on the way,
 * as a submit does it, so the prompt an agent is shown (and an approval holds on to) is composed within the same limit
 * as the one that is sent.
 */
export async function loadModels(): Promise<VideoModel[]> {
  let models: VideoModel[]
  try {
    models = await callService<VideoModel[]>('models:list')
  } catch (err) {
    throw new Error(`Couldn't fetch the models from ${activeServiceName()}: ${errorText(err)}`)
  }
  rememberPromptLimits(models)
  return models
}

/** How long a read tool waits for the model list before it answers without it. */
const MODELS_TIMEOUT_MS = 5000

/**
 * The model list, or undefined when the service can't be reached in time (the shared helpers decide on their own then,
 * and the prompt is composed within the limit main last remembered). Read tools like get_workspace wait for it,
 * so a stalled connection must not hold them up until the agent's client gives up, as paid requests and submits
 * also only wait so long for it.
 */
export async function modelsIfAvailable(): Promise<VideoModel[] | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), MODELS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([loadModels().catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Models Studio can generate with: text, start image or reference mode, and online. */
export function usableModels(models: readonly VideoModel[]): VideoModel[] {
  return models.filter((m) => (MODES as string[]).includes(m.kind) && !m.offline)
}

export function requireModel(models: readonly VideoModel[], id: string): VideoModel {
  const model = usableModels(models).find((m) => m.id === id)
  if (!model) {
    const service = activeServiceName()
    throw new Error(`The model ${id} isn't available at ${service} right now. Use list_models to see which there are.`)
  }
  return model
}

/**
 * Whether a model takes reference audio (@AudioN): only reference-to-video models whose Venice constraints say
 * so. The fetched list decides when it is at hand; otherwise the shared helper (which knows the list main last
 * fetched).
 */
export function takesAudio(modelId: string, models?: readonly VideoModel[]): boolean {
  if (kindOfModelId(modelId) !== 'reference-to-video') return false
  const listed = models?.find((m) => m.id === modelId)
  return listed ? listed.audioInput === true : supportsAudioInput(modelId)
}

/** The audio (and video) target for references chosen for this model. */
export function audioTarget(
  modelId: string,
  models: readonly VideoModel[] | undefined,
  existing?: readonly ReferenceAudio[],
  existingVideos?: readonly ReferenceVideo[]
): AudioTarget {
  const videoLimits = referenceVideoLimits(modelId)
  return {
    modelLabel: models?.find((m) => m.id === modelId)?.name ?? modelId,
    audioInput: takesAudio(modelId, models),
    maxAudios: maxReferenceAudios(modelId),
    existing,
    videoInput: supportsReferenceVideos(modelId),
    ...(videoLimits ? { videoLimits } : {}),
    ...(existingVideos ? { existingVideos } : {})
  }
}

/**
 * The model for a mode, as Studio's own mode switch picks it: the same family's model for that mode, else the
 * app's default for it, else any online one.
 */
export function modelForMode(models: readonly VideoModel[], currentModel: string, mode: Kind): string {
  const list = usableModels(models).filter((m) => m.kind === mode)
  const sibling = currentModel.replace(/(text|image|reference)-to-video/, mode)
  const preferred = [sibling, DEFAULT_MODEL[mode]].find((c) => list.some((m) => m.id === c))
  const id = preferred ?? [...list].sort((a, b) => a.name.localeCompare(b.name))[0]?.id
  if (!id) throw new Error(`${activeServiceName()} has no model for the ${mode} mode right now.`)
  return id
}

/** "8" or "8 s" → "8s", the way Venice writes durations. */
export function normalizeDuration(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const compact = value.replace(/\s+/g, '').toLowerCase()
  return /^\d+(\.\d+)?$/.test(compact) ? `${compact}s` : compact
}

/** "720" → "720p", the way Venice writes resolutions. */
export function normalizeResolution(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const compact = value.trim().toLowerCase()
  return /^\d+$/.test(compact) ? `${compact}p` : compact
}

/** "16x9" or "16/9" → "16:9". */
export function normalizeAspectRatio(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().replace(/^(\d+)\s*[x/:]\s*(\d+)$/i, '$1:$2')
}

export interface OutputOptions {
  duration?: string
  resolution?: string
  aspectRatio?: string
  audio?: boolean
}

function oneOf(label: string, value: string, allowed: readonly string[], model: VideoModel): void {
  if (allowed.length && !allowed.includes(value)) {
    throw new Error(`${label} ${value} doesn't work with ${model.name}. Choose one of: ${allowed.join(', ')}.`)
  }
}

/** Throws (naming what is allowed) when the model can't do one of the given options. */
export function checkOutputOptions(model: VideoModel, o: OutputOptions): void {
  if (o.duration !== undefined) oneOf('The duration', o.duration, model.durations, model)
  if (o.resolution !== undefined) oneOf('The resolution', o.resolution, model.resolutions, model)
  if (o.aspectRatio !== undefined) oneOf('The aspect ratio', o.aspectRatio, model.aspectRatios, model)
  if (o.audio !== undefined) {
    if (o.audio && !model.audio) throw new Error(`${model.name} can't make sound.`)
    if (model.audio && !model.audioConfigurable && !o.audio) {
      throw new Error(`${model.name} always makes sound; it can't be turned off.`)
    }
  }
}

export function checkPromptLength(model: VideoModel | undefined, prompt: string | undefined): void {
  const limit = model?.promptCharacterLimit
  if (limit && prompt && prompt.length > limit) {
    throw new Error(`The prompt is ${prompt.length} characters but ${model.name} takes at most ${limit}. Shorten it.`)
  }
}

/** A model as list_models shows it. */
export function modelInfo(m: VideoModel): Record<string, unknown> {
  const mode = m.kind as Kind
  const reference = mode === 'reference-to-video'
  const audioInput = reference && m.audioInput === true
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    default: DEFAULT_MODEL[mode] === m.id,
    durations: m.durations,
    resolutions: m.resolutions,
    aspect_ratios: m.aspectRatios,
    max_reference_images: reference ? maxReferenceImages(m.id) : 0,
    audio: m.audio,
    audio_configurable: m.audioConfigurable,
    audio_input: audioInput,
    max_reference_audios: audioInput ? maxReferenceAudios(m.id) : 0,
    ...(audioInput ? { max_reference_audio_seconds: MAX_REFERENCE_AUDIO_SECONDS } : {}),
    ...referenceVideoInfo(m.id),
    ...(mode === 'image-to-video' ? { supports_end_image: supportsEndImage(m.id) } : {}),
    ...(m.promptCharacterLimit ? { prompt_character_limit: m.promptCharacterLimit } : {})
  }
}

/**
 * What a model takes in reference videos (@VideoN), for list_models and the form's limits: reference_videos, and for
 * Seedance 2.x its family's count and seconds (2.0: 3 videos of 2–15 s, 15 s together; 2.5: 10 of 2–30 s, 30 s).
 */
export function referenceVideoInfo(modelId: string): Record<string, unknown> {
  const limits = referenceVideoLimits(modelId)
  if (!limits) return kindOfModelId(modelId) === 'reference-to-video' ? { reference_videos: false } : {}
  return {
    reference_videos: true,
    max_reference_videos: limits.maxVideos,
    reference_video_seconds: { min: limits.minSeconds, max_each: limits.maxSeconds, max_total: limits.maxTotalSeconds }
  }
}

// ── Prompt checks ────────────────────────────────────────────────────────────

/**
 * The params as they are sent for a clip (as the sequence service's takeParams has them). A clip that takes a
 * frame from a neighbour is generated by the image-to-video sibling of its model, without references:
 * continuing, with the previous clip's last frame as its start image; endFromNext, with the next clip's first
 * frame as its end image (Studio keeps the stored model one that takes it). Those frames are extracted when the
 * take is generated, so they are left out here; an explicit keyframe in the other slot stays.
 */
export function asGenerated(params: GenerationParams, continuing: boolean, endFromNext = false): GenerationParams {
  if (!continuing && !endFromNext) return params
  return {
    ...params,
    model: imageToVideoVariant(params.model),
    startImage: continuing ? undefined : params.startImage,
    endImage: endFromNext ? undefined : params.endImage,
    referenceImages: undefined,
    referenceAudios: undefined,
    referenceVideos: undefined
  }
}

/**
 * Every @ImageN / @AudioN problem of both prompts, the main prompt's first, as the window shows them: a reference the
 * References legend explains – `composed`, by default the prompt these params send (composeSubmission) – isn't
 * reported as unmentioned.
 */
export function promptIssues(params: GenerationParams, composed?: ComposedPrompt): PromptIssue[] {
  const sent = composed ?? (isLibraryReady() ? composeSubmission(params) : undefined)
  // Checked as sent: a director's style frames and videos among the references, explained by its section.
  const directed = isLibraryReady() ? directParams(params) : params
  const { prompt, negativePrompt } = validateGenerationParams(directed, sent ? { explained: explainedReferences(sent) } : {})
  return [...prompt, ...negativePrompt]
}

/** Issues as the tools report them. */
export function issueList(issues: readonly PromptIssue[]): { severity: string; code: string; message: string }[] {
  return issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }))
}

/**
 * What stops these params from being generated: missing input for the mode, or the first blocking
 * @ImageN / @AudioN problem. `continuing`: a sequence clip that continues from the previous one; it is generated
 * image-to-video with that clip's last frame (extracted when it is generated) and sends no references.
 * `endFromNext`: it ends on the next clip's first frame, so its model must take an end image.
 */
export function blockingProblem(given: GenerationParams, continuing = false, endFromNext = false): string | undefined {
  // As sent: a director's style frames count among the references (directed by params.director, as a submit does).
  const params = isLibraryReady() ? directParams(given) : given
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'The prompt is empty.'
  // An end image the model can't take would be dropped on the way to Venice: a keyframe paid for and lost.
  if (endFromNext && !supportsEndImage(params.model)) {
    return `The model ${params.model} can't take an end image. Choose an image-to-video model that can (supports_end_image, e.g. Seedance), or turn off end_from_next.`
  }
  if (kind === 'image-to-video' && params.endImage && !supportsEndImage(params.model)) {
    return `The model ${params.model} can't take an end image. Choose a model that can, or remove the end image (end_image: null).`
  }
  if (continuing) return blockingContinuationError(params)
  if (kind === 'image-to-video' && !params.startImage) {
    return endFromNext
      ? "The clip ends on the next clip's first frame but has no start image. Choose a start image (start_image) or let it continue from the previous clip."
      : 'There is no start image.'
  }
  // A reference video the model takes is a reference too.
  if (kind === 'reference-to-video' && !params.referenceImages?.length && !paramsForSubmit(params).referenceVideos?.length) {
    return 'There are no reference images (or reference videos).'
  }
  if (kind === 'image-to-video' && (endFromNext || params.endImage)) {
    // The automatic frames follow the same rule as a keyframe: references can't go along with pictures.
    const tokens = blockingContinuationError(params)
    if (tokens) return keyframeTokensMessage(tokens)
  }
  return blockingPromptError(params)
}

/**
 * The continuation wording of a token problem, turned into one for a clip that is generated from its start and
 * end images rather than from the previous clip.
 */
function keyframeTokensMessage(message: string): string {
  if (!message.startsWith('The clip continues from')) return message
  const named = /remove (.*) from (the prompt|the negative prompt), /.exec(message)
  return named
    ? `The clip is generated from its start and end images (image-to-video) and sends no references – remove ${named[1]} from ${named[2]} and describe in words what happens.`
    : message
}

/** A prompt from an agent with its tokens in canonical form ("@image3" → "@Image3", "@audio1" → "@Audio1"). */
export function canonical(text: string | undefined): string | undefined {
  // Line breaks as Studio's text fields keep them ("\r\n" from an agent becomes "\n").
  return text === undefined ? undefined : canonicalizeTokens(text.replace(/\r\n?/g, '\n'))
}

/** The params as the tools show them. */
export function paramsInfo(p: GenerationParams, index: AssetIndex): Record<string, unknown> {
  const mode = kindOfModelId(p.model)
  const reference = mode === 'reference-to-video'
  return {
    mode,
    model: p.model,
    duration: p.duration,
    resolution: p.resolution,
    aspect_ratio: p.aspectRatio,
    audio: p.audio,
    prompt: p.prompt,
    negative_prompt: p.negativePrompt || undefined,
    ...(reference ? { references: tokenMap(p.referenceImages, index) } : {}),
    ...(reference && p.referenceAudios?.length
      ? {
          audio_references: audioTokenMap(p.referenceAudios, index),
          audio_reference_seconds: seconds(audioSeconds(p.referenceAudios, index))
        }
      : {}),
    ...(reference && referenceVideosOf(p).length
      ? {
          video_references: videoTokenMap(referenceVideosOf(p)),
          video_reference_seconds: seconds(videoSeconds(referenceVideosOf(p)))
        }
      : {}),
    ...(mode === 'image-to-video' && p.startImage ? { start_image: describePicture(p.startImage, index) } : {}),
    ...(mode === 'image-to-video' && p.endImage ? { end_image: describePicture(p.endImage, index) } : {})
  }
}

// ── Descriptions in the prompt (the References legend) ───────────────────────

/** A legend entry as the tools show it: the asset, its tokens, the text that is appended and whether it is. */
export interface DescriptionEntryInfo {
  asset_id: string
  asset_name: string
  kind: AssetKind
  tokens: string[]
  description: string
  /** false: switched off for these params (excluded_description_asset_ids, or include_descriptions false). */
  included: boolean
  /**
   * In composed_prompt right now. False when switched off, and also for one switched on when nothing is appended:
   * the prompt is empty, or the descriptions don't fit within the model's limit (see descriptions_note).
   */
  sent: boolean
  /** Shortened (ending in "…") to fit the model's prompt_character_limit. */
  shortened?: boolean
  /** An outfit: the character wearing it, as the legend names it ("worn by Anna (@Image1)"). */
  worn_by?: { asset_id: string; name: string; tokens: string[] }
}

/**
 * The prompt the params would send and the descriptions that go along with it, as get_workspace, validate_prompt,
 * get_sequence and reorder_references report it: `composed_prompt` (what Venice gets: the prompt plus the
 * References legend, composed by main's own composeSubmission – the descriptions as the database has them now,
 * the params' switches, the prompt language, the model's prompt limit), `description_entries` (every referenced
 * asset that has a description, with whether it is switched on and whether it is in composed_prompt now), the
 * switches, and the composed length against the model's limit (with a note when the descriptions had to be
 * shortened or left out to fit, or a blank prompt gets none). Needs an open library.
 */
export function descriptionInfo(params: GenerationParams, index: AssetIndex): Record<string, unknown> {
  const sent = composeSubmission(params)
  // Every described reference, switched on or off, so an agent sees what it could turn back on (in full: the
  // length limit only shortens what is actually sent).
  const all = composePrompt(params, describedAssets(index.assets), { language: getPromptLanguage(), include: true })
  const appended = new Map(sent.entries.map((e) => [e.assetId, e]))
  const excluded = params.excludedDescriptionAssetIds ?? []
  const limit = promptLimitOf(params.model)
  const entries: DescriptionEntryInfo[] = all.entries.map((e) => {
    const used = appended.get(e.assetId)
    const wearer = (used ?? e).wornBy
    return {
      asset_id: e.assetId,
      asset_name: e.name,
      kind: e.kind,
      tokens: e.tokens,
      description: (used ?? e).description,
      included: !!used,
      // composePrompt lists every entry also when it appends none (an empty prompt, a legend that doesn't fit); the
      // legend may hold a director's section alone.
      sent: !!used && !!sent.legend && !sent.dropped,
      ...(used?.shortened ? { shortened: true } : {}),
      ...(wearer ? { worn_by: { asset_id: wearer.assetId, name: wearer.name, tokens: wearer.tokens } } : {})
    }
  })
  const note = sent.dropped
    ? "The descriptions don't fit within the model's prompt_character_limit, so none are appended. Shorten the prompt to make room for them."
    : sent.truncated
      ? "Some descriptions were shortened to fit the model's prompt_character_limit."
      : sent.entries.length && !sent.legend
        ? 'Nothing is appended to an empty prompt; the descriptions come along once there is one.'
        : undefined
  const direction = sent.direction
  return {
    composed_prompt: sent.prompt,
    description_entries: entries,
    include_descriptions: includesDescriptions(params),
    ...(excluded.length ? { excluded_description_asset_ids: excluded } : {}),
    composed_characters: sent.prompt.length,
    ...(limit ? { prompt_character_limit: limit } : {}),
    ...(note ? { descriptions_note: note } : {}),
    // The director's Direction section (after the legend in composed_prompt), what it sends besides, and what not.
    ...(direction
      ? {
          direction: {
            director_id: direction.directorId,
            director_name: direction.name,
            section: direction.section.replace(/^\n+/, ''),
            ...(direction.styleFrames.length ? { style_frames: direction.styleFrames } : {}),
            ...(direction.styleVideos.length ? { style_videos: direction.styleVideos } : {}),
            ...(direction.droppedParts.length ? { parts_left_out: direction.droppedParts } : {}),
            ...(direction.notes.length ? { notes: direction.notes } : {})
          }
        }
      : {})
  }
}

/** An agent's "worn by" choice (set_form, add_segment, update_segment; kit.ts outfitWearersInput). */
export interface OutfitWearerInput {
  outfit_asset_id: string
  /** null: nobody; left out: the default again. */
  character_asset_id?: string | null
}

/**
 * GenerationParams.outfitWearers with an agent's choices applied (`choices` undefined: none), kept to the outfits and
 * characters among `references` (the picture paths of the form or clip, also those past the model's limit;
 * outfitWearersAmong). Each outfit must be an outfit and each character a character, both with a photo among the
 * references; otherwise refused, naming every problem.
 */
export function applyOutfitWearers(
  current: GenerationParams['outfitWearers'],
  choices: readonly OutfitWearerInput[] | undefined,
  references: readonly string[],
  index: AssetIndex
): GenerationParams['outfitWearers'] {
  const present = new Set(references.flatMap((path) => index.photo(path)?.asset.id ?? []))
  let wearers = current
  const problems: string[] = []
  const seen = new Set<string>()
  /** The asset an id names, checked to be of `kind` and among the references; undefined (and a problem) if not. */
  const among = (id: string, kind: 'outfit' | 'character', what: string): Asset | undefined => {
    const asset = index.get(id.trim())
    if (!asset) problems.push(`There is no asset with id ${id} (${what}).`)
    else if (asset.kind !== kind) {
      problems.push(`${q(asset.name)} is not ${kind === 'outfit' ? 'an outfit' : 'a character'} (${what}).`)
    } else if (!present.has(asset.id)) {
      problems.push(`${q(asset.name)} is not among the reference images – add it first (${what}).`)
    } else return asset
    return undefined
  }
  for (const choice of choices ?? []) {
    const outfit = among(choice.outfit_asset_id, 'outfit', 'outfit_asset_id')
    const character =
      typeof choice.character_asset_id === 'string'
        ? among(choice.character_asset_id, 'character', 'character_asset_id')
        : undefined
    if (!outfit || (typeof choice.character_asset_id === 'string' && !character)) continue
    if (seen.has(outfit.id)) {
      problems.push(`${q(outfit.name)} appears more than once in outfit_wearers.`)
      continue
    }
    seen.add(outfit.id)
    wearers = withOutfitWearer(wearers, outfit.id, character ? character.id : choice.character_asset_id)
  }
  if (problems.length) throw new Error(`Who wears the outfits couldn't be set: ${problems.join(' ')}`)
  return outfitWearersAmong(wearers, present)
}

/** "@Image1 Anna (character) photo 1" – one line per reference, for compact listings. */
export function referenceSummary(p: GenerationParams, index: AssetIndex): string[] {
  if (kindOfModelId(p.model) !== 'reference-to-video') return []
  const images = tokenMap(p.referenceImages, index).map((t) =>
    t.asset_name ? `${t.token} ${t.asset_name} (${t.kind}) photo ${t.photo_number}` : `${t.token} ${t.file}`
  )
  const audios = audioTokenMap(p.referenceAudios, index).map((t) =>
    t.asset_name ? `${t.token} ${t.asset_name} (${t.role})` : `${t.token} ${t.file}`
  )
  const videos = videoTokenMap(referenceVideosOf(p)).map(
    (t) => `${t.token} ${t.title ?? t.file} (video, ${t.start}–${seconds(t.start + t.length)} s)`
  )
  return [...images, ...audios, ...videos]
}
