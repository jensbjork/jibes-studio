// Venice's image models, for the keyframes and other stills of a storyboard: which models there are, what a
// picture costs, and the two paid endpoints. Text-to-image models come from GET /models?type=image and are
// called with POST /image/generate; models that combine reference pictures (characters, outfits, places, poses,
// earlier stills) come from GET /models?type=inpaint and are called with POST /image/multi-edit. Nothing here
// touches the library; stills.ts decides what is generated and where the result goes.

import { extname } from 'node:path'
import { nativeImage } from 'electron'
import type { ImageModel } from '@shared/types'
import { decodeImageFile } from './input-image'
import { fileErrorReason } from './references'
import { FAL_DEFAULT_EDIT_MODEL, FAL_DEFAULT_IMAGE_MODEL } from '@shared/fal-models'
import { providerOf } from '@shared/provider'
import { falImageCatalog, falRequestImage } from './fal-images'
import { getApiKey, getImageSafeMode, getProvider } from './settings'
import { VeniceError } from './venice'

const BASE_URL = 'https://api.venice.ai/api/v1'

/** The default when the user (or an agent) names no model: the Seedream family, the same as Seedance's. */
export const DEFAULT_IMAGE_MODEL = 'seedream-v5-pro'
export const DEFAULT_EDIT_MODEL = 'seedream-v5-pro-edit'

/** The active service's default model for making a picture (`edit`: combining reference pictures). */
export function defaultImageModelId(edit: boolean): string {
  if (getProvider() === 'fal') return edit ? FAL_DEFAULT_EDIT_MODEL : FAL_DEFAULT_IMAGE_MODEL
  return edit ? DEFAULT_EDIT_MODEL : DEFAULT_IMAGE_MODEL
}

/** How many reference pictures an edit model takes when its entry in the list doesn't say (Venice's default). */
export const DEFAULT_MAX_INPUT_IMAGES = 3

/** The resolution tier Studio asks for unless told otherwise: cheap, and plenty for a keyframe. */
export const DEFAULT_RESOLUTION = '1K'

/**
 * Text-to-image models without an aspect ratio list (SD-style models) take width and height instead; Studio
 * offers these ratios for them and works out the size (see sizeFor).
 */
const SIZED_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '21:9']
/** /image/generate's limits for width and height, and the area its default 1024×1024 has. */
const MAX_SIDE = 1280
const TARGET_AREA = 1024 * 1024

/** Model ids in the image list that aren't generators (a background remover, upscalers). */
const NOT_A_GENERATOR = /bg-remover|background-remov|upscale/i

/** Models rarely change; the list is fetched again after this long (or when asked to). */
const MODEL_CACHE_MS = 10 * 60_000
const LIST_TIMEOUT_MS = 20_000
/**
 * How long a picture may take. Most arrive within a minute; the high-quality GPT and Flux tiers can take a few.
 * Past this Studio stops waiting, and says that Venice may still have charged for it.
 */
export const GENERATE_TIMEOUT_MS = 4 * 60_000

/** Venice's limits for an input picture of /image/multi-edit. */
const MIN_INPUT_PIXELS = 65_536
const MAX_INPUT_SIDE = 2048
const MAX_INPUT_BYTES = 20 * 1024 * 1024
/** Above this a PNG input is sent as JPEG, so a request with six references stays a reasonable size. */
const MAX_PNG_INPUT_BYTES = 4 * 1024 * 1024

// ── Model list ───────────────────────────────────────────────────────────────

interface Usd {
  usd?: number
}

/** model_spec.pricing as the model list gives it (diem prices left out). */
export interface RawImagePricing {
  /** Text-to-image: a flat price per picture. */
  generation?: Usd
  /** Edit models: the flat price per picture. */
  inpaint?: Usd
  /** Per resolution tier ("1K", "2K", "4K"). */
  resolutions?: Record<string, Usd>
  /** Per resolution tier and quality ("low", "medium", "high"). */
  quality?: Record<string, Record<string, Usd>>
  /** Edit models: the first `included` input pictures are in the price, each further one costs `additional`. */
  inputImages?: { included?: number; additional?: Usd }
}

