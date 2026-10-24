// The Editor's operations: plans, free local renders, paid audio jobs made of steps, and picture operations that go
// through the job manager as AI takes.
//
// Money rules, which everything here is built around:
// - A plan is free: it validates, quotes with Venice's free endpoints (or estimates from the published prices) and
//   works out what will be sent. The window and agents get the same plan; nothing paid starts from it.
// - A run re-plans and refuses when the price rose above the price the user (or the approval) saw.
// - Every paid step is written to the database before it is sent, and set 'sending' right before the request. A
//   step found 'sending' after a restart may or may not have been charged: it is failed, never sent again.
// - Starting the library (resume) only fetches what was already sent; unsent parts wait for the user's "Continue",
//   which quotes them again.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  audioDurationFor,
  fitLine,
  formatSecondsSv,
  formatTimecode,
  isPaidOperation,
  MAX_SPEAK_LINES,
  minuteBillingNote,
  operationLabel,
  PICTURE_EDIT_MODELS,
  planVoiceChunks,
  remapTranscript,
  roundUsd,
  segmentsFromTimed,
  segmentsFromWords,
  snapRange,
  snapSegments,
  speechPriceUsd,
  speechRegions,
  transcriptionPriceUsd,
  voiceChunkQuoteSeconds
} from '@shared/edit-plan'
import { blockingPromptError } from '@shared/prompt-refs'
import {
  endImageVariant,
  isLipSyncModel,
  isUpscaleModel,
  MAX_REQUEST_MEDIA_BYTES,
  supportsEndImage,
  supportsReferenceVideos
} from '@shared/models'
import type {
  AsrModel,
  AudioCatalog,
  AudioMix,
  BackgroundChoice,
  EditJob,
  EditOperation,
  EditPlan,
  EditRange,
  EditRecipe,
  EditRunOptions,
  EditRunResult,
  EditProgress,
  Generation,
  GenerationParams,
  SpeakLine,
  SpeechModel,
  Transcript,
  TranscriptSegment,
  VideoModel,
  VoiceChangerModel,
  VoiceChoice,
  VoiceDesignRequest
} from '@shared/types'
import { addGeneratedAudio } from './assets'
import { alignTo, estimateOffsetSamples } from './audio-align'
import { assertWithinBudget, runConfirmed } from './budget'
import * as db from './db'
import * as mixes from './edit-mix'
import * as store from './edit-store'
import {
  assembleAt,
  encodeUpload,
  extractAudio,
  extractFrame,
  extractFrameAtOrAfter,
  extractThumbnail,
  loudness,
  makeProxy,
  makeStandIn,
  MIX_RATE,
  probe,
  probeAudio,
  renderMix,
  replaceAudioTrack,
  silences,
  spliceVideo,
  timeStretch,
  VOICE_UPLOAD_MAX_BYTES,
  type ResolvedMix
} from './ffmpeg'
import { toPublic, type JobManager } from './jobs'
import {
  APP_DATA,
  appDataDir,
  dayStamp,
  editDir,
  framesDir,
  fromStoredPath,
  libraryOperationSettled,
  libraryRoot,
  safeName,
  thumbsDir,
  timeStamp,
  tmpDir
} from './paths'
import { FILE_MANAGER, IS_MAC } from './platform'
import { cloneInto, placeFile, serialized } from './references'
import { activeServiceName, getActiveKey } from './settings'
import type { AudioBackend, VideoBackend } from './providers'
import { providerName, providerOf, type Provider } from '@shared/provider'
import { activeServiceModels, type ServiceModels } from '@shared/service-models'
import { imageRequestBytes } from './venice'
import { separationStatus } from './voice-separation'

// ── Limits and defaults ──────────────────────────────────────────────────────

const MB = 1024 * 1024
/** Transcription uploads: Venice takes ≤25 MB. */
const ASR_MAX_BYTES = 24 * MB
const ASR_MAX_SECONDS = 50 * 60
/** The lowest bitrate a proxy may be squeezed to, in bits per pixel per frame (makeProxy refuses below it). */
const MIN_BITS_PER_PIXEL_FRAME = 0.05
/** A take may be time-scaled by at most this much to fit its slot; beyond it the take is refused. */
const TIME_SCALE_TOLERANCE = 0.08
const MIN_REMAINING_SECONDS = 0.2
const MAX_STEPS_IN_FLIGHT = 3
const MAX_QUOTES_IN_FLIGHT = 4
const POLL_INTERVAL_MS = 5000
const MAX_RETRY_DELAY_MS = 60_000
/** Polls of a paid, queued step while Venice can't be reached (as the job manager: a bit over an hour). */
const MAX_UNREACHABLE_RETRIES = 70
const MAX_RETRIES = 5
const DISK_REFUSE_BYTES = 2 * 1024 ** 3
const DISK_WARN_BYTES = 5 * 1024 ** 3
/** A replaced line's original voice is muted this much beyond its transcript times. */
const LINE_PAD = 0.15
const MAX_TEMPO = 1.15
const CHUNK_MARGIN = 0.5
const SAMPLE_RATE = MIX_RATE
const MAX_PATCH_HEIGHT = 720
/** A lip sync's selection (Sync's lipsync-2 takes any length; a minute keeps a mistake affordable). */
const LIP_SYNC_MIN_SECONDS = 2
const LIP_SYNC_MAX_SECONDS = 60
const MAX_UPSCALE_SECONDS = 300
const MAX_UPSCALE_LONG_SIDE = 3840
const MAX_LINES = MAX_SPEAK_LINES
const DEFAULT_MUSIC_GAIN_DB = -6
const DEFAULT_MUSIC_FADE = 2

/** The models the cards start from: the active service's (shared/service-models.ts). */
const serviceDefaults = (): ServiceModels => activeServiceModels()
export const DESIGN_VOICE = 'Describe in prompt'

// ── Messages ─────────────────────────────────────────────────────────

export const LOST =
  "The service's answer never arrived – it may have been charged. Check your balance before you continue."
export const CLOSED = 'Studio was closed before all parts were sent. Continue to send the rest.'
export const PRICE_CHANGED = 'The price has changed – check it and try again.'
export const BUSY = 'An edit is in progress. Wait until it is done and try again.'
const CONFIRM_PRICE = 'Confirm the price before the operation runs.'
const NO_SEPARATION = IS_MAC
  ? "Voice separation isn't available on this Mac."
  : 'Voice separation is only available on macOS.'
const NO_KEY = 'Add the API key in Settings.'
const noVoiceChanger = (): string =>
  `${activeServiceName()} doesn't offer voice change right now — use Re-record lines instead.`
const CONSENT_MISSING = 'Tick that you have the right to use the voice (Characters → Voice).'
const SAMPLE_TOO_SHORT = 'The voice sample is shorter than 5 seconds and cannot be cloned.'
const TOO_BIG = 'The input is too large to send (at most ~22 MB). Select a shorter part.'
const IMAGES_TOO_BIG =
  'The images to start from make the input too large to send (at most ~22 MB together with the film). Choose fewer images or a shorter selection.'
/** Room left beside the pictures for the request's rounding (base64 padding, JPEG sizes varying by a few kB). */
const IMAGE_BYTES_MARGIN = 256 * 1024
const UPSCALE_TOO_BIG =
  'The film is too long to upscale in one go (at most ~22 MB can be sent). Shorter films work.'
const LIP_SYNC =
  "The mouth movements don't follow the new line. Best for a voice off screen — or regenerate the section afterwards."
const REAL_PEOPLE = "Seedance often doesn't accept video with real people. If it is refused, try another model."
const BASE_GONE = 'The version the operation started from no longer exists.'
const NO_MODELS = 'The model list could not be fetched. Check your internet connection and try again.'
const CLONE_EXPIRED = 'The voice clone has expired. Continue to clone the voice again.'
const CLONE_UNPRICED = 'Voice cloning: no price in advance'

// ── Formatting ─────────────────────────────────────────────────────

const round = (n: number, step = 1000): number => Math.round(n * step) / step
const fmtSeconds = formatSecondsSv
function fmtDuration(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (!m) return `${s} s`
  return s ? `${m} min ${s} s` : `${m} min`
}
const fmtGb = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`
const fmtClock = formatTimecode
function excerpt(text: string, max = 40): string {
  return safeName(text.replace(/\s+/g, ' '), { max, fallback: '' })
}
/**
 * A version's or a sound's label as part of a file name: its timecodes ("0:41.5–0:45.0", or "0:41,5" in labels
 * from before) written "0m41.5s–0m45s", since safeName would turn the colon into a dot ("0.41.5").
 */
export function fileLabel(label: string): string {
  return label.replace(/(?:(\d+):)?(\d+):(\d{2})[.,](\d)/g, (_m, h: string | undefined, m: string, s: string, d: string) => {
    const tenths = d === '0' ? '' : `.${d}`
    return h ? `${h}h${m.padStart(2, '0')}m${s}${tenths}s` : `${m}m${s}${tenths}s`
  })
}
/** The service a model belongs to, by name; the active one when there is no model. */
function serviceOf(model: string | undefined): string {
  return model ? providerName(providerOf(model)) : activeServiceName()
}
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

// ── Service errors ───────────────────────────────────────────────────────────

/** The service answered (and charged) but the answer couldn't be kept: told as it is, not as a lost answer. */
class AfterSendError extends Error {}

/** Keeps an answer that was paid for, or says so. */
async function keepAnswer(path: string, data: Buffer | string): Promise<void> {
  try {
    await writeFile(path, data)
  } catch (err) {
    throw new AfterSendError(`The service's answer could not be saved (${errorText(err)}). The part has been charged.`)
  }
}

/** The HTTP status of a failed service call, or undefined when no response came (network, aborted, local). */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

/** A failed paid request, by status (the spec's wording where it has one); `model` names the service it went to. */
export function veniceFailure(err: unknown, model?: string): string {
  const status = statusOf(err)
  const message = errorText(err)
  const service = serviceOf(model)
  if (status === 402) return `Your ${service} balance is too low.`
  if (status === 401 && /pro\b/i.test(message)) return 'The model requires Venice Pro.'
  if (status === 422) return `${service} refused the content.`
  if (status === 413) return 'The input is too large.'
  return message
}

// ── Plans ────────────────────────────────────────────────────────────────────

export interface OpsDeps {
  jobs: JobManager
  /** The video services' quotes (providers.ts). */
  venice: Pick<VideoBackend, 'quote'>
  /** The audio services (providers.ts). */
  audio: AudioBackend
  models: () => Promise<VideoModel[]>
  notify: (editId: string) => void
  progress: (p: EditProgress) => void
  generationChanged: (g: Generation) => void
  /**
   * The asset library changed (a designed voice added as a voice clip, clone consent given or withdrawn): every
   * open asset list and picker refetches. index.ts routes it to 'library:change'.
   */
  libraryChanged?: () => void
}

/** What the Editor runs right now, for the status summary (work.ts). */
export interface EditActiveWork {
  /** Running paid jobs: an edit's operations, and designed voices (assetId). */
  jobs: {
    jobId: string
    editId?: string
    assetId?: string
    label: string
    fraction?: number
    currentStep?: string
    stepsDone: number
    stepsTotal: number
    startedAt: number
    /** The version it works on. */
    baseId?: string
    /** A picture operation's AI take (its progress at Venice is the job's). */
    takeId?: string
  }[]
  /** Free renders (a cut, a fade, a sound fix …) that make a version without any paid job. */
  renders: { token: string; editId: string; label: string; fraction: number; startedAt: number }[]
}

interface BaseInfo {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  bytes: number
  /** dev:ino:size:mtime of the file, for fingerprints. */
  identity: string
}

/** A paid step as the plan works it out: what is sent and what Venice says (or Studio estimates) it costs. */
interface StepSpec {
  endpoint: store.StepEndpoint
  model: string
  request: Record<string, unknown>
  quote?: number
  label: string
  seconds?: number
}

/** What a picture operation sends: the params (paths filled in at run) and what the run must make first. */
interface PictureSpec {
  params: GenerationParams
  frames?: { start?: string; end?: string }
  /** Make a proxy of the base in this range (prompt-edit) or the whole film (upscale, when the file is too big). */
  proxy?: { start: number; end: number; maxHeight: number; audio: boolean; maxBytes?: number }
  /** Upscale: send a clone of the base file as it is. */
  sendBase?: boolean
}

type Exec =
  | { kind: 'free' }
  | { kind: 'audio'; steps: StepSpec[]; finish: Record<string, unknown> }
  | { kind: 'picture'; spec: PictureSpec; finish: Record<string, unknown> }
  | { kind: 'none' }

export interface Planned {
  plan: EditPlan
  edit: store.EditRow
  base: db.StoredGeneration & { filePath: string }
  info: BaseInfo
  op: EditOperation
  exec: Exec
}

/** Accumulates a plan's texts, steps and price. */
class Draft {
  notes: string[] = []
  warnings: string[] = []
  problems: string[] = []
  steps: EditPlan['steps'] = []
  private total = 0
  private priced = false
  private unpriced = false
  priceNote?: string
  frames?: { start?: string; end?: string }
  resultSeconds?: number
  estimatedBytes?: number
  /** What else changes the price or the work besides the op itself (fingerprinted). */
  inputs: unknown[] = []

  addPrice(usd: number | undefined): void {
    if (typeof usd === 'number' && Number.isFinite(usd)) {
      this.total += usd
      this.priced = true
    } else this.unpriced = true
  }

  problem(text: string | undefined): void {
    if (text && !this.problems.includes(text)) this.problems.push(text)
  }

  note(text: string | undefined): void {
    if (text && !this.notes.includes(text)) this.notes.push(text)
  }

  warn(text: string | undefined): void {
    if (text && !this.warnings.includes(text)) this.warnings.push(text)
  }

  price(): { priceUsd?: number; partialPrice?: boolean } {
    if (!this.priced) return {}
    return { priceUsd: roundUsd(this.total), ...(this.unpriced ? { partialPrice: true } : {}) }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}
function readRange(v: unknown): EditRange | undefined {
  if (!v || typeof v !== 'object') return undefined
  const start = num((v as EditRange).start)
  const end = num((v as EditRange).end)
  return start === undefined || end === undefined ? undefined : { start, end }
}
function sha1(value: unknown): string {
  return createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}
export function aspectOf(width: number, height: number): string {
  const w = Math.round(width)
  const h = Math.round(height)
  if (!w || !h) return '16:9'
  const g = gcd(w, h)
  return `${w / g}:${h / g}`
}

/** The params of a row that isn't a Venice generation: only its shape. */
export function versionParams(p: { duration: number; width: number; height: number }): GenerationParams {
  return {
    model: '',
    prompt: '',
    duration: `${Math.max(1, Math.round(p.duration))}s`,
    resolution: `${Math.round(p.height)}p`,
    aspectRatio: aspectOf(p.width, p.height)
  }
}

/** The largest of the model's resolutions at or below the film's own height (capped at 720p), else its smallest. */
function patchResolution(options: readonly string[], height: number, wanted?: string): string | undefined {
  if (wanted && options.includes(wanted)) return wanted
  const cap = Math.min(height, MAX_PATCH_HEIGHT)
  const numeric = options
    .map((o) => ({ o, h: Number.parseInt(o, 10) }))
    .filter((x) => Number.isFinite(x.h))
    .sort((a, b) => a.h - b.h)
  if (!numeric.length) return options[0]
  return [...numeric].reverse().find((x) => x.h <= cap)?.o ?? numeric[0].o
}

/** The model's aspect ratio closest to the film's (Seedance and others take one besides the image). */
function closestAspect(options: readonly string[], width: number, height: number): string | undefined {
  const target = width / height
  let best: { o: string; d: number } | undefined
  for (const o of options) {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(o)
    if (!m) continue
    const d = Math.abs(Math.log(Number(m[1]) / Number(m[2]) / target))
    if (!best || d < best.d) best = { o, d }
  }
  return best?.o
}

/** Whole-second durations a model offers ("4s" … "30s"). */
function modelSeconds(m: Pick<VideoModel, 'durations'>): number[] {
  return [...new Set(m.durations.map((d) => Number.parseFloat(d)).filter((n) => Number.isFinite(n) && n > 0))].sort(
    (a, b) => a - b
  )
}

/** What voice design sends as its one prompt: the description, then the sample text (Venice documents no format). */
export function designPrompt(description: string, sampleText: string): string {
  return `${description.trim()}\n${sampleText.trim()}`
}

/**
 * A Seedance edit prompt: "Strictly edit <Video 1>, …" with the user's @ImageN as <Image N> (Venice's way of naming
 * them); on fal.ai "Strictly edit @Video1, …" with @ImageN as they are, as fal's Seedance names its inputs.
 */
export function seedanceEditPrompt(text: string, provider: Provider = 'venice'): string {
  if (provider === 'fal') {
    const body = text.trim().replace(/@image\s*(\d+)/gi, '@Image$1')
    if (/^strictly edit\b/i.test(body)) return body
    return `Strictly edit @Video1, ${body.charAt(0).toLowerCase()}${body.slice(1)}`
  }
  const body = text.trim().replace(/@image\s*(\d+)/gi, '<Image $1>')
  if (/^strictly edit\b/i.test(body)) return body
  return `Strictly edit <Video 1>, ${body.charAt(0).toLowerCase()}${body.slice(1)}`
}

/** Runs async work at most `limit` at a time, keeping order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Transcript of a generation: its own, or inherited along `timing: 'same'` ancestors. */
export function transcriptFor(generationId: string): Transcript | null {
  const seen = new Set<string>()
  let id: string | undefined = generationId
  while (id && !seen.has(id)) {
    seen.add(id)
    const own = store.storedTranscript(id)
    if (own) {
      const { source: _source, ...t } = own
      return id === generationId ? t : { ...t, generationId, inheritedFrom: id }
    }
    const g = db.getGeneration(id)
    if (!g || g.recipe?.timing !== 'same' || !g.parentId) return null
    id = g.parentId
  }
  return null
}

// ── The service ──────────────────────────────────────────────────────────────

interface JobRun {
  jobId: string
  /** 'send': the user's click or approval in this session. 'poll': only fetch what was already sent (resume). */
  mode: 'send' | 'poll'
  epoch: number
  failed: boolean
  stopped: boolean
  claimed: Set<string>
}

export class EditOps {
  /** Renders (free ops, finishes) run one at a time over the whole library. */
  private readonly renders = serialized()
  private rendering = 0
  private planning = 0
  private submitting = 0
  /** Jobs being submitted (picture ops): their take id isn't recorded yet. */
  private readonly submittingJobs = new Set<string>()
  private readonly runs = new Map<string, JobRun>()
  private readonly finishing = new Set<string>()
  /** Steps whose request is on its way right now (so a 'sending' step isn't mistaken for a lost one). */
  private readonly inFlight = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly live = new Map<string, { fraction?: number; currentStep?: string }>()
  /**
   * Free renders, from the call until the version is written (or the render failed), by a token of their own: they
   * have no job row, so this is how the edit list and the status summary know one runs.
   */
  private readonly liveRenders = new Map<
    string,
    { editId: string; label: string; fraction: number; startedAt: number }
  >()
  /** Bumped when a library is opened or Studio stops: loops of an older epoch end. */
  private epoch = 0
  /** Studio is quitting: finished takes are left for the next start to pick up. */
  private stopped = false
  private catalogCache?: { at: number; catalog: AudioCatalog }
  private readonly probes = new Map<string, { key: string; info: Promise<Omit<BaseInfo, 'identity'>> }>()
  private readonly frameJobs = new Map<string, Promise<string>>()
  /** What a picture adds to a request (re-encoded as the submit encodes it), by path, size and modification time. */
  private readonly imageBytes = new Map<string, { key: string; bytes: Promise<number> }>()
  private readonly standIns = new Map<string, Promise<string>>()

  constructor(private readonly deps: OpsDeps) {
    deps.jobs.on('settled', (g: db.StoredGeneration) => this.onTakeSettled(g))
  }

  // ── Busy, lifecycle ──────────────────────────────────────────────────────

  isBusy(): string | undefined {
    if (
      this.rendering ||
      this.planning ||
      this.submitting ||
      this.runs.size ||
      this.finishing.size ||
      mixes.separationsRunning()
    ) {
      return BUSY
    }
    return undefined
  }

