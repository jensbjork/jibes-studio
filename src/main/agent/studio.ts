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
  referenceAudioWindow,
  supportsAudioInput,
  supportsEndImage,
  type Kind
} from '@shared/models'
import {
  composePrompt,
  describedAssets,
  includesDescriptions,
  promptLimitOf,
  rememberPromptLimits
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
  type AssetKind,
  type GenerationParams,
  type ReferenceAudio,
  type Still,
  type VideoModel
} from '@shared/types'
import { composeSubmission } from '../jobs'
import { isLibraryReady } from '../paths'
import { getPromptLanguage } from '../settings'
import { callService } from './local-ipc'

// What the agent tools share: the library check, looking up assets with their photos and audio clips, the token
// maps (@ImageN → which photo of which asset, @AudioN → which voice or soundscape), the model list and its
// options, and the prompt checks.

export const NO_LIBRARY =
  'Studio har inget bibliotek öppet. Användaren behöver välja en biblioteksmapp i Studio innan du kan arbeta där.'

/** Throws (in Swedish) unless a library is open; tools that read or change it call this first. */
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
 * raw consent request ("Klipp 2: NEEDS_CONSENT:{…}") for the window, which asks the user and restarts the run.
 */
export function readableRunError(error: string | undefined): string | undefined {
  if (!error) return undefined
  const at = error.indexOf(NEEDS_CONSENT)
  if (at < 0) return error
  return `${error.slice(0, at)}Venice vill att användaren godkänner modellens villkor innan klippet kan genereras. Det görs i Studio under Sekvenser (”Generera saknade”).`
}

/** "Anna" → "”Anna”", for names in messages. */
export const q = (name: string): string => `”${name}”`

// ── Assets, their photos and their audio clips ───────────────────────────────