interface RawImageModel {
  id: string
  type?: string
  model_spec?: {
    name?: string
    privacy?: string
    offline?: boolean
    pricing?: RawImagePricing
    constraints?: {
      aspectRatios?: string[]
      defaultAspectRatio?: string
      resolutions?: string[]
      defaultResolution?: string
      qualities?: string[]
      defaultQuality?: string
      promptCharacterLimit?: number
      widthHeightDivisor?: number
      combineImages?: boolean
      maxInputImages?: number
    }
  }
}

/** An image model with what Studio needs beyond the public ImageModel: its pricing and defaults. */
export interface ImageModelInfo extends ImageModel {
  pricing: RawImagePricing
  defaultResolution?: string
  defaultQuality?: string
  promptCharacterLimit?: number
  /** Set for models that take width/height instead of an aspect ratio: the multiple both must be of. */
  sizeDivisor?: number
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : []

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined

/** A text-to-image model (edit false) or a reference-combining edit model (edit true); undefined to skip it. */
export function toImageModel(raw: RawImageModel, edit: boolean): ImageModelInfo | undefined {
  const spec = raw?.model_spec
  if (!raw || typeof raw.id !== 'string' || !raw.id || !spec) return undefined
  const c = spec.constraints ?? {}
  if (edit) {
    // Only models that combine several pictures can take references through /image/multi-edit; the others
    // edit a single picture through another endpoint.
    if (c.combineImages !== true) return undefined
  } else if (NOT_A_GENERATOR.test(raw.id)) {
    return undefined
  }
  const listed = strings(c.aspectRatios)
  // SD-style models size the picture with width/height; Studio offers the usual ratios and converts.
  const sized = !edit && listed.length === 0
  return {
    id: raw.id,
    name: typeof spec.name === 'string' && spec.name ? spec.name : raw.id,
    edit,
    maxInputImages: edit ? Math.floor(positive(c.maxInputImages) ?? DEFAULT_MAX_INPUT_IMAGES) : 0,
    aspectRatios: sized ? [...SIZED_ASPECT_RATIOS] : listed,
    resolutions: strings(c.resolutions),
    qualities: strings(c.qualities),
    privacy: typeof spec.privacy === 'string' ? spec.privacy : 'unknown',
    offline: spec.offline === true,
    pricing: spec.pricing && typeof spec.pricing === 'object' ? spec.pricing : {},
    defaultResolution: typeof c.defaultResolution === 'string' ? c.defaultResolution : undefined,
    defaultQuality: typeof c.defaultQuality === 'string' ? c.defaultQuality : undefined,
    promptCharacterLimit: positive(c.promptCharacterLimit),
    sizeDivisor: sized ? Math.max(1, Math.floor(positive(c.widthHeightDivisor) ?? 8)) : undefined
  }
}

/** The public part, as the window and agents get it. */
export function publicImageModel(m: ImageModelInfo): ImageModel {
  return {
    id: m.id,
    name: m.name,
    edit: m.edit,
    maxInputImages: m.maxInputImages,
    aspectRatios: m.aspectRatios,
    resolutions: m.resolutions,
    qualities: m.qualities,
    privacy: m.privacy,
    offline: m.offline
  }
}

let modelCache: { at: number; models: ImageModelInfo[] } | undefined

/** Text-to-image models first, then the edit models, each in Venice's order. Cached for 10 minutes. */
export async function imageModelCatalog(force = false): Promise<ImageModelInfo[]> {
  // fal's are Studio's own list (fal-images.ts); Venice's are fetched.
  if (getProvider() === 'fal') return falImageCatalog()
  if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models
  try {
    const [generators, editors] = await Promise.all([fetchModels('image'), fetchModels('inpaint')])
    const models = [
      ...generators.flatMap((raw) => toImageModel(raw, false) ?? []),
      ...editors.flatMap((raw) => toImageModel(raw, true) ?? [])
    ]
    modelCache = { at: Date.now(), models }
    return models
  } catch (err) {
    // A list from a little while ago beats none when Venice can't be reached for a moment.
    if (modelCache) return modelCache.models
    throw err
  }
}

/** The image models for the window and agents. */
export async function listImageModels(force = false): Promise<ImageModel[]> {
  return (await imageModelCatalog(force)).map(publicImageModel)
}

/** For tests: forget the cached list. */
export function clearImageModelCache(): void {
  modelCache = undefined
}

async function fetchModels(type: 'image' | 'inpaint'): Promise<RawImageModel[]> {
  const res = await call(`/models?type=${type}`, { method: 'GET', timeoutMs: LIST_TIMEOUT_MS, requireKey: false })
  const json = (await res.json().catch(() => undefined)) as { data?: unknown } | undefined
  if (!json || !Array.isArray(json.data)) throw new VeniceError('Venice sent an unexpected model list.', res.status)
  return json.data as RawImageModel[]
}

// ── Choosing options ─────────────────────────────────────────────────────────

/** "16:9" → 1.777…; undefined for "auto" or anything else that isn't a ratio. */
export function ratioOf(aspectRatio: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio ?? '')
  if (!m) return undefined
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? w / h : undefined
}

