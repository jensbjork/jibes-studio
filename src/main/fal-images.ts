// Pictures on fal.ai (Create image…): Seedream 5.0 Pro and Nano Banana 2.1, to make a picture from text or combine
// reference pictures, as images.ts does with Venice's /image/generate and /image/multi-edit. The models are described
// as Venice's list describes its own (ImageModelInfo with a price table), so stills.ts checks, prices and records a
// fal picture exactly as a Venice one. The answer comes inline (sync_mode), so fal keeps no copy of the picture.

import { basename } from 'node:path'
import { falImageModel, FAL_IMAGE_MODELS, type FalImageModel } from '@shared/fal-models'
import { FalClient, FalError } from './fal'
import type { ImageModelInfo, ImageRequest, ImageResult } from './images'
import { imageFormat, ratioOf } from './images'
import { getFalKey } from './settings'
import { encodeInputImage } from './venice'

const fal = new FalClient(getFalKey)

/** fal's image models as Studio's catalogue has them (stills.ts reads prices and options from this). */
export function falImageCatalog(): ImageModelInfo[] {
  return FAL_IMAGE_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    edit: m.edit,
    maxInputImages: m.maxInputImages,
    aspectRatios: m.aspectRatios,
    resolutions: m.resolutions,
    qualities: [],
    privacy: 'unknown',
    offline: false,
    pricing: {
      resolutions: Object.fromEntries(Object.entries(m.usd).map(([r, usd]) => [r, { usd }])),
      ...(m.usdPerExtraInput ? { inputImages: { included: 1, additional: { usd: m.usdPerExtraInput } } } : {})
    },
    defaultResolution: m.defaultResolution
  }))
}

/** Seedream's resolution tiers as pixel areas (1K ≈ 1 MP … 2K ≈ 4 MP), within its 0.92–4.6 MP. */
const SEEDREAM_AREA: Record<string, number> = { '1K': 1024 * 1024, '1.5K': 1536 * 1536, '2K': 2048 * 2048 }

/** width × height for Seedream: the tier's area in the ratio, both multiples of 16, never under its smallest area. */
export function seedreamSize(
  aspectRatio: string | undefined,
  resolution: string | undefined
): { width: number; height: number } {
  const ratio = ratioOf(aspectRatio) ?? 1
  const area = Math.max(921_600, SEEDREAM_AREA[resolution ?? '1.5K'] ?? SEEDREAM_AREA['1.5K'])
  const snap = (v: number): number => Math.max(16, Math.ceil(v / 16) * 16)
  const width = snap(Math.sqrt(area * ratio))
  const height = snap(width / ratio)
  return { width, height }
}

/** The picture's input for the model (prompt, size, references), as its endpoint takes it. */
export async function falImageInput(
  model: FalImageModel,
  req: ImageRequest,
  safeMode: boolean,
  upload: (path: string) => Promise<string>
): Promise<Record<string, unknown>> {
  // Neither model takes a negative prompt: like a video model without one, it goes last as "Avoid: …".
  const avoid = req.negativePrompt?.replace(/\s+/g, ' ').trim()
  const prompt = avoid ? `${req.prompt.trimEnd()}\n\nAvoid: ${avoid.replace(/[.\s]+$/, '')}.` : req.prompt
  const input: Record<string, unknown> = { prompt, num_images: 1, output_format: 'png', sync_mode: true }
  if (model.style === 'seedream') {
    input.image_size = seedreamSize(req.aspectRatio, req.resolution)
  } else {
    if (req.aspectRatio && model.aspectRatios.includes(req.aspectRatio)) input.aspect_ratio = req.aspectRatio
    if (req.resolution && model.resolutions.includes(req.resolution)) input.resolution = req.resolution
    // Safe mode: fal's default tolerance (4); off: the most permissive Google allows (6).
    input.safety_tolerance = safeMode ? '4' : '6'
  }
  if (model.edit) {
    if (!req.referenceImages.length) throw new Error('Choose at least one reference picture.')
    input.image_urls = await Promise.all(req.referenceImages.map(upload))
  }
  return input
}

/** Makes the picture at fal (paid) and returns its bytes. */
export async function falRequestImage(req: ImageRequest, safeMode: boolean, timeoutMs: number): Promise<ImageResult> {
  const model = falImageModel(req.model.id)
  if (!model) throw new Error(`fal.ai has no image model ${req.model.id} in Studio. Choose another model.`)
  const upload = async (path: string): Promise<string> => {
    const { bytes, mime } = await encodeInputImage(path)
    return fal.upload(bytes, mime, basename(path))
  }
  const input = await falImageInput(model, req, safeMode, upload)
  const out = await fal.run<{ images?: { url?: string }[] }>(model.endpoint, input, { timeoutMs })
  const url = out?.images?.[0]?.url
  if (!url) throw new FalError('fal.ai sent no image. It may have been charged anyway – check your usage.', 502)
  const data = url.startsWith('data:')
    ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    : await fal.download(url, 'The image could not be downloaded from fal.ai.')
  const format = imageFormat(data)
  if (!format) throw new FalError('fal.ai sent something that is not an image. Try again.', 502)
  return { data, format }
}
