// fal.ai's models as Studio offers them: a list chosen for Studio rather than fal's catalogue, which hides some of
// them (Seedance 2.x, Veo 3.1) from its search and says little about what each takes. Every entry's inputs follow the
// endpoint's OpenAPI schema (fal.ai/api/openapi/queue/openapi.json?endpoint_id=…) and its price the model's page, as
// of 2026-10. Ids are Studio's (`fal:<endpoint id>`, provider.ts); pure data and arithmetic, shared by main and window.

import { FAL_PREFIX } from './provider'
import type { AudioGenModel, AsrModel, GenerationParams, SpeechModel, VideoModel, VoiceChangerModel } from './types'

/** How an endpoint's input is written (fal-video.ts builds each). */
export type FalInputStyle =
  'seedance' | 'kling4' | 'kling3' | 'kling-o3' | 'veo' | 'wan-edit' | 'gemini-edit' | 'topaz' | 'lipsync'

/** What a model takes as reference videos (models.ts' ReferenceVideoLimits, kept here to stay import-free). */
export interface FalVideoLimits {
  family: string
  maxVideos: number
  minSeconds: number
  maxSeconds: number
  maxTotalSeconds: number
}

/** How a model is priced. Rates are USD per second of output unless said otherwise. */
export type FalVideoPrice =
  | {
      kind: 'per-second'
      /** By resolution ('*' for any). */
      rate: Record<string, number>
      /** With sound on, by resolution ('*' for any); else `rate` either way. */
      audioRate?: Record<string, number>
      /**
       * With reference videos (or a video to edit): this factor on the rate, counted on the input videos' seconds and
       * the output's together (Seedance), at least `minOutputMultiple` × the output's seconds (Kling 4).
       */
      videoInput?: { factor: number; minOutputMultiple?: number }
    }
  /** Per second of the input video, rounded up to the step (Kling's lip sync: 5 s). */
  | { kind: 'per-input-second'; rate: number; step?: number }
  /** Topaz: per second of output, by output height. */
  | { kind: 'upscale'; rate: Record<'720p' | '1080p' | '4k', number> }

export interface FalVideoModel {
  /** Studio's id: fal:<endpoint>. */
  id: string
  name: string
  kind: 'text-to-video' | 'image-to-video' | 'reference-to-video' | 'video-to-video'
  /** fal's endpoint. */
  endpoint: string
  /** The endpoint used instead when an end image goes along (Veo's first-last-frame model). */
  endEndpoint?: string
  style: FalInputStyle
  durations: string[]
  resolutions: string[]
  aspectRatios: string[]
  /** Makes sound; `audioConfigurable`: it can be switched off (generate_audio). */
  audio: boolean
  audioConfigurable: boolean
  endImage: boolean
  maxImages: number
  /** Reference audio clips it takes (0: none). */
  maxAudios: number
  videoLimits?: FalVideoLimits
  /** Takes Seedance 2.5's `task` (reference / editing / extension). */
  referenceTask: boolean
  negativePrompt: boolean
  seed: boolean
  /** The same family's model for each mode, where it has one. */
  siblings: Partial<Record<'text-to-video' | 'image-to-video' | 'reference-to-video', string>>
  price: FalVideoPrice
  /** Only the Editor uses it (an edit, an upscaler, lip sync): Generate never offers it. */
  editorOnly?: boolean
  upscale?: boolean
  lipSync?: boolean
  /** Longest prompt it takes, where fal says. */
  promptCharacterLimit?: number
}