/** Of the model's ratios, the one nearest the wanted ratio (by how much it stretches); undefined without any. */
export function closestAspectRatio(wanted: string | undefined, offered: readonly string[]): string | undefined {
  if (wanted && offered.includes(wanted)) return wanted
  const target = ratioOf(wanted)
  const ratios = offered.filter((r) => ratioOf(r) !== undefined)
  if (target === undefined || !ratios.length) return offered.includes('auto') ? 'auto' : ratios[0]
  return ratios.reduce((best, r) =>
    Math.abs(Math.log(ratioOf(r)! / target)) < Math.abs(Math.log(ratioOf(best)! / target)) ? r : best
  )
}

/**
 * width × height for a model that is sized in pixels: about a megapixel in the ratio, no side over 1280 (the
 * endpoint's limit), both multiples of the model's divisor. 16:9 → 1280 × 720, 1:1 → 1024 × 1024.
 */
export function sizeFor(aspectRatio: string | undefined, divisor: number): { width: number; height: number } {
  const ratio = ratioOf(aspectRatio) ?? 1
  let width = Math.sqrt(TARGET_AREA * ratio)
  let height = width / ratio
  const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height)
  width *= scale
  height *= scale
  const step = Math.max(1, divisor)
  const snap = (v: number): number => Math.max(step, Math.floor(v / step) * step)
  return { width: snap(width), height: snap(height) }
}

/**
 * The resolution tier a request for this model uses: the one asked for, else 1K, else the model's default. It is
 * always sent, so the price Studio shows is the price of what is asked for.
 */
export function effectiveResolution(model: ImageModelInfo, resolution?: string): string | undefined {
  if (!model.resolutions.length) return undefined
  if (resolution && model.resolutions.includes(resolution)) return resolution
  if (model.resolutions.includes(DEFAULT_RESOLUTION)) return DEFAULT_RESOLUTION
  if (model.defaultResolution && model.resolutions.includes(model.defaultResolution)) return model.defaultResolution
  return model.resolutions[0]
}

/**
 * The quality a request for this model uses: the one asked for, else the model's default, else "medium". It is
 * always sent, so the price Studio shows is the price of what is asked for.
 */
export function effectiveQuality(model: ImageModelInfo, quality?: string): string | undefined {
  if (!model.qualities.length) return undefined
  if (quality && model.qualities.includes(quality)) return quality
  if (model.defaultQuality && model.qualities.includes(model.defaultQuality)) return model.defaultQuality
  return model.qualities.includes('medium') ? 'medium' : model.qualities[0]
}

// ── Price ────────────────────────────────────────────────────────────────────

/** Cents and fractions of them; the list's float sums (0.0023000000000000004) are cut to a millionth. */
const roundUsd = (v: number): number => Math.round(v * 1e6) / 1e6

const usd = (v: Usd | undefined): number | undefined =>
  typeof v?.usd === 'number' && Number.isFinite(v.usd) && v.usd >= 0 ? v.usd : undefined

/**
 * What one picture costs, from the model list's pricing: the price for the quality at that resolution tier, else
 * for the tier, else the model's flat price; for edit models plus each input picture beyond those included.
 * `inputImages` is the number of pictures sent (the base picture counts). Undefined when the list has no price.
 */