  /** Studio is quitting (or the library closing): no loop sends or polls again; renders are stopped. */
  stop(): void {
    this.stopped = true
    this.epoch++
    for (const run of this.runs.values()) run.stopped = true
    for (const c of this.controllers) c.abort()
  }

  /**
   * A library was opened: jobs still running in it are picked up without sending anything new. Steps that were
   * queued at Venice are fetched (they are paid for); a step found 'sending' is failed (its answer was lost); a job
   * with unsent steps ends up failed with "Continue". Picture jobs finish once their take has.
   */
  resumeAll(): void {
    this.stopped = false
    this.epoch++
    this.runs.clear()
    this.live.clear()
    void mixes.pruneStemCache()
    let jobs: store.StoredJob[]
    try {
      jobs = store.listJobsWithStatus('running')
    } catch (err) {
      console.warn('Reading the edit jobs failed:', err)
      return
    }
    for (const job of jobs) {
      try {
        if (isPictureOp(job.op)) this.resumePicture(job)
        else this.startJob(job.id, 'poll')
      } catch (err) {
        console.error(`Resuming edit job ${job.id} failed:`, err)
      }
    }
    // Cancelled or failed jobs may still have parts at Venice: those are paid for and fetched too.
    for (const status of ['cancelled', 'failed'] as const) {
      for (const job of store.listJobsWithStatus(status)) {
        if (store.listSteps(job.id).some((s) => s.status === 'queued')) this.startJob(job.id, 'poll')
      }
    }
  }

  // ── Catalog, base ────────────────────────────────────────────────────────

  async catalog(force = false): Promise<AudioCatalog> {
    if (!force && this.catalogCache && Date.now() - this.catalogCache.at < 10 * 60_000) return this.catalogCache.catalog
    const catalog = await this.deps.audio.catalog(force)
    this.catalogCache = { at: Date.now(), catalog }
    return catalog
  }

  private async baseInfo(path: string): Promise<BaseInfo> {
    const s = await stat(path)
    const key = `${s.size}:${s.mtimeMs}`
    let cached = this.probes.get(path)
    if (!cached || cached.key !== key) {
      const info = probe(path).then((p) => ({
        duration: p.duration,
        width: p.width,
        height: p.height,
        fps: p.fps > 0 ? p.fps : 24,
        hasAudio: p.hasAudio,
        bytes: s.size
      }))
      cached = { key, info }
      this.probes.set(path, cached)
      info.catch(() => this.probes.delete(path))
    }
    return { ...(await cached.info), identity: `${s.dev}:${s.ino}:${s.size}:${Math.round(s.mtimeMs)}` }
  }

  /** The version an operation works on: the one asked for (of this edit), else the current one. */
  requireBase(edit: store.EditRow, baseId?: unknown): db.StoredGeneration & { filePath: string } {
    const versions = store.listVersions(edit)
    let base: db.StoredGeneration | undefined
    if (baseId !== undefined && baseId !== null && baseId !== '') {
      const id = store.safeId(baseId, 'version ID')
      base = versions.find((v) => v.id === id)
      if (!base) throw new Error('The version does not belong to the edit.')
    } else {
      base =
        versions.find((v) => v.id === edit.current_generation_id) ??
        versions.find((v) => v.id === edit.origin_generation_id) ??
        versions[versions.length - 1]
    }
    if (!base) throw new Error('The edit has no versions left.')
    if (base.status !== 'completed' || !base.filePath || !existsSync(base.filePath)) {
      throw new Error(`The version's video file is missing (moved or deleted in ${FILE_MANAGER}).`)
    }
    return base as db.StoredGeneration & { filePath: string }
  }

  // ── Planning ─────────────────────────────────────────────────────────────

  async plan(editId: unknown, op: unknown, baseId?: unknown): Promise<EditPlan> {
    return (await this.planDetailed(editId, op, baseId)).plan
  }

  async planDetailed(editId: unknown, rawOp: unknown, baseId?: unknown): Promise<Planned> {
    const edit = store.requireEditRow(editId)
    const base = this.requireBase(edit, baseId)
    this.planning++
    try {
      const info = await this.baseInfo(base.filePath)
      const d = new Draft()
      const raw = (rawOp && typeof rawOp === 'object' ? rawOp : {}) as Record<string, unknown>
      let op: EditOperation
      let exec: Exec = { kind: 'free' }
      const mix = mixes.mixOf(base, base.id === edit.origin_generation_id)
      switch (raw.op) {
        case 'trim':
        case 'cut':
        case 'fade':
        case 'volume':
        case 'mute':
        case 'denoise':
        case 'loudness':
        case 'add-audio':
        case 'layer':
          op = await this.planFree(d, edit, info, mix, raw)
          break
        case 'transcribe':
          ;({ op, exec } = await this.planTranscribe(d, base, info, raw))
          break
        case 'change-voice':
          ;({ op, exec } = await this.planChangeVoice(d, base, info, mix, raw))
          break
        case 'speak-lines':
          ;({ op, exec } = await this.planSpeakLines(d, base, info, raw))
          break
        case 'music':
        case 'effect':
          ;({ op, exec } = await this.planAudioGen(d, info, raw))
          break
        case 'regenerate':
        case 'prompt-edit':
        case 'extend':
        case 'upscale':
        case 'lip-sync':
          ;({ op, exec } = await this.planPicture(d, edit, base, info, raw))
          break
        default:
          d.problem('Unknown operation.')
          op = { op: 'denoise', strength: 'mild' }
          exec = { kind: 'none' }
      }
      if (exec.kind !== 'picture' && exec.kind !== 'none' && op.op !== 'transcribe' && !mixes.mixIsComplete(mix)) {
        d.note(mixes.MISSING_SOURCE_NOTE)
      }
      if (op.op !== 'transcribe' && exec.kind !== 'none') {
        d.estimatedBytes ??= info.bytes
        d.resultSeconds ??= info.duration
        await this.diskCheck(d, d.estimatedBytes)
      }
      const paid = isPaidOperation(op)
      const price = paid ? d.price() : { priceUsd: 0 }
      const plan: EditPlan = {
        operation: op,
        baseId: base.id,
        paid,
        ...price,
        ...(d.priceNote ? { priceNote: d.priceNote } : {}),
        steps: d.steps,
        ...(d.frames ? { frames: d.frames } : {}),
        ...(d.resultSeconds !== undefined ? { resultSeconds: round(d.resultSeconds) } : {}),
        ...(d.estimatedBytes !== undefined ? { estimatedBytes: Math.round(d.estimatedBytes) } : {}),
        notes: d.notes,
        warnings: d.warnings,
        problems: d.problems,
        fingerprint: sha1({
          base: base.id,
          file: info.identity,
          op,
          steps: d.steps.map((s) => [s.label, s.seconds]),
          inputs: d.inputs
        })
      }
      return { plan, edit, base, info, op, exec }
    } finally {
      this.planning--
    }
  }

  private async diskCheck(d: Draft, bytes: number | undefined): Promise<void> {
    if (!bytes || bytes <= 0) return
    try {
      const s = await statfs(libraryRoot())
      const free = Number(s.bavail) * Number(s.bsize)
      const left = free - bytes
      if (left < DISK_REFUSE_BYTES) d.problem(`There is too little free disk space (needs ~${fmtGb(bytes)}).`)
      else if (left < DISK_WARN_BYTES) {
        d.warn(`Less than 5 GB will be left free on the disk (the version takes ~${fmtGb(bytes)}).`)
      }
    } catch {
      // statfs isn't available everywhere; the render itself reports a full disk.
    }
  }

  private snap(
    d: Draft,
    range: EditRange,
    info: BaseInfo,
    o: { min?: number; max?: number; wholeSeconds?: boolean; allowed?: number[] } = {}
  ): EditRange {
    const res = snapRange(mixes.clampRange(range, info.duration), {
      duration: info.duration,
      fps: info.fps,
      ...o
    })
    d.note(res.note)
    d.problem(res.problem)
    // As snapRange left it (on the frame grid, to the microsecond): rounding to milliseconds would move an edge up to
    // half a millisecond off its frame (247/24 s → 10.292), and the splice, the start and end frames and the proxy
    // would then cut one frame later than the range the user marked.
    return { start: res.range.start, end: res.range.end }
  }

  private async separationAvailable(): Promise<boolean> {
    try {
      return (await separationStatus()).available
    } catch {
      return false
    }
  }

  // ── Free operations ──────────────────────────────────────────────────────

  private async planFree(
    d: Draft,
    edit: store.EditRow,
    info: BaseInfo,
    mix: AudioMix,
    raw: Record<string, unknown>
  ): Promise<EditOperation> {
    const D = info.duration
    const needsStems = async (target: unknown): Promise<'all' | 'voice' | 'background'> => {
      const t = target === 'voice' || target === 'background' ? target : 'all'
      if (t !== 'all' && !(await this.separationAvailable())) d.problem(NO_SEPARATION)
      return t
    }
    switch (raw.op) {
      case 'trim': {
        const keep = readRange(raw.keep)
        if (!keep) {
          d.problem('Select what to keep.')
          return { op: 'trim', keep: { start: 0, end: D } }
        }
        const r = this.snap(d, keep, info, { min: MIN_REMAINING_SECONDS })
        if (r.start <= 1e-3 && r.end >= D - 1e-3) d.problem('The selection is already the whole film.')
        d.resultSeconds = r.end - r.start
        d.estimatedBytes = info.bytes * (d.resultSeconds / D) * 1.3
        return { op: 'trim', keep: r }
      }
      case 'cut': {
        const range = readRange(raw.range)
        if (!range) {
          d.problem('Select what to cut out.')
          return { op: 'cut', range: { start: 0, end: 0 } }
        }
        const r = this.snap(d, range, info)
        if (r.end - r.start <= 0) d.problem('The selection is empty.')
        if (D - (r.end - r.start) < MIN_REMAINING_SECONDS) d.problem('At least 0.2 s of the film must be left.')
        d.resultSeconds = D - (r.end - r.start)
        d.estimatedBytes = info.bytes * (d.resultSeconds / D) * 1.3
        return { op: 'cut', range: r }
      }
      case 'fade': {
        const inSeconds = round(Math.max(0, num(raw.inSeconds) ?? 0), 100)
        const outSeconds = round(Math.max(0, num(raw.outSeconds) ?? 0), 100)
        if (!inSeconds && !outSeconds) d.problem('Choose how long the fade should be.')
        if (inSeconds > D / 2 || outSeconds > D / 2) d.problem('A fade can be at most half the film.')
        d.estimatedBytes = info.bytes * 1.3
        return {
          op: 'fade',
          ...(inSeconds ? { inSeconds } : {}),
          ...(outSeconds ? { outSeconds } : {})
        }
      }
      case 'volume': {
        const gainDb = num(raw.gainDb)
        if (gainDb === undefined) d.problem('Give how much the volume should change.')
        const target = await needsStems(raw.target)
        const range = readRange(raw.range)
        const r = range ? this.snap(d, range, info) : undefined
        if (!info.hasAudio && !mix.layers.length) d.problem('The film has no sound.')
        return {
          op: 'volume',
          gainDb: round(Math.min(24, Math.max(-60, gainDb ?? 0)), 10),
          ...(r ? { range: r } : {}),
          target
        }
      }
      case 'mute': {
        const target = await needsStems(raw.target)
        const range = readRange(raw.range)
        const r = range ? this.snap(d, range, info) : undefined
        return { op: 'mute', ...(r ? { range: r } : {}), target }
      }
      case 'denoise':
        return { op: 'denoise', strength: raw.strength === 'strong' ? 'strong' : 'mild' }
      case 'loudness': {
        const lufs = raw.lufs === -16 || raw.lufs === -23 ? raw.lufs : -14
        if (raw.lufs !== undefined && raw.lufs !== lufs) d.problem('The loudness can be −14, −16 or −23 LUFS.')
        return { op: 'loudness', lufs }
      }
      case 'add-audio': {
        const source = (raw.source && typeof raw.source === 'object' ? raw.source : {}) as Record<string, unknown>
        let duration = 0
        let src: { mediaId: string } | { assetAudioId: string }
        if (typeof source.mediaId === 'string') {
          const media = store.getMedia(source.mediaId)
          if (!media || media.editId !== edit.id) d.problem('The audio is not in the edit.')
          else if (!existsSync(media.path)) d.problem(`The audio file is missing (moved or deleted in ${FILE_MANAGER}).`)
          else duration = media.duration ?? (await probeAudio(media.path).catch(() => ({ duration: 0 }))).duration
          src = { mediaId: source.mediaId }
        } else if (typeof source.assetAudioId === 'string') {
          const clip = store.audioClipRow(source.assetAudioId)
          if (!clip) d.problem('The audio clip no longer exists in the library.')
          else duration = clip.duration
          src = { assetAudioId: source.assetAudioId }
        } else {
          d.problem('Choose a sound to add.')
          src = { mediaId: '' }
        }
        const at = round(Math.max(0, num(raw.at) ?? 0))
        if (at >= D) d.problem('The sound must start inside the film.')
        const loop = raw.loop === true
        const room = Math.max(0, D - at)
        const asked = num(raw.length)
        const length = round(Math.max(0.05, Math.min(asked ?? (loop ? room : duration || room), room)))
        const fadeInSeconds = round(Math.max(0, Math.min(num(raw.fadeInSeconds) ?? 0, length / 2)), 100)
        const fadeOutSeconds = round(Math.max(0, Math.min(num(raw.fadeOutSeconds) ?? 0, length / 2)), 100)
        return {
          op: 'add-audio',
          source: src,
          at,
          gainDb: round(Math.min(24, Math.max(-60, num(raw.gainDb) ?? 0)), 10),
          duck: raw.duck === true,
          loop,
          length,
          fadeInSeconds,
          fadeOutSeconds,
          replaceBed: raw.replaceBed === true
        }
      }
      case 'layer':
      default: {
        const layerId = typeof raw.layerId === 'string' ? raw.layerId : ''
        const layer = mix.layers.find((l) => l.id === layerId)
        if (!layer) d.problem('The layer is not in this version.')
        const at = num(raw.at)
        if (at !== undefined && (at < 0 || at >= D)) d.problem('The layer must start inside the film.')
        const gainDb = num(raw.gainDb)
        return {
          op: 'layer',
          layerId,
          ...(gainDb !== undefined ? { gainDb: round(Math.min(24, Math.max(-60, gainDb)), 10) } : {}),
          ...(at !== undefined ? { at: round(at) } : {}),
          ...(raw.remove === true ? { remove: true } : {})
        }
      }
    }
  }

  // ── Transcribe ───────────────────────────────────────────────────────────

  private async planTranscribe(
    d: Draft,
    base: db.StoredGeneration,
    info: BaseInfo,
    raw: Record<string, unknown>
  ): Promise<{ op: EditOperation; exec: Exec }> {
    const catalog = await this.catalogOrProblem(d)
    const wanted = str(raw.model, 200) || serviceDefaults().transcription
    const model: AsrModel | undefined = catalog?.transcription.find((m) => m.id === wanted)
    if (catalog && !model) d.problem(`${activeServiceName()} doesn't have the transcription model.`)
    const language = str(raw.language, 20) || undefined
    if (!info.hasAudio) d.problem('The film has no sound to transcribe.')
    if (info.duration > ASR_MAX_SECONDS) d.problem('The film is too long to transcribe (at most 50 minutes).')
    const usd = model ? transcriptionPriceUsd(info.duration, model.usdPerSecond) : undefined
    d.addPrice(usd)
    d.steps.push({ label: `Transcribe ${fmtClock(info.duration)}`, seconds: round(info.duration), priceUsd: usd })
    if (model?.timestamps === 'segment') d.note('The model gives times per sentence, not per word.')
    if (transcriptFor(base.id)) d.note('The current transcript is replaced.')
    const op: EditOperation = { op: 'transcribe', model: wanted, ...(language ? { language } : {}) }
    const exec: Exec = {
      kind: 'audio',
      steps: [
        {
          endpoint: 'transcription',
          model: wanted,
          request: { language, seconds: round(info.duration) },
          quote: usd,
          label: 'Transcribe',
          seconds: info.duration
        }
      ],
      finish: {}
    }
    return { op, exec }
  }

  private async catalogOrProblem(d: Draft): Promise<AudioCatalog | undefined> {
    try {
      return await this.catalog()
    } catch (err) {
      d.problem(`${activeServiceName()}'s model list could not be fetched: ${errorText(err)}`)
      return undefined
    }
  }

  // ── Change voice (speech-to-speech) ──────────────────────────────────────

  /** Where the spoken voice of the base comes from for an upload: the voice stem when it can be separated. */
  private async voiceSource(
    base: db.StoredGeneration & { filePath: string },
    mix: AudioMix,
    separation: boolean
  ): Promise<{ path: string; kind: 'voice' | 'mix' } | undefined> {
    if (!separation) return { path: base.filePath, kind: 'mix' }
    if (mixes.mixIsComplete(mix)) {
      const voice = mix.bed.stems?.voice
      if (voice && voice !== 'separated') {
        const path = mixes.sourcePath(voice)
        return path ? { path, kind: 'voice' } : undefined
      }
      if (voice === null) return undefined
      const bed = mixes.sourcePath(mix.bed.source)
      if (!bed || !(await mixes.hasAudio(bed))) return undefined
      return { path: (await mixes.stemsOf(bed)).voice, kind: 'voice' }
    }
    return { path: (await mixes.stemsOf(base.filePath)).voice, kind: 'voice' }
  }

  /**
   * Speech regions (seconds) of a recording inside the given scope spans, and the short pauses inside speech where a
   * stretch too long for one request is best cut.
   */
  private async speechIn(
    path: string,
    duration: number,
    scopes: EditRange[]
  ): Promise<{ speech: EditRange[]; pauses: EditRange[] }> {
    // Pauses: short and slightly louder than full silence (breaths), the settings proven on long speech in B's harness.
    const [quiet, pauses] = await Promise.all([silences(path), silences(path, { minSeconds: 0.08, noiseDb: -40 })])
    const regions = speechRegions(quiet, duration)
    const speech: EditRange[] = []
    for (const s of scopes) {
      for (const r of regions) {
        const start = Math.max(s.start, r.start)
        const end = Math.min(s.end, r.end)
        if (end - start > 0.05) speech.push({ start: round(start), end: round(end) })
      }
    }
    return { speech, pauses }
  }

