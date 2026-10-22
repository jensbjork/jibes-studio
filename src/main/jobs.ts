import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paramsForSubmit, referenceVideosOf, videosAreReferences } from '@shared/models'
import {
  composeOptionsFor,
  composePrompt,
  continuationLeadIn,
  knowsPromptLimit,
  promptLimitOf,
  rememberPromptLimits
} from '@shared/prompt-compose'
import { withDirection } from '@shared/direction'
import { generationTitle } from '@shared/generation-label'
import { sanitizeOutfitWearers } from '@shared/outfits'
import { blockingPromptError, canonicalizeParams } from '@shared/prompt-refs'
import { isGenerateOrigin } from '@shared/session'
import {
  NEEDS_CONSENT,
  type ComposedPrompt,
  type ConsentRequest,
  type Generation,
  type GenerationParams,
  type VideoModel
} from '@shared/types'
import { describedAssetsFor } from './assets'
import * as db from './db'
import { libraryDirector } from './directors'
import { extractThumbnail, ffmpegStatus, probe } from './ffmpeg'
import {
  dayStamp,
  EDIT_FOLDERS,
  ensureLibraryDir,
  FOLDERS,
  KIND_FOLDERS,
  libraryRoot,
  promptExcerpt,
  safeName,
  sequenceKindOf,
  thumbsDir,
  timeStamp,
  tmpDir
} from './paths'
import { resolveReferenceVideos } from './reference-videos'
import { importExternalReferences, placeFile } from './references'
import { noteCarriedOver } from './session'
import { getAcceptedConsents, getPromptLanguage } from './settings'
import {
  buildRequestBody,
  download,
  ensureImagesExist,
  NetworkError,
  resolveReferenceAudios,
  VeniceClient,
  VeniceError
} from './venice'

const POLL_INTERVAL_MS = 5000
/** Longest pause between polls while Venice can't be reached. */
const MAX_RETRY_DELAY_MS = 60_000
/**
 * Failed polls in a row while Venice can't be reached (network errors, 5xx) before a job is given up: with
 * the backoff above, a bit over an hour of outage. Giving up abandons a video that is already paid for and
 * still waiting at Venice, so a dropped Wi-Fi mid-render must not do it. Counted in attempts rather than
 * wall-clock time, so a Mac that slept through a render doesn't give up on its first failed poll after waking.
 */
const MAX_UNREACHABLE_RETRIES = 70
/** Other unexpected errors (e.g. the video couldn't be saved) get a few quick retries; each re-downloads it. */
const MAX_RETRIES = 5
/** How long a submit waits for the model list (for the model's prompt limit) before it composes without one. */
const MODELS_TIMEOUT_MS = 5000
/** A list that didn't know the model (or couldn't be had) is asked again at most this often. */
const MODELS_RECHECK_MS = 10 * 60_000

function consentRequest(body: unknown): ConsentRequest | undefined {
  const b = body as {
    error?: { code?: string }
    consent_flow?: string
    consent?: { consent_version?: string; policy_text?: string }
  }
  if (b?.error?.code !== 'needs_consent' || !b.consent_flow) return undefined
  return { flow: b.consent_flow, version: b.consent?.consent_version ?? '', policyText: b.consent?.policy_text ?? '' }
}

/** Drops fields the renderer shouldn't see (the pre-signed download URL). */
export function toPublic({ downloadUrl: _, ...g }: db.StoredGeneration): Generation {
  return g
}