export function priceImage(
  model: ImageModelInfo,
  options: { resolution?: string; quality?: string; inputImages?: number } = {}
): number | undefined {
  const p = model.pricing
  const resolution = effectiveResolution(model, options.resolution) ?? model.defaultResolution ?? DEFAULT_RESOLUTION
  const quality = effectiveQuality(model, options.quality)
  let base: number | undefined
  if (quality) base = usd(p.quality?.[resolution]?.[quality])
  base ??= usd(p.resolutions?.[resolution])
  base ??= usd(model.edit ? p.inpaint : p.generation) ?? usd(model.edit ? p.generation : p.inpaint)
  if (base === undefined) return undefined
  let total = base
  if (model.edit && p.inputImages) {
    const included = Math.max(0, Math.floor(p.inputImages.included ?? 0))
    const extra = Math.max(0, Math.floor(options.inputImages ?? 0) - included)
    total += extra * (usd(p.inputImages.additional) ?? 0)
  }
  return roundUsd(total)
}

// ── Requests ─────────────────────────────────────────────────────────────────

/** A request as /image/generate takes it (only the fields Studio sends). */
export interface GenerateImageBody {
  model: string
  prompt: string
  negative_prompt?: string
  aspect_ratio?: string
  width?: number
  height?: number
  resolution?: string
  quality?: string
  format: 'png'
  safe_mode: boolean
  hide_watermark: true
  return_binary: false
}

/** A request as /image/multi-edit takes it; it refuses fields it doesn't know. */
export interface MultiEditBody {
  modelId: string
  prompt: string
  /** Data URLs; the first is the base picture the others are combined into. */
  images: string[]
  aspect_ratio?: string
  resolution?: string
  quality?: string
  output_format: 'png'
  safe_mode: boolean
}

/** What Studio asks for, after stills.ts has checked it against the model. */
export interface ImageRequest {
  model: ImageModelInfo
  prompt: string
  negativePrompt?: string
  /** Absolute paths, base first; empty for text-to-image. */
  referenceImages: string[]
  aspectRatio?: string
  resolution?: string
  quality?: string
}

export function generateBody(req: ImageRequest, safeMode: boolean): GenerateImageBody {
  const body: GenerateImageBody = {
    model: req.model.id,
    prompt: req.prompt,
    format: 'png',
    safe_mode: safeMode,
    hide_watermark: true,
    return_binary: false
  }
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt
  if (req.model.sizeDivisor !== undefined) {
    Object.assign(body, sizeFor(req.aspectRatio, req.model.sizeDivisor))
  } else if (req.aspectRatio) {
    body.aspect_ratio = req.aspectRatio
  }
  if (req.resolution && req.model.resolutions.includes(req.resolution)) body.resolution = req.resolution
  if (req.quality && req.model.qualities.includes(req.quality)) body.quality = req.quality
  return body
}