  private async planChangeVoice(
    d: Draft,
    base: db.StoredGeneration & { filePath: string },
    info: BaseInfo,
    mix: AudioMix,
    raw: Record<string, unknown>
  ): Promise<{ op: EditOperation; exec: Exec }> {
    const D = info.duration
    const catalog = await this.catalogOrProblem(d)
    const changers = catalog?.voiceChangers ?? []
    const wanted = str(raw.model, 200)
    const model: VoiceChangerModel | undefined =
      changers.find((m) => m.id === wanted) ?? (wanted ? undefined : changers[0])
    if (catalog && !changers.length) d.problem(catalog.keyed || getActiveKey() ? noVoiceChanger() : NO_KEY)
    else if (catalog && !model) d.problem(`${activeServiceName()} doesn't have the voice change model.`)

    // The new voice.
    const v = (raw.voice && typeof raw.voice === 'object' ? raw.voice : {}) as Record<string, unknown>
    let voice: Exclude<VoiceChoice, { kind: 'clone' }>
    if (v.kind === 'custom') {
      const voiceId = str(v.voiceId, 200)
      if (!voiceId) d.problem('Give the voice ID.')
      if (model && !model.customVoiceId) d.problem("The model doesn't take custom voice IDs.")
      voice = { kind: 'custom', voiceId }
    } else {
      const name = str(v.voice, 200) || model?.defaultVoice || model?.voices[0] || ''
      if (model && !model.voices.includes(name)) d.problem("Choose one of the model's voices.")
      voice = { kind: 'preset', voice: name }
    }

    // What is converted.
    let scopes: EditRange[] = [{ start: 0, end: D }]
    let range: EditRange | undefined
    let segmentIds: string[] | undefined
    if (Array.isArray(raw.segmentIds) && raw.segmentIds.length) {
      segmentIds = [...new Set(raw.segmentIds.filter((s): s is string => typeof s === 'string'))]
      const t = transcriptFor(base.id)
      if (!t) d.problem('Transcribe the film first to choose lines.')
      const chosen = (t?.segments ?? []).filter((s) => segmentIds!.includes(s.id))
      if (t && chosen.length !== segmentIds.length) d.problem('A chosen line is no longer in the transcript.')
      scopes = mergeRanges(
        chosen.map((s) => ({ start: Math.max(0, s.start - LINE_PAD), end: Math.min(D, s.end + LINE_PAD) }))
      )
      d.inputs.push({ transcript: t?.updatedAt })
    } else {
      const r = readRange(raw.range)
      if (r) {
        range = this.snap(d, r, info, { min: 0.5 })
        scopes = [range]
      }
    }

    const separation = await this.separationAvailable()
    const background: BackgroundChoice =
      raw.background === 'remove' || raw.background === 'keep' || raw.background === 'duck'
        ? raw.background
        : separation
          ? 'keep'
          : 'duck'
    if (background === 'keep' && !separation) d.problem(NO_SEPARATION)
    // Without separation the whole mix is uploaded: the model's own noise removal keeps music and effects from being
    // "converted" too. With separation only the voice stem goes, which needs none.
    const removeNoise = model?.backgroundNoiseRemoval
      ? typeof raw.removeNoise === 'boolean'
        ? raw.removeNoise
        : !separation
      : undefined

    let chunks: { start: number; end: number; billedMinutes: number; fadeIn?: number; fadeOut?: number }[] = []
    let source: 'voice' | 'mix' = separation ? 'voice' : 'mix'
    if (!d.problems.length && model) {
      try {
        const from = await this.voiceSource(base, mix, separation)
        if (!from) d.problem('The film has no speech to change the voice of.')
        else {
          source = from.kind
          const { speech, pauses } = await this.speechIn(from.path, D, scopes)
          chunks = planVoiceChunks(speech, { maxSeconds: model.maxSourceSeconds, margin: CHUNK_MARGIN, pauses })
          if (!chunks.length) d.problem('There is no speech in the range to change the voice of.')
        }
      } catch (err) {
        d.problem(`The speech could not be found: ${errorText(err)}`)
      }
    }

    const steps: StepSpec[] = []
    if (model && chunks.length) {
      const quotes = await mapLimited(chunks, MAX_QUOTES_IN_FLIGHT, (c) =>
        this.deps.audio
          .quoteVoiceChange(model.id, voiceChunkQuoteSeconds(c, CHUNK_MARGIN))
          .catch(() => undefined as number | undefined)
      )
      const voiceValue = voice.kind === 'preset' ? voice.voice : voice.voiceId
      chunks.forEach((c, i) => {
        const seconds = round(c.end - c.start)
        steps.push({
          endpoint: 'voice-changer',
          model: model.id,
          request: {
            start: round(c.start),
            end: round(c.end),
            voice: voiceValue,
            ...(removeNoise !== undefined ? { removeNoise } : {}),
            source,
            seconds: voiceChunkQuoteSeconds(c, CHUNK_MARGIN),
            ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
            ...(c.fadeOut ? { fadeOut: c.fadeOut } : {})
          },
          quote: quotes[i],
          label: chunks.length > 1 ? `Part ${i + 1} of ${chunks.length}` : 'Voice change',
          seconds
        })
        d.addPrice(quotes[i])
        d.steps.push({
          label: `${chunks.length > 1 ? `Part ${i + 1}` : 'Voice change'} (${fmtClock(c.start)}–${fmtClock(c.end)})`,
          seconds,
          priceUsd: quotes[i]
        })
      })
      const sent = chunks.reduce((s, c) => s + (c.end - c.start), 0)
      const minutes = chunks.reduce((s, c) => s + c.billedMinutes, 0)
      const parts = `${chunks.length} ${chunks.length === 1 ? 'part' : 'parts'}`
      d.priceNote = `${fmtDuration(sent)} → ${parts}, ${minuteBillingNote(minutes)}`
    }
    d.note('The picture is left untouched, so the lips follow along.')
    if (!segmentIds) d.note('Every voice in the range gets the new voice. Choose lines to change only one person.')
    if (!separation) d.warn('The old voice may be faintly heard under the new one.')
    d.inputs.push({ separation, chunks: chunks.map((c) => [c.start, c.end]) })

    const op: EditOperation = {
      op: 'change-voice',
      model: model?.id ?? wanted,
      voice,
      ...(range ? { range } : {}),
      ...(segmentIds ? { segmentIds } : {}),
      background,
      ...(removeNoise !== undefined ? { removeNoise } : {})
    }
    const scopeStart = Math.min(...scopes.map((s) => s.start))
    const scopeEnd = Math.max(...scopes.map((s) => s.end))
    return {
      op,
      exec: {
        kind: 'audio',
        steps,
        finish: { scopes, scopeStart: round(scopeStart), scopeEnd: round(scopeEnd), background, source }
      }
    }
  }

  // ── Speak lines (TTS) ────────────────────────────────────────────────────

  private async planSpeakLines(
    d: Draft,
    base: db.StoredGeneration,
    info: BaseInfo,
    raw: Record<string, unknown>
  ): Promise<{ op: EditOperation; exec: Exec }> {
    const D = info.duration
    const catalog = await this.catalogOrProblem(d)
    const v = (raw.voice && typeof raw.voice === 'object' ? raw.voice : {}) as Record<string, unknown>
    const cloning = v.kind === 'clone'
    const wanted = cloning ? serviceDefaults().cloneSpeech : str(raw.model, 200) || serviceDefaults().speech
    const model: SpeechModel | undefined = catalog?.speech.find((m) => m.id === wanted)
    if (catalog && !model) {
      const service = activeServiceName()
      d.problem(
        cloning ? `${service} doesn't offer voice cloning right now.` : `${service} doesn't have the speech model.`
      )
    }
    if (cloning && model && !model.cloning) d.problem('The model cannot clone voices.')

    // The voice.
    let voice: VoiceChoice
    let clip: store.AudioClipRow | undefined
    if (cloning) {
      const audioId = str(v.audioId, 80)
      clip = store.audioClipRow(audioId)
      voice = { kind: 'clone', audioId }
      if (!clip) d.problem('The voice clip no longer exists in the library.')
      else {
        if (!clip.clone_consent_at) d.problem(CONSENT_MISSING)
        const min = model?.cloning?.minSampleSeconds ?? 5
        if (clip.duration < min - 1e-3) d.problem(SAMPLE_TOO_SHORT)
      }
    } else if (v.kind === 'custom') {
      const voiceId = str(v.voiceId, 200)
      if (!voiceId) d.problem('Give the voice ID.')
      if (model && !model.customVoiceId) d.problem("The model doesn't take custom voice IDs.")
      voice = { kind: 'custom', voiceId }
    } else {
      const name = str(v.voice, 200) || model?.defaultVoice || model?.voices[0] || ''
      if (model && model.voices.length && !model.voices.includes(name)) d.problem("Choose one of the model's voices.")
      voice = { kind: 'preset', voice: name }
    }

    // The lines and where they go.
    const rawLines = Array.isArray(raw.lines) ? raw.lines.slice(0, MAX_LINES + 1) : []
    if (!rawLines.length) d.problem('Write at least one line.')
    if (rawLines.length > MAX_LINES) d.problem(`At most ${MAX_LINES} lines at a time.`)
    const transcript = rawLines.some((l) => typeof (l as SpeakLine)?.segmentId === 'string')
      ? transcriptFor(base.id)
      : null
    const segments = transcript?.segments ?? []
    const maxChars = model?.maxCharacters ?? 4096
    const lines: SpeakLine[] = []
    const slots: {
      index: number
      segmentId?: string
      text: string
      old?: string
      start: number
      end: number
      limit: number
      replace: boolean
    }[] = []
    rawLines.slice(0, MAX_LINES).forEach((value, i) => {
      const l = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
      const text = str(l.text, 6000)
      if (!text) d.problem(`Line ${i + 1} is empty.`)
      else if (Array.from(text).length > maxChars) d.problem(`Line ${i + 1} is too long (at most ${maxChars} characters).`)
      if (typeof l.segmentId === 'string') {
        if (!transcript) d.problem('Transcribe the film first to re-record lines.')
        const seg = segments.find((s) => s.id === l.segmentId)
        if (transcript && !seg) d.problem(`Line ${i + 1} is no longer in the transcript.`)
        lines.push({ segmentId: l.segmentId, text })
        if (seg) {
          const next = segments.filter((s) => s.start > seg.start + 1e-3).sort((a, b) => a.start - b.start)[0]
          slots.push({
            index: i,
            segmentId: seg.id,
            text,
            old: seg.text,
            start: round(seg.start),
            end: round(seg.end),
            limit: round(Math.min(D, next ? next.start : D)),
            replace: true
          })
        }
      } else {
        const at = num(l.at)
        if (at === undefined || at < 0 || at >= D) d.problem(`Line ${i + 1} must be placed inside the film.`)
        const t = round(Math.min(Math.max(0, at ?? 0), D))
        lines.push({ at: t, text })
        const next = segments.filter((s) => s.start > t + 1e-3).sort((a, b) => a.start - b.start)[0]
        slots.push({ index: i, text, start: t, end: t, limit: round(next ? next.start : D), replace: false })
      }
    })
    if (transcript) d.inputs.push({ transcript: transcript.updatedAt })

    const separation = await this.separationAvailable()
    const replacing = slots.some((s) => s.replace)
    const background: BackgroundChoice =
      raw.background === 'remove' || raw.background === 'keep' || raw.background === 'duck'
        ? raw.background
        : separation
          ? 'keep'
          : 'duck'
    if (replacing && background === 'keep' && !separation) d.problem(NO_SEPARATION)
    const fit = raw.fit === 'overlap' ? 'overlap' : 'tempo'
    const style = model?.stylePrompt ? str(raw.style, 500) || undefined : undefined
    if (!model?.stylePrompt && str(raw.style)) d.note("The model takes no tone – it isn't sent.")
    const language = model?.endpoint === 'speech' ? str(raw.language, 40) || undefined : undefined
    const format = model
      ? (['wav', 'mp3', 'flac'].find((f) => model.formats.includes(f)) ?? model.formats[0] ?? 'mp3')
      : 'mp3'

    // Prices: per line (a per-request minimum applies to the queued models), a clone first when needed.
    const steps: StepSpec[] = []
    if (cloning && clip && model && !store.validClone(clip.id, model.id)) {
      const min = model.cloning?.minSampleSeconds ?? 5
      const window = cloneWindow(clip, min)
      // fal's "clone" uploads the sample, which is free; Venice's has no price in advance.
      const free = providerOf(model.id) === 'fal'
      steps.push({
        endpoint: 'voice-clone',
        model: model.id,
        request: { audioId: clip.id, start: window.start, length: window.length },
        label: 'Voice cloning',
        ...(free ? { quote: 0 } : {})
      })
      if (free) {
        d.addPrice(0)
        d.steps.push({ label: `Voice cloning (${clip.asset_name})`, priceUsd: 0 })
      } else {
        d.addPrice(undefined)
        d.priceNote = CLONE_UNPRICED
        d.steps.push({ label: `Voice cloning (${clip.asset_name})` })
      }
    }
    if (model) {
      const voiceValue =
        voice.kind === 'preset' ? voice.voice : voice.kind === 'custom' ? voice.voiceId : { clone: voice.audioId }
      const prices = await mapLimited(slots, MAX_QUOTES_IN_FLIGHT, async (slot) => {
        const chars = Array.from(slot.text).length
        if (model.endpoint === 'speech') {
          return model.usdPerThousandChars !== undefined ? speechPriceUsd(chars, model.usdPerThousandChars) : undefined
        }
        return this.deps.audio.quoteAudio({ model: model.id, characterCount: chars }).catch(() => undefined)
      })
      slots.forEach((slot, i) => {
        steps.push({
          endpoint: model.endpoint === 'speech' ? 'speech' : 'audio-queue',
          model: model.id,
          request: {
            kind: 'speech',
            line: slot.index,
            text: slot.text,
            voice: voiceValue,
            ...(model.endpoint === 'speech' ? { format } : {}),
            ...(style ? { style } : {}),
            ...(language ? { language } : {})
          },
          quote: prices[i],
          label: `Line ${slot.index + 1}`
        })
        d.addPrice(prices[i])
        d.steps.push({ label: `Line ${slot.index + 1}: ${excerpt(slot.text, 30)}`, priceUsd: prices[i] })
      })
      if (model.endpoint === 'speech' && !d.priceNote) {
        d.priceNote = `Estimated from ${providerName(providerOf(model.id))}'s price list`
      }
      if (model.endpoint === 'speech' && d.priceNote === CLONE_UNPRICED) {
        d.priceNote = `${CLONE_UNPRICED} · lines estimated from the price list`
      }
    }
    if (replacing) d.warn(LIP_SYNC)
    if (fit === 'overlap') d.note('Lines that get longer than their slot may overlap what comes after.')
    if (cloning) {
      d.note("Listen to the first line before you re-record a whole film – cloned voices in Swedish haven't been tested.")
    }
    if (replacing && !separation) d.warn('The old voice may be faintly heard under the new one.')

    const op: EditOperation = {
      op: 'speak-lines',
      model: model?.id ?? wanted,
      voice,
      lines,
      background,
      fit,
      ...(style ? { style } : {}),
      ...(language ? { language } : {})
    }
    return { op, exec: { kind: 'audio', steps, finish: { lines: slots, background, fit, separation } } }
  }

  // ── Music and effects ────────────────────────────────────────────────────

  private async planAudioGen(
    d: Draft,
    info: BaseInfo,
    raw: Record<string, unknown>
  ): Promise<{ op: EditOperation; exec: Exec }> {
    const D = info.duration
    const isMusic = raw.op === 'music'
    const catalog = await this.catalogOrProblem(d)
    const wanted = str(raw.model, 200) || (isMusic ? serviceDefaults().music : serviceDefaults().effect)
    const list = isMusic ? catalog?.music : catalog?.effects
    const model = list?.find((m) => m.id === wanted)
    if (catalog && !model) {
      const service = activeServiceName()
      d.problem(isMusic ? `${service} doesn't have the music model.` : `${service} doesn't have the sound effect model.`)
    }
    const prompt = str(raw.prompt, 4000)
    if (!prompt) d.problem(isMusic ? 'Describe the music.' : 'Describe the sound.')
    else if (model && prompt.length > model.promptLimit) {
      d.problem(`The description is too long (at most ${model.promptLimit} characters).`)
    }
    else if (model && prompt.length < model.minPromptLength) d.problem('The description is too short.')
    const gainDb = round(Math.min(24, Math.max(-60, num(raw.gainDb) ?? (isMusic ? DEFAULT_MUSIC_GAIN_DB : 0))), 10)

    if (isMusic) {
      const r = readRange(raw.range)
      const range = r ? this.snap(d, r, info, { min: 1 }) : undefined
      const at = range?.start ?? 0
      const length = range ? range.end - range.start : D
      const seconds = model ? audioDurationFor(model, length) : undefined
      if (model && !model.durationControl) {
        d.note('The model picks the length itself – the music is cut short or ends earlier.')
      } else if (seconds !== undefined && seconds < length - 0.5) {
        const of = range ? 'the selection' : 'the film'
        d.note(`The music will be ${seconds} s (the model's longest) and ends before ${of} does.`)
      }
      const instrumental = model?.instrumental ? raw.instrumental !== false : undefined
      const duck = raw.duck !== false
      const fadeSeconds = round(Math.max(0, Math.min(num(raw.fadeSeconds) ?? DEFAULT_MUSIC_FADE, length / 2)), 100)
      const usd = model
        ? await this.deps.audio
            .quoteAudio({ model: model.id, ...(seconds !== undefined ? { durationSeconds: seconds } : {}) })
            .catch(() => undefined)
        : undefined
      d.addPrice(usd)
      d.steps.push({ label: `Music ${seconds !== undefined ? `${seconds} s` : ''}`.trim(), seconds, priceUsd: usd })
      const op: EditOperation = {
        op: 'music',
        model: model?.id ?? wanted,
        prompt,
        ...(range ? { range } : {}),
        ...(instrumental !== undefined ? { instrumental } : {}),
        gainDb,
        duck,
        fadeSeconds
      }
      return {
        op,
        exec: {
          kind: 'audio',
          steps: model
            ? [
                {
                  endpoint: 'audio-queue',
                  model: model.id,
                  request: {
                    kind: 'music',
                    prompt,
                    ...(seconds !== undefined ? { durationSeconds: seconds } : {}),
                    ...(instrumental !== undefined ? { instrumental } : {})
                  },
                  quote: usd,
                  label: 'Music',
                  seconds
                }
              ]
            : [],
          finish: { kind: 'music', at, length, gainDb, duck, fade: fadeSeconds, prompt }
        }
      }
    }

    const at = round(Math.max(0, num(raw.at) ?? 0))
    if (at >= D) d.problem('The sound effect must start inside the film.')
    const asked = Math.max(1, num(raw.seconds) ?? model?.defaultSeconds ?? 3)
    const seconds = model ? (audioDurationFor(model, asked) ?? asked) : Math.round(asked)
    if (model && model.durationControl && Math.abs(seconds - asked) > 0.5) {
      d.note(`The sound effect will be ${seconds} s (the model makes ${model.minSeconds}–${model.maxSeconds} s).`)
    }
    const usd = model
      ? await this.deps.audio
          .quoteAudio({ model: model.id, ...(model.durationControl ? { durationSeconds: seconds } : {}) })
          .catch(() => undefined)
      : undefined
    d.addPrice(usd)
    d.steps.push({ label: `Sound effect ${seconds} s`, seconds, priceUsd: usd })
    const op: EditOperation = { op: 'effect', model: model?.id ?? wanted, prompt, at, seconds, gainDb }
    return {
      op,
      exec: {
        kind: 'audio',
        steps: model
          ? [
              {
                endpoint: 'audio-queue',
                model: model.id,
                request: { kind: 'effect', prompt, ...(model.durationControl ? { durationSeconds: seconds } : {}) },
                quote: usd,
                label: 'Sound effect',
                seconds
              }
            ]
          : [],
        finish: { kind: 'effect', at, length: seconds, gainDb, prompt }
      }
    }
  }

  // ── Picture operations ───────────────────────────────────────────────────

  /** A frame of the base (free, cached in .studio/frames). */
  private frame(
    base: db.StoredGeneration & { filePath: string },
    kind: 'before' | 'after' | 'last',
    t = 0
  ): Promise<string> {
    const name = `${base.id}-edit-${kind}-${Math.round(t * 1000)}.png`
    const out = join(framesDir(), name)
    const running = this.frameJobs.get(out)
    if (running) return running
    if (existsSync(out)) return Promise.resolve(out)
    const job = (async () => {
      const tmp = join(tmpDir(), `${randomUUID()}.png`)
      try {
        if (kind === 'last') await extractFrame(base.filePath, tmp)
        else if (kind === 'before') await extractFrame(base.filePath, tmp, t)
        else await extractFrameAtOrAfter(base.filePath, tmp, t)
        await rename(tmp, out)
        return out
      } finally {
        await rm(tmp, { force: true }).catch(() => {})
      }
    })()
    this.frameJobs.set(out, job)
    void job.finally(() => this.frameJobs.delete(out)).catch(() => {})
    return job
  }

  /** The bytes a picture adds to a request (cached: plans are made again on every change of a form). */
  private async requestBytesOf(path: string): Promise<number> {
    const s = await stat(path)
    const key = `${s.size}:${s.mtimeMs}`
    let cached = this.imageBytes.get(path)
    if (!cached || cached.key !== key) {
      cached = { key, bytes: imageRequestBytes(path).catch(() => s.size) }
      this.imageBytes.set(path, cached)
    }
    return cached.bytes
  }