const id = (endpoint: string): string => FAL_PREFIX + endpoint
const seconds = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}s`)

const SEEDANCE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

/** Seedance 2.0's reference videos on fal: up to 3, 2–15 s together (as Venice's 2.0). */
const SEEDANCE_20_VIDEOS: FalVideoLimits = {
  family: 'Seedance 2.0',
  maxVideos: 3,
  minSeconds: 2,
  maxSeconds: 15,
  maxTotalSeconds: 15
}
/** Seedance 2.5's: up to 10, 1.8–30.2 s each and together (Studio keeps to 2–30). */
const SEEDANCE_25_VIDEOS: FalVideoLimits = {
  family: 'Seedance 2.5',
  maxVideos: 10,
  minSeconds: 2,
  maxSeconds: 30,
  maxTotalSeconds: 30
}
/** Kling 4.0's: up to 5 of 3–30 s, 30 s together. */
const KLING_4_VIDEOS: FalVideoLimits = {
  family: 'Kling 4.0',
  maxVideos: 5,
  minSeconds: 3,
  maxSeconds: 30,
  maxTotalSeconds: 30
}

function seedanceFamily(
  base: string,
  name: string,
  o: {
    durations: string[]
    resolutions: string[]
    price: FalVideoPrice
    videos: FalVideoLimits
    referenceTask: boolean
    /** 2.5's image-to-video takes the picture's shape (aspect_ratio is always "auto"). */
    i2vAspectFromImage: boolean
  }
): FalVideoModel[] {
  const t2v = id(`${base}/text-to-video`)
  const i2v = id(`${base}/image-to-video`)
  const r2v = id(`${base}/reference-to-video`)
  const siblings = { 'text-to-video': t2v, 'image-to-video': i2v, 'reference-to-video': r2v }
  const common = {
    style: 'seedance' as const,
    durations: o.durations,
    resolutions: o.resolutions,
    audio: true,
    audioConfigurable: true,
    negativePrompt: false,
    siblings,
    price: o.price
  }
  return [
    {
      ...common,
      id: t2v,
      name,
      kind: 'text-to-video',
      endpoint: `${base}/text-to-video`,
      aspectRatios: SEEDANCE_ASPECTS,
      endImage: false,
      maxImages: 0,
      maxAudios: 0,
      referenceTask: false,
      seed: false
    },
    {
      ...common,
      id: i2v,
      name: `${name} (start image)`,
      kind: 'image-to-video',
      endpoint: `${base}/image-to-video`,
      aspectRatios: o.i2vAspectFromImage ? [] : SEEDANCE_ASPECTS,
      endImage: true,
      maxImages: 0,
      maxAudios: 0,
      referenceTask: false,
      seed: false
    },
    {
      ...common,
      id: r2v,
      name: `${name} (references)`,
      kind: 'reference-to-video',
      endpoint: `${base}/reference-to-video`,
      aspectRatios: SEEDANCE_ASPECTS,
      endImage: false,
      maxImages: 9,
      maxAudios: 3,
      videoLimits: o.videos,
      referenceTask: o.referenceTask,
      // 2.5's reference-to-video is the only Seedance endpoint on fal with a seed.
      seed: o.referenceTask
    }
  ]
}

/** Every fal video model Studio knows: the ones Generate offers, then the Editor's. */
export const FAL_VIDEO_MODELS: readonly FalVideoModel[] = [
  ...seedanceFamily('bytedance/seedance-2.5', 'Seedance 2.5', {
    durations: seconds(4, 30),
    resolutions: ['480p', '720p', '1080p'],
    price: { kind: 'per-second', rate: { '480p': 0.2205, '720p': 0.473, '1080p': 1.164 }, videoInput: { factor: 0.6 } },
    videos: SEEDANCE_25_VIDEOS,
    referenceTask: true,
    i2vAspectFromImage: true
  }),
  ...seedanceFamily('bytedance/seedance-2.0', 'Seedance 2.0', {
    durations: seconds(4, 15),
    resolutions: ['480p', '720p', '1080p', '4k'],
    // $0.014 per 1,000 tokens (4K: $0.008), tokens = width × height × seconds × 24 / 1024; with reference videos
    // $0.0086016 (4K $0.0048) on the input and output seconds together.
    price: {
      kind: 'per-second',
      rate: { '480p': 0.1348, '720p': 0.3034, '1080p': 0.682, '4k': 1.5552 },
      videoInput: { factor: 0.6144 }
    },
    videos: SEEDANCE_20_VIDEOS,
    referenceTask: false,
    i2vAspectFromImage: false
  }),
  ...seedanceFamily('bytedance/seedance-2.0/fast', 'Seedance 2.0 Fast', {
    durations: seconds(4, 15),
    resolutions: ['480p', '720p'],
    price: { kind: 'per-second', rate: { '480p': 0.1075, '720p': 0.2419 }, videoInput: { factor: 0.6 } },
    videos: SEEDANCE_20_VIDEOS,
    referenceTask: false,
    i2vAspectFromImage: false
  }),
  ...klingFour(),
  ...klingThree(),
  ...veo('fal-ai/veo3.1', 'Veo 3.1', {
    rate: { '720p': 0.2, '1080p': 0.2, '4k': 0.4 },
    audioRate: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
    references: true
  }),
  ...veo('fal-ai/veo3.1/fast', 'Veo 3.1 Fast', {
    rate: { '720p': 0.1, '1080p': 0.1, '4k': 0.3 },
    audioRate: { '720p': 0.15, '1080p': 0.15, '4k': 0.35 },
    references: false
  }),
  ...editorModels()
]

function klingFour(): FalVideoModel[] {
  const t2v = id('kling/v4/text-to-video')
  const i2v = id('kling/v4/image-to-video')
  const r2v = id('kling/v4/reference-to-video')
  const common = {
    style: 'kling4' as const,
    durations: seconds(3, 30),
    resolutions: ['720p', '1080p'],
    // No sound switch is documented: what the model does with sound is its own.
    audio: false,
    audioConfigurable: false,
    endImage: false,
    maxImages: 0,
    maxAudios: 0,
    referenceTask: false,
    negativePrompt: false,
    seed: false,
    siblings: { 'text-to-video': t2v, 'image-to-video': i2v, 'reference-to-video': r2v },
    price: { kind: 'per-second', rate: { '720p': 0.157, '1080p': 0.235 } } as FalVideoPrice
  }
  return [
    {
      ...common,
      id: t2v,
      name: 'Kling 4.0',
      kind: 'text-to-video',
      endpoint: 'kling/v4/text-to-video',
      aspectRatios: ['16:9', '9:16', '1:1', '21:9']
    },
    {
      ...common,
      id: i2v,
      name: 'Kling 4.0 (start image)',
      kind: 'image-to-video',
      endpoint: 'kling/v4/image-to-video',
      aspectRatios: [],
      endImage: true
    },
    {
      ...common,
      id: r2v,
      name: 'Kling 4.0 (references)',
      kind: 'reference-to-video',
      endpoint: 'kling/v4/reference-to-video',
      aspectRatios: ['16:9', '9:16', '1:1', '21:9'],
      maxImages: 9,
      videoLimits: KLING_4_VIDEOS,
      price: {
        kind: 'per-second',
        rate: { '720p': 0.157, '1080p': 0.235 },
        // With video references $0.094 / $0.141 a second, on the input and output together, at least twice the output.
        videoInput: { factor: 0.6, minOutputMultiple: 2 }
      }
    }
  ]
}

function klingThree(): FalVideoModel[] {
  const t2v = id('fal-ai/kling-video/v3/pro/text-to-video')
  const i2v = id('fal-ai/kling-video/v3/pro/image-to-video')
  const r2v = id('fal-ai/kling-video/o3/pro/reference-to-video')
  const siblings = { 'text-to-video': t2v, 'image-to-video': i2v, 'reference-to-video': r2v }
  const silentAndSound: FalVideoPrice = { kind: 'per-second', rate: { '*': 0.112 }, audioRate: { '*': 0.168 } }
  return [
    {
      id: t2v,
      name: 'Kling 3',
      kind: 'text-to-video',
      endpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
      style: 'kling3',
      durations: seconds(3, 15),
      resolutions: [],
      aspectRatios: ['16:9', '9:16', '1:1'],
      audio: true,
      audioConfigurable: true,
      endImage: false,
      maxImages: 0,
      maxAudios: 0,
      referenceTask: false,
      negativePrompt: true,
      seed: false,
      siblings,
      price: silentAndSound
    },
    {
      id: i2v,
      name: 'Kling 3 (start image)',
      kind: 'image-to-video',
      endpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
      style: 'kling3',
      durations: seconds(3, 15),
      resolutions: [],
      aspectRatios: [],
      audio: true,
      audioConfigurable: true,
      endImage: true,
      maxImages: 0,
      maxAudios: 0,
      referenceTask: false,
      negativePrompt: true,
      seed: false,
      siblings,
      price: silentAndSound
    },
    {
      id: r2v,
      name: 'Kling O3 (references)',
      kind: 'reference-to-video',
      endpoint: 'fal-ai/kling-video/o3/pro/reference-to-video',
      style: 'kling-o3',
      durations: seconds(3, 15),
      resolutions: [],
      aspectRatios: ['16:9', '9:16', '1:1'],
      audio: true,
      audioConfigurable: true,
      endImage: false,
      maxImages: 4,
      maxAudios: 0,
      referenceTask: false,
      negativePrompt: false,
      seed: false,
      siblings,
      price: { kind: 'per-second', rate: { '*': 0.112 }, audioRate: { '*': 0.14 } }
    }
  ]
}

function veo(
  base: string,
  name: string,
  o: { rate: Record<string, number>; audioRate: Record<string, number>; references: boolean }
): FalVideoModel[] {
  const t2v = id(base)
  const i2v = id(`${base}/image-to-video`)
  const r2v = o.references ? id(`${base}/reference-to-video`) : undefined
  const siblings = { 'text-to-video': t2v, 'image-to-video': i2v, ...(r2v ? { 'reference-to-video': r2v } : {}) }
  const common = {
    style: 'veo' as const,
    durations: ['4s', '6s', '8s'],
    resolutions: ['720p', '1080p', '4k'],
    audio: true,
    audioConfigurable: true,
    maxAudios: 0,
    referenceTask: false,
    siblings,
    price: { kind: 'per-second', rate: o.rate, audioRate: o.audioRate } as FalVideoPrice
  }
  const models: FalVideoModel[] = [
    {
      ...common,
      id: t2v,
      name,
      kind: 'text-to-video',
      endpoint: base,
      aspectRatios: ['16:9', '9:16'],
      endImage: false,
      maxImages: 0,
      negativePrompt: true,
      seed: true
    },
    {
      ...common,
      id: i2v,
      name: `${name} (start image)`,
      kind: 'image-to-video',
      endpoint: `${base}/image-to-video`,
      endEndpoint: `${base}/first-last-frame-to-video`,
      aspectRatios: ['16:9', '9:16'],
      endImage: true,
      maxImages: 0,
      negativePrompt: true,
      seed: true
    }
  ]
  if (r2v) {
    models.push({
      ...common,
      id: r2v,
      name: `${name} (references)`,
      kind: 'reference-to-video',
      endpoint: `${base}/reference-to-video`,
      // fal's reference-to-video makes 8 s only.
      durations: ['8s'],
      aspectRatios: ['16:9', '9:16'],
      endImage: false,
      maxImages: 3,
      negativePrompt: false,
      seed: false
    })
  }
  return models
}

/** The Editor's models on fal: Edit with prompt's video-to-video models, the upscaler and lip sync. */
function editorModels(): FalVideoModel[] {
  const editor = {
    kind: 'video-to-video' as const,
    durations: [],
    aspectRatios: [],
    audio: false,
    audioConfigurable: false,
    endImage: false,
    maxImages: 0,
    maxAudios: 0,
    referenceTask: false,
    negativePrompt: false,
    seed: false,
    siblings: {},
    editorOnly: true
  }
  return [
    {
      ...editor,
      id: id('fal-ai/wan/v2.7/edit-video'),
      name: 'Wan 2.7 Edit',
      endpoint: 'fal-ai/wan/v2.7/edit-video',
      style: 'wan-edit',
      resolutions: ['720p', '1080p'],
      price: { kind: 'per-second', rate: { '720p': 0.1, '1080p': 0.15 } }
    },
    {
      ...editor,
      id: id('google/gemini-omni-flash/v1.1/edit'),
      name: 'Gemini Omni Flash 1.1 Edit',
      endpoint: 'google/gemini-omni-flash/v1.1/edit',
      style: 'gemini-edit',
      resolutions: ['720p', '1080p'],
      price: { kind: 'per-second', rate: { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 } }
    },
    {
      ...editor,
      id: id('fal-ai/topaz/upscale/video'),
      name: 'Topaz Video Upscale',
      endpoint: 'fal-ai/topaz/upscale/video',
      style: 'topaz',
      resolutions: ['2x', '4x'],
      upscale: true,
      price: { kind: 'upscale', rate: { '720p': 0.01, '1080p': 0.02, '4k': 0.08 } }
    },
    {
      ...editor,
      // Sync's lipsync-2: any size and length, $3 a minute of video ($0.05 a second).
      id: id('fal-ai/sync-lipsync/v2'),
      name: 'Sync Lipsync 2',
      endpoint: 'fal-ai/sync-lipsync/v2',
      style: 'lipsync',
      resolutions: [],
      lipSync: true,
      price: { kind: 'per-input-second', rate: 0.05 }
    }
  ]
}

const BY_ID = new Map(FAL_VIDEO_MODELS.map((m) => [m.id, m]))

/** A fal video model by Studio's id; undefined for any other id. */
export function falVideoModel(modelId: string | undefined | null): FalVideoModel | undefined {
  return typeof modelId === 'string' ? BY_ID.get(modelId) : undefined
}

/** The models as the form's model list has them (VideoModel), Generate's and the Editor's. */
export function falVideoModelList(): VideoModel[] {
  return FAL_VIDEO_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    privacy: 'unknown',
    offline: false,
    aspectRatios: m.aspectRatios,
    resolutions: m.resolutions,
    durations: m.durations,
    audio: m.audio,
    audioConfigurable: m.audioConfigurable,
    audioInput: m.maxAudios > 0,
    ...(m.promptCharacterLimit ? { promptCharacterLimit: m.promptCharacterLimit } : {}),
    modelSets: [],
    videoInput: m.kind === 'video-to-video'
  }))
}

/** fal's defaults per mode, as DEFAULT_MODEL has Venice's. */
export const FAL_DEFAULT_MODEL = {
  'text-to-video': id('bytedance/seedance-2.5/text-to-video'),
  'image-to-video': id('bytedance/seedance-2.5/image-to-video'),
  'reference-to-video': id('bytedance/seedance-2.5/reference-to-video')
} as const

/** The Editor's models on fal (edit-ops.ts reads the provider's set). */
export const FAL_EDITOR_MODELS = {
  upscale: id('fal-ai/topaz/upscale/video'),
  lipSync: id('fal-ai/sync-lipsync/v2')
} as const

// ── Prices ───────────────────────────────────────────────────────────────────

const OUTPUT_HEIGHT: Record<string, number> = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 }

function rateFor(table: Record<string, number> | undefined, resolution: string | undefined): number | undefined {
  if (!table) return undefined
  if (resolution && table[resolution] !== undefined) return table[resolution]
  if (table['*'] !== undefined) return table['*']
  // A resolution the table doesn't list (none chosen): the first, the model's lowest.
  return Object.values(table)[0]
}

/**
 * A fal video model's price for these params, in USD: per second of output by resolution (and sound), with reference
 * videos at their reduced rate on the input and output seconds together. `inputVideoSeconds`: the reference videos'
 * (or the video to edit's) total length; `sourceSeconds`/`sourceHeight`: an upscaler's or lip sync's input.
 * Undefined for a model Studio doesn't know.
 */
export function falVideoPrice(
  modelId: string,
  params: Pick<GenerationParams, 'duration' | 'resolution' | 'audio' | 'upscaleFactor'>,
  inputs: { inputVideoSeconds?: number; sourceSeconds?: number; sourceHeight?: number } = {}
): number | undefined {
  const model = falVideoModel(modelId)
  if (!model) return undefined
  // "auto" (the Editor's edit, which follows its video): the output is as long as the video it edits.
  const out = Number.parseFloat(params.duration) || inputs.inputVideoSeconds || 0
  const price = model.price
  let usd: number
  if (price.kind === 'per-input-second') {
    const s = inputs.sourceSeconds ?? out
    const step = price.step ?? 1
    usd = Math.ceil(Math.max(s, 0.001) / step) * step * price.rate
  } else if (price.kind === 'upscale') {
    const s = inputs.sourceSeconds ?? out
    const height = (inputs.sourceHeight ?? 720) * (params.upscaleFactor ?? 2)
    const tier = height > 1080 ? '4k' : height > 720 ? '1080p' : '720p'
    usd = s * price.rate[tier]
  } else {
    const base =
      (params.audio !== false && model.audioConfigurable ? rateFor(price.audioRate, params.resolution) : undefined) ??
      rateFor(price.rate, params.resolution) ??
      0
    const outputSeconds = model.kind === 'video-to-video' ? (inputs.sourceSeconds ?? out) : out
    const videoIn = inputs.inputVideoSeconds ?? 0
    if (price.videoInput && videoIn > 0) {
      const counted = Math.max(videoIn + outputSeconds, (price.videoInput.minOutputMultiple ?? 0) * outputSeconds)
      usd = base * price.videoInput.factor * counted
    } else {
      usd = base * outputSeconds
    }
  }
  return Math.round(usd * 1e6) / 1e6
}

/** The height of a resolution label, for the upscaler's tier (720p → 720). */
export function resolutionHeight(resolution: string | undefined): number | undefined {
  return resolution ? OUTPUT_HEIGHT[resolution] : undefined
}

// ── Images ───────────────────────────────────────────────────────────────────

export interface FalImageModel {
  id: string
  name: string
  endpoint: string
  /** Combines reference pictures (an edit endpoint). */
  edit: boolean
  maxInputImages: number
  aspectRatios: string[]
  resolutions: string[]
  defaultResolution: string
  /** The fal input style (fal-images.ts). */
  style: 'seedream' | 'nano-banana'
  /** USD per picture by resolution, plus per extra input picture (Seedream's edit). */
  usd: Record<string, number>
  usdPerExtraInput?: number
}

const IMAGE_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']

export const FAL_IMAGE_MODELS: readonly FalImageModel[] = [
  {
    id: id('bytedance/seedream/v5/pro/text-to-image'),
    name: 'Seedream 5.0 Pro',
    endpoint: 'bytedance/seedream/v5/pro/text-to-image',
    edit: false,
    maxInputImages: 0,
    aspectRatios: IMAGE_ASPECTS,
    resolutions: ['1K', '1.5K', '2K'],
    defaultResolution: '1.5K',
    style: 'seedream',
    usd: { '1K': 0.0675, '1.5K': 0.0675, '2K': 0.135 }
  },
  {
    id: id('bytedance/seedream/v5/pro/edit'),
    name: 'Seedream 5.0 Pro Edit',
    endpoint: 'bytedance/seedream/v5/pro/edit',
    edit: true,
    maxInputImages: 10,
    aspectRatios: IMAGE_ASPECTS,
    resolutions: ['1K', '1.5K', '2K'],
    defaultResolution: '1.5K',
    style: 'seedream',
    usd: { '1K': 0.0675, '1.5K': 0.0675, '2K': 0.135 },
    usdPerExtraInput: 0.0045
  },
  {
    id: id('google/nano-banana-2.1'),
    name: 'Nano Banana 2.1',
    endpoint: 'google/nano-banana-2.1',
    edit: false,
    maxInputImages: 0,
    aspectRatios: IMAGE_ASPECTS,
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    style: 'nano-banana',
    usd: { '1K': 0.045, '2K': 0.065, '4K': 0.14 }
  },
  {
    id: id('google/nano-banana-2.1/edit'),
    name: 'Nano Banana 2.1 Edit',
    endpoint: 'google/nano-banana-2.1/edit',
    edit: true,
    maxInputImages: 14,
    aspectRatios: IMAGE_ASPECTS,
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    style: 'nano-banana',
    usd: { '1K': 0.045, '2K': 0.065, '4K': 0.14 }
  }
]

export const FAL_DEFAULT_IMAGE_MODEL = id('bytedance/seedream/v5/pro/text-to-image')
export const FAL_DEFAULT_EDIT_MODEL = id('bytedance/seedream/v5/pro/edit')

export function falImageModel(modelId: string | undefined | null): FalImageModel | undefined {
  return FAL_IMAGE_MODELS.find((m) => m.id === modelId)
}

/** A picture's price: per output picture by resolution, plus each input picture after the first. */
export function falImagePrice(model: FalImageModel, resolution: string | undefined, inputImages = 0): number {
  const base = model.usd[resolution ?? model.defaultResolution] ?? model.usd[model.defaultResolution] ?? 0
  const extra = Math.max(0, inputImages - 1) * (model.usdPerExtraInput ?? 0)
  return Math.round((base + extra) * 1e6) / 1e6
}

// ── Audio ────────────────────────────────────────────────────────────────────

/** ElevenLabs' premade voices, as fal's ElevenLabs endpoints take them (by name). */
export const ELEVENLABS_VOICES = [
  'Rachel',
  'Aria',
  'Roger',
  'Sarah',
  'Laura',
  'Charlie',
  'George',
  'Callum',
  'River',
  'Liam',
  'Charlotte',
  'Alice',
  'Matilda',
  'Will',
  'Jessica',
  'Eric',
  'Chris',
  'Brian',
  'Daniel',
  'Lily',
  'Bill'
]

/** The text-to-speech models: ElevenLabs v3 with its voices, and Chatterbox, which speaks in a cloned voice. */
export const FAL_SPEECH_MODELS: readonly SpeechModel[] = [
  {
    id: id('fal-ai/elevenlabs/tts/eleven-v3'),
    name: 'ElevenLabs v3',
    endpoint: 'queue',
    voices: ELEVENLABS_VOICES,
    defaultVoice: 'Rachel',
    customVoiceId: false,
    formats: ['mp3'],
    maxCharacters: 5000,
    usdPerThousandChars: 0.1,
    stylePrompt: false,
    languageCode: true
  },
  {
    id: id('fal-ai/chatterbox/text-to-speech'),
    name: 'Chatterbox (cloned voice)',
    endpoint: 'queue',
    voices: [],
    customVoiceId: false,
    // fal's Chatterbox takes the voice sample with every line: "cloning" uploads it (no charge) and keeps its link.
    cloning: { minSampleSeconds: 5, formats: ['wav', 'mp3'], retentionDays: 1 },
    formats: ['wav'],
    maxCharacters: 5000,
    usdPerThousandChars: 0.025,
    stylePrompt: false,
    languageCode: false
  }
]

/** Voice design: a voice from a description, spoken as a short sample (Qwen 3 TTS). */
export const FAL_VOICE_DESIGN: readonly SpeechModel[] = [
  {
    id: id('fal-ai/qwen-3-tts/voice-design/1.7b'),
    name: 'Qwen 3 TTS Voice Design',
    endpoint: 'queue',
    voices: [],
    customVoiceId: false,
    formats: ['wav'],
    maxCharacters: 1000,
    usdPerThousandChars: 0.09,
    stylePrompt: true,
    languageCode: false
  }
]

export const FAL_MUSIC_MODELS: readonly AudioGenModel[] = [
  {
    id: id('fal-ai/ace-step/prompt-to-audio'),
    name: 'ACE-Step',
    kind: 'music',
    minSeconds: 5,
    maxSeconds: 240,
    defaultSeconds: 60,
    loop: false,
    instrumental: true,
    promptLimit: 2000,
    minPromptLength: 1,
    durationControl: true
  },
  {
    id: id('elevenlabs/music/v2.5'),
    name: 'ElevenLabs Music',
    kind: 'music',
    minSeconds: 3,
    maxSeconds: 600,
    defaultSeconds: 30,
    loop: false,
    instrumental: true,
    promptLimit: 2000,
    minPromptLength: 1,
    durationControl: true
  }
]

export const FAL_EFFECT_MODELS: readonly AudioGenModel[] = [
  {
    id: id('fal-ai/elevenlabs/sound-effects/v2'),
    name: 'ElevenLabs Sound Effects',
    kind: 'effect',
    minSeconds: 1,
    maxSeconds: 22,
    defaultSeconds: 5,
    loop: true,
    instrumental: false,
    promptLimit: 450,
    minPromptLength: 1,
    durationControl: true
  }
]

export const FAL_TRANSCRIPTION_MODELS: readonly AsrModel[] = [
  {
    id: id('fal-ai/elevenlabs/speech-to-text/scribe-v2'),
    name: 'ElevenLabs Scribe v2',
    usdPerSecond: 0.008 / 60,
    timestamps: 'word'
  }
]

export const FAL_VOICE_CHANGERS: readonly VoiceChangerModel[] = [
  {
    id: id('fal-ai/elevenlabs/voice-changer'),
    name: 'ElevenLabs Voice Changer',
    voices: ELEVENLABS_VOICES,
    defaultVoice: 'Rachel',
    customVoiceId: false,
    maxSourceSeconds: 300,
    formats: ['mp3', 'wav'],
    backgroundNoiseRemoval: true,
    seed: true
  }
]

/** What an audio model costs on fal, as /audio/quote answers for Venice's: by characters or seconds. */
export function falAudioPrice(
  modelId: string,
  o: { characterCount?: number; durationSeconds?: number }
): number | undefined {
  const usd = (n: number): number => Math.round(n * 1e6) / 1e6
  const chars = Math.max(0, o.characterCount ?? 0)
  const secs = Math.max(0, o.durationSeconds ?? 0)
  const speech = [...FAL_SPEECH_MODELS, ...FAL_VOICE_DESIGN].find((m) => m.id === modelId)
  if (speech?.usdPerThousandChars !== undefined) return usd((chars / 1000) * speech.usdPerThousandChars)
  switch (modelId) {
    case id('fal-ai/ace-step/prompt-to-audio'):
      return usd(Math.max(secs, 5) * 0.0002)
    case id('elevenlabs/music/v2.5'):
      // Billed per started minute.
      return usd(Math.max(1, Math.ceil(secs / 60)) * 0.6)
    case id('fal-ai/elevenlabs/sound-effects/v2'):
      return usd(Math.max(secs, 1) * 0.002)
    case id('fal-ai/elevenlabs/voice-changer'):
      return usd((Math.max(secs, 1) / 60) * 0.3)
    case id('fal-ai/elevenlabs/speech-to-text/scribe-v2'):
      return usd((secs / 60) * 0.008)
    default:
      return undefined
  }
}