export async function multiEditBody(req: ImageRequest, safeMode: boolean): Promise<MultiEditBody> {
  const body: MultiEditBody = {
    modelId: req.model.id,
    prompt: req.prompt,
    images: await Promise.all(req.referenceImages.map(inputImageDataUrl)),
    output_format: 'png',
    safe_mode: safeMode
  }
  if (req.aspectRatio) body.aspect_ratio = req.aspectRatio
  if (req.resolution && req.model.resolutions.includes(req.resolution)) body.resolution = req.resolution
  if (req.quality && req.model.qualities.includes(req.quality)) body.quality = req.quality
  return body
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

/**
 * An input picture as a data URL within Venice's limits: at most 2048 px on the long side (smaller requests,
 * and no model needs more for a reference), at least 65 536 pixels, PNGs kept as PNG so transparency survives,
 * everything else as JPEG. Decoded as Studio shows it (decodeImageFile: a phone photo turned upright, a WebP
 * through ffmpeg); only a picture that can't be decoded at all (a WebP without ffmpeg) is sent as it is.
 */
export async function inputImageDataUrl(path: string): Promise<string> {
  try {
    return await encodeInputImage(path)
  } catch (err) {
    if (err instanceof VeniceError) throw err
    throw new Error(`The reference image ${shortName(path)} could not be read: ${fileErrorReason(err)}.`, { cause: err })
  }
}

async function encodeInputImage(path: string): Promise<string> {
  const ext = extname(path).toLowerCase()
  const { image: img, bytes } = await decodeImageFile(path)
  if (!img) {
    if (bytes.length > MAX_INPUT_BYTES) {
      throw new VeniceError(`The reference image ${shortName(path)} is too large for Venice (over 20 MB).`, 413)
    }
    return `data:${MIME[ext] ?? 'image/png'};base64,${bytes.toString('base64')}`
  }
  const { width, height } = img.getSize()
  let scale = Math.min(1, MAX_INPUT_SIDE / Math.max(width, height))
  // A tiny picture (an icon, a thumbnail) is scaled up to the smallest size Venice takes.
  if (width * height * scale * scale < MIN_INPUT_PIXELS) scale = Math.sqrt(MIN_INPUT_PIXELS / (width * height)) * 1.01
  const sized =
    scale === 1
      ? img
      : img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
  // A PNG may carry transparency that matters (a cut-out outfit), and so may a WebP (decoded to PNG); a large one
  // goes as JPEG all the same.
  if (ext === '.png' || ext === '.webp') {
    const png = sized.toPNG()
    if (png.length <= MAX_PNG_INPUT_BYTES) return `data:image/png;base64,${png.toString('base64')}`
  }
  return `data:image/jpeg;base64,${sized.toJPEG(92).toString('base64')}`
}

const shortName = (path: string): string => path.split(/[\\/]/).pop() ?? path

// ── Calling Venice ───────────────────────────────────────────────────────────

interface CallOptions {
  method: 'GET' | 'POST'
  body?: unknown
  timeoutMs: number
  /** Paid endpoints need the key; the model list is public (the key is still sent when there is one). */
  requireKey?: boolean
}

const NO_KEY = 'No API key is set. Add it in Settings.'
const CONTENT_VIOLATION =
  "Venice stopped the image because it breaks Venice's terms of use. Change the prompt or the reference images and try again."

/** fetch() with the key, a deadline and plain errors; resolves only with a 2xx response that isn't a violation. */
async function call(path: string, opts: CallOptions): Promise<Response> {
  const headers = new Headers()
  const key = getApiKey()
  if (key) headers.set('Authorization', `Bearer ${key}`)
  else if (opts.requireKey !== false) throw new VeniceError(NO_KEY, 401)
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs)
    })
  } catch (err) {
    throw transportError(err, opts)
  }
  if (isContentViolation(res)) {
    await res.body?.cancel().catch(() => {})
    throw new VeniceError(CONTENT_VIOLATION, res.status === 200 ? 422 : res.status)
  }
  if (!res.ok) throw await responseError(res, opts.method === 'GET' ? 'list' : 'image')
  return res
}

function isContentViolation(res: Response): boolean {
  return res.headers.get('x-venice-is-content-violation')?.trim().toLowerCase() === 'true'
}

/** Timeouts and dropped connections. A paid request may have been charged anyway, which the message says. */
function transportError(err: unknown, opts: CallOptions): Error {
  const name = (err as { name?: string } | undefined)?.name
  const paid = opts.method === 'POST'
  if (name === 'TimeoutError' || name === 'AbortError') {
    const minutes = Math.round(opts.timeoutMs / 60_000)
    const waited =
      minutes >= 1 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : `${Math.round(opts.timeoutMs / 1000)} s`
    return new VeniceError(
      paid
        ? `Venice did not answer within ${waited}, so Studio stopped waiting. The image may have been charged anyway – check your balance before you try again.`
        : `Venice did not answer within ${waited}. Try again in a moment.`,
      0,
      undefined
    )
  }
  return new VeniceError(
    paid
      ? 'The connection to Venice was lost. Check your internet connection; the image may have been charged anyway, so check your balance before you try again.'
      : 'Could not reach Venice. Check your internet connection and try again.',
    0,
    err
  )
}

/** Venice's own wording of an error body (its `error`, `message` or `details`), or the raw text. */
function detailOf(body: unknown, text: string): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown; details?: unknown }
    const error = typeof b.error === 'string' ? b.error : (b.error as { message?: unknown } | undefined)?.message
    for (const v of [error, b.message]) if (typeof v === 'string' && v.trim()) return v.trim()
    if (b.details !== undefined) return JSON.stringify(b.details).slice(0, 300)
  }
  return text.trim().slice(0, 300)
}

/**
 * A failed response in plain words, with Venice's own detail where it helps the user fix the request. `what`: the
 * model list (free) or a picture (paid).
 */