  /** A tiny grey clip of the given length and shape, for free quotes only (never queued). */
  private standIn(seconds: number, width: number, height: number, fps: number): Promise<string> {
    const key = sha1(`${round(seconds)}:${even(width)}x${even(height)}@${round(fps)}`).slice(0, 16)
    const out = join(tmpDir(), `standin-${key}.mp4`)
    const running = this.standIns.get(out)
    if (running) return running
    if (existsSync(out)) return Promise.resolve(out)
    const job = makeStandIn(out, { seconds, width: even(width), height: even(height), fps }).then(() => out)
    this.standIns.set(out, job)
    void job.finally(() => this.standIns.delete(out)).catch(() => {})
    return job
  }

  private async videoModels(d: Draft): Promise<VideoModel[]> {
    try {
      return await this.deps.models()
    } catch {
      d.problem(NO_MODELS)
      return []
    }
  }

  private async quote(
    d: Draft,
    params: GenerationParams,
    label: string,
    seconds?: number
  ): Promise<number | undefined> {
    let usd: number | undefined
    try {
      usd = await this.deps.venice.quote(params)
    } catch (err) {
      const status = statusOf(err)
      if (status === 401 || status === 403) d.problem(NO_KEY)
      else d.warn(`The price could not be fetched: ${errorText(err)}`)
    }
    d.addPrice(usd)
    d.steps.push({ label, ...(seconds !== undefined ? { seconds: round(seconds) } : {}), priceUsd: usd })
    return usd
  }

  /** Whether the edit started from the user's own film (real people may be in it). */
  private ownFootage(edit: store.EditRow): boolean {
    if (edit.origin_kind === 'import') return true
    const g = edit.origin_generation_id ? db.getGeneration(edit.origin_generation_id) : undefined
    return g?.source === 'import' && !g.recipe?.export
  }

