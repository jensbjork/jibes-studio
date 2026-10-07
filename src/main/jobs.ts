import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paramsForSubmit } from '@shared/models'
import {
  composeOptionsFor,
  composePrompt,
  knowsPromptLimit,
  promptLimitOf,
  rememberPromptLimits
} from '@shared/prompt-compose'
import { blockingPromptError, canonicalizeParams } from '@shared/prompt-refs'
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
import { extractThumbnail, ffmpegStatus, probe } from './ffmpeg'
import { dayStamp, generationsDayDir, promptExcerpt, sequenceTakesDir, thumbsDir, timeStamp, tmpDir } from './paths'
import { importExternalReferences, placeFile } from './references'
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
 * The prompt as a submission of these params sends it (composePrompt): the user's prompt with the References legend
 * of the referenced assets' descriptions appended – the descriptions as the database has them right now, the
 * params' own switches (includeDescriptions, excludedDescriptionAssetIds), the user's prompt language – and kept
 * within the model's prompt limit: `characterLimit` when given, else the one remembered from the model list.
 * Tokens are canonicalised first, as they are sent. Synchronous, so a check (an approval's) can compare it on the
 * very database state a submit reads. Needs an open library.
 */
export function composeSubmission(
  params: GenerationParams,
  opts: { characterLimit?: number } = {}
): ComposedPrompt {
  const p = canonicalizeParams(params)
  const limit = opts.characterLimit ?? promptLimitOf(p.model)
  return composePrompt(p, describedAssetsFor(paramsForSubmit(p)), composeOptionsFor(p, getPromptLanguage(), limit))
}

/**
 * Refuses (Swedish) a prompt that can't be sent as composed. The legend's tokens are valid by construction and
 * its texts carry no "@", so this only says again what the user's prompt said; it runs anyway, on exactly the
 * text Venice gets, so nothing that would spoil a paid generation can slip in with a description.
 */
function checkComposed(params: GenerationParams, composed: Pick<ComposedPrompt, 'prompt'>): void {
  if (composed.prompt === params.prompt) return
  const problem = blockingPromptError({ ...params, prompt: composed.prompt })
  if (problem) throw new Error(problem)
}

/**
 * The params exactly as a paid submission sends them, or a Swedish refusal: the prompt's @ImageN and @AudioN
 * references are checked against what the caller has (so a token past the model's limit is reported as such),
 * tokens are canonicalised, inputs the model doesn't use are dropped (paramsForSubmit), the prompt as composed with
 * the descriptions legend (composeSubmission) is checked too, and every reference audio clip is measured and its
 * window filled in, so that a clip shorter than 2 s or clips longer than 15 s together — which Venice would refuse
 * after the upload — are refused here. The returned params keep the user's prompt: the legend is composed again,
 * from the descriptions as they are then, when the job is sent. Nothing is copied or sent. JobManager.submit runs
 * it on every submission; callers that quote first (a sequence take) run it before the quote too.
 */
export async function prepareSubmission(params: GenerationParams): Promise<GenerationParams> {
  const problem = blockingPromptError(params)
  if (problem) throw new Error(problem)
  const checked = paramsForSubmit(canonicalizeParams(params))
  checkComposed(checked, composeSubmission(checked))
  if (!checked.referenceAudios?.length) return checked
  // "The clip no longer exists" says more than ffprobe failing to open it.
  ensureImagesExist(checked)
  const measured = await resolveReferenceAudios(checked)
  const late = blockingPromptError(measured)
  if (late) throw new Error(late)
  return measured
}

/** The folder of the sequence a segment belongs to; undefined if the segment is gone or the sequence has none. */
function sequenceFolderOf(segmentId: string): string | undefined {
  const folder = db
    .getDb()
    .prepare('SELECT s.folder FROM segments seg JOIN sequences s ON s.id = seg.sequence_id WHERE seg.id = ?')
    .pluck()
    .get(segmentId) as string | null | undefined
  return folder || undefined
}

/**
 * Where a generation's video belongs and what it is called (without ".mp4"): a take goes into its
 * sequence's Tagningar folder as "<YYYY-MM-DD HH.MM> <prompt>", anything else into Genereringar/<day>/ as
 * "<HH.MM> <prompt>". Times are when the generation was submitted.
 */
export function videoLocation(g: Pick<Generation, 'createdAt' | 'prompt' | 'segmentId'>): { dir: string; base: string } {
  const created = new Date(g.createdAt)
  const excerpt = promptExcerpt(g.prompt)
  const folder = g.segmentId ? sequenceFolderOf(g.segmentId) : undefined
  if (folder) return { dir: sequenceTakesDir(folder), base: `${dayStamp(created)} ${timeStamp(created)} ${excerpt}` }
  return { dir: generationsDayDir(created), base: `${timeStamp(created)} ${excerpt}` }
}

interface JobEvents {
  /** Any change to a generation (created, progress, completed, failed, poster added). */
  update: [Generation]
  /** Exactly once per generation: completed (duration and poster already stored) or failed. */
  settled: [db.StoredGeneration]
}

export interface SubmitOptions {
  /** USD, as quoted before submitting. */
  quote?: number
  /** Makes the generation a take of this sequence segment. */
  segmentId?: string
  /**
   * The prompt to send, composed by the caller from these params (composeSubmission) when it read them: a sequence
   * take composes it together with the reads its approval's check runs on, and an agent's approved form request
   * passes the text the user approved, so each sends exactly what was checked however long the frames, the quote
   * and the upload take. Checked like a prompt composed here; one that doesn't start with the params' prompt is
   * ignored. Default: composed when the job is sent.
   */
  sentPrompt?: string
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
    for (const g of db.listPendingGenerations()) this.track(g)
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
    try {
      // Before the files are read: the model list may take a moment, and paths are only followed from there on.
      // A caller that composed the prompt itself (a sequence take) already had the limit.
      const limit = opts.sentPrompt === undefined ? await this.promptLimit(params.model) : undefined
      return await this.queue(await prepareSubmission(params), opts, limit)
    } finally {
      this.submitting--
    }
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
    // "Välj en biblioteksmapp först." before anything is sent.
    db.getDb()
    // A clear "the start image no longer exists" beats a failed copy.
    ensureImagesExist(params)
    // The upload below can take seconds; an asset renamed meanwhile (or "Städa upp") moves its pictures,
    // and the row written afterwards must point at where they are now (db.followRewrites).
    const mark = db.rewriteMark()
    // What Venice gets: the prompt with the descriptions of the referenced assets as the library has them now
    // (asset files are inside the library, so the copying below never changes the paths they are found by). The
    // row keeps the user's prompt in `prompt` and `params`, and this one as sentPrompt.
    const given = opts.sentPrompt
    const own = params.prompt.trimEnd()
    const composed =
      typeof given === 'string' && (given === params.prompt || (own !== '' && given.startsWith(own)))
        ? { prompt: given }
        : composeSubmission(params, { characterLimit: limit })
    checkComposed(params, composed)
    // Outside images and audio are copied into Referensbilder first, so the stored params point at the copies.
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
      model: params.model,
      prompt: params.prompt,
      sentPrompt: composed.prompt,
      params: db.followRewrites(params, mark),
      status: 'queued',
      queueId: res.queue_id,
      downloadUrl: res.download_url,
      quote: opts.quote,
      segmentId: opts.segmentId,
      reviewCount: 0,
      agentReviewCount: 0
    }
    try {
      db.insertGeneration(g)
    } catch (err) {
      // The segment was deleted while the job was being queued. The job is already paid for, so keep it
      // in the feed rather than lose track of it.
      if (!g.segmentId || (err as { code?: string }).code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw err
      g.segmentId = undefined
      db.insertGeneration(g)
    }
    this.safeEmit('update', toPublic(g))
    this.poll(g.id)
    return toPublic(g)
  }

  /** Resolves once the generation is completed or failed (immediately if it already is). */
  waitFor(id: string): Promise<db.StoredGeneration> {
    const g = db.getGeneration(id)
    if (!g) return Promise.reject(new Error('Genereringen finns inte.'))
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
    else this.settle(g.id, { status: 'failed', error: 'Appen stängdes innan jobbet skickades.' })
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
    for (const w of waiters) w.reject(new Error('Genereringen togs bort innan den blev klar.'))
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
        return this.fail(id, 'Jobbet saknar kö-id hos Venice.')
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
