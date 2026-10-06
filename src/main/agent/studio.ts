import { basename } from 'node:path'
import { DEFAULT_MODEL, KINDS, imageToVideoVariant, kindOfModelId, maxReferenceImages, type Kind } from '@shared/models'
import {
  blockingContinuationError,
  blockingPromptError,
  canonicalizeTokens,
  validateGenerationParams,
  type PromptIssue
} from '@shared/prompt-refs'
import { NEEDS_CONSENT, type Asset, type AssetKind, type GenerationParams, type VideoModel } from '@shared/types'
import { isLibraryReady } from '../paths'
import { callService } from './local-ipc'

// What the agent tools share: the library check, looking up assets and their photos, the token map
// (@ImageN → which photo of which asset), the model list and its options, and the prompt checks.

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

// ── Assets and their photos ──────────────────────────────────────────────────

export interface PhotoRef {
  asset: Asset
  /** 1-based, as "foto 2" in Studio. */
  photoNumber: number
  imageId: string
}

const pathKey = (path: string): string => path.normalize('NFC')

/** Every asset, found by id or by the path of one of its photos. */
export class AssetIndex {
  private readonly byId = new Map<string, Asset>()
  private readonly byPath = new Map<string, PhotoRef>()

  constructor(readonly assets: Asset[]) {
    for (const asset of assets) {
      this.byId.set(asset.id, asset)
      asset.images.forEach((image, i) =>
        this.byPath.set(pathKey(image.path), { asset, photoNumber: i + 1, imageId: image.id })
      )
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
      throw new Error(`Det finns ingen karaktär, miljö eller klädsel med id ${id}. Använd list_assets för att se vad som finns.`)
    }
    return asset
  }

  photo(path: string | undefined): PhotoRef | undefined {
    return path ? this.byPath.get(pathKey(path)) : undefined
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

export type TokenEntry = { token: string } & PictureInfo

/** What each @ImageN points at: @Image1 is the first reference image, and so on. */
export function tokenMap(paths: readonly string[] | undefined, index: AssetIndex): TokenEntry[] {
  return (paths ?? []).map((path, i) => ({ token: `@Image${i + 1}`, ...describePicture(path, index) }))
}

export interface ReferenceItem {
  asset_id: string
  image_ids?: string[]
}

/** The photo paths for the given assets, in order: all of an asset's photos, or the chosen ones. No duplicates. */
export function referencePaths(items: readonly ReferenceItem[], index: AssetIndex): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const asset = index.require(item.asset_id)
    if (!asset.images.length) {
      throw new Error(`${q(asset.name)} har inga bilder än. Användaren behöver lägga till bilder i Studio först.`)
    }
    const chosen = item.image_ids?.length
      ? item.image_ids.map((imageId) => {
          const image = asset.images.find((img) => img.id === imageId)
          if (!image) {
            throw new Error(
              `Bilden ${imageId} hör inte till ${q(asset.name)}. Bildernas id finns i image_ids från list_assets eller get_asset.`
            )
          }
          return image
        })
      : asset.images
    for (const image of chosen) {
      const key = pathKey(image.path)
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(image.path)
    }
  }
  return paths
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

/** Venice's video models (cached in main for ten minutes). */
export async function loadModels(): Promise<VideoModel[]> {
  try {
    return await callService<VideoModel[]>('models:list')
  } catch (err) {
    throw new Error(`Kunde inte hämta modellerna från Venice: ${errorText(err)}`)
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
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    default: DEFAULT_MODEL[mode] === m.id,
    durations: m.durations,
    resolutions: m.resolutions,
    aspect_ratios: m.aspectRatios,
    max_reference_images: mode === 'reference-to-video' ? maxReferenceImages(m.id) : 0,
    audio: m.audio,
    audio_configurable: m.audioConfigurable,
    ...(m.promptCharacterLimit ? { prompt_character_limit: m.promptCharacterLimit } : {})
  }
}

// ── Prompt checks ────────────────────────────────────────────────────────────

/**
 * The params as they are sent for a clip: a continuing clip is generated by the image-to-video model, with the
 * previous clip's last frame (extracted when it is generated) as its start image.
 */
export function asGenerated(params: GenerationParams, continuing: boolean): GenerationParams {
  if (!continuing) return params
  return { ...params, model: imageToVideoVariant(params.model), startImage: undefined, referenceImages: undefined }
}

/** Every @ImageN problem of both prompts, the main prompt's first. */
export function promptIssues(
  params: Pick<GenerationParams, 'model' | 'prompt' | 'negativePrompt' | 'referenceImages'>
): PromptIssue[] {
  const { prompt, negativePrompt } = validateGenerationParams(params)
  return [...prompt, ...negativePrompt]
}

/** Issues as the tools report them. */
export function issueList(issues: readonly PromptIssue[]): { severity: string; code: string; message: string }[] {
  return issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }))
}

/**
 * What stops these params from being generated, in Swedish: missing input for the mode, or the first blocking
 * @ImageN problem. `continuing`: a sequence clip that continues from the previous one; it is generated
 * image-to-video with that clip's last frame (extracted when it is generated) and sends no reference images.
 */
export function blockingProblem(params: GenerationParams, continuing = false): string | undefined {
  const kind = kindOfModelId(params.model)
  if (!params.prompt.trim()) return 'Prompten är tom.'
  if (continuing) return blockingContinuationError(params)
  if (kind === 'image-to-video' && !params.startImage) return 'Det finns ingen startbild.'
  if (kind === 'reference-to-video' && !params.referenceImages?.length) return 'Det finns inga referensbilder.'
  return blockingPromptError(params)
}

/** A prompt from an agent with its tokens in canonical form ("@image3" → "@Image3"). */
export function canonical(text: string | undefined): string | undefined {
  // Line breaks as Studio's text fields keep them ("\r\n" from an agent becomes "\n").
  return text === undefined ? undefined : canonicalizeTokens(text.replace(/\r\n?/g, '\n'))
}

/** The params as the tools show them. */
export function paramsInfo(p: GenerationParams, index: AssetIndex): Record<string, unknown> {
  const mode = kindOfModelId(p.model)
  return {
    mode,
    model: p.model,
    duration: p.duration,
    resolution: p.resolution,
    aspect_ratio: p.aspectRatio,
    audio: p.audio,
    prompt: p.prompt,
    negative_prompt: p.negativePrompt || undefined,
    ...(mode === 'reference-to-video' ? { references: tokenMap(p.referenceImages, index) } : {}),
    ...(mode === 'image-to-video' && p.startImage ? { start_image: describePicture(p.startImage, index) } : {}),
    ...(mode === 'image-to-video' && p.endImage ? { end_image: describePicture(p.endImage, index) } : {})
  }
}