  private async planPicture(
    d: Draft,
    edit: store.EditRow,
    base: db.StoredGeneration & { filePath: string },
    info: BaseInfo,
    raw: Record<string, unknown>
  ): Promise<{ op: EditOperation; exec: Exec }> {
    const D = info.duration
    const frame = 1 / info.fps
    const models = await this.videoModels(d)
    const ids = models.map((m) => m.id)
    const own = this.ownFootage(edit)
    const prompt = str(raw.prompt, 5000)

    if (raw.op === 'upscale') {
      const factor: 2 | 4 = raw.factor === 4 ? 4 : 2
      const vm = models.find((m) => m.videoInput && isUpscaleModel(m.id))
      const modelId = vm?.id ?? serviceDefaults().upscale
      if (models.length && !vm) d.problem(`${activeServiceName()} doesn't offer upscaling right now.`)
      const longSide = Math.max(info.width, info.height)
      if (longSide * factor > MAX_UPSCALE_LONG_SIDE) {
        d.problem(
          factor === 4 && longSide * 2 <= MAX_UPSCALE_LONG_SIDE
            ? 'The film gets too large at 4× (at most 3840 pixels on the long side). Choose 2×.'
            : 'The film is already so large that it cannot be upscaled further.'
        )
      }
      const sendBase = info.bytes <= MAX_REQUEST_MEDIA_BYTES && /\.(mp4|mov|m4v)$/i.test(base.filePath)
      const minBytes = (MIN_BITS_PER_PIXEL_FRAME * info.width * info.height * Math.min(info.fps, 60) * D) / 8
      if (D > MAX_UPSCALE_SECONDS || (!sendBase && minBytes > MAX_REQUEST_MEDIA_BYTES)) d.problem(UPSCALE_TOO_BIG)
      if (!getActiveKey()) d.problem(NO_KEY)
      const op: EditOperation = { op: 'upscale', factor }
      const params: GenerationParams = { model: modelId, prompt: '', duration: 'Auto', upscaleFactor: factor }
      if (!d.problems.length) {
        const standIn = await this.standIn(D, info.width, info.height, info.fps)
        d.problem(blockingPromptError(params))
        if (!d.problems.length) await this.quote(d, { ...params, sourceVideo: standIn }, `Upscale ${factor}×`, D)
      }
      d.resultSeconds = D
      d.estimatedBytes = info.bytes * factor * factor
      d.note('The whole film is upscaled in one request.')
      return {
        op,
        exec: {
          kind: 'picture',
          spec: {
            params,
            ...(sendBase ? { sendBase: true } : { proxy: { start: 0, end: D, maxHeight: info.height, audio: false } })
          },
          finish: {}
        }
      }
    }

    if (raw.op === 'extend') {
      let modelId = str(raw.model, 200) || serviceDefaults().i2v
      let vm = models.find((m) => m.id === modelId)
      if (models.length && !vm) d.problem(`${providerName(providerOf(modelId))} doesn't have the model.`)
      if (vm && vm.kind !== 'image-to-video') {
        modelId = endImageVariant(modelId, ids)
        vm = models.find((m) => m.id === modelId)
      }
      const allowed = vm ? modelSeconds(vm).filter((s) => s >= 4 && s <= 15) : [4, 5, 6, 8, 10, 12, 15]
      const asked = num(raw.seconds) ?? 5
      const seconds = allowed.reduce(
        (best, s) => (Math.abs(s - asked) < Math.abs(best - asked) ? s : best),
        allowed[0] ?? 5
      )
      if (!allowed.length) d.problem('The model cannot make 4–15 s.')
      if (Math.abs(seconds - asked) > 1e-3) d.note(`The length is adjusted to ${seconds} s — the model makes whole seconds.`)
      if (!prompt) d.problem('Write what happens next.')
      const audio: 'model' | 'silence' = raw.audio === 'silence' ? 'silence' : 'model'
      const resolution = vm ? patchResolution(vm.resolutions, info.height, str(raw.resolution, 20)) : undefined
      const aspectRatio = vm ? closestAspect(vm.aspectRatios, info.width, info.height) : undefined
      const sound = audio === 'model' && !!vm?.audio
      if (audio === 'model' && vm && !vm.audio) d.note('The model makes no sound – the extension will be silent.')
      const params: GenerationParams = {
        model: modelId,
        prompt,
        duration: `${seconds}s`,
        ...(resolution ? { resolution } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(vm?.audio ? { audio: sound } : {}),
        includeDescriptions: false
      }
      try {
        d.frames = { start: await this.frame(base, 'last') }
      } catch (err) {
        d.problem(`The last frame could not be taken out: ${errorText(err)}`)
      }
      if (own) d.warn(REAL_PEOPLE)
      if (prompt) d.problem(blockingPromptError(params))
      if (!d.problems.length) await this.quote(d, params, `Extend ${seconds} s`, seconds)
      d.resultSeconds = D + seconds - frame
      d.estimatedBytes = info.bytes * (d.resultSeconds / D) * 1.3
      const op: EditOperation = {
        op: 'extend',
        seconds,
        prompt,
        model: modelId,
        ...(resolution ? { resolution } : {}),
        audio
      }
      return { op, exec: { kind: 'picture', spec: { params, frames: d.frames }, finish: {} } }
    }

    const r = readRange(raw.range)
    if (!r) d.problem('Select the section first.')
    const audio: 'keep' | 'model' = raw.audio === 'model' ? 'model' : 'keep'

    if (raw.op === 'lip-sync') {
      // fal.ai only (Venice has no lip sync model): the selection, with the sound it has now, goes as a proxy; the
      // model's picture is put back over the range and the film's own sound stays.
      const modelId = str(raw.model, 200) || serviceDefaults().lipSync || ''
      const vm = models.find((m) => m.id === modelId)
      if (!modelId || !isLipSyncModel(modelId)) {
        d.problem(`${activeServiceName()} has no lip sync. Choose fal.ai in Settings → Service.`)
      } else if (models.length && !vm) {
        d.problem(`${providerName(providerOf(modelId))} doesn't have the model.`)
      }
      const range = r
        ? this.snap(d, r, info, { min: LIP_SYNC_MIN_SECONDS, max: LIP_SYNC_MAX_SECONDS })
        : { start: 0, end: Math.min(D, LIP_SYNC_MIN_SECONDS) }
      const length = round(range.end - range.start)
      if (!info.hasAudio) d.problem('The film has no sound for the mouths to follow.')
      if (!getActiveKey()) d.problem(NO_KEY)
      const params: GenerationParams = { model: modelId, prompt: '', duration: 'Auto', includeDescriptions: false }
      try {
        const first = await this.frame(base, 'after', range.start)
        const last = await this.frame(base, 'before', range.end)
        d.frames = { start: first, end: last }
      } catch (err) {
        console.warn('The frames of a lip sync could not be taken out:', err)
      }
      if (!d.problems.length) {
        const standIn = await this.standIn(length, 64, 36, 24)
        await this.quote(d, { ...params, sourceVideo: standIn }, `Lip sync ${fmtSeconds(length)}`, length)
      }
      d.note('The mouths follow the sound the selection has now: re-recorded lines, say. Speech alone works best.')
      if (own) d.warn(REAL_PEOPLE)
      d.resultSeconds = D
      d.estimatedBytes = info.bytes * 1.3
      const op: EditOperation = { op: 'lip-sync', range, model: modelId }
      return {
        op,
        exec: {
          kind: 'picture',
          spec: {
            params,
            proxy: { start: range.start, end: range.end, maxHeight: MAX_PATCH_HEIGHT, audio: true },
            frames: d.frames
          },
          finish: {}
        }
      }
    }

    if (raw.op === 'regenerate') {
      let modelId = str(raw.model, 200) || serviceDefaults().i2v
      let vm = models.find((m) => m.id === modelId)
      if (models.length && !vm) d.problem(`${providerName(providerOf(modelId))} doesn't have the model.`)
      if (vm && (vm.kind !== 'image-to-video' || !supportsEndImage(modelId))) {
        const swapped = endImageVariant(modelId, ids)
        if (swapped !== modelId) {
          const name = models.find((m) => m.id === swapped)?.name ?? swapped
          d.note(`The model is switched to ${name}, which takes an end image.`)
        }
        modelId = swapped
        vm = models.find((m) => m.id === modelId)
      }
      const allowed = vm ? modelSeconds(vm) : []
      const range = r
        ? this.snap(d, r, info, {
            wholeSeconds: true,
            ...(allowed.length ? { allowed, min: allowed[0], max: allowed[allowed.length - 1] } : { min: 4, max: 30 })
          })
        : { start: 0, end: Math.min(D, 4) }
      const length = round(range.end - range.start)
      const needEnd = range.end < D - frame / 2
      if (!prompt) d.problem('Write what happens in the section.')
      const resolution = vm ? patchResolution(vm.resolutions, info.height, str(raw.resolution, 20)) : undefined
      const aspectRatio = vm ? closestAspect(vm.aspectRatios, info.width, info.height) : undefined
      if (audio === 'model' && vm && !vm.audio) d.problem('The model makes no sound. Choose Keep the original sound.')
      const params: GenerationParams = {
        model: modelId,
        prompt,
        duration: `${Math.round(length)}s`,
        ...(resolution ? { resolution } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(vm?.audio ? { audio: audio === 'model' } : {}),
        includeDescriptions: false
      }
      try {
        const start =
          range.start > frame / 2 ? await this.frame(base, 'before', range.start) : await this.frame(base, 'after', 0)
        const end = needEnd ? await this.frame(base, 'after', range.end) : undefined
        d.frames = { start, ...(end ? { end } : {}) }
      } catch (err) {
        d.problem(`The frames could not be taken out: ${errorText(err)}`)
      }
      if (range.start <= frame / 2) d.note("The section starts on the film's first frame.")
      if (!needEnd) d.note('The section ends where the film ends – no end image is needed.')
      if (own) d.warn(REAL_PEOPLE)
      if (prompt) d.problem(blockingPromptError(params))
      if (!d.problems.length) await this.quote(d, params, `Regenerate ${fmtSeconds(length)}`, length)
      d.resultSeconds = D
      d.estimatedBytes = info.bytes * 1.3
      const op: EditOperation = {
        op: 'regenerate',
        range,
        prompt,
        model: modelId,
        ...(resolution ? { resolution } : {}),
        audio
      }
      return { op, exec: { kind: 'picture', spec: { params, frames: d.frames }, finish: { needEnd } } }
    }

    // prompt-edit
    const modelId = str(raw.model, 200) || serviceDefaults().promptEdit
    const spec = PICTURE_EDIT_MODELS[modelId]
    const vm = models.find((m) => m.id === modelId)
    if (!spec) d.problem('The model cannot edit video.')
    else if (models.length && !vm) d.problem(`${providerName(providerOf(modelId))} doesn't have the model.`)
    const range = r
      ? this.snap(d, r, info, { min: spec?.minSeconds ?? 1, max: spec?.maxSeconds ?? 10 })
      : { start: 0, end: Math.min(D, spec?.minSeconds ?? 4) }
    const length = round(range.end - range.start)
    if (!prompt) d.problem('Write what should change.')
    const seedance = spec?.kind === 'r2v-edit' || supportsReferenceVideos(modelId)
    const resolution = vm ? patchResolution(vm.resolutions, info.height, str(raw.resolution, 20)) : undefined
    const imageIds = Array.isArray(raw.referenceImageIds)
      ? [...new Set(raw.referenceImageIds.filter((s): s is string => typeof s === 'string'))]
      : []
    const imagePaths: string[] = []
    if (imageIds.length && !spec?.referenceImages) d.problem('The model takes no images to start from.')
    if (imageIds.length > 9) d.problem('At most 9 images to start from.')
    for (const id of imageIds) {
      const path = store.assetImagePath(id)
      if (!path || !existsSync(path)) d.problem('An image to start from no longer exists.')
      else imagePaths.push(path)
    }
    let soundFromModel = audio === 'model'
    if (soundFromModel && vm && !vm.audio) {
      d.note('The model makes no sound – the original sound is kept.')
      soundFromModel = false
    }
    // The proxy: ≤720p (the film's own height when lower), at least 0.05 bits per pixel and frame, ≤22 MB.
    // makeProxy caps the shorter side (a portrait film's width) at 720.
    const proxyScale = Math.min(1, MAX_PATCH_HEIGHT / Math.min(info.width, info.height))
    const proxyHeight = even(info.height * proxyScale)
    const proxyWidth = even(info.width * proxyScale)
    const proxyFps = Math.min(info.fps, 30)
    const pictureBytes = (MIN_BITS_PER_PIXEL_FRAME * proxyWidth * proxyHeight * proxyFps * length) / 8
    const minBytes = pictureBytes + (soundFromModel ? (128_000 * length) / 8 : 0)
    // The pictures to start from go in the same request, encoded the way the submit encodes them: the proxy gets
    // what is left of Venice's limit.
    let imageBytes = 0
    for (const path of imagePaths) imageBytes += await this.requestBytesOf(path)
    if (minBytes > MAX_REQUEST_MEDIA_BYTES) d.problem(TOO_BIG)
    else if (imageBytes && minBytes + imageBytes + IMAGE_BYTES_MARGIN > MAX_REQUEST_MEDIA_BYTES) {
      d.problem(IMAGES_TOO_BIG)
    }
    const sentPrompt = seedance ? seedanceEditPrompt(prompt, providerOf(modelId)) : prompt
    const params: GenerationParams = seedance
      ? {
          model: modelId,
          prompt: sentPrompt,
          duration: 'auto',
          aspectRatio: 'adaptive',
          ...(resolution ? { resolution } : {}),
          referenceTask: 'edit',
          ...(imagePaths.length ? { referenceImages: imagePaths } : {}),
          ...(vm?.audio ? { audio: soundFromModel } : {}),
          includeDescriptions: false
        }
      : {
          model: modelId,
          prompt: sentPrompt,
          duration: 'Auto',
          ...(resolution ? { resolution } : {}),
          includeDescriptions: false
        }
    if (own && seedance) d.warn(REAL_PEOPLE)
    const named = Math.max(0, ...[...prompt.matchAll(/@image\s*(\d+)/gi)].map((m) => Number(m[1])))
    if (named > imagePaths.length) {
      const chosen = `${imagePaths.length} ${imagePaths.length === 1 ? 'image' : 'images'}`
      d.problem(
        imagePaths.length
          ? `The prompt refers to @Image${named}, but only ${chosen} to start from ${imagePaths.length === 1 ? 'is' : 'are'} chosen.`
          : `The prompt refers to @Image${named}, but no image to start from is chosen.`
      )
    }
    // What the change works on, for the approval dialog and plan_edit_operation (only a preview: nothing is sent).
    try {
      const first = await this.frame(base, 'after', range.start)
      const last = await this.frame(base, 'before', range.end)
      d.frames = { start: first, end: last }
    } catch (err) {
      console.warn('The frames of a prompt edit could not be taken out:', err)
    }
    if (!d.problems.length) {
      const standIn = await this.standIn(length, 64, 36, 24)
      // The checks every submission runs (JobManager.submit), on what will be sent: refused here rather than after
      // the proxy is made.
      const sent: GenerationParams = seedance
        ? { ...params, referenceVideos: [{ path: standIn }] }
        : { ...params, sourceVideo: standIn }
      d.problem(blockingPromptError(sent as Parameters<typeof blockingPromptError>[0]))
      if (!d.problems.length) await this.quote(d, sent, `Edit ${fmtSeconds(length)}`, length)
    }
    d.resultSeconds = D
    d.estimatedBytes = info.bytes * 1.3
    d.inputs.push({ images: imagePaths })
    const op: EditOperation = {
      op: 'prompt-edit',
      range,
      prompt,
      model: modelId,
      ...(resolution ? { resolution } : {}),
      ...(imageIds.length ? { referenceImageIds: imageIds } : {}),
      audio: soundFromModel ? 'model' : 'keep'
    }
    return {
      op,
      exec: {
        kind: 'picture',
        spec: {
          params,
          proxy: {
            start: range.start,
            end: range.end,
            maxHeight: MAX_PATCH_HEIGHT,
            audio: soundFromModel,
            maxBytes: Math.max(0, MAX_REQUEST_MEDIA_BYTES - imageBytes - (imageBytes ? IMAGE_BYTES_MARGIN : 0))
          }
        },
        finish: { seedance }
      }
    }
  }

  // ── Running ──────────────────────────────────────────────────────────────

  /**
   * Runs an operation: plans it again (the single validation), refuses when the price rose above what was seen,
   * then renders a free op (resolving with the version), starts a paid audio job, or submits the AI take.
   */
  async run(editId: unknown, op: unknown, opts: EditRunOptions = {}): Promise<EditRunResult> {
    const planned = await this.planDetailed(editId, op, opts?.baseId)
    const { plan } = planned
    if (plan.problems.length) throw new Error(plan.problems[0])
    if (plan.paid) {
      const expected = opts?.expectedPriceUsd
      if (typeof expected !== 'number' || !Number.isFinite(expected)) throw new Error(CONFIRM_PRICE)
      if (plan.priceUsd !== undefined && plan.priceUsd > expected + 0.01) throw new Error(PRICE_CHANGED)
      // A part without a price that came in after the user saw a full one (a clone handle ran out meanwhile, so the
      // clone is made again) is refused like a price that rose: the button then shows it, and the extra question is
      // asked before anything is sent.
      if (opts?.expectedPartial === false && (plan.priceUsd === undefined || plan.partialPrice)) {
        throw new Error(PRICE_CHANGED)
      }
      // Refused with OVER_BUDGET before anything is sent when it would take the spending past the budget.
      assertWithinBudget(plan.priceUsd, { confirmed: opts?.confirmOverBudget === true })
      // Checked (or confirmed) here as a whole: what the job sends, now or when it goes on, isn't asked about again.
      return runConfirmed(() => this.execute(planned))
    }
    return this.execute(planned)
  }

  /** Carries out a planned operation that may run (see run). */
  private async execute(planned: Planned): Promise<EditRunResult> {
    switch (planned.exec.kind) {
      case 'free':
        return { versionId: await this.renderFree(planned) }
      case 'audio':
        return { jobId: await this.startAudioJob(planned, planned.exec) }
      case 'picture':
        return this.runPicture(planned, planned.exec)
      default:
        throw new Error('Unknown operation.')
    }
  }

  private report(p: EditProgress): void {
    try {
      this.deps.progress(p)
    } catch (err) {
      console.warn('Edit progress listener failed:', err)
    }
  }

  /** A job's last progress event: done, with its error when it has one. */
  private reportDone(job: store.StoredJob, error?: string): void {
    const { editId, assetId, id: jobId } = job
    this.report({ editId, assetId, jobId, label: job.request.label, done: true, error })
  }

  private notify(editId: string | undefined): void {
    if (!editId) return
    try {
      this.deps.notify(editId)
    } catch (err) {
      console.warn('Edit change listener failed:', err)
    }
  }

  /**
   * Runs a render in the global queue, with its own abort and scratch folder. A render without a job (a free
   * operation) is recorded in liveRenders from the call on, named by `title` (the operation's label) when given.
   */
  private render<T>(
    editId: string | undefined,
    label: string,
    task: (ctx: { signal: AbortSignal; work: string; progress: (f: number) => void }) => Promise<T>,
    opts: { jobId?: string; assetId?: string; title?: string } = {}
  ): Promise<T> {
    const { jobId, assetId, title } = opts
    this.rendering++
    const token = randomUUID()
    const live = !jobId && editId ? { editId, label: title ?? label, fraction: 0, startedAt: Date.now() } : undefined
    if (live) this.liveRenders.set(token, live)
    return this.renders(async () => {
      const ctrl = new AbortController()
      this.controllers.add(ctrl)
      const work = join(tmpDir(), `edit-${randomUUID()}`)
      try {
        await libraryOperationSettled()
        await mkdir(work, { recursive: true })
        this.report({ editId, jobId, assetId, fraction: 0, label })
        const result = await task({
          signal: ctrl.signal,
          work,
          progress: (f) => {
            const fraction = Math.min(1, Math.max(0, f))
            if (live) live.fraction = fraction
            this.report({ editId, jobId, assetId, fraction, label })
          }
        })
        this.report({ editId, jobId, assetId, fraction: 1, label, done: true })
        return result
      } catch (err) {
        this.report({ editId, jobId, assetId, label, done: true, error: errorText(err) })
        throw err
      } finally {
        // In the same tick as the done report: the status summary it triggers no longer lists the render.
        this.liveRenders.delete(token)
        this.controllers.delete(ctrl)
        this.rendering--
        await rm(work, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  /** A free render of the edit is running (or waiting for its turn): the edit counts as working. */
  isRendering(editId: string): boolean {
    for (const r of this.liveRenders.values()) if (r.editId === editId) return true
    return false
  }

  /** What runs right now: the running paid jobs and the free renders (see EditActiveWork). */
  activeWork(): EditActiveWork {
    const jobs: EditActiveWork['jobs'] = []
    for (const job of store.listJobsWithStatus('running')) {
      const view = this.jobView(job)
      jobs.push({
        jobId: job.id,
        ...(job.editId ? { editId: job.editId } : {}),
        ...(job.assetId ? { assetId: job.assetId } : {}),
        label: job.request.label,
        ...(view.fraction !== undefined ? { fraction: view.fraction } : {}),
        ...(view.currentStep ? { currentStep: view.currentStep } : {}),
        stepsDone: view.stepsDone,
        stepsTotal: view.stepsTotal,
        startedAt: job.createdAt,
        ...(job.baseId ? { baseId: job.baseId } : {}),
        ...(job.takeId ? { takeId: job.takeId } : {})
      })
    }
    const renders = [...this.liveRenders].map(([token, r]) => ({ token, ...r }))
    return { jobs, renders }
  }

  /**
   * The base's mix, ready to build on: when one of its sources is gone (a library clip removed, an edit deleted),
   * the base's own sound is copied into Audio/ as a bed and used instead, so the edit keeps working.
   */
  private async usableMix(
    edit: store.EditRow,
    base: db.StoredGeneration & { filePath: string },
    info: BaseInfo
  ): Promise<AudioMix> {
    const mix = mixes.mixOf(base, base.id === edit.origin_generation_id)
    if (mixes.mixIsComplete(mix)) return mix
    if (!info.hasAudio) return { bed: { source: null, gains: [] }, layers: [] }
    const tmp = join(tmpDir(), `${randomUUID()}.flac`)
    try {
      await extractAudio(base.filePath, tmp, { rate: SAMPLE_RATE, channels: 2, codec: 'flac' })
      const media = await this.addMediaFile(edit, tmp, {
        kind: 'bake',
        label: `Sound from ${base.title ?? 'the version'}`,
        duration: info.duration
      })
      return mixes.defaultMixFromMedia(media.id)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** Copies (or moves, from scratch) a file into the edit's Audio/ and records it as edit media. */
  async addMediaFile(
    edit: store.EditRow,
    file: string,
    m: {
      kind: store.MediaKind
      label: string
      model?: string
      cost?: number
      duration?: number
      details?: Record<string, unknown>
    },
    move = false
  ): Promise<store.StoredMedia> {
    const fresh = store.getEditRow(edit.id)
    if (!fresh?.folder) throw new Error('The edit no longer exists.')
    await libraryOperationSettled()
    const dir = editDir(fresh.folder, 'audio')
    const ext = extname(file).toLowerCase() || '.wav'
    const base = safeName(fileLabel(m.label), { max: 80, fallback: 'Audio' })
    let path: string
    if (move) path = await placeFile(file, dir, base, ext)
    else {
      const tmp = join(tmpDir(), `${randomUUID()}${ext}`)
      await copyFile(file, tmp)
      path = await placeFile(tmp, dir, base, ext)
    }
    try {
      const duration = m.duration ?? (await probeAudio(path).then((p) => p.duration, () => undefined))
      return store.insertMedia({
        editId: edit.id,
        kind: m.kind,
        path,
        label: m.label,
        model: m.model,
        cost: m.cost,
        duration,
        details: m.details ?? {}
      })
    } catch (err) {
      await rm(path, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Renders a mix to a wav in `work`; null when nothing in it sounds (the version gets no sound track). */
  private async mixToFile(
    mix: AudioMix,
    duration: number,
    work: string,
    signal: AbortSignal,
    progress?: (f: number) => void
  ): Promise<string | null> {
    const resolved = await mixes.resolveMix(mix, duration, { signal })
    return this.renderResolved(resolved, work, signal, progress)
  }

  private async renderResolved(
    resolved: ResolvedMix,
    work: string,
    signal: AbortSignal,
    progress?: (f: number) => void
  ): Promise<string | null> {
    const stems = resolved.bed.stems
    const silent = !resolved.bed.path && !resolved.layers.length && !stems?.voicePath && !stems?.backgroundPath
    if (silent) return null
    const out = join(work, `${randomUUID()}.wav`)
    await renderMix(resolved, out, { signal, onProgress: progress })
    return out
  }

  /**
   * spliceVideo, resolving with the file it wrote. Its output is constant frame rate at `fps`, so the last frame
   * keeps its duration and replaceAudioTrack pads the sound to the full picture length.
   */
  private async splice(o: Parameters<typeof spliceVideo>[0]): Promise<string> {
    await spliceVideo(o)
    return o.out
  }

  /** Inserts a finished version: placed in the edit folder, poster and length, current when the base still is. */
  private async writeVersion(spec: {
    edit: store.EditRow
    base: db.StoredGeneration
    op: EditOperation
    label: string
    video: string
    mix: AudioMix
    timing: 'same' | 'changed'
    spans?: mixes.TimeSpan[]
    takeId?: string
    quote?: number
    costUsd?: number
    /** Made by a paid job: the version is news for the user until they look at it (Activity). */
    paid?: boolean
  }): Promise<db.StoredGeneration> {
    const edit = store.getEditRow(spec.edit.id)
    if (!edit?.folder) throw new Error('The edit no longer exists.')
    await libraryOperationSettled()
    const n = store.nextVersionNumber(edit)
    const dir = editDir(edit.folder)
    const fileBase = safeName(`${edit.name} v${n} – ${fileLabel(spec.label)}`, { max: 120, fallback: `Version ${n}` })
    const path = await placeFile(spec.video, dir, fileBase, '.mp4')
    const id = randomUUID()
    let thumb: string | undefined
    try {
      const p = await probe(path)
      thumb = await extractThumbnail(path, join(thumbsDir(), `${id}.jpg`)).catch(() => undefined)
      const baseCuts = spec.base.recipe?.cuts
      const cuts =
        spec.timing === 'changed' && spec.spans
          ? mixes.remapTimes(baseCuts ?? [], spec.spans, spec.op.op === 'cut')
          : baseCuts
      const recipe: EditRecipe = {
        op: spec.op.op,
        operation: spec.op,
        baseId: spec.base.id,
        label: spec.label,
        ...(spec.costUsd !== undefined ? { costUsd: roundUsd(spec.costUsd) } : {}),
        number: n,
        timing: spec.timing,
        ...(spec.spans ? { spans: spec.spans } : {}),
        mix: spec.mix,
        ...(spec.takeId ? { takeId: spec.takeId } : {}),
        ...(cuts?.length ? { cuts } : {})
      }
      const now = Date.now()
      const row: db.StoredGeneration = {
        id,
        createdAt: now,
        source: 'edit',
        title: `${edit.name} v${n}`,
        parentId: spec.base.id,
        editId: edit.id,
        recipe,
        model: '',
        prompt: '',
        params: versionParams(p),
        status: 'completed',
        filePath: path,
        thumbPath: thumb,
        videoDuration: p.duration,
        completedAt: now,
        ...(spec.quote !== undefined && spec.quote > 0 ? { quote: roundUsd(spec.quote) } : {}),
        reviewCount: 0,
        agentReviewCount: 0
      }
      db.getDb().transaction(() => {
        db.insertGeneration(row)
        // A free render the user just asked for is looked at right away; what a paid job made may land much later.
        if (spec.paid) db.addUnseen({ generationId: id, context: { editId: edit.id } })
        const fresh = store.getEditRow(edit.id)
        // The new version becomes current when the base still is; otherwise it is a branch.
        if (fresh && (!fresh.current_generation_id || fresh.current_generation_id === spec.base.id)) {
          store.setEditCurrent(edit.id, id)
        } else store.touchEdit(edit.id)
      })()
    } catch (err) {
      await rm(path, { force: true }).catch(() => {})
      if (thumb) await rm(thumb, { force: true }).catch(() => {})
      throw err
    }
    // A timing-changing version gets its base's transcript moved along.
    if (spec.timing === 'changed' && spec.spans) {
      const t = transcriptFor(spec.base.id)
      if (t?.segments.length) {
        store.saveTranscript({
          generationId: id,
          segments: remapTranscript(t.segments, spec.spans),
          source: 'remapped',
          model: t.model,
          language: t.language
        })
      }
    }
    const g = db.getGeneration(id)!
    try {
      this.deps.generationChanged(toPublic(g))
    } catch (err) {
      console.warn('Announcing a version failed:', err)
    }
    this.notify(edit.id)
    return g
  }

  private label(op: EditOperation): string {
    let voiceName: string | undefined
    let mediaLabel: string | undefined
    if (op.op === 'speak-lines' && op.voice.kind === 'clone') {
      voiceName = store.audioClipRow(op.voice.audioId)?.asset_name
    }
    if (op.op === 'add-audio') {
      if ('mediaId' in op.source) mediaLabel = store.getMedia(op.source.mediaId)?.label
      else mediaLabel = store.audioClipRow(op.source.assetAudioId)?.asset_name
    }
    try {
      return operationLabel(op, { voiceName, mediaLabel })
    } catch {
      return op.op
    }
  }

  // ── Free renders ─────────────────────────────────────────────────────────

  private renderFree(p: Planned): Promise<string> {
    const { edit, base, info, op } = p
    const label = this.label(op)
    return this.render(edit.id, `${label}…`, async ({ signal, work, progress }) => {
      const D = info.duration
      let mix = await this.usableMix(edit, base, info)
      const out = join(work, 'version.mp4')
      switch (op.op) {
        case 'volume':
        case 'mute': {
          const range = op.range ?? { start: 0, end: D }
          mixes.addGain(mix, op.target ?? 'all', {
            start: range.start,
            end: range.end,
            ...(op.op === 'mute' ? { mute: true } : { gainDb: op.gainDb })
          })
          break
        }
        case 'denoise':
          mix.denoise = op.strength
          break
        case 'loudness':
          mix.loudness = op.lufs
          break
        case 'add-audio': {
          const media = await this.mediaForSource(edit, op.source)
          const length = op.length ?? Math.min(media.duration ?? D, D - op.at)
          mixes.addLayer(mix, {
            id: randomUUID(),
            kind: 'audio',
            mediaId: media.id,
            ...('assetAudioId' in op.source ? { assetAudioId: op.source.assetAudioId } : {}),
            label: media.label,
            at: op.at,
            offset: 0,
            length,
            gainDb: op.gainDb ?? 0,
            fadeIn: op.fadeInSeconds ?? 0,
            fadeOut: op.fadeOutSeconds ?? 0,
            duck: op.duck === true,
            loop: op.loop === true
          })
          if (op.replaceBed) mixes.addGain(mix, 'all', { start: 0, end: D, mute: true })
          break
        }
        case 'layer': {
          const layer = mix.layers.find((l) => l.id === op.layerId)
          if (!layer) throw new Error('The layer is not in this version.')
          if (op.remove) mix.layers = mix.layers.filter((l) => l.id !== op.layerId)
          else {
            if (op.gainDb !== undefined) layer.gainDb = op.gainDb
            if (op.at !== undefined) {
              layer.at = op.at
              layer.length = Math.min(layer.length, Math.max(0.05, D - op.at))
            }
          }
          break
        }
        case 'fade': {
          if (op.inSeconds) mix.fadeIn = op.inSeconds
          if (op.outSeconds) mix.fadeOut = op.outSeconds
          const wav = await this.mixToFile(mix, D, work, signal, (f) => progress(f * 0.3))
          const picture = await this.splice({
            parts: [{ path: base.filePath, start: 0, end: D }],
            out: join(work, 'picture.mp4'),
            width: info.width,
            height: info.height,
            fps: info.fps,
            ...(op.inSeconds ? { fadeIn: op.inSeconds } : {}),
            ...(op.outSeconds ? { fadeOut: op.outSeconds } : {}),
            signal,
            onProgress: (f) => progress(0.3 + f * 0.6)
          })
          await replaceAudioTrack(picture, wav, out, { signal })
          return (await this.writeVersion({ edit, base, op, label, video: out, mix, timing: 'same' })).id
        }
        case 'trim':
        case 'cut': {
          const spans: mixes.TimeSpan[] =
            op.op === 'trim'
              ? [{ from: op.keep.start, to: op.keep.end, at: 0 }]
              : [
                  ...(op.range.start > 0 ? [{ from: 0, to: op.range.start, at: 0 }] : []),
                  ...(op.range.end < D
                    ? [{ from: op.range.end, to: D, at: op.range.start > 0 ? op.range.start : 0 }]
                    : [])
                ]
          const total = spans.reduce((s, x) => s + (x.to - x.from), 0)
          const picture = await this.splice({
            parts: spans.map((s) => ({ path: base.filePath, start: s.from, end: s.to })),
            out: join(work, 'picture.mp4'),
            width: info.width,
            height: info.height,
            fps: info.fps,
            signal,
            onProgress: (f) => progress(f * 0.6)
          })
          // The sound as it was, cut the same way, becomes the new version's bed (its layers are baked in).
          const whole = await this.mixToFile(mix, D, work, signal, (f) => progress(0.6 + f * 0.2))
          let wav: string | null = null
          if (whole) {
            wav = await this.renderResolved(
              { duration: total, bed: { path: null, gains: [] }, layers: mixes.spanLayers(whole, spans, D) },
              work,
              signal,
              (f) => progress(0.8 + f * 0.1)
            )
          }
          mix = await this.bakeMix(edit, wav, `${label} – sound`)
          await replaceAudioTrack(picture, wav, out, { signal })
          return (
            await this.writeVersion({ edit, base, op, label, video: out, mix, timing: 'changed', spans })
          ).id
        }
        default:
          throw new Error('The operation cannot be done here.')
      }
      const wav = await this.mixToFile(mix, D, work, signal, (f) => progress(f * 0.8))
      await replaceAudioTrack(base.filePath, wav, out, { signal })
      return (await this.writeVersion({ edit, base, op, label, video: out, mix, timing: 'same' })).id
    }, { title: label })
  }

  /** A rendered sound stored as the edit's "bake" media, as a new mix whose bed it is (or a silent one). */
  private async bakeMix(edit: store.EditRow, wav: string | null, label: string): Promise<AudioMix> {
    if (!wav) return { bed: { source: null, gains: [] }, layers: [] }
    const flac = `${wav.replace(/\.wav$/i, '')}.flac`
    await extractAudio(wav, flac, { codec: 'flac' })
    const media = await this.addMediaFile(edit, flac, { kind: 'bake', label }, true)
    return mixes.defaultMixFromMedia(media.id)
  }

  /** The edit media an add-audio op plays: one of the edit's own, or a library clip copied into Audio/ (free). */
  private async mediaForSource(
    edit: store.EditRow,
    source: { mediaId: string } | { assetAudioId: string }
  ): Promise<store.StoredMedia> {
    if ('mediaId' in source) {
      const media = store.getMedia(source.mediaId)
      if (!media || media.editId !== edit.id || !existsSync(media.path)) {
        throw new Error('The audio is not in the edit.')
      }
      return media
    }
    const clip = store.audioClipRow(source.assetAudioId)
    if (!clip) throw new Error('The audio clip no longer exists in the library.')
    const path = fromStoredPath(clip.file_path)
    if (!existsSync(path)) throw new Error("The audio clip's file is missing.")
    return this.addMediaFile(edit, path, {
      kind: 'audio',
      label: `${clip.asset_name} – ${basename(path, extname(path))}`,
      duration: clip.duration,
      details: { assetAudioId: clip.id, assetName: clip.asset_name }
    })
  }

  // ── Audio jobs ───────────────────────────────────────────────────────────

  private async startAudioJob(p: Planned, exec: Extract<Exec, { kind: 'audio' }>): Promise<string> {
    const { edit, base, info, op, plan } = p
    if (!exec.steps.length) throw new Error('There is nothing to send.')
    this.submitting++
    try {
      // The mix the finish builds on is fixed now (a missing source becomes a bed of the base's own sound), and the
      // uploads are cut from the very same recording.
      const mix = op.op === 'transcribe' ? undefined : await this.usableMix(edit, base, info)
      const job = store.insertJob({
        editId: edit.id,
        baseId: base.id,
        op: op.op,
        request: { operation: op, label: this.label(op), finish: { ...exec.finish, ...(mix ? { mix } : {}) } },
        quote: plan.priceUsd
      })
      store.insertSteps(
        job.id,
        exec.steps.map((s) => ({ endpoint: s.endpoint, model: s.model, request: s.request, quote: s.quote }))
      )
      this.startJob(job.id, 'send')
      this.notify(edit.id)
      return job.id
    } finally {
      this.submitting--
    }
  }

  /** Starts (or joins) the job's runner. */
  private startJob(jobId: string, mode: 'send' | 'poll'): void {
    if (this.runs.has(jobId)) return
    const run: JobRun = { jobId, mode, epoch: this.epoch, failed: false, stopped: false, claimed: new Set() }
    this.runs.set(jobId, run)
    void this.drive(run)
      .catch((err: unknown) => {
        console.error(`Edit job ${jobId} stopped:`, err)
        try {
          if (db.isDbOpen() && store.getJob(jobId)?.status === 'running') {
            store.updateJob(jobId, { status: 'failed', error: errorText(err) })
          }
        } catch {
          // The library is gone; the job is picked up when it opens again.
        }
      })
      .finally(() => {
        if (this.runs.get(jobId) === run) this.runs.delete(jobId)
        this.live.delete(jobId)
        const job = db.isDbOpen() ? store.getJob(jobId) : undefined
        this.notify(job?.editId)
      })
  }

  private current(run: JobRun): boolean {
    return run.epoch === this.epoch && !run.stopped && db.isDbOpen()
  }

  /** Whether the runner may send another step. */
  private maySend(run: JobRun): boolean {
    return run.mode === 'send' && this.current(run) && !run.failed && store.getJob(run.jobId)?.status === 'running'
  }

  private async drive(run: JobRun): Promise<void> {
    const jobId = run.jobId
    // A step left 'sending' by an earlier session may have been charged: it is failed, never sent again.
    for (const s of store.listSteps(jobId)) {
      if (s.status === 'sending' && !this.inFlight.has(s.id)) {
        store.updateStep(s.id, { status: 'failed', error: LOST })
        run.failed = true
      }
    }
    const polls = store
      .listSteps(jobId)
      .filter((s) => s.status === 'queued')
      .map((s) => this.poll(run, s))
    if (run.mode === 'send' && !run.failed) {
      // A voice clone runs alone, before the lines that need its handle.
      for (const s of store.listSteps(jobId)) {
        if (s.status !== 'pending' || s.endpoint !== 'voice-clone' || !this.maySend(run)) continue
        run.claimed.add(s.id)
        await this.send(run, s)
      }
      const worker = async (): Promise<void> => {
        while (this.maySend(run)) {
          const next = store.listSteps(jobId).find((s) => s.status === 'pending' && !run.claimed.has(s.id))
          if (!next) return
          run.claimed.add(next.id)
          await this.send(run, next)
        }
      }
      await Promise.all(Array.from({ length: MAX_STEPS_IN_FLIGHT }, worker))
    }
    await Promise.all(polls)
    if (this.current(run)) await this.conclude(run)
  }

  /** After the steps: finish, or fail the job with what stands in the way. */
  private async conclude(run: JobRun): Promise<void> {
    const job = store.getJob(run.jobId)
    if (!job || job.status !== 'running') return
    const steps = store.listSteps(job.id)
    if (steps.some((s) => s.status === 'queued' || s.status === 'sending')) return
    const failed = steps.find((s) => s.status === 'failed')
    if (failed) {
      store.updateJob(job.id, { status: 'failed', error: failed.error ?? 'A part failed.' })
      this.reportDone(job, failed.error)
      return
    }
    if (steps.some((s) => s.status === 'pending' || s.status === 'cancelled')) {
      // Only a resumed job (nothing sent without a click) gets here: it waits for "Continue".
      store.updateJob(job.id, { status: 'failed', error: CLOSED })
      this.reportDone(job, CLOSED)
      return
    }
    await this.finish(job.id)
  }

  private jobDir(jobId: string): string {
    return appDataDir(APP_DATA.editJobs, jobId)
  }

  private setLive(job: store.StoredJob): void {
    const steps = store.listSteps(job.id)
    const done = steps.filter((s) => s.status === 'completed').length
    const total = steps.length
    const fraction = total ? (done / total) * 0.9 : 0
    const currentStep = total > 1 ? `part ${Math.min(done + 1, total)} of ${total}` : undefined
    this.live.set(job.id, { fraction, currentStep })
    this.report({
      editId: job.editId,
      assetId: job.assetId,
      jobId: job.id,
      fraction,
      label: `${job.request.label}${currentStep ? ` … ${currentStep}` : ' …'}`
    })
  }

  /** The upload source of a voice-changer or transcription step, as the job's finish will read it. */
  private async uploadSource(job: store.StoredJob, source: unknown): Promise<string> {
    const base = job.baseId ? db.getGeneration(job.baseId) : undefined
    if (!base?.filePath || !existsSync(base.filePath)) throw new Error(BASE_GONE)
    if (source !== 'voice') return base.filePath
    const mix = job.request.finish?.mix as AudioMix | undefined
    if (job.op === 'transcribe' || !mix) return (await mixes.stemsOf(base.filePath)).voice
    const from = await this.voiceSource(base as db.StoredGeneration & { filePath: string }, mix, true)
    if (!from) throw new Error('The film has no speech to change the voice of.')
    return from.path
  }

  /**
   * Makes a step's upload (free, local) and sends it. Everything that can fail locally (the upload, a clone handle
   * that ran out) happens before the step is marked 'sending', so such a failure leaves nothing charged.
   */
  private async send(run: JobRun, step: store.StoredStep): Promise<void> {
    const job = store.getJob(run.jobId)
    if (!job) return
    const dir = this.jobDir(job.id)
    let request: () => Promise<void>
    try {
      request = await this.prepare(job, step, dir)
    } catch (err) {
      store.updateStep(step.id, { status: 'failed', error: errorText(err) })
      run.failed = true
      return
    }
    // Stopped, cancelled or failed elsewhere while the upload was made: the step stays unsent.
    if (!this.maySend(run)) return
    // Recorded before the request: if Studio stops before the answer, the step is failed at the next start.
    store.updateStep(step.id, { status: 'sending', error: null })
    this.inFlight.add(step.id)
    this.setLive(job)
    try {
      await request()
    } catch (err) {
      // An answer (a status) means the service refused; no answer at all may mean it was charged.
      const status = statusOf(err)
      const error =
        err instanceof AfterSendError ? err.message : status === undefined ? LOST : veniceFailure(err, step.model)
      store.updateStep(step.id, { status: 'failed', error })
      run.failed = true
      return
    } finally {
      this.inFlight.delete(step.id)
    }
    this.setLive(job)
    const fresh = store.getStep(step.id)
    if (fresh?.status === 'queued') await this.poll(run, fresh)
  }

  /** The local part of a step: its upload made, its request ready to send (the returned function sends it). */
  private async prepare(job: store.StoredJob, step: store.StoredStep, dir: string): Promise<() => Promise<void>> {
    const req = step.request
    switch (step.endpoint) {
      case 'voice-changer': {
        const changer = (await this.catalog()).voiceChangers.find((m) => m.id === step.model)
        if (!changer) throw new Error(noVoiceChanger())
        const src = await this.uploadSource(job, req.source)
        const sent = join(dir, `${step.position}.sent`)
        const res = await encodeUpload(src, sent, {
          start: Number(req.start),
          end: Number(req.end),
          formats: changer.formats,
          maxBytes: VOICE_UPLOAD_MAX_BYTES
        })
        const named = join(dir, `${step.position}.sent.${res.format}`)
        if (existsSync(sent)) await rename(sent, named)
        if (!existsSync(named)) throw new Error('The audio could not be prepared.')
        store.updateStep(step.id, { request: { ...req, sentFormat: res.format } })
        const file = await readFile(named)
        const filename = `part-${step.position + 1}.${res.format}`
        return async () => {
          const out = await this.deps.audio.queueVoiceChange({
            model: step.model,
            file,
            filename,
            voice: String(req.voice),
            ...(typeof req.removeNoise === 'boolean' ? { removeNoise: req.removeNoise } : {})
          })
          store.updateStep(step.id, { status: 'queued', queueId: out.queueId })
          // Venice bills what it measured: that is quoted again (free) and recorded when it differs.
          let cost = step.quote
          if (out.durationSeconds && out.durationSeconds !== req.seconds) {
            cost = await this.deps.audio.quoteVoiceChange(step.model, out.durationSeconds).catch(() => step.quote)
            store.updateStep(step.id, {
              quote: cost ?? null,
              request: { ...req, sentFormat: res.format, billedSeconds: out.durationSeconds }
            })
          }
          store.addJobCost(job.id, cost ?? 0)
        }
      }
      case 'audio-queue': {
        const body = this.queueBody(step)
        return async () => {
          const out = await this.deps.audio.queueAudio(body)
          store.updateStep(step.id, { status: 'queued', queueId: out.queueId })
          store.addJobCost(job.id, step.quote ?? 0)
        }
      }
      case 'speech': {
        const voice = this.speechVoice(step)
        return async () => {
          const out = await this.deps.audio.speech({
            model: step.model,
            input: String(req.text),
            voice,
            format: String(req.format ?? 'mp3'),
            ...(typeof req.language === 'string' ? { language: req.language } : {}),
            ...(typeof req.style === 'string' ? { prompt: req.style } : {})
          })
          // Charged once the answer is in; saved before the step counts as done.
          store.addJobCost(job.id, step.quote ?? 0)
          await keepAnswer(join(dir, `${step.position}.${out.format}`), out.data)
          store.updateStep(step.id, { status: 'completed', request: { ...req, format: out.format } })
        }
      }
      case 'transcription': {
        const src = await this.uploadSource(job, (await this.separationAvailable()) ? 'voice' : 'mix')
        const sent = join(dir, `${step.position}.sent.mp3`)
        await extractAudio(src, sent, { rate: 16000, channels: 1, codec: 'mp3', bitrate: '64k' })
        if ((await stat(sent)).size > ASR_MAX_BYTES) {
          throw new Error('The audio is too long to transcribe in one go (at most ~24 MB).')
        }
        const file = await readFile(sent)
        return async () => {
          const out = await this.deps.audio.transcribe({
            model: step.model,
            file,
            filename: 'ljud.mp3',
            ...(typeof req.language === 'string' && req.language ? { language: req.language } : {})
          })
          store.addJobCost(job.id, step.quote ?? 0)
          await keepAnswer(join(dir, `${step.position}.json`), JSON.stringify(out))
          store.updateStep(step.id, { status: 'completed' })
        }
      }
      case 'voice-clone': {
        const clip = store.audioClipRow(String(req.audioId))
        if (!clip) throw new Error('The voice clip no longer exists in the library.')
        if (!clip.clone_consent_at) throw new Error(CONSENT_MISSING)
        const sample = join(dir, `${step.position}.sample.wav`)
        const start = Number(req.start) || 0
        await extractAudio(fromStoredPath(clip.file_path), sample, {
          start,
          end: start + (Number(req.length) || 10),
          rate: SAMPLE_RATE,
          channels: 1,
          codec: 'pcm_s16le'
        })
        const file = await readFile(sample)
        return async () => {
          const out = await this.deps.audio.cloneVoice({ model: step.model, file, filename: 'rostprov.wav' })
          const catalog = await this.catalog().catch(() => undefined)
          const days = catalog?.speech.find((m) => m.id === step.model)?.cloning?.retentionDays ?? 7
          store.insertClone({
            audio_id: clip.id,
            model: step.model,
            handle: out.handle,
            window_start: start,
            window_length: Number(req.length) || 0,
            expires_at: Date.now() + days * 24 * 3600_000
          })
          store.updateStep(step.id, { status: 'completed' })
        }
      }
      default:
        throw new Error('Unknown part of the job.')
    }
  }

  /** The voice a TTS step sends: a preset or provider id, or the clone handle of a character's clip. */
  private speechVoice(step: store.StoredStep): string {
    const voice = step.request.voice
    const audioId = cloneVoiceOf(step)
    if (audioId) {
      // Consent withdrawn after the job was planned (or before "Continue"): the line is not said in that voice. Checked
      // here, before the step is marked 'sending', so the refusal leaves nothing charged.
      if (!store.audioClipRow(audioId)?.clone_consent_at) throw new Error(CONSENT_MISSING)
      const clone = store.validClone(audioId, step.model, 60_000)
      if (!clone) throw new Error(CLONE_EXPIRED)
      return clone.handle
    }
    return String(voice ?? '')
  }

  /** /audio/queue body; optional fields only as the plan normalized them for the model. */
  private queueBody(step: store.StoredStep): Record<string, unknown> {
    const req = step.request
    const body: Record<string, unknown> = { model: step.model }
    if (req.kind === 'speech') {
      body.prompt = String(req.text)
      const voice = this.speechVoice(step)
      if (voice) body.voice = voice
      return body
    }
    if (req.kind === 'design') {
      body.prompt = String(req.prompt)
      body.voice = String(req.voice ?? DESIGN_VOICE)
      return body
    }
    body.prompt = String(req.prompt)
    if (typeof req.durationSeconds === 'number') body.duration_seconds = Math.round(req.durationSeconds)
    if (typeof req.instrumental === 'boolean') body.force_instrumental = req.instrumental
    return body
  }

  /** Polls a queued (paid) step to its audio, with the job manager's backoff. */
  private async poll(run: JobRun, step: store.StoredStep): Promise<void> {
    if (!step.queueId) {
      const error = `The job has no queue ID at ${providerName(providerOf(step.model))}.`
      store.updateStep(step.id, { status: 'failed', error })
      return
    }
    const job = store.getJob(step.jobId)
    if (!job) return
    const dir = this.jobDir(job.id)
    const voiceChanger = step.endpoint === 'voice-changer'
    let retries = 0
    for (;;) {
      if (run.epoch !== this.epoch || !db.isDbOpen()) return
      try {
        const res = voiceChanger
          ? await this.deps.audio.retrieveVoiceChange(step.model, step.queueId)
          : await this.deps.audio.retrieveAudio(step.model, step.queueId)
        if (res.state === 'processing') {
          retries = 0
          await sleep(POLL_INTERVAL_MS)
          continue
        }
        if (run.epoch !== this.epoch || !db.isDbOpen()) return
        await writeFile(join(dir, `${step.position}.${res.format}`), res.data)
        store.updateStep(step.id, { status: 'completed', request: { ...step.request, format: res.format } })
        const complete = voiceChanger
          ? this.deps.audio.completeVoiceChange(step.model, step.queueId)
          : this.deps.audio.completeAudio(step.model, step.queueId)
        void Promise.resolve(complete).catch(() => {})
        this.setLive(job)
        return
      } catch (err) {
        const status = statusOf(err)
        const unreachable = status === undefined || status >= 500 || status === 429
        const venice = status !== undefined
        const transient = unreachable || !venice
        if (transient && ++retries <= (unreachable ? MAX_UNREACHABLE_RETRIES : MAX_RETRIES)) {
          await sleep(Math.min(POLL_INTERVAL_MS * retries, MAX_RETRY_DELAY_MS))
          continue
        }
        store.updateStep(step.id, { status: 'failed', error: veniceFailure(err, step.model) })
        run.failed = true
        return
      }
    }
  }

  // ── Finishing audio jobs ─────────────────────────────────────────────────

  private finish(jobId: string): Promise<void> {
    if (this.finishing.has(jobId)) return Promise.resolve()
    this.finishing.add(jobId)
    const job = store.getJob(jobId)!
    const label = job.request.label
    return this.render(
      job.editId,
      `${label} … finishing`,
      async (ctx) => {
        try {
          await this.finishJob(jobId, ctx)
          store.updateJob(jobId, { status: 'completed', error: null })
          await rm(this.jobDir(jobId), { recursive: true, force: true }).catch(() => {})
        } catch (err) {
          if (db.isDbOpen() && store.getJob(jobId)) store.updateJob(jobId, { status: 'failed', error: errorText(err) })
          throw err
        }
      },
      { jobId, assetId: job.assetId }
    )
      .catch((err: unknown) => console.warn(`Finishing edit job ${jobId} failed:`, err))
      .finally(() => {
        this.finishing.delete(jobId)
        this.notify(job.editId)
      })
  }

  private async finishJob(
    jobId: string,
    ctx: { signal: AbortSignal; work: string; progress: (f: number) => void }
  ): Promise<void> {
    const job = store.getJob(jobId)
    if (!job) throw new Error('The job no longer exists.')
    const steps = store.listSteps(jobId)
    const dir = this.jobDir(jobId)
    const output = (s: store.StoredStep): string => {
      const format = typeof s.request.format === 'string' ? s.request.format : 'mp3'
      const path = join(dir, `${s.position}.${format}`)
      if (!existsSync(path)) throw new Error('A fetched sound is missing. Do the operation again.')
      return path
    }

    if (job.op === 'design-voice') {
      const req = job.request.voiceDesign
      const step = steps[0]
      if (!req || !step) throw new Error('The job is incomplete.')
      await addGeneratedAudio(req.assetId, output(step), `Designed voice ${dayStamp(new Date())}`)
      this.deps.libraryChanged?.()
      return
    }

    const edit = job.editId ? store.getEditRow(job.editId) : undefined
    if (!edit) throw new Error('The edit no longer exists.')
    const base = job.baseId ? db.getGeneration(job.baseId) : undefined
    if (!base?.filePath || !existsSync(base.filePath)) throw new Error(BASE_GONE)
    const fullBase = base as db.StoredGeneration & { filePath: string }
    const info = await this.baseInfo(base.filePath)
    const D = info.duration
    const op = job.request.operation
    if (!op) throw new Error('The job is incomplete.')
    const fin = job.request.finish ?? {}
    const mix = mixes.cloneMix(
      (fin.mix as AudioMix | undefined) ?? mixes.mixOf(base, base.id === edit.origin_generation_id)
    )
    const label = job.request.label
    const { signal, work, progress } = ctx

    if (op.op === 'transcribe') {
      const step = steps[0]
      const raw = JSON.parse(await readFile(join(dir, `${step.position}.json`), 'utf8')) as {
        language?: string
        words?: { text: string; start: number; end: number }[]
        segments?: { text: string; start: number; end: number }[]
      }
      let segments: TranscriptSegment[] = raw.words?.length
        ? segmentsFromWords(raw.words)
        : segmentsFromTimed(raw.segments ?? [])
      try {
        const src = (await this.separationAvailable()) ? (await mixes.stemsOf(base.filePath)).voice : base.filePath
        segments = snapSegments(segments, speechRegions(await silences(src), D))
      } catch (err) {
        console.warn('Snapping the transcript to the speech failed:', err)
      }
      store.saveTranscript({
        generationId: base.id,
        segments,
        source: 'venice',
        model: step.model,
        language: raw.language ?? (op.language || undefined),
        cost: store.getJob(jobId)?.cost
      })
      this.notify(edit.id)
      return
    }

    const quote = store.getJob(jobId)?.cost ?? 0
    const out = join(work, 'version.mp4')

    if (op.op === 'change-voice') {
      const scopes = (fin.scopes as EditRange[]) ?? [{ start: 0, end: D }]
      const scopeStart = Number(fin.scopeStart) || 0
      const scopeEnd = Number(fin.scopeEnd) || D
      const total = Math.round((scopeEnd - scopeStart) * SAMPLE_RATE)
      const chunks: { path: string; startSample: number }[] = []
      for (const s of steps.filter((x) => x.endpoint === 'voice-changer')) {
        const start = Number(s.request.start)
        const end = Number(s.request.end)
        const returned = output(s)
        const sentFormat = typeof s.request.sentFormat === 'string' ? s.request.sentFormat : undefined
        const sent = sentFormat ? join(dir, `${s.position}.sent.${sentFormat}`) : undefined
        const offset = sent && existsSync(sent) ? await estimateOffsetSamples(sent, returned) : 0
        const aligned = join(work, `${s.position}.aligned.wav`)
        // Chunks cut inside speech overlap their neighbour: they crossfade over the overlap instead of a 10 ms edge.
        await alignTo(returned, offset, Math.round((end - start) * SAMPLE_RATE), aligned, {
          ...(typeof s.request.fadeIn === 'number' ? { fadeIn: s.request.fadeIn } : {}),
          ...(typeof s.request.fadeOut === 'number' ? { fadeOut: s.request.fadeOut } : {}),
          signal
        })
        chunks.push({ path: aligned, startSample: Math.round((start - scopeStart) * SAMPLE_RATE) })
      }
      progress(0.2)
      const assembled = join(work, 'converted.wav')
      await assembleAt(chunks, total, assembled)
      const voiceName = op.voice.kind === 'preset' ? op.voice.voice : op.voice.voiceId
      const background = op.background
      // Only the chosen stretches of the converted sound are used. A part may run across the gap between two chosen
      // lines (one billed minute instead of two), and whoever speaks in that gap must not be heard a second time in
      // the new voice: each stretch is laid in on its own, with short ramps, and nothing between them.
      const convertedLayers = (at0: number): ResolvedMix['layers'] =>
        scopes.map((s, i) => ({
          id: `converted-${i}`,
          kind: 'voice',
          label: '',
          path: assembled,
          at: s.start - at0,
          offset: s.start - scopeStart,
          length: s.end - s.start,
          gainDb: 0,
          fadeIn: mixes.GAIN_FADE,
          fadeOut: mixes.GAIN_FADE,
          duck: false,
          loop: false
        }))
      if (fin.source === 'voice') {
        // The converted voice replaces the voice stem in the scope; outside it the original voice stays.
        mixes.ensureStems(mix)
        const original = await this.voiceSource(fullBase, mix, true)
        const whole = scopes.length === 1 && scopeStart <= 1e-3 && scopeEnd >= D - 1e-3
        let voiceTrack = assembled
        if (!whole) {
          const rendered = await this.renderResolved(
            {
              duration: D,
              bed: {
                path: original?.path ?? null,
                gains: scopes.map((s) => ({ start: s.start, end: s.end, mute: true, fade: mixes.GAIN_FADE }))
              },
              layers: convertedLayers(0)
            },
            work,
            signal
          )
          if (rendered) voiceTrack = rendered
        }
        const flac = join(work, 'voice.flac')
        await extractAudio(voiceTrack, flac, { codec: 'flac' })
        const media = await this.addMediaFile(edit, flac, {
          kind: 'voice',
          label: `Voice – ${voiceName}`,
          model: steps[0]?.model,
          cost: quote,
          details: { voice: voiceName }
        }, true)
        mix.bed.stems!.voice = { kind: 'media', id: media.id }
        if (background !== 'keep') {
          for (const s of scopes) {
            mixes.addGain(mix, 'background', {
              start: s.start,
              end: s.end,
              ...(background === 'remove' ? { mute: true } : { gainDb: mixes.DUCK_DB })
            })
          }
        }
      } else {
        // Without separation the whole mix was converted: it goes on top, the original under it ducked or removed.
        // Several chosen lines: the converted sound is first cut to them (silence between), as one track.
        const gated =
          scopes.length > 1
            ? await this.renderResolved(
                { duration: scopeEnd - scopeStart, bed: { path: null, gains: [] }, layers: convertedLayers(scopeStart) },
                work,
                signal
              )
            : assembled
        const flac = join(work, 'voice.flac')
        await extractAudio(gated ?? assembled, flac, { codec: 'flac' })
        const media = await this.addMediaFile(edit, flac, {
          kind: 'voice',
          label: `Voice – ${voiceName}`,
          model: steps[0]?.model,
          cost: quote,
          details: { voice: voiceName }
        }, true)
        mixes.addLayer(mix, {
          id: randomUUID(),
          kind: 'voice',
          mediaId: media.id,
          label: `Voice – ${voiceName}`,
          at: scopeStart,
          offset: 0,
          length: scopeEnd - scopeStart,
          gainDb: 0,
          fadeIn: mixes.GAIN_FADE,
          fadeOut: mixes.GAIN_FADE,
          duck: false,
          loop: false
        })
        for (const s of scopes) {
          mixes.addGain(mix, 'all', {
            start: s.start,
            end: s.end,
            ...(background === 'remove' ? { mute: true } : { gainDb: mixes.DUCK_DB })
          })
        }
      }
      progress(0.5)
      const wav = await this.mixToFile(mix, D, work, signal, (f) => progress(0.5 + f * 0.4))
      await replaceAudioTrack(base.filePath, wav, out, { signal })
      const g = await this.writeVersion({
        edit,
        base,
        op,
        label,
        video: out,
        mix,
        timing: 'same',
        quote,
        costUsd: quote,
        paid: true
      })
      store.updateJob(jobId, { resultId: g.id })
      return
    }

    if (op.op === 'speak-lines') {
      const slots = (fin.lines ?? []) as {
        index: number
        text: string
        start: number
        end: number
        limit: number
        replace: boolean
      }[]
      const separation = fin.separation === true
      const voiceRef = separation ? await this.voiceSource(fullBase, mix, true).catch(() => undefined) : undefined
      const loudnessSource = voiceRef?.path ?? base.filePath
      let filmLufs: number | undefined
      const lineSteps = steps.filter((s) => s.endpoint === 'speech' || s.endpoint === 'audio-queue')
      const voiceName =
        op.voice.kind === 'preset'
          ? op.voice.voice
          : op.voice.kind === 'custom'
            ? op.voice.voiceId
            : (store.audioClipRow(op.voice.audioId)?.asset_name ?? 'cloned voice')
      for (const [i, s] of lineSteps.entries()) {
        const slot = slots.find((x) => x.index === Number(s.request.line))
        if (!slot) continue
        let file = output(s)
        let length = (await probeAudio(file)).duration
        if (op.fit === 'tempo' && slot.replace) {
          const fitted = fitLine(length, Math.max(0.1, slot.limit - slot.start), MAX_TEMPO)
          if (fitted.tempo > 1.001) {
            const stretched = join(work, `${s.position}.fit.wav`)
            await timeStretch(file, stretched, fitted.tempo)
            file = stretched
            length = (await probeAudio(file)).duration
          }
        }
        // Level: the original line's loudness (or the film's speech for a new line), within ±12 dB.
        let gainDb = 0
        try {
          const tts = (await loudness(file)).lufs
          let target: number | undefined
          if (slot.replace) target = (await loudness(loudnessSource, { start: slot.start, end: slot.end })).lufs
          else {
            filmLufs ??= (await loudness(loudnessSource)).lufs
            target = filmLufs
          }
          if (Number.isFinite(tts) && target !== undefined && Number.isFinite(target)) {
            gainDb = round(Math.max(-12, Math.min(12, target - tts)), 10)
          }
        } catch (err) {
          console.warn('Measuring a line failed:', err)
        }
        const media = await this.addMediaFile(edit, file, {
          kind: 'speech',
          label: `Line ${slot.index + 1} – ${excerpt(slot.text, 40)}`,
          model: s.model,
          cost: s.quote,
          duration: length,
          details: { text: slot.text, voice: voiceName }
        })
        mixes.addLayer(mix, {
          id: randomUUID(),
          kind: 'speech',
          mediaId: media.id,
          ...(op.voice.kind === 'clone' ? { assetAudioId: op.voice.audioId } : {}),
          label: `Line ${slot.index + 1}: ${excerpt(slot.text, 30)}`,
          at: slot.start,
          offset: 0,
          length: Math.min(length, Math.max(0.05, D - slot.start)),
          gainDb,
          fadeIn: 0.01,
          fadeOut: 0.01,
          duck: !slot.replace,
          loop: false
        })
        if (slot.replace) {
          const span = { start: Math.max(0, slot.start - LINE_PAD), end: Math.min(D, slot.end + LINE_PAD) }
          if (op.background === 'keep') mixes.addGain(mix, 'voice', { ...span, mute: true })
          else {
            const change = op.background === 'remove' ? { mute: true } : { gainDb: mixes.DUCK_DB }
            mixes.addGain(mix, 'all', { ...span, ...change })
          }
        }
        progress(((i + 1) / lineSteps.length) * 0.5)
      }
      const wav = await this.mixToFile(mix, D, work, signal, (f) => progress(0.5 + f * 0.4))
      await replaceAudioTrack(base.filePath, wav, out, { signal })
      const g = await this.writeVersion({
        edit,
        base,
        op,
        label,
        video: out,
        mix,
        timing: 'same',
        quote,
        costUsd: quote,
        paid: true
      })
      store.updateJob(jobId, { resultId: g.id })
      return
    }

    if (op.op === 'music' || op.op === 'effect') {
      const step = steps[0]
      const file = output(step)
      const duration = (await probeAudio(file)).duration
      const at = Number(fin.at) || 0
      const length = Math.max(0.05, Math.min(Number(fin.length) || duration, duration, D - at))
      const fade = op.op === 'music' ? Math.min(Number(fin.fade) || 0, length / 2) : Math.min(0.01, length / 4)
      const media = await this.addMediaFile(edit, file, {
        kind: op.op,
        label: `${op.op === 'music' ? 'Music' : 'Effect'} – ${excerpt(op.prompt, 40)}`,
        model: step.model,
        cost: quote,
        duration,
        details: { prompt: op.prompt }
      })
      mixes.addLayer(mix, {
        id: randomUUID(),
        kind: op.op,
        mediaId: media.id,
        label: `${op.op === 'music' ? 'Music' : 'Effect'}: ${excerpt(op.prompt, 30)}`,
        at,
        offset: 0,
        length,
        gainDb: op.gainDb ?? 0,
        fadeIn: fade,
        fadeOut: fade,
        duck: op.op === 'music' ? fin.duck !== false : false,
        loop: false
      })
      const wav = await this.mixToFile(mix, D, work, signal, (f) => progress(f * 0.8))
      await replaceAudioTrack(base.filePath, wav, out, { signal })
      const g = await this.writeVersion({
        edit,
        base,
        op,
        label,
        video: out,
        mix,
        timing: 'same',
        quote,
        costUsd: quote,
        paid: true
      })
      store.updateJob(jobId, { resultId: g.id })
      return
    }

    throw new Error('Unknown operation.')
  }

  // ── Cancel and "Continue" ────────────────────────────────────────────────

  cancel(jobId: unknown): void {
    const job = store.requireJob(jobId)
    if (job.status !== 'running') return
    if (isPictureOp(job.op)) throw new Error('The take has already been sent and cannot be cancelled.')
    db.getDb().transaction(() => {
      store.cancelPendingSteps(job.id)
      store.updateJob(job.id, { status: 'cancelled', error: null })
    })()
    // The runner sees the status and sends nothing more; parts already at the service are fetched and kept.
    this.reportDone(job, 'Cancelled.')
    this.notify(job.editId)
  }

  /**
   * What "Continue" would send again now, priced afresh (each step's quote – the stored one when Venice's fails right
   * now – undefined for one Venice doesn't price): the price is what the priced parts cost, undefined when none of
   * them can be priced; `unknown` when a part has no price.
   */
  private async resumePrice(
    job: store.StoredJob
  ): Promise<{ steps: store.StoredStep[]; quotes: (number | undefined)[]; price?: number; unknown: boolean }> {
    const steps = store.listSteps(job.id).filter(isUnsent)
    const quotes: (number | undefined)[] = []
    let price = 0
    let unknown = false
    for (const s of steps) {
      // A quote that fails right now keeps the one the step has: it is what the part costs as far as anyone knows, and
      // what the job's cost adds when the part is sent (null would count it as free).
      const q = (await this.requote(s).catch(() => undefined)) ?? s.quote
      quotes.push(q)
      if (q === undefined) unknown = true
      else price += q
    }
    return { steps, quotes, price: steps.length && unknown && price === 0 ? undefined : roundUsd(price), unknown }
  }

  private async requote(s: store.StoredStep): Promise<number | undefined> {
    const req = s.request
    switch (s.endpoint) {
      case 'voice-changer':
        return this.deps.audio.quoteVoiceChange(s.model, Number(req.seconds) || 1)
      case 'audio-queue':
        if (req.kind === 'speech') {
          return this.deps.audio.quoteAudio({ model: s.model, characterCount: Array.from(String(req.text)).length })
        }
        return this.deps.audio.quoteAudio({
          model: s.model,
          ...(typeof req.durationSeconds === 'number' ? { durationSeconds: req.durationSeconds } : {})
        })
      case 'speech': {
        const m = (await this.catalog()).speech.find((x) => x.id === s.model)
        return m?.usdPerThousandChars !== undefined
          ? speechPriceUsd(Array.from(String(req.text)).length, m.usdPerThousandChars)
          : undefined
      }
      case 'transcription': {
        const m = (await this.catalog()).transcription.find((x) => x.id === s.model)
        return m ? (Number(req.seconds) || 0) * m.usdPerSecond : undefined
      }
      default:
        return undefined
    }
  }

  async resume(
    jobId: unknown,
    expectedPriceUsd?: unknown,
    expectedPartial?: unknown,
    opts?: { confirmOverBudget?: unknown }
  ): Promise<EditJob> {
    const job = store.requireJob(jobId)
    if (job.status === 'running' || this.runs.has(job.id) || this.finishing.has(job.id)) {
      throw new Error('The job is already running.')
    }
    if (job.status === 'completed') throw new Error('The job is already done.')
    if (job.editId) {
      const base = job.baseId ? db.getGeneration(job.baseId) : undefined
      if (!base?.filePath || !existsSync(base.filePath)) throw new Error(BASE_GONE)
    }
    if (isPictureOp(job.op)) {
      // Nothing is sent again: a take that is paid for and still here is only put into the film once more (free).
      if (!this.pictureRefinishable(job)) throw new Error('A picture operation cannot be continued – do it again instead.')
      store.updateJob(job.id, { status: 'running', error: null })
      this.finishPicture(job.id)
      this.notify(job.editId)
      return this.jobView(store.getJob(job.id)!)
    }
    // A voice the user no longer lets be cloned says nothing more, however the job got here.
    for (const s of store.listSteps(job.id)) {
      const audioId = cloneVoiceOf(s)
      if (audioId && isUnsent(s) && !store.audioClipRow(audioId)?.clone_consent_at) throw new Error(CONSENT_MISSING)
    }
    // A clone handle that has run out is made again inside this job (the user clicked Continue): its clone step is
    // sent again, or — for a job planned while an earlier handle was still valid, which has no clone step — one is
    // added. Without it every line would fail on the expired handle again, however often Continue is clicked.
    const steps = store.listSteps(job.id)
    const cloned = new Map<string, string>()
    for (const s of steps) {
      const voice = s.request.voice
      if (s.endpoint === 'voice-clone' || !isUnsent(s) || !voice || typeof voice !== 'object') continue
      const audioId = (voice as { clone?: unknown }).clone
      if (typeof audioId === 'string') cloned.set(audioId, s.model)
    }
    for (const [audioId, model] of cloned) {
      if (store.validClone(audioId, model)) continue
      const own = steps.find((x) => x.endpoint === 'voice-clone' && String(x.request.audioId) === audioId)
      if (own) {
        // A failed, pending or cancelled clone step is sent again anyway.
        if (own.status === 'completed') store.updateStep(own.id, { status: 'pending', error: null })
        continue
      }
      const clip = store.audioClipRow(audioId)
      if (!clip) throw new Error('The voice clip no longer exists in the library.')
      const speechModel = (await this.catalog().catch(() => undefined))?.speech.find((m) => m.id === model)
      const min = speechModel?.cloning?.minSampleSeconds ?? 5
      store.appendStep(job.id, { endpoint: 'voice-clone', model, request: { audioId, ...cloneWindow(clip, min) } })
    }
    const { steps: again, quotes, price, unknown } = await this.resumePrice(job)
    // Fresh quotes for what is sent again: what the job's cost adds when each is sent, and what the button shows
    // next (so a price that rose is the one the user sees and confirms on the next click, not the old one again).
    const keepQuotes = (): void => again.forEach((s, i) => store.updateStep(s.id, { quote: quotes[i] ?? null }))
    if (again.length) {
      if (typeof expectedPriceUsd !== 'number' || !Number.isFinite(expectedPriceUsd)) throw new Error(CONFIRM_PRICE)
      // A part without a price that came in after the button showed a full one (a clone handle that ran out since)
      // goes back to the button too, which then asks the extra question.
      if ((price !== undefined && price > expectedPriceUsd + 0.01) || (expectedPartial === false && unknown)) {
        keepQuotes()
        this.notify(job.editId)
        throw new Error(PRICE_CHANGED)
      }
      // What is sent again counts against the budget like a new job: refused with OVER_BUDGET unless confirmed.
      assertWithinBudget(price, { confirmed: opts?.confirmOverBudget === true })
    }
    db.getDb().transaction(() => {
      for (const s of again) {
        store.updateStep(s.id, { status: 'pending', error: null, queueId: null })
      }
      store.updateJob(job.id, { status: 'running', error: null })
      keepQuotes()
    })()
    runConfirmed(() => this.startJob(job.id, 'send'))
    this.notify(job.editId)
    return this.jobView(store.getJob(job.id)!)
  }

  // ── Job views ────────────────────────────────────────────────────────────

  jobView(job: store.StoredJob): EditJob {
    const steps = store.listSteps(job.id)
    const picture = isPictureOp(job.op)
    const take = job.takeId ? db.getGeneration(job.takeId) : undefined
    const live = this.live.get(job.id)
    const done = picture ? (take?.status === 'completed' ? 1 : 0) : steps.filter((s) => s.status === 'completed').length
    const total = picture ? 1 : steps.length
    const resumable = picture ? [] : steps.filter(isUnsent)
    const baseOk = !job.editId || (!!job.baseId && !!db.getGeneration(job.baseId)?.filePath)
    const canResume =
      (job.status === 'failed' || job.status === 'cancelled') &&
      !this.runs.has(job.id) &&
      !this.finishing.has(job.id) &&
      baseOk &&
      (!picture || this.pictureRefinishable(job))
    // What the priced parts cost (as resume checks it); a part Venice doesn't price (a voice clone) makes it partial,
    // and with no priced part at all it is unknown. Nothing left to send (only the finish failed) is free.
    const known = resumable.map((s) => s.quote).filter((q): q is number => typeof q === 'number')
    const resumePriceUsd = !canResume
      ? undefined
      : !resumable.length
        ? 0
        : known.length
          ? roundUsd(known.reduce((sum, q) => sum + q, 0))
          : undefined
    // A clone handle that has run out is made again by Continue (resume adds or reopens its clone step): unpriced too.
    const cloneAgain = resumable.some((s) => {
      const audioId = s.endpoint === 'voice-clone' ? undefined : cloneVoiceOf(s)
      return (
        !!audioId &&
        // fal's clone is a free upload: making it again changes no price.
        providerOf(s.model) !== 'fal' &&
        !store.validClone(audioId, s.model) &&
        !resumable.some((x) => x.endpoint === 'voice-clone' && x.request.audioId === audioId)
      )
    })
    const resumePartialPrice =
      canResume && known.length > 0 && (known.length < resumable.length || cloneAgain)
    // Said only when every part left out is a voice clone; a part whose quote failed gets the dialog's generic words.
    const clonesOnly = resumable.every((s) => typeof s.quote === 'number' || s.endpoint === 'voice-clone')
    let currentStep = live?.currentStep
    if (picture && job.status === 'running') {
      currentStep = this.finishing.has(job.id)
        ? 'putting the take in'
        : take?.status === 'processing'
          ? `${serviceOf(take?.model)} is making the take`
          : `queued at ${serviceOf(take?.model)}`
    }
    return {
      id: job.id,
      op: job.op as EditJob['op'],
      label: job.request.label,
      status: job.status,
      ...(job.baseId ? { baseId: job.baseId } : {}),
      ...(live?.fraction !== undefined && job.status === 'running' ? { fraction: live.fraction } : {}),
      stepsDone: done,
      stepsTotal: total,
      ...(currentStep && job.status === 'running' ? { currentStep } : {}),
      costUsd: picture ? (take?.quote ?? 0) : roundUsd(job.cost),
      ...(job.quote !== undefined ? { quoteUsd: job.quote } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.takeId ? { takeId: job.takeId } : {}),
      ...(job.resultId ? { resultId: job.resultId } : {}),
      canCancel: !picture && job.status === 'running' && steps.some((s) => s.status === 'pending'),
      canResume,
      ...(resumePriceUsd !== undefined ? { resumePriceUsd } : {}),
      ...(resumePartialPrice ? { resumePartialPrice: true } : {}),
      ...(resumePartialPrice && clonesOnly ? { resumePriceNote: 'The voice cloning has no price in advance.' } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }
  }

  /** Whether a job of this edit is running (or finishing) in this session or waits at Venice. */
  editRunning(editId: string): boolean {
    return store.listJobs(editId).some((j) => j.status === 'running')
  }

  // ── Picture operations: submit, settle, finish ───────────────────────────

  private async runPicture(p: Planned, exec: Extract<Exec, { kind: 'picture' }>): Promise<EditRunResult> {
    const { edit, base, op, plan } = p
    const spec = exec.spec
    this.submitting++
    const placed: string[] = []
    const jobId = randomUUID()
    this.submittingJobs.add(jobId)
    try {
      await libraryOperationSettled()
      const fresh = store.getEditRow(edit.id)
      if (!fresh?.folder) throw new Error('The edit no longer exists.')
      const dir = editDir(fresh.folder, 'inputs')
      const now = new Date()
      const stamp = `${dayStamp(now)} ${timeStamp(now)}`
      const params: GenerationParams = { ...spec.params }
      const copyIn = async (src: string, name: string, ext: string): Promise<string> => {
        const tmp = join(tmpDir(), `${randomUUID()}${ext}`)
        await copyFile(src, tmp)
        const path = await placeFile(tmp, dir, `${stamp} ${name}`, ext)
        placed.push(path)
        return path
      }
      if (spec.frames?.start) params.startImage = await copyIn(spec.frames.start, 'startbild', '.png')
      if (spec.frames?.end) params.endImage = await copyIn(spec.frames.end, 'slutbild', '.png')
      if (spec.sendBase) {
        const ext = extname(base.filePath).toLowerCase() || '.mp4'
        const path = await cloneInto(base.filePath, dir, `${stamp} underlag`, ext)
        placed.push(path)
        params.sourceVideo = path
      } else if (spec.proxy) {
        const tmp = join(tmpDir(), `${randomUUID()}.mp4`)
        try {
          await makeProxy(base.filePath, tmp, {
            start: spec.proxy.start,
            end: spec.proxy.end,
            // Room is left for the pictures sent with it (prompt-edit's images to start from).
            maxBytes: spec.proxy.maxBytes ?? MAX_REQUEST_MEDIA_BYTES,
            maxHeight: spec.proxy.maxHeight,
            audio: spec.proxy.audio
          })
          const path = await placeFile(tmp, dir, `${stamp} underlag`, '.mp4')
          placed.push(path)
          if (op.op === 'prompt-edit' && supportsReferenceVideos(params.model)) params.referenceVideos = [{ path }]
          else params.sourceVideo = path
        } finally {
          await rm(tmp, { force: true }).catch(() => {})
        }
      }
      store.insertJob({
        id: jobId,
        editId: edit.id,
        baseId: base.id,
        op: op.op,
        request: { operation: op, label: this.label(op), finish: exec.finish },
        quote: plan.priceUsd
      })
      let take: Generation
      try {
        take = await this.deps.jobs.submit(params, { quote: plan.priceUsd, editId: edit.id })
      } catch (err) {
        // Nothing was paid: the job and what was made for it go. NEEDS_CONSENT reaches the caller unchanged.
        store.deleteJob(jobId)
        await Promise.all(placed.map((f) => rm(f, { force: true }).catch(() => {})))
        throw err
      }
      store.updateJob(jobId, { takeId: take.id })
      this.submittingJobs.delete(jobId)
      // A take that settled before its id was recorded is handled now.
      const now2 = db.getGeneration(take.id)
      if (now2 && (now2.status === 'completed' || now2.status === 'failed')) this.onTakeSettled(now2)
      this.notify(edit.id)
      return { jobId, takeId: take.id }
    } finally {
      this.submittingJobs.delete(jobId)
      this.submitting--
    }
  }

  private onTakeSettled(g: db.StoredGeneration): void {
    try {
      if (this.stopped || !db.isDbOpen()) return
      const job = store.jobForTake(g.id)
      if (!job || job.status !== 'running') return
      if (g.status === 'failed') {
        store.updateJob(job.id, { status: 'failed', error: `The take failed: ${g.error ?? 'unknown error'}` })
        this.report({ editId: job.editId, jobId: job.id, label: job.request.label, done: true, error: g.error })
        this.notify(job.editId)
        return
      }
      if (g.status === 'completed') this.finishPicture(job.id)
    } catch (err) {
      console.error('Handling a finished edit take failed:', err)
    }
  }

  /**
   * A picture job whose finish failed (a full disk, a file that couldn't be written) can be finished again for free:
   * its take is paid for, done and still here, and the version it works on is too.
   */
  private pictureRefinishable(job: store.StoredJob): boolean {
    if (!isPictureOp(job.op) || job.status !== 'failed' || !job.editId || !job.request.operation) return false
    // Failed for a reason another try can't change (the take came back the wrong length, or can't be read).
    if (job.request.noRefinish) return false
    const take = job.takeId ? db.getGeneration(job.takeId) : undefined
    if (take?.status !== 'completed' || !take.filePath || !existsSync(take.filePath)) return false
    const base = job.baseId ? db.getGeneration(job.baseId) : undefined
    return !!base?.filePath && existsSync(base.filePath)
  }

  private resumePicture(job: store.StoredJob): void {
    let takeId = job.takeId
    if (!takeId && job.editId && !this.submittingJobs.has(job.id)) {
      // Studio stopped between Venice accepting the take and the job recording it.
      const found = db
        .getDb()
        .prepare(
          `SELECT id FROM generations WHERE edit_id = ? AND source = 'generated' AND created_at >= ?
             AND id NOT IN (SELECT take_generation_id FROM media_jobs WHERE take_generation_id IS NOT NULL)
           ORDER BY created_at LIMIT 1`
        )
        .pluck()
        .get(job.editId, job.createdAt) as string | undefined
      if (found) {
        store.updateJob(job.id, { takeId: found })
        takeId = found
      }
    }
    if (!takeId) {
      store.updateJob(job.id, { status: 'failed', error: 'Studio was closed before the take was sent.' })
      this.notify(job.editId)
      return
    }
    const take = db.getGeneration(takeId)
    if (!take) {
      store.updateJob(job.id, { status: 'failed', error: 'The take was deleted before it was done.' })
      this.notify(job.editId)
      return
    }
    if (take.status === 'completed' || take.status === 'failed') this.onTakeSettled(take)
    // Otherwise the job manager polls it and its 'settled' event finishes the job.
  }

  private finishPicture(jobId: string): void {
    if (this.finishing.has(jobId)) return
    this.finishing.add(jobId)
    const job = store.getJob(jobId)!
    void this.render(
      job.editId,
      `${job.request.label} … putting the take in`,
      async (ctx) => {
        try {
          const g = await this.finishPictureJob(jobId, ctx)
          store.updateJob(jobId, { status: 'completed', error: null, resultId: g.id })
        } catch (err) {
          const stored = db.isDbOpen() ? store.getJob(jobId) : undefined
          if (stored) {
            store.updateJob(jobId, {
              status: 'failed',
              error: errorText(err),
              // No free "Continue" for what would fail the same way again: the row can then be hidden.
              ...(err instanceof FinishRefused ? { request: { ...stored.request, noRefinish: true } } : {})
            })
          }
          throw err
        }
      },
      { jobId }
    )
      .catch((err: unknown) => console.warn(`Finishing edit job ${jobId} failed:`, err))
      .finally(() => {
        this.finishing.delete(jobId)
        this.notify(job.editId)
      })
  }

  private async finishPictureJob(
    jobId: string,
    ctx: { signal: AbortSignal; work: string; progress: (f: number) => void }
  ): Promise<db.StoredGeneration> {
    const { signal, work, progress } = ctx
    const job = store.getJob(jobId)
    if (!job?.editId) throw new Error('The job no longer exists.')
    const edit = store.getEditRow(job.editId)
    if (!edit) throw new Error('The edit no longer exists.')
    const base = job.baseId ? db.getGeneration(job.baseId) : undefined
    if (!base?.filePath || !existsSync(base.filePath)) throw new Error(BASE_GONE)
    const fullBase = base as db.StoredGeneration & { filePath: string }
    const take = job.takeId ? db.getGeneration(job.takeId) : undefined
    if (!take?.filePath || !existsSync(take.filePath)) throw new Error("The take's video file is missing.")
    const op = job.request.operation
    if (!op) throw new FinishRefused('The job is incomplete.')
    const info = await this.baseInfo(base.filePath)
    const t = await probe(take.filePath).catch((err: unknown) => {
      throw new FinishRefused(`The take's video file cannot be read (${errorText(err)}). Do the operation again.`)
    })
    const D = info.duration
    const L = t.duration
    const tf = 1 / (t.fps > 0 ? t.fps : info.fps)
    const label = job.request.label
    const out = join(work, 'version.mp4')
    const spliced = join(work, 'picture.mp4')
    // Every version a picture job makes: its paid take, what it cost, and that it is news (paid).
    const pictureVersion = { edit, base, op, label, takeId: take.id, costUsd: take.quote, paid: true }

    const refuseScale = (span: number, target: number): void => {
      if (target <= 0 || Math.abs(span / target - 1) > TIME_SCALE_TOLERANCE) {
        throw new FinishRefused(
          `The take came out ${fmtSeconds(span)} but the section is ${fmtSeconds(target)} – too big a difference to ` +
            'fit in. Do the operation again.'
        )
      }
    }

    // The sound of the base as it is (its mix rendered, or its own track when the mix can't be rebuilt).
    const baseSound = async (): Promise<{ wav: string | null; mix: AudioMix }> => {
      const mix = mixes.mixOf(base, base.id === edit.origin_generation_id)
      if (mixes.mixIsComplete(mix)) return { wav: await this.mixToFile(mix, D, work, signal), mix }
      if (!info.hasAudio) return { wav: null, mix: { bed: { source: null, gains: [] }, layers: [] } }
      const wav = join(work, 'base.wav')
      await extractAudio(fullBase.filePath, wav, { rate: SAMPLE_RATE, channels: 2, codec: 'pcm_f32le' })
      return { wav, mix: await this.usableMix(edit, fullBase, info) }
    }
    const takeSound = async (start: number, end: number, target: number): Promise<string | null> => {
      if (!t.hasAudio) return null
      const raw = join(work, 'take.wav')
      await extractAudio(take.filePath!, raw, { start, end, rate: SAMPLE_RATE, channels: 2, codec: 'pcm_f32le' })
      const tempo = (end - start) / target
      if (Math.abs(tempo - 1) < 0.002) return raw
      const fitted = join(work, 'take.fit.wav')
      await timeStretch(raw, fitted, tempo)
      return fitted
    }

    if (op.op === 'upscale') {
      refuseScale(L, D)
      const { wav, mix } = await baseSound()
      if (Math.abs(L - D) <= 1.5 * tf) {
        // The take as Venice made it (a Topaz HEVC output is kept as is): only the sound is put back.
        await replaceAudioTrack(take.filePath, wav, out, { signal })
      } else {
        const picture = await this.splice({
          parts: [{ path: take.filePath, start: 0, end: L, fitTo: D }],
          out: spliced,
          width: t.width,
          height: t.height,
          fps: info.fps,
          signal,
          onProgress: (f) => progress(f * 0.8)
        })
        await replaceAudioTrack(picture, wav, out, { signal })
      }
      return this.writeVersion({ ...pictureVersion, video: out, mix, timing: 'same' })
    }

    if (op.op === 'extend') {
      const from = Math.min(tf, L / 2)
      const picture = await this.splice({
        parts: [
          { path: base.filePath, start: 0, end: D },
          { path: take.filePath, start: from, end: L }
        ],
        out: spliced,
        width: info.width,
        height: info.height,
        fps: info.fps,
        signal,
        onProgress: (f) => progress(f * 0.7)
      })
      const added = L - from
      const total = D + added
      const { wav: baseWav } = await baseSound()
      const takeWav = op.audio === 'model' ? await takeSound(from, L, added) : null
      const wav = await this.renderResolved(
        {
          duration: total,
          bed: { path: baseWav, gains: [] },
          layers: takeWav
            ? [
                {
                  id: 'take',
                  kind: 'audio',
                  label: '',
                  path: takeWav,
                  at: D,
                  offset: 0,
                  length: added,
                  gainDb: 0,
                  fadeIn: mixes.GAIN_FADE,
                  fadeOut: 0,
                  duck: false,
                  loop: false
                }
              ]
            : []
        },
        work,
        signal
      )
      const mix = await this.bakeMix(edit, wav, `${label} – sound`)
      await replaceAudioTrack(picture, wav, out, { signal })
      return this.writeVersion({
        ...pictureVersion,
        video: out,
        mix,
        timing: 'changed',
        spans: [{ from: 0, to: D, at: 0 }]
      })
    }

    if (op.op !== 'regenerate' && op.op !== 'prompt-edit' && op.op !== 'lip-sync') {
      throw new FinishRefused('Unknown picture operation.')
    }
    const { start: a, end: b } = op.range
    const target = b - a
    // A regenerated range drops the take's first frame (the start image, already shown) and its last (the end image).
    const takeStart = op.op === 'regenerate' && a > tf / 2 ? Math.min(tf, L / 2) : 0
    const takeEnd = op.op === 'regenerate' && b < D - tf / 2 ? Math.max(takeStart + tf, L - tf) : L
    refuseScale(takeEnd - takeStart, target)
    const parts = [
      ...(a > 1e-3 ? [{ path: base.filePath, start: 0, end: a }] : []),
      { path: take.filePath, start: takeStart, end: takeEnd, fitTo: target },
      ...(b < D - 1e-3 ? [{ path: base.filePath, start: b, end: D }] : [])
    ]
    const picture = await this.splice({
      parts,
      out: spliced,
      width: info.width,
      height: info.height,
      fps: info.fps,
      signal,
      onProgress: (f) => progress(f * 0.7)
    })
    const { wav: baseWav, mix: baseMix } = await baseSound()
    // Lip sync changes the mouths only: the film's sound is the sound they now follow.
    if (op.op === 'lip-sync' || op.audio === 'keep') {
      await replaceAudioTrack(picture, baseWav, out, { signal })
      return this.writeVersion({ ...pictureVersion, video: out, mix: baseMix, timing: 'same' })
    }
    // The model's sound replaces the range's: the base's sound is baked with the take's laid in.
    const takeWav = await takeSound(takeStart, takeEnd, target)
    const wav = await this.renderResolved(
      {
        duration: D,
        bed: { path: baseWav, gains: [{ start: a, end: b, mute: true, fade: mixes.GAIN_FADE }] },
        layers: takeWav
          ? [
              {
                id: 'take',
                kind: 'audio',
                label: '',
                path: takeWav,
                at: a,
                offset: 0,
                length: target,
                gainDb: 0,
                fadeIn: mixes.GAIN_FADE,
                fadeOut: mixes.GAIN_FADE,
                duck: false,
                loop: false
              }
            ]
          : []
      },
      work,
      signal
    )
    const mix = await this.bakeMix(edit, wav, `${label} – sound`)
    await replaceAudioTrack(picture, wav, out, { signal })
    return this.writeVersion({ ...pictureVersion, video: out, mix, timing: 'same' })
  }

  /** A take of a running job was deleted (from the feed): the job can't finish. */
  takeDeleted(): void {
    for (const job of store.listJobsWithStatus('running')) {
      if (!isPictureOp(job.op) || job.takeId || this.submittingJobs.has(job.id) || this.finishing.has(job.id)) continue
      store.updateJob(job.id, { status: 'failed', error: 'The take was deleted before it was done.' })
      this.notify(job.editId)
    }
  }

  // ── Voice design ─────────────────────────────────────────────────────────

  async planVoiceDesign(raw: unknown): Promise<EditPlan> {
    return (await this.planVoiceDesignDetailed(raw)).plan
  }

  private async planVoiceDesignDetailed(raw: unknown): Promise<{ plan: EditPlan; prompt: string; model: string }> {
    const d = new Draft()
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceDesignRequest>
    const assetId = typeof req.assetId === 'string' ? req.assetId : ''
    const asset = assetId
      ? (db.getDb().prepare('SELECT id, name, kind FROM assets WHERE id = ?').get(assetId) as
          | { id: string; name: string; kind: string }
          | undefined)
      : undefined
    if (!asset) d.problem('The character no longer exists.')
    else if (asset.kind !== 'character') d.problem('Only characters have a voice.')
    const description = str(req.description, 2000)
    const sampleText = str(req.sampleText, 2000)
    if (!description) d.problem('Describe the voice.')
    if (!sampleText) d.problem('Write a sample text.')
    const catalog = await this.catalogOrProblem(d)
    const wanted = str(req.model, 200) || serviceDefaults().voiceDesign
    const model = catalog?.voiceDesign.find((m) => m.id === wanted)
    if (catalog && !model) d.problem(`${activeServiceName()} doesn't offer voice design right now.`)
    const prompt = designPrompt(description, sampleText)
    if (model && Array.from(prompt).length > model.maxCharacters) {
      d.problem(`The description and sample text may be at most ${model.maxCharacters} characters together.`)
    }
    const usd = model ? await this.deps.audio.quoteAudio({ model: model.id }).catch(() => undefined) : undefined
    d.addPrice(usd)
    d.steps.push({ label: 'Design voice', priceUsd: usd })
    if (asset) d.note(`The voice is added as a new voice clip of ${asset.name}.`)
    d.warn(
      `${serviceOf(model?.id)} doesn't say how the description and sample text should be written – listen to the result before you use it.`
    )
    const plan: EditPlan = {
      // Voice design is no operation on a film: the plan's operation names it, for whoever reads plans generically.
      operation: { op: 'design-voice' } as unknown as EditOperation,
      baseId: '',
      paid: true,
      ...d.price(),
      steps: d.steps,
      notes: d.notes,
      warnings: d.warnings,
      problems: d.problems,
      fingerprint: sha1({ assetId, model: wanted, prompt })
    }
    return { plan, prompt, model: wanted }
  }

  async designVoice(
    raw: unknown,
    expectedPriceUsd?: unknown,
    opts?: { confirmOverBudget?: unknown }
  ): Promise<EditJob> {
    const { plan, prompt, model } = await this.planVoiceDesignDetailed(raw)
    if (plan.problems.length) throw new Error(plan.problems[0])
    if (typeof expectedPriceUsd !== 'number' || !Number.isFinite(expectedPriceUsd)) throw new Error(CONFIRM_PRICE)
    if (plan.priceUsd !== undefined && plan.priceUsd > expectedPriceUsd + 0.01) throw new Error(PRICE_CHANGED)
    // Refused with OVER_BUDGET before anything is sent when it would take the spending past the budget.
    assertWithinBudget(plan.priceUsd, { confirmed: opts?.confirmOverBudget === true })
    const req = raw as VoiceDesignRequest
    const name =
      (db.getDb().prepare('SELECT name FROM assets WHERE id = ?').pluck().get(req.assetId) as string | undefined) ?? ''
    const design: VoiceDesignRequest = {
      assetId: req.assetId,
      description: str(req.description, 2000),
      sampleText: str(req.sampleText, 2000),
      model
    }
    const job = store.insertJob({
      assetId: req.assetId,
      op: 'design-voice',
      request: { voiceDesign: design, label: `Designing a voice for ${name}` },
      quote: plan.priceUsd
    })
    store.insertSteps(job.id, [
      {
        endpoint: 'audio-queue',
        model,
        request: { kind: 'design', prompt, voice: DESIGN_VOICE },
        quote: plan.priceUsd
      }
    ])
    runConfirmed(() => this.startJob(job.id, 'send'))
    return this.jobView(store.getJob(job.id)!)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A step "Continue" sends again: never sent, failed, or cancelled. */
/**
 * A picture job's finish failed for a reason another try can't change (the take is the wrong length, unreadable, or
 * the job incomplete): Continue (a free re-finish) isn't offered for it.
 */
class FinishRefused extends Error {}

function isUnsent(s: store.StoredStep): boolean {
  return s.status === 'pending' || s.status === 'failed' || s.status === 'cancelled'
}

/** The character's voice clip a step clones or speaks with (a voice-clone step, or a line in a cloned voice). */
function cloneVoiceOf(s: store.StoredStep): string | undefined {
  if (s.endpoint === 'voice-clone') return typeof s.request.audioId === 'string' ? s.request.audioId : undefined
  const voice = s.request.voice
  const clone = voice && typeof voice === 'object' ? (voice as { clone?: unknown }).clone : undefined
  return typeof clone === 'string' ? clone : undefined
}

export function isPictureOp(op: string): boolean {
  return op === 'regenerate' || op === 'prompt-edit' || op === 'extend' || op === 'upscale' || op === 'lip-sync'
}

/** Overlapping or touching ranges merged, in order. */
export function mergeRanges(ranges: EditRange[]): EditRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: EditRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1e-3) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out.map((r) => ({ start: round(r.start), end: round(r.end) }))
}

/** The part of a character's clip a clone is made from: its reference window, widened to at least `min` seconds. */
export function cloneWindow(
  clip: Pick<store.AudioClipRow, 'duration' | 'clip_start' | 'clip_length'>,
  min: number
): { start: number; length: number } {
  const total = clip.duration
  const length = Math.min(total, Math.max(min, clip.clip_length ?? Math.min(total, 10)))
  let start = Math.max(0, clip.clip_start)
  if (start + length > total) start = Math.max(0, total - length)
  return { start: round(start), length: round(length) }
}