export interface PhotoRef {
  asset: Asset
  /** 1-based, as "foto 2" in Studio. */
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
        `Det finns ingen karaktär, miljö, klädsel eller pose med id ${id}. Använd list_assets för att se vad som finns.`
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
        `Det finns ingen bild med id ${imageId} bland karaktärerna, miljöerna, kläderna och poserna. Bildernas id finns i image_ids från list_assets eller get_asset.`
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
      throw new Error(`Det finns inget ljudklipp med id ${id}. Ljudklippens id finns i audio från list_assets eller get_asset.`)
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
    if (!still) throw new Error(`Det finns ingen stillbild med id ${id}. list_stills visar vilka som finns.`)
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

/** An asset's audio clips as the tools list them. */
export function audioClipsInfo(asset: Asset): Record<string, unknown>[] {
  return audioOf(asset).map((a, i) => ({
    audio_id: a.id,
    clip_number: i + 1,
    role: audioRole(asset.kind),
    file: basename(a.path),
    duration: seconds(a.duration),
    clip_start: seconds(a.clipStart),
    clip_length: seconds(a.clipLength)
  }))
}

// ── Choosing references ──────────────────────────────────────────────────────

export interface ReferenceItem {
  asset_id: string
  /** Only these photos, in this order; [] for none of the asset's photos (e.g. only its voice). */
  image_ids?: string[]
  /** Only these audio clips, in this order. */
  audio_ids?: string[]
  /** Add the asset's first audio clip when no audio_ids are given. Default: characters yes, others no. */
  include_voice?: boolean
}

/** What the references are chosen for: whether the model takes reference audio, and how much. */
export interface AudioTarget {
  /** The model's name for messages. */
  modelLabel: string
  audioInput: boolean
  /** maxReferenceAudios of the model. */
  maxAudios: number
  /** Audio already in place (the form's, when appending); counted against the limits. */
  existing?: readonly ReferenceAudio[]
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
  /** Clips that were asked for (or would have been added by default) but don't fit, and why (Swedish). */
  skippedAudio: (AudioInfo & { reason: string })[]
  /** What was decided on the agent's behalf (Swedish), e.g. a voice left out because the model takes none. */
  notes: string[]
}

function chosenImages(asset: Asset, item: ReferenceItem): Asset['images'] {
  if (item.image_ids === undefined) return asset.images
  return item.image_ids.map((imageId) => {
    const image = asset.images.find((img) => img.id === imageId)
    if (!image) {
      throw new Error(
        `Bilden ${imageId} hör inte till ${q(asset.name)}. Bildernas id finns i image_ids från list_assets eller get_asset.`
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
  item: ReferenceItem,
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
          `Ljudklippet ${audioId} hör inte till ${q(asset.name)}. Ljudklippens id finns i audio från list_assets eller get_asset.`
        )
      }
      return clip
    })
    if (target && !target.audioInput) {
      throw new Error(
        `${target.modelLabel} tar inte emot ljudreferenser (@Audio1 …). Ta bort audio_ids, eller välj en modell med audio_input: true i list_models.`
      )
    }
    return chosen
  }
  const wanted = item.include_voice ?? asset.kind === 'character'
  if (!wanted || !clips.length) {
    if (item.include_voice === true && !clips.length) {
      notes.push(`${q(asset.name)} har inget ljudklipp än, så inget ljud lades till.`)
    }
    return []
  }
  if (target && !target.audioInput) {
    if (item.include_voice === true) {
      throw new Error(
        `${target.modelLabel} tar inte emot ljudreferenser (@Audio1 …). Sätt include_voice till false, eller välj en modell med audio_input: true i list_models.`
      )
    }
    notes.push(`Rösten för ${q(asset.name)} togs inte med: ${target.modelLabel} tar inte emot ljudreferenser.`)
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
  const notes: string[] = []
  const seenImages = new Set<string>()
  const limits = target && target.enforceLimits !== false ? target : undefined
  const existing = target?.existing ?? []
  const seenAudio = new Set(existing.map((a) => pathKey(a.path)))
  let count = existing.length
  let total = audioSeconds(existing, index)

  for (const item of items) {
    const asset = index.require(item.asset_id)
    const images = chosenImages(asset, item)
    const tooShort: AssetAudio[] = []
    const clips = chosenAudio(asset, item, target, notes, tooShort)
    if (!images.length && !clips.length) {
      throw new Error(
        asset.images.length
          ? `${q(asset.name)} ger inga referenser: image_ids är tom och inget ljud valdes.`
          : `${q(asset.name)} har inga bilder än. Användaren behöver lägga till bilder i Studio först.`
      )
    }
    for (const clip of tooShort) {
      skippedAudio.push({
        ...describeAudio(referenceAudioOf(clip), index),
        reason: `Röstklippet är bara ${seconds(clip.clipLength)} s – Venice tar bara emot ljudklipp på minst ${MIN_AUDIO_CLIP_SECONDS} s, så det lades inte till. Användaren behöver lägga till en längre inspelning i Studio.`
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
        skippedAudio.push({ ...describeAudio(ref, index), reason: `Modellen tar högst ${limits.maxAudios} ljudklipp.` })
        continue
      }
      if (limits && total + clip.clipLength > MAX_REFERENCE_AUDIO_SECONDS + 1e-6) {
        skippedAudio.push({
          ...describeAudio(ref, index),
          reason: `Ljudreferenserna får vara högst ${MAX_REFERENCE_AUDIO_SECONDS} s tillsammans (det här klippet är ${seconds(clip.clipLength)} s, ${seconds(total)} s är redan valda). Korta klippens referensfönster med update_asset_audio.`
        })
        continue
      }
      count++
      total += clip.clipLength
      audios.push(ref)
    }
  }
  return { paths, audios, skippedAudio, notes }
}

/** One photo of an asset (the chosen one, else its cover). */
export function assetPhotoPath(assetId: string, imageId: string | undefined, index: AssetIndex): string {
  const asset = index.require(assetId)
  if (!asset.images.length) {
    throw new Error(`${q(asset.name)} har inga bilder än. Användaren behöver lägga till bilder i Studio först.`)
  }
  if (!imageId) return asset.images[0].path
  const image = asset.images.find((img) => img.id === imageId)
  if (!image) throw new Error(`Bilden ${imageId} hör inte till ${q(asset.name)}.`)
  return image.path
}

// ── Models ───────────────────────────────────────────────────────────────────

/**
 * Venice's video models (cached in main for ten minutes). Their prompt limits are remembered on the way, as a
 * submit does it, so the prompt an agent is shown (and an approval holds on to) is composed within the same limit
 * as the one that is sent.
 */
export async function loadModels(): Promise<VideoModel[]> {
  let models: VideoModel[]
  try {
    models = await callService<VideoModel[]>('models:list')
  } catch (err) {
    throw new Error(`Kunde inte hämta modellerna från Venice: ${errorText(err)}`)
  }
  rememberPromptLimits(models)
  return models
}

/** How long a read tool waits for the model list before it answers without it. */
const MODELS_TIMEOUT_MS = 5000

/**
 * The model list, or undefined when Venice can't be reached in time (the shared helpers decide on their own then,
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
  if (!model) throw new Error(`Modellen ${id} finns inte hos Venice just nu. Använd list_models för att se vilka som finns.`)
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

/** The audio target for references chosen for this model. */
export function audioTarget(
  modelId: string,
  models: readonly VideoModel[] | undefined,
  existing?: readonly ReferenceAudio[]
): AudioTarget {
  return {
    modelLabel: models?.find((m) => m.id === modelId)?.name ?? modelId,
    audioInput: takesAudio(modelId, models),
    maxAudios: maxReferenceAudios(modelId),
    existing
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
  if (!id) throw new Error(`Venice har ingen modell för läget ${mode} just nu.`)
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
    throw new Error(`${label} ${value} går inte med ${model.name}. Välj något av: ${allowed.join(', ')}.`)
  }
}

/** Throws (in Swedish, naming what is allowed) when the model can't do one of the given options. */
export function checkOutputOptions(model: VideoModel, o: OutputOptions): void {
  if (o.duration !== undefined) oneOf('Längden', o.duration, model.durations, model)
  if (o.resolution !== undefined) oneOf('Upplösningen', o.resolution, model.resolutions, model)
  if (o.aspectRatio !== undefined) oneOf('Bildformatet', o.aspectRatio, model.aspectRatios, model)
  if (o.audio !== undefined) {
    if (o.audio && !model.audio) throw new Error(`${model.name} kan inte göra ljud.`)
    if (model.audio && !model.audioConfigurable && !o.audio) {
      throw new Error(`${model.name} gör alltid ljud; det går inte att stänga av.`)
    }
  }
}

export function checkPromptLength(model: VideoModel | undefined, prompt: string | undefined): void {
  const limit = model?.promptCharacterLimit
  if (limit && prompt && prompt.length > limit) {
    throw new Error(`Prompten är ${prompt.length} tecken men ${model.name} tar högst ${limit}. Korta ner den.`)
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
    ...(m.promptCharacterLimit ? { prompt_character_limit: m.promptCharacterLimit } : {})
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
    referenceAudios: undefined
  }
}

type CheckedParams = Pick<GenerationParams, 'model' | 'prompt' | 'negativePrompt' | 'referenceImages' | 'referenceAudios'>

/** Every @ImageN / @AudioN problem of both prompts, the main prompt's first. */
export function promptIssues(params: CheckedParams): PromptIssue[] {
  const { prompt, negativePrompt } = validateGenerationParams(params)
  return [...prompt, ...negativePrompt]
}

/** Issues as the tools report them. */
export function issueList(issues: readonly PromptIssue[]): { severity: string; code: string; message: string }[] {
  return issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }))
}