export async function responseError(res: Response, what: 'list' | 'image' = 'image'): Promise<VeniceError> {
  const text = await res.text().catch(() => '')
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON; keep the text.
  }
  const detail = detailOf(body, text)
  const code = (body as { code?: unknown } | undefined)?.code
  const withDetail = (message: string): string => (detail ? `${message} (Venice: ${detail})` : message)
  let message: string
  switch (res.status) {
    case 400:
    case 422:
      message = withDetail('Venice did not accept the request.')
      break
    case 401:
      message = /pro/i.test(detail)
        ? 'The model requires Venice Pro. Choose another model or upgrade your Venice account.'
        : 'Venice did not accept the API key. Check it in Settings.'
      break
    case 402:
      message = 'Your Venice balance is too low. Top it up at Venice and try again.'
      break
    case 403:
      message = withDetail('Venice refused the request for this API key.')
      break
    case 404:
      message = "Venice doesn't know the model any more. Choose another model."
      break
    case 413:
      message = 'The reference images are too large for Venice. Use fewer or smaller images.'
      break
    case 415:
      message = withDetail('Venice could not read the request.')
      break
    case 429:
      message = "Venice isn't taking more requests right now. Wait a moment and try again."
      break
    case 503:
      message = 'The model is fully busy at Venice right now. Try again in a moment or choose another model.'
      break
    default:
      message =
        res.status >= 500
          ? `Venice could not create the image (server error ${res.status}). Try again in a moment.`
          : withDetail(`Venice answered with error ${res.status}.`)
  }
  if (code === 'INSUFFICIENT_BALANCE') {
    message = 'Your Venice balance is too low. Top it up at Venice and try again.'
  }
  if (what === 'list' && res.status !== 401 && res.status !== 429) {
    message = `Venice could not send the list of image models (error ${res.status}). Try again in a moment.`
  }
  return new VeniceError(message, res.status, body)
}

/** The picture a paid call returned, and its format as read from the bytes themselves. */
export interface ImageResult {
  data: Buffer
  format: 'png' | 'jpeg' | 'webp'
}

/** The format of image bytes from their signature; undefined when they aren't a picture Studio can store. */
export function imageFormat(data: Buffer): ImageResult['format'] | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return undefined
}

function asImage(data: Buffer, res: Response): ImageResult {
  const format = imageFormat(data)
  if (!format) throw new VeniceError('Venice sent something that is not an image. Try again.', res.status)
  return { data, format }
}

/** POST /image/generate (paid). */
export async function requestGenerate(body: GenerateImageBody): Promise<ImageResult> {
  const res = await call('/image/generate', { method: 'POST', body, timeoutMs: GENERATE_TIMEOUT_MS })
  let json: { images?: unknown }
  try {
    json = (await res.json()) as { images?: unknown }
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new VeniceError(
        'Venice sent an answer that could not be read. The image may have been charged anyway – check your balance before you try again.',
        res.status
      )
    }
    throw transportError(err, { method: 'POST', timeoutMs: GENERATE_TIMEOUT_MS })
  }
  const first = Array.isArray(json?.images) ? json.images[0] : undefined
  if (typeof first !== 'string' || !first) throw new VeniceError('Venice sent no image. Try again.', res.status)
  // Venice sends plain base64; a data URL prefix is tolerated all the same.
  return asImage(Buffer.from(first.replace(/^data:[^,]*,/, ''), 'base64'), res)
}

/** POST /image/multi-edit (paid); answers with the picture's bytes. */
export async function requestMultiEdit(body: MultiEditBody): Promise<ImageResult> {
  const res = await call('/image/multi-edit', { method: 'POST', body, timeoutMs: GENERATE_TIMEOUT_MS })
  let data: Buffer
  try {
    data = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    throw transportError(err, { method: 'POST', timeoutMs: GENERATE_TIMEOUT_MS })
  }
  return asImage(data, res)
}

/** Sends the request to the right endpoint with the user's safe-mode setting (paid). */
export async function requestImage(req: ImageRequest): Promise<ImageResult> {
  const safeMode = getImageSafeMode()
  if (providerOf(req.model.id) === 'fal') return falRequestImage(req, safeMode, GENERATE_TIMEOUT_MS)
  if (req.model.edit) return requestMultiEdit(await multiEditBody(req, safeMode))
  return requestGenerate(generateBody(req, safeMode))
}

/** PNG bytes for a picture Venice sent in another format; undefined when it can't be converted here. */
export function toPng(result: ImageResult): Buffer | undefined {
  if (result.format === 'png') return result.data
  const img = nativeImage.createFromBuffer(result.data)
  return img.isEmpty() ? undefined : img.toPNG()
}