function isSettled(g: db.StoredGeneration): boolean {
  return g.status === 'completed' || g.status === 'failed'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The instruction in front of the prompt of a sequence clip that continues in reference mode, whose previous clip's
 * last frame is sent as @Image{frameToken} (continuationLeadIn, in the user's prompt language); '' without a frame.
 */
export function continuationLeadInFor(frameToken: number | undefined): string {
  return frameToken ? continuationLeadIn(frameToken, getPromptLanguage()) : ''
}

/**
 * The prompt as a submission of these params sends it (composePrompt): the user's prompt with the References legend
 * of the referenced assets' descriptions appended – the descriptions as the database has them right now, the
 * params' own switches (includeDescriptions, excludedDescriptionAssetIds), the user's prompt language – and kept
 * within the model's prompt limit: `characterLimit` when given, else the one remembered from the model list.
 * `continuationFrame`: a sequence clip continuing in reference mode, whose last reference image (@Image{n}) is the
 * previous clip's last frame; the instruction to start on it goes in front of the prompt (continuationLeadInFor).
 * Tokens are canonicalised first, as they are sent. A director (params.director) directs the params first, as a
 * submission sends them (withDirection: its style frames and videos among the references), and its Direction section
 * follows the legend, the director as the library has it right now. Synchronous, so a check (an approval's) can
 * compare it on the very database state a submit reads. Needs an open library.
 */
export function composeSubmission(
  params: GenerationParams,
  opts: { characterLimit?: number; continuationFrame?: number } = {}
): ComposedPrompt {
  const director = libraryDirector(params.director)
  const p = canonicalizeParams(withDirection(params, director, { continuationFrame: !!opts.continuationFrame }))
  const limit = opts.characterLimit ?? promptLimitOf(p.model)
  const leadIn = continuationLeadInFor(opts.continuationFrame)
  return composePrompt(p, describedAssetsFor(paramsForSubmit(p)), {
    ...composeOptionsFor(p, getPromptLanguage(), limit),
    ...(leadIn ? { leadIn } : {}),
    ...(director ? { director } : {})
  })
}

/**
 * Refuses a prompt that can't be sent as composed. The legend's tokens are valid by construction and
 * its texts carry no "@", so this only says again what the user's prompt said; it runs anyway, on exactly the
 * text Venice gets, so nothing that would spoil a paid generation can slip in with a description.
 */
function checkComposed(params: GenerationParams, composed: Pick<ComposedPrompt, 'prompt'>): void {
  if (composed.prompt === params.prompt) return
  const problem = blockingPromptError({ ...params, prompt: composed.prompt })
  if (problem) throw new Error(problem)
}

/** The params with their "worn by" choices as stored (sanitizeOutfitWearers): kept with the generation for "Use again". */
function withCleanWearers(params: GenerationParams): GenerationParams {
  const { outfitWearers, ...rest } = params
  const wearers = sanitizeOutfitWearers(outfitWearers)
  return wearers ? { ...rest, outfitWearers: wearers } : rest
}

/**
 * The params exactly as a paid submission sends them, or a refusal: a director (params.director) directs them first
 * (withDirection: its avoid in the negative prompt, its style frames and videos after the references – none after a
 * continuation's frame, which stays the last picture), then the prompt's @ImageN, @AudioN and @VideoN
 * references are checked against what the caller has (so a token past the model's limit is reported as such),
 * tokens are canonicalised, inputs the model doesn't use are dropped (paramsForSubmit), the prompt as composed with
 * the descriptions legend (composeSubmission) is checked too, and every reference audio clip and reference video is
 * measured and its window filled in, so that a clip shorter than 2 s, clips longer than 15 s together, a file that is
 * no video, or videos past their family's 15 s (Seedance 2.0) or 30 s (2.5) — which Venice would refuse after the
 * upload — are refused here. The returned params keep the user's prompt: the legend is composed again, from the
 * descriptions as they are then, when the job is sent. Nothing is copied or sent. JobManager.submit runs it on every
 * submission; callers that quote first (a sequence take) run it before the quote too.
 */
export async function prepareSubmission(params: GenerationParams): Promise<GenerationParams> {
  // Directed as it is sent: idempotent, so params a sequence take (or an earlier call) directed already stay as they are.
  const directed = withDirection(params, libraryDirector(params.director))
  const problem = blockingPromptError(directed)
  if (problem) throw new Error(problem)
  const checked = withCleanWearers(paramsForSubmit(canonicalizeParams(directed)))
  checkComposed(checked, composeSubmission(checked))
  const videos = videosAreReferences(checked) ? referenceVideosOf(checked).length : 0
  if (!checked.referenceAudios?.length && !videos) return checked
  // "The clip no longer exists" says more than ffprobe failing to open it.
  ensureImagesExist(checked)
  const measured = await resolveReferenceVideos(await resolveReferenceAudios(checked))
  const late = blockingPromptError(measured)
  if (late) throw new Error(late)
  return measured
}

/**
 * The folder (and kind) of the sequence or storyboard a segment belongs to; undefined if the segment is gone or
 * it has no folder.
 */
function sequenceFolderOf(segmentId: string): { folder: string; kind: string } | undefined {
  const row = db
    .getDb()
    .prepare('SELECT s.folder, s.kind FROM segments seg JOIN sequences s ON s.id = seg.sequence_id WHERE seg.id = ?')
    .get(segmentId) as { folder: string | null; kind: string } | undefined
  return row?.folder ? { folder: row.folder, kind: row.kind } : undefined
}

/** The folder of an edit (Edits/<folder>), if the edit still exists and has a usable folder name. */
function editFolderOf(editId: string): string | undefined {
  const row = db.getDb().prepare('SELECT folder FROM edits WHERE id = ?').get(editId) as
    | { folder: string | null }
    | undefined
  return isPlainFolderName(row?.folder) ? row.folder : undefined
}

/** A folder name from the database that stays inside its parent. */
function isPlainFolderName(name: string | null | undefined): name is string {
  return typeof name === 'string' && !!name && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
}

/** What videoLocation reads of a generation. Rows from before own clips existed have no source: Venice's. */
export type LocatedGeneration = Pick<Generation, 'createdAt' | 'prompt' | 'segmentId'> &
  Partial<Pick<Generation, 'source' | 'title' | 'editId' | 'originalPath'>>

/** An import's or a version's file name (without extension): its title, made safe for Finder. */
function titleBase(g: LocatedGeneration): string {
  // A name on disk (Tidy up compares it): kept as it has always been.
  const fallback = g.source === 'edit' ? 'Version' : 'Eget klipp'
  return safeName(typeof g.title === 'string' ? g.title : '', { max: 120, fallback })
}

/**
 * Where a generation's video belongs and what it is called (without its extension), by the file home rule:
 * - an import with an edit (an export cloned in as an edit's v1) and an edit version: Edits/<edit>/<title>;
 * - any other import: Own clips/<day it was imported>/<title>, also when it is a take of a sequence clip (an
 *   import with a working copy is "<title> (working copy)", its untouched original sits next to it as "<title>");
 * - an AI take made in the Editor: Edits/<edit>/Takes/"<YYYY-MM-DD HH.MM> <prompt>";
 * - anything else (and a version whose edit is gone): a take goes into its sequence's Takes folder (a storyboard
 *   transition's into the storyboard's Transitions) as "<YYYY-MM-DD HH.MM> <name>", anything else into
 *   Generations/<day>/ as "<HH.MM> <name>", where the name is the prompt, or the title of a row without one.
 * Times are when the generation was submitted (or imported). Pure: nothing is created (videoLocation creates the
 * folder). The single source of truth for where files go: the job manager, sequence moves, "Tidy up" and the edit
 * service all ask it.
 */
export function videoHome(g: LocatedGeneration): { dir: string; base: string } {
  const root = libraryRoot()
  const created = new Date(g.createdAt)
  const source = g.source ?? 'generated'
  const editFolder = g.editId ? editFolderOf(g.editId) : undefined
  if (editFolder && (source === 'import' || source === 'edit')) {
    return { dir: join(root, FOLDERS.edits, editFolder), base: titleBase(g) }
  }
  if (source === 'import') {
    const base = titleBase(g)
    return {
      dir: join(root, FOLDERS.ownClips, dayStamp(created)),
      base: g.originalPath ? `${base} (working copy)` : base
    }
  }
  if (editFolder && source === 'generated') {
    return {
      dir: join(root, FOLDERS.edits, editFolder, EDIT_FOLDERS.takes),
      base: `${dayStamp(created)} ${timeStamp(created)} ${promptExcerpt(g.prompt)}`
    }
  }
  // generationTitle names a version without a prompt by its title, so it never becomes "… Utan prompt".
  const excerpt = promptExcerpt(source === 'generated' ? g.prompt : generationTitle({ ...g, source }))
  const owner = g.segmentId ? sequenceFolderOf(g.segmentId) : undefined
  if (owner && isPlainFolderName(owner.folder)) {
    const layout = KIND_FOLDERS[sequenceKindOf(owner.kind)]
    return {
      dir: join(root, layout.parent, owner.folder, layout.takes),
      base: `${dayStamp(created)} ${timeStamp(created)} ${excerpt}`
    }
  }
  return { dir: join(root, FOLDERS.generations, dayStamp(created)), base: `${timeStamp(created)} ${excerpt}` }
}

/** videoHome, with its folder created. */
export function videoLocation(g: LocatedGeneration): { dir: string; base: string } {
  const home = videoHome(g)
  ensureLibraryDir(home.dir)
  return home
}

/**
 * Where an import's untouched original belongs when it has a working copy: next to the working copy, named after
 * the title (the working copy is "<title> (working copy)"). Undefined for rows without an original. Pure.
 */
export function originalHome(g: LocatedGeneration): { dir: string; base: string } | undefined {
  if (!g.originalPath) return undefined
  return { dir: videoHome(g).dir, base: titleBase(g) }
}

/** originalHome, with its folder created. */
export function originalLocation(g: LocatedGeneration): { dir: string; base: string } | undefined {
  const home = originalHome(g)
  if (home) ensureLibraryDir(home.dir)
  return home
}

interface JobEvents {
  /** Any change to a generation (created, progress, completed, failed, poster added). */
  update: [Generation]
  /** Exactly once per generation: completed (duration and poster already stored) or failed. */
  settled: [db.StoredGeneration]
  /**
   * A submit started or ended its way to Venice (see sending()). Nothing is broadcast while a submit uploads, so the
   * status summary (work.ts) listens here to show it.
   */
  sending: []
}

/** A submit on its way to Venice: from its first check until Venice answered and the row was written (or it failed). */
export interface SendingSubmit {
  token: string
  startedAt: number
  segmentId?: string
  editId?: string
  prompt: string
  model: string
}

/** How many of a model's latest finished generations its typical duration is measured over. */
const TYPICAL_SAMPLE = 20
/** How long a model's typical duration is kept before it is measured again. */
const TYPICAL_TTL_MS = 10 * 60_000

/** The middle value (the mean of the two middle ones for an even count); undefined for none. */
export function median(values: readonly number[]): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (!sorted.length) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export interface SubmitOptions {
  /** USD, as quoted before submitting. */
  quote?: number
  /** Makes the generation a take of this sequence segment. */
  segmentId?: string
  /**
   * Makes the generation an AI take of this edit (the Editor): its video goes into the edit's Takes folder. An
   * edit deleted while the job was queued leaves an ordinary generation, as for a segment.
   */
  editId?: string
  /**
   * The prompt to send, composed by the caller from these params (composeSubmission) when it read them: a sequence
   * take composes it together with the reads its approval's check runs on, and an agent's approved form request
   * passes the text the user approved, so each sends exactly what was checked however long the frames, the quote
   * and the upload take. Checked like a prompt composed here; one that doesn't start with the params' prompt (after
   * the continuation's instruction, with `continuationFrame`) is ignored. Default: composed when the job is sent.
   */
  sentPrompt?: string
  /**
   * A sequence clip continuing in reference mode: its last reference image is the previous clip's last frame,
   * @Image{continuationFrame}, and the prompt sent starts with the instruction to begin on it (composeSubmission).
   */
  continuationFrame?: number
}

type MediaInfo = Pick<db.StoredGeneration, 'videoDuration' | 'thumbPath'>

interface Waiter {
  resolve: (g: db.StoredGeneration) => void
  reject: (err: Error) => void
}

export class JobManager extends EventEmitter<JobEvents> {
  private readonly polling = new Set<string>()
  private readonly waiters = new Map<string, Waiter[]>()
  /** Submits between their first await and the row being written (copying images, uploading to Venice). */
  private submitting = 0
  /**
   * The submits behind `submitting` that got as far as submit() itself, with what they send, by a token of their own:
   * what the status panel shows while a take uploads. `submitting` stays the busy count (holdSubmit bumps it before
   * any params exist, and hasActiveJobs relies on it); this map only describes.
   */
  private readonly sendingNow = new Map<string, Omit<SendingSubmit, 'token'>>()
  /** Each model's typical time from submit to saved video (see typicalMs), with when it was measured. */
  private readonly typical = new Map<string, { at: number; ms: number | undefined }>()
  /** Bumped by every resume() (a library opened) and pauseBackfill(); an older backfill loop then stops. */
  private epoch = 0
  /** The backfill's current poster/duration step, which writes into the library that was open when it began. */
  private backfillStep: Promise<unknown> | undefined
  /** When the model list was last asked for a model's prompt limit (see promptLimit). */
  private limitsCheckedAt = 0

  /**
   * `models`: the video model list as main caches it, for the models' prompt limits; without it the list is
   * fetched from Venice (GET /models, free) when a submit needs a limit it doesn't know yet.
   */
  constructor(
    private readonly venice: VeniceClient,
    private readonly models?: () => Promise<VideoModel[]>
  ) {
    super()
  }

  /**
   * Picks up jobs that were still running when the library was last closed, then fills in missing posters.
   * Called again after switching libraries.
   */
  resume(): void {
    const epoch = ++this.epoch
    // Typical durations are the open library's; another library measures its own.
    this.typical.clear()
    const pending = db.listPendingGenerations()
    // Generate's list keeps these once they settle (shared/session.ts): they were on their way when the session began.
    noteCarriedOver(pending.filter(isGenerateOrigin).map((g) => g.id))
    for (const g of pending) this.track(g)
    void this.backfill(epoch).catch((err: unknown) => console.warn('Media backfill stopped:', err))
  }

  /**
   * True while any generation is queued or processing (in this library or still being polled), or a submit
   * is on its way to Venice. The library folder must not be switched or moved then: the finished video
   * would be saved into the wrong library, or a pending job would be left behind in the old one.
   */
  hasActiveJobs(): boolean {
    if (this.submitting > 0) return true
    // Without an open library (its folder vanished) polling stops at the next tick and the jobs stay pending
    // in that library's database; they mustn't keep Studio from opening a library meanwhile.
    if (!db.isDbOpen()) return false
    return this.polling.size > 0 || db.listPendingGenerations().length > 0
  }

  /**
   * Sends a paid generation. Every submission passes here (the Generate view, a segment's take, "generate
   * all", an agent's approved request), so this is where the prompt's @ImageN and @AudioN references and the
   * reference audio windows are checked against what is actually sent (prepareSubmission): a wrong one would
   * spend money on a video made from the wrong picture or voice, or none.
   */
  async submit(params: GenerationParams, opts: SubmitOptions = {}): Promise<Generation> {
    // The prompt is checked at once, before anything is copied or sent; measuring audio clips takes a moment.
    const problem = blockingPromptError(params)
    if (problem) throw new Error(problem)
    this.submitting++
    const token = randomUUID()
    this.sendingNow.set(token, {
      startedAt: Date.now(),
      ...(opts.segmentId ? { segmentId: opts.segmentId } : {}),
      ...(opts.editId ? { editId: opts.editId } : {}),
      prompt: params.prompt,
      model: params.model
    })
    this.safeEmit('sending')
    try {
      // Before the files are read: the model list may take a moment, and paths are only followed from there on.
      // A caller that composed the prompt itself (a sequence take) already had the limit.
      const limit = opts.sentPrompt === undefined ? await this.promptLimit(params.model) : undefined
      return await this.queue(await prepareSubmission(params), opts, limit)
    } finally {
      this.submitting--
      this.sendingNow.delete(token)
      this.safeEmit('sending')
    }
  }

  /** The submits on their way to Venice right now (copying pictures, measuring audio, uploading), oldest first. */
  sending(): SendingSubmit[] {
    return [...this.sendingNow].map(([token, s]) => ({ token, ...s }))
  }

  /**
   * How long a video of this model usually takes from submit to saved file, in milliseconds: the median over its
   * latest finished Venice generations in the open library (measured again after ten minutes). Undefined when it has
   * none yet or no library is open. Shown for a video still queued at Venice ("brukar ta ~3 min").
   */
  typicalMs(model: string): number | undefined {
    if (typeof model !== 'string' || !model || !db.isDbOpen()) return undefined
    const cached = this.typical.get(model)
    const now = Date.now()
    if (cached && now - cached.at < TYPICAL_TTL_MS) return cached.ms
    let ms: number | undefined
    try {
      const durations = db
        .getDb()
        .prepare(
          `SELECT completed_at - created_at FROM generations
           WHERE model = ? AND source = 'generated' AND status = 'completed' AND completed_at IS NOT NULL
           ORDER BY completed_at DESC LIMIT ?`
        )
        .pluck()
        .all(model, TYPICAL_SAMPLE) as number[]
      ms = median(durations)
    } catch (err) {
      console.warn('Could not measure how long a model usually takes:', err)
    }
    this.typical.set(model, { at: now, ms })
    return ms
  }

  /**
   * The model's prompt limit, for composing what is sent: from the remembered model list, which is fetched when
   * it doesn't know the model (at most every MODELS_RECHECK_MS). When the list can't be had in time the prompt is
   * composed without a limit, as before limits were known.
   */
  private async promptLimit(model: string): Promise<number | undefined> {
    if (!knowsPromptLimit(model) && Date.now() - this.limitsCheckedAt > MODELS_RECHECK_MS) {
      this.limitsCheckedAt = Date.now()
      const load = this.models ?? (() => this.venice.listVideoModels())
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), MODELS_TIMEOUT_MS)
      })
      try {
        const models = await Promise.race([load().catch(() => undefined), timeout])
        if (models) rememberPromptLimits(models)
      } finally {
        clearTimeout(timer)
      }
    }
    return promptLimitOf(model)
  }

  /**
   * Counts a submit as on its way before submit() itself is called, e.g. while its price is quoted: a
   * library switch must not close the database under it. Call the returned function when done.
   */
  holdSubmit(): () => void {
    this.submitting++
    let held = true
    return () => {
      if (held) this.submitting--
      held = false
    }
  }

  /**
   * Stops the poster backfill and waits for the ffmpeg step it is in. Its output path was decided under the
   * library that is about to be closed for a switch, and a poster written there after a move would bring
   * the old folder back. resume() starts it again.
   */
  async pauseBackfill(): Promise<void> {
    this.epoch++
    await this.backfillStep?.catch(() => {})
  }

  private async queue(params: GenerationParams, opts: SubmitOptions, limit: number | undefined): Promise<Generation> {
    // Without an open library the job could be paid for and then not recorded anywhere; this throws
    // "Choose a library folder first." before anything is sent.
    db.getDb()
    // A clear "the start image no longer exists" beats a failed copy.
    ensureImagesExist(params)
    // The upload below can take seconds; an asset renamed meanwhile (or "Tidy up") moves its pictures,
    // and the row written afterwards must point at where they are now (db.followRewrites).
    const mark = db.rewriteMark()
    // What Venice gets: the prompt with the descriptions of the referenced assets as the library has them now
    // (asset files are inside the library, so the copying below never changes the paths they are found by). The
    // row keeps the user's prompt in `prompt` and `params`, and this one as sentPrompt.
    const given = opts.sentPrompt
    const own = params.prompt.trimEnd()
    // A continuation in reference mode sends its instruction in front of the prompt.
    const frame = opts.continuationFrame
    const leadIn = continuationLeadInFor(frame)
    const head = leadIn && own ? `${leadIn}\n\n${own}` : own
    const composed =
      typeof given === 'string' && (given === params.prompt || (head !== '' && given.startsWith(head)))
        ? { prompt: given }
        : composeSubmission(params, { characterLimit: limit, ...(frame ? { continuationFrame: frame } : {}) })
    checkComposed(params, composed)
    // Outside images, audio and reference videos are copied into Reference images first, so the stored params point at
    // the copies.
    params = await importExternalReferences(params)
    const body = await buildRequestBody({ ...params, prompt: composed.prompt })
    if (params.model.includes('seedance') && getAcceptedConsents().seedance) {
      body.consents = {
        seedance: {
          confirmed_terms_and_privacy: true,
          confirmed_legal_right: true,
          confirmed_screening_acknowledged: true
        }
      }
    }
    let res: Awaited<ReturnType<VeniceClient['queue']>>
    try {
      res = await this.venice.queue(body)
    } catch (err) {
      const consent = err instanceof VeniceError && err.status === 409 ? consentRequest(err.body) : undefined
      if (consent) throw new Error(NEEDS_CONSENT + JSON.stringify(consent))
      throw err
    }
    const g: db.StoredGeneration = {
      id: randomUUID(),
      createdAt: Date.now(),
      source: 'generated',
      model: params.model,
      prompt: params.prompt,
      sentPrompt: composed.prompt,
      params: db.followRewrites(params, mark),
      status: 'queued',
      queueId: res.queue_id,
      downloadUrl: res.download_url,
      quote: opts.quote,
      segmentId: opts.segmentId,
      editId: opts.editId,
      reviewCount: 0,
      agentReviewCount: 0
    }
    try {
      db.insertGeneration(g)
    } catch (err) {
      // The segment (or the edit) was deleted while the job was being queued. The job is already paid for, so
      // keep it in the feed rather than lose track of it.
      if ((!g.segmentId && !g.editId) || (err as { code?: string }).code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw err
      const conn = db.getDb()
      if (g.segmentId && !conn.prepare('SELECT 1 FROM segments WHERE id = ?').get(g.segmentId)) g.segmentId = undefined
      if (g.editId && !conn.prepare('SELECT 1 FROM edits WHERE id = ?').get(g.editId)) g.editId = undefined
      db.insertGeneration(g)
    }
    this.safeEmit('update', toPublic(g))
    this.poll(g.id)
    return toPublic(g)
  }

  /** Resolves once the generation is completed or failed (immediately if it already is). */
  waitFor(id: string): Promise<db.StoredGeneration> {
    const g = db.getGeneration(id)
    if (!g) return Promise.reject(new Error('The generation does not exist.'))
    if (isSettled(g)) return Promise.resolve(g)
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(id) ?? []
      list.push({ resolve, reject })
      this.waiters.set(id, list)
      // Normally already polling; this covers a pending job that resume() hasn't reached.
      this.track(g)
    })
  }

  /** Starts polling a pending generation, or fails it if it never reached Venice. */
  private track(g: db.StoredGeneration): void {
    if (this.polling.has(g.id)) return
    if (g.queueId) this.poll(g.id)
    else this.settle(g.id, { status: 'failed', error: 'The app was closed before the job was sent.' })
  }

  /** Emits without letting a throwing listener break the job bookkeeping. */
  private safeEmit<K extends keyof JobEvents>(event: K, ...args: JobEvents[K]): void {
    try {
      // Typed callers are checked by the signature above; the generic spread needs the untyped emit.
      ;(this as EventEmitter).emit(event, ...args)
    } catch (err) {
      console.error(`JobManager '${String(event)}' listener failed:`, err)
    }
  }

  /** Updates and broadcasts; undefined when the generation has been deleted. */
  private patch(id: string, patch: Partial<db.StoredGeneration>): db.StoredGeneration | undefined {
    if (!db.getGeneration(id)) return undefined
    const g = db.updateGeneration(id, patch)
    this.safeEmit('update', toPublic(g))
    return g
  }

  /** Moves a pending generation to completed/failed and notifies listeners and waiters, once. */
  private settle(id: string, patch: Partial<db.StoredGeneration>): db.StoredGeneration | undefined {
    const current = db.getGeneration(id)
    if (!current) {
      this.forget(id)
      return undefined
    }
    if (isSettled(current)) return current
    const g = db.updateGeneration(id, patch)
    this.safeEmit('update', toPublic(g))
    // 'settled' listeners (e.g. auto-selecting a sequence take) run before waiters resume.
    this.safeEmit('settled', g)
    const waiters = this.waiters.get(id) ?? []
    this.waiters.delete(id)
    for (const w of waiters) w.resolve(g)
    return g
  }

  /** The generation was deleted while pending. */
  private forget(id: string): void {
    this.polling.delete(id)
    const waiters = this.waiters.get(id) ?? []
    this.waiters.delete(id)
    for (const w of waiters) w.reject(new Error('The generation was deleted before it was done.'))
  }

  private fail(id: string, error: string): void {
    this.settle(id, { status: 'failed', error })
  }

  private poll(id: string): void {
    if (this.polling.has(id)) return
    this.polling.add(id)
    let retries = 0

    const tick = async (): Promise<void> => {
      // The library was closed under the job (its folder vanished): the job stays pending in that library's
      // database, and resume() picks it up again when the library is opened.
      if (!db.isDbOpen()) {
        this.stop(id)
        return
      }
      const g = db.getGeneration(id)
      if (!g) return this.forget(id)
      if (isSettled(g)) return this.stop(id)
      if (!g.queueId) {
        this.stop(id)
        return this.fail(id, 'The job has no queue ID at Venice.')
      }
      try {
        // An earlier attempt (or a run the app quit during) already saved the video; only the rest is left.
        let filePath = g.filePath && (await exists(g.filePath)) ? g.filePath : undefined
        if (!filePath) {
          const res = await this.venice.retrieve(g.model, g.queueId)
          if (res.state === 'processing') {
            // Only a poll that got all the way counts as recovery; a retrieve that succeeds before a failing
            // download must not reset the count, or that download would be retried forever.
            retries = 0
            const updated = this.patch(id, {
              status: 'processing',
              averageExecutionTime: res.averageExecutionTime,
              executionDuration: res.executionDuration
            })
            if (!updated) return this.forget(id)
            setTimeout(() => void tick(), POLL_INTERVAL_MS)
            return
          }
          const data = res.state === 'video' ? res.data : await download(res.url ?? g.downloadUrl ?? '')
          filePath = await this.saveVideo(id, data)
        }
        // Undefined: deleted while downloading. Otherwise the take may have been moved meanwhile (its segment
        // deleted, its sequence renamed), so work from the path the database has now.
        const saved = filePath && db.getGeneration(id)?.filePath
        const media: MediaInfo = saved ? await this.mediaInfo(id, saved) : {}
        const settled = this.settle(id, {
          status: 'completed',
          completedAt: Date.now(),
          downloadUrl: undefined,
          ...media
        })
        this.stop(id)
        // Deleted meanwhile: whoever deleted it took care of the video, but not of a poster made just now.
        if (!settled && media.thumbPath) await unlink(media.thumbPath).catch(() => {})
        // We have our own copy now; ask Venice to delete theirs.
        this.venice.complete(g.model, g.queueId).catch(() => {})
      } catch (err) {
        // Network hiccups, rate limiting (429) and 5xx are worth retrying — the job is already paid for.
        // Other 4xx (policy, balance, not found) are final.
        const unreachable =
          err instanceof NetworkError || (err instanceof VeniceError && (err.status >= 500 || err.status === 429))
        const transient = unreachable || !(err instanceof VeniceError)
        if (transient && ++retries <= (unreachable ? MAX_UNREACHABLE_RETRIES : MAX_RETRIES)) {
          setTimeout(() => void tick(), Math.min(POLL_INTERVAL_MS * retries, MAX_RETRY_DELAY_MS))
          return
        }
        this.stop(id)
        this.fail(id, errorMessage(err))
      }
    }
    void tick()
  }

  private stop(id: string): void {
    this.polling.delete(id)
  }

  /**
   * Writes the video to the scratch folder, then moves it to its place in the library (videoLocation), so
   * a half-written file never shows up in the visible folders. The place is decided now rather than at
   * submit, since the take may have been moved into or out of a sequence meanwhile. The path is recorded
   * at once (the status stays pending until settle), so a sequence rename or a freed take that happens
   * while the poster is made carries the file along. Resolves undefined when the generation was deleted.
   */
  private async saveVideo(id: string, data: Buffer): Promise<string | undefined> {
    const tmp = join(tmpDir(), `${id}.mp4`)
    try {
      await writeFile(tmp, data)
      const g = db.getGeneration(id)
      if (!g) return undefined
      const { dir, base } = videoLocation(g)
      const path = await placeFile(tmp, dir, base, '.mp4')
      try {
        if (!db.getGeneration(id)) {
          // Deleted during the move: the file is ours alone.
          await rm(path, { force: true })
          return undefined
        }
        db.updateGeneration(id, { filePath: path })
      } catch (err) {
        await rm(path, { force: true }).catch(() => {})
        throw err
      }
      return path
    } finally {
      // Already gone when the move succeeded.
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /**
   * Duration and poster for a saved video. Best effort: a missing or failing ffmpeg must never fail
   * the generation itself, so problems are only logged.
   */
  private async mediaInfo(
    id: string,
    filePath: string,
    want: { duration: boolean; thumb: boolean } = { duration: true, thumb: true },
    stillWanted: () => boolean = () => true
  ): Promise<MediaInfo> {
    const info: MediaInfo = {}
    if (want.duration) {
      try {
        info.videoDuration = (await probe(filePath)).duration
      } catch (err) {
        console.warn(`Could not probe generation ${id}: ${errorMessage(err)}`)
      }
    }
    // The poster's folder is looked up only now, after the probe, and not at all once it's no longer wanted.
    if (want.thumb && stillWanted()) {
      try {
        info.thumbPath = await extractThumbnail(filePath, join(thumbsDir(), `${id}.jpg`))
      } catch (err) {
        console.warn(`Could not create a thumbnail for generation ${id}: ${errorMessage(err)}`)
      }
    }
    return info
  }

  /**
   * Completed generations from before ffmpeg support (or saved while it was missing) lack poster/duration.
   * Stops as soon as another library is opened (or this one is closed) under it.
   */
  private async backfill(epoch: number): Promise<void> {
    const current = (): boolean => epoch === this.epoch && db.isDbOpen()
    const candidates = db.listGenerations().filter((g) => g.status === 'completed' && g.filePath)
    if (!candidates.length) return
    let checkedFfmpeg = false
    for (const candidate of candidates) {
      if (!current()) return
      // Re-read: the file may have been moved or the generation deleted since the list was made.
      const g = db.getGeneration(candidate.id)
      if (!g?.filePath || g.status !== 'completed') continue
      const thumb = !g.thumbPath || !(await exists(g.thumbPath))
      const duration = g.videoDuration === undefined
      if (!thumb && !duration) continue
      if (!(await exists(g.filePath))) continue
      if (!checkedFfmpeg) {
        const status = await ffmpegStatus()
        if (!status.ok) {
          console.warn(`Skipping thumbnail backfill: ${status.message}`)
          return
        }
        checkedFfmpeg = true
      }
      if (!current()) return
      const step = this.mediaInfo(g.id, g.filePath, { duration, thumb }, current)
      this.backfillStep = step
      let media: MediaInfo
      try {
        media = await step
      } finally {
        if (this.backfillStep === step) this.backfillStep = undefined
      }
      if (!current()) return
      if (media.videoDuration !== undefined || media.thumbPath) this.patch(g.id, media)
    }
  }
}