/**
 * What stops these params from being generated, in Swedish: missing input for the mode, or the first blocking
 * @ImageN / @AudioN problem. `continuing`: a sequence clip that continues from the previous one; it is generated
 * image-to-video with that clip's last frame (extracted when it is generated) and sends no references.
 * `endFromNext`: it ends on the next clip's first frame, so its model must take an end image.
 */
export function blockingProblem(params: GenerationParams, continuing = false, endFromNext = false): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Prompten är tom.'
  // An end image the model can't take would be dropped on the way to Venice: a keyframe paid for and lost.
  if (endFromNext && !supportsEndImage(params.model)) {
    return `Modellen ${params.model} kan inte ta en slutbild. Välj en bild-till-video-modell som kan det (supports_end_image, t.ex. Seedance), eller slå av end_from_next.`
  }
  if (kind === 'image-to-video' && params.endImage && !supportsEndImage(params.model)) {
    return `Modellen ${params.model} kan inte ta en slutbild. Välj en modell som kan det, eller ta bort slutbilden (end_image: null).`
  }
  if (continuing) return blockingContinuationError(params)
  if (kind === 'image-to-video' && !params.startImage) {
    return endFromNext
      ? 'Klippet slutar på nästa klipps första bildruta men har ingen startbild. Välj en startbild (start_image) eller låt det fortsätta från föregående klipp.'
      : 'Det finns ingen startbild.'
  }
  if (kind === 'reference-to-video' && !params.referenceImages?.length) return 'Det finns inga referensbilder.'
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
  if (!message.startsWith('Klippet fortsätter')) return message
  const named = /ta bort (.*) ur (prompten|den negativa prompten)/.exec(message)
  return named
    ? `Klippet genereras från sin start- och slutbild (bild-till-video) och skickar inga referenser – ta bort ${named[1]} ur ${named[2]} och beskriv i ord vad som händer.`
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
    return {
      asset_id: e.assetId,
      asset_name: e.name,
      kind: e.kind,
      tokens: e.tokens,
      description: (used ?? e).description,
      included: !!used,
      // composePrompt lists every entry also when it appends none (an empty prompt, a legend that doesn't fit).
      sent: !!used && !!sent.legend,
      ...(used?.shortened ? { shortened: true } : {})
    }
  })
  const note = sent.dropped
    ? "The descriptions don't fit within the model's prompt_character_limit, so none are appended. Shorten the prompt to make room for them."
    : sent.truncated
      ? "Some descriptions were shortened to fit the model's prompt_character_limit."
      : sent.entries.length && !sent.legend
        ? 'Nothing is appended to an empty prompt; the descriptions come along once there is one.'
        : undefined
  return {
    composed_prompt: sent.prompt,
    description_entries: entries,
    include_descriptions: includesDescriptions(params),
    ...(excluded.length ? { excluded_description_asset_ids: excluded } : {}),
    composed_characters: sent.prompt.length,
    ...(limit ? { prompt_character_limit: limit } : {}),
    ...(note ? { descriptions_note: note } : {})
  }
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
  return [...images, ...audios]
}
