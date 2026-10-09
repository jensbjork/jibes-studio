import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { agentUploadsDir, isLibraryReady, LIBRARY_NOT_READY, safeName, withoutLocalPaths } from '../paths'
import { checkUrl, fetchToFile, hostOf, type AddressRules, type FetchOptions } from './fetch-url'
import {
  checkUpload,
  HEAD_BYTES,
  KIND_WORDS,
  notOfKind,
  readHead,
  sniff,
  tooLargeMessage,
  UPLOAD_CAPS,
  type UploadInfo,
  type UploadKind
} from './upload-check'

// Files agents send to Studio. Agents run on other machines, so a file never arrives as a path: it comes as a URL
// Studio fetches, as a raw PUT on the agent port (curl -T), or – for tiny files – as base64 inside the tool call. Each
// upload is staged in its own folder in the library's scratch (.studio/tmp/agent-uploads/<id>/), on the library's
// own volume so a large video can be cloned into place rather than copied, under its original name (photos, sound
// clips and own clips are named after their files) with the extension of what its bytes really are. A ready upload
// lives for two hours and can feed several tools; tools copy or clone it, never move it. Nothing here touches the
// library itself.

export type UploadStatus = 'receiving' | 'downloading' | 'checking' | 'ready' | 'failed'

/** An upload as the tools see it. */
export interface UploadEntry {
  id: string
  /** The agent that began it. */
  client: string
  /** The session address it was begun from: only that machine may PUT its bytes. */
  peer: string
  kind: UploadKind
  /** As the agent named it (the staged file keeps its stem). */
  fileName: string
  status: UploadStatus
  /** Declared (PUT), announced by the server (URL) or, once received, exact. */
  bytes?: number
  received: number
  sha256?: string
  expectedSha?: string
  /** The staged file, once ready. */
  path?: string
  mime?: string
  info?: UploadInfo
  /** Swedish, when it failed. */
  error?: string
  /** The host a URL upload comes from (never the URL itself). */
  host?: string
  createdAt: number
  readyAt?: number
  /** Ready: two hours after it was ready. Receiving or downloading: 30 minutes after the last byte. */
  expiresAt: number
}

/** What runs, for Pågår och klart (WorkStatus reads it through AgentService.uploads). */
export interface UploadWork {
  id: string
  client: string
  fileName: string
  kind: 'image' | 'audio' | 'video'
  status: 'receiving' | 'downloading' | 'checking'
  received: number
  bytes?: number
  startedAt: number
  host?: string
}

export type UploadSource =
  /** Studio fetches it (in the background). */
  | { url: string; rules: AddressRules }
  /** The bytes themselves (base64 in the tool call, decoded). */
  | { data: Buffer }
  /** The agent PUTs this many bytes to /uploads/<id> next. */
  | { bytes: number }

export interface BeginInput {
  client: string
  peer: string
  kind: UploadKind
  fileName: string
  source: UploadSource
  /** Lower-case hex, compared once the file is in. */
  sha256?: string
}

export interface UploadStoreOptions {
  /** Something started, moved on, finished or went away ('progress': only bytes moved). */
  notify?: (kind: 'structure' | 'progress') => void
  /**
   * A fetched or PUT upload became ready or failed after the tool call that began it had answered: the activity log
   * says so ("hämtade en bild från example.com"). Inline uploads are told by their own call.
   */
  onSettled?: (entry: UploadEntry) => void
  userAgent: string
  /** Stand-in for DNS in URL fetches (tests). */
  resolve?: FetchOptions['resolve']
  /** Shorter limits for tests. */
  limits?: Partial<typeof LIMITS>
}

const GB = 1024 ** 3

const LIMITS = {
  /** Uploads that are not failed. */
  live: 16,
  /** Everything staged together. */
  stagedBytes: 8 * GB,
  /** What must stay free on the library's disk. */
  freeBytes: 2 * GB,
  /** A ready upload. */
  readyMs: 2 * 60 * 60 * 1000,
  /** Receiving or downloading without a byte. */
  idleMs: 30 * 60 * 1000,
  /** How long a failed upload is still listed (get_upload tells why). */
  failedMs: 30 * 60 * 1000,
  /** One PUT: no data for this long ends it; the whole transfer at most putTotalMs. */
  putIdleMs: 60_000,
  putTotalMs: 30 * 60 * 1000,
  /**
   * A PUT not sent yet holds its declared size against the free-disk floor this long after begin_upload (so two
   * large ones begun together can't both fit); after that, and once one has been tried, only while one is sending.
   */
  putReserveMs: 5 * 60 * 1000,
  /** One URL fetch, redirects included. */
  fetchMs: 120_000,
  videoFetchMs: 30 * 60 * 1000,
  /** URL fetches at a time; the others wait as "downloading" at 0 %. */
  fetches: 2
}

/** The largest data_base64 file: what fits in one tool call under the agent port's 1 MiB body limit. */
export const MAX_INLINE_BYTES = 700_000

const SWEEP_MS = 60_000
const PROGRESS_MS = 1000
const PART = '.upload.part'
const REMEMBERED_REASONS = 200
/** A URL download checks the free disk again at least this often while bytes arrive… */
const DISK_CHECK_MS = 1000
/** …and after this many bytes, whichever comes first. */
const DISK_CHECK_BYTES = 64 * 1024 ** 2

const DISK_FULL = 'Det finns för lite ledigt utrymme på disken.'

const FALLBACK_NAME: Record<UploadKind, string> = { image: 'Bild', audio: 'Ljud', video: 'Film' }

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface Live extends UploadEntry {
  dir: string
  /** Its bytes come by PUT. */
  viaPut: boolean
  /** A PUT has been sent to it (and broke off or was stopped): its size is reserved only while one is sending. */
  putTried?: boolean
  /** A URL upload waiting for a fetch slot: not idle, it hasn't been able to start. */
  queued?: boolean
  /** How it ended is in the activity log already. */
  reported?: boolean
  lastActivity: number
  controller?: AbortController
  request?: IncomingMessage
  waiters: (() => void)[]
}

const PENDING: ReadonlySet<UploadStatus> = new Set(['receiving', 'downloading', 'checking'])

export class UploadStore {
  private readonly entries = new Map<string, Live>()
  /** Why recent uploads went away (token changed, library switched, expired), so a later call can say so. */
  private readonly goneReasons = new Map<string, string>()
  private readonly sweeper: NodeJS.Timeout
  private readonly limits: typeof LIMITS
  private fetching = 0
  private readonly fetchQueue: (() => void)[] = []
  private lastProgress = 0

  constructor(private readonly opts: UploadStoreOptions) {
    this.limits = { ...LIMITS, ...opts.limits }
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS)
    this.sweeper.unref?.()
  }

  // ── Beginning ──────────────────────────────────────────────────────────────

  /**
   * Starts an upload. Inline data is checked at once (resolves ready, or rejects with the Swedish refusal and
   * keeps nothing); a URL is fetched in the background (resolves downloading); a PUT waits for its bytes
   * (resolves receiving). Refused without a library, past the limits or with too little disk.
   */
  async begin(input: BeginInput): Promise<UploadEntry> {
    if (!isLibraryReady()) throw new Error(LIBRARY_NOT_READY)
    this.sweep()
    const cap = UPLOAD_CAPS[input.kind].bytes
    this.assertRoom(1, input.client)
    const source = input.source
    let declared = 0
    let url: URL | undefined
    if ('data' in source) {
      if (!source.data.length) throw new Error('Filen är tom.')
      if (source.data.length > MAX_INLINE_BYTES) {
        throw new Error(
          `data_base64 tar högst ${MAX_INLINE_BYTES.toLocaleString('sv-SE')} byte. Skicka större filer med bytes (PUT) eller url.`
        )
      }
      if (source.data.length > cap) throw new Error(tooLargeMessage(input.kind))
      declared = source.data.length
    } else if ('bytes' in source) {
      if (!Number.isSafeInteger(source.bytes) || source.bytes < 1) {
        throw new Error('bytes ska vara filens storlek i byte.')
      }
      if (source.bytes > cap) throw new Error(tooLargeMessage(input.kind))
      declared = source.bytes
    } else {
      url = checkUrl(source.url)
    }
    const root = agentUploadsDir()
    const free = await freeBytes(root)
    // Checked again after the wait, and the entry registered before the next one, so begins that overlap all count.
    this.assertRoom(1, input.client)
    if (this.staged() + declared > this.limits.stagedBytes) throw new Error(this.stagedFull())
    // What other transfers still have to write counts as taken: two large PUTs begun together must not both fit.
    if (free - this.outstanding() - declared < this.limits.freeBytes) throw new Error(this.diskFull(input.client))

    const id = randomUUID()
    const dir = join(root, id)
    const now = Date.now()
    const entry: Live = {
      id,
      client: input.client,
      peer: input.peer,
      kind: input.kind,
      fileName: input.fileName,
      status: 'data' in source ? 'checking' : 'bytes' in source ? 'receiving' : 'downloading',
      ...('bytes' in source ? { bytes: source.bytes } : {}),
      ...('data' in source ? { bytes: source.data.length } : {}),
      received: 0,
      ...(input.sha256 ? { expectedSha: input.sha256.toLowerCase() } : {}),
      ...(url ? { host: hostOf(url) } : {}),
      createdAt: now,
      expiresAt: now + this.limits.idleMs,
      dir,
      viaPut: 'bytes' in source,
      lastActivity: now,
      waiters: []
    }
    this.entries.set(id, entry)
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      this.entries.delete(id)
      throw err
    }
    if (!this.isLive(entry)) {
      // Ended meanwhile (the token changed, the library switched): nothing of it is kept.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new Error(this.goneMessage(id))
    }
    this.changed()

    if ('data' in source) {
      const part = join(dir, PART)
      await writeFile(part, source.data, { flag: 'wx' })
      entry.received = source.data.length
      entry.sha256 = createHash('sha256').update(source.data).digest('hex')
      await this.finish(entry, part)
      if (entry.status !== 'ready') {
        // Checked at once: nothing usable was made, so nothing is kept either.
        this.entries.delete(id)
        this.changed()
        throw new Error(entry.error ?? notOfKind(input.kind))
      }
    } else if ('url' in source) {
      void this.download(entry, source.url, source.rules)
    }
    return this.view(entry)
  }

  // ── Receiving a PUT ────────────────────────────────────────────────────────

  /**
   * Whether a PUT of `length` bytes from `peer` may go to this upload, checked before a byte is read (and before
   * "100 Continue"): undefined when it may, else the HTTP status and the Swedish reason. The free-disk floor is
   * checked again here: a PUT's size is only reserved while it can come soon (see outstanding).
   */
  async checkPut(id: string, peer: string, length: number): Promise<{ status: number; error: string } | undefined> {
    const problem = this.putProblem(id, peer, length)
    if (problem) return problem
    const entry = this.entries.get(id)!
    const free = await freeBytes(entry.dir)
    // Checked again after the wait (it may have gone, or another PUT may have begun sending it). From here to
    // receive() nothing waits, so a second PUT checked meanwhile counts this one as sending.
    const again = this.putProblem(id, peer, length)
    if (again) return again
    if (free - this.outstanding(entry) - length < this.limits.freeBytes) {
      return { status: 507, error: this.diskFull(entry.client, entry) }
    }
    return undefined
  }

  /** checkPut's checks that need no disk: the upload, the machine, its state and the length. */
  private putProblem(id: string, peer: string, length: number): { status: number; error: string } | undefined {
    this.sweep()
    const entry = this.entries.get(id)
    if (!entry) return { status: 404, error: this.goneMessage(id) }
    if (entry.peer !== peer) return { status: 403, error: 'Uppladdningen började från en annan dator.' }
    if (entry.status !== 'receiving' || entry.request) {
      return {
        status: 409,
        error: `Uppladdningen tar inte emot någon fil just nu (${entry.request ? 'receiving' : entry.status}).`
      }
    }
    if (length !== entry.bytes) {
      return { status: 400, error: `Content-Length är ${length}, men begin_upload angav bytes = ${entry.bytes}.` }
    }
    return undefined
  }

  /**
   * Streams a checked PUT's body into the upload: byte-counted, hashed, then checked like every upload. Resolves
   * with the HTTP answer. A transfer that breaks off – or that Studio stops (no data for putIdleMs, longer than
   * putTotalMs in all) – leaves the upload receiving with the reason in `error`, so the agent can send it again. The
   * connection itself is left to the caller, so a stopped transfer can still be answered (408) before it closes.
   */
  async receive(id: string, req: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    const entry = this.entries.get(id)
    if (!entry || entry.status !== 'receiving' || entry.request) {
      return { status: 409, body: { error: 'Uppladdningen tar inte emot någon fil just nu.' } }
    }
    entry.request = req
    entry.putTried = true
    const limit = entry.bytes ?? 0
    const part = join(entry.dir, PART)
    const hash = createHash('sha256')
    let received = 0
    let overflow = false
    let timedOut: 'idle' | 'total' | undefined
    entry.received = 0
    entry.error = undefined
    entry.lastActivity = Date.now()
    this.changed()
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        received += chunk.length
        if (received > limit) {
          overflow = true
          done(new Error('overflow'))
          return
        }
        hash.update(chunk)
        entry.received = received
        entry.lastActivity = Date.now()
        this.progressed()
        done(null, chunk)
      }
    })
    // The body is piped by hand rather than through pipeline(): pipeline would destroy the request – and with it
    // the socket – on any error, and the answer could never be sent.
    const stop = (err: Error): void => {
      req.unpipe(counter)
      req.pause()
      counter.destroy(err)
    }
    const cut = (why: 'idle' | 'total'): void => {
      timedOut = why
      stop(new Error('timeout'))
    }
    const broken = (): void => {
      if (!req.complete) stop(new Error('aborted'))
    }
    req.setTimeout(this.limits.putIdleMs, () => cut('idle'))
    const total = setTimeout(() => cut('total'), this.limits.putTotalMs)
    req.once('error', broken)
    req.once('close', broken)
    req.pipe(counter)
    // Closed while checkPut looked at the disk: its 'close' has been and gone.
    if (req.destroyed) broken()
    try {
      await pipeline(counter, createWriteStream(part, { flags: 'w' }))
    } catch {
      entry.request = undefined
      const live = this.isLive(entry)
      await rm(part, { force: true }).catch(() => {})
      if (!live) return { status: 410, body: { error: this.goneMessage(id) } }
      if (overflow) {
        await this.fail(entry, `Filen är större än de ${limit} byte som begin_upload angav.`)
        return { status: 413, body: { error: entry.error } }
      }
      // A broken connection or a stalled one: nothing is kept and the agent can send the file again.
      const error =
        timedOut === 'idle'
          ? `Inget kom fram på ${spokenTime(this.limits.putIdleMs)}, så överföringen avbröts. Skicka filen igen.`
          : timedOut === 'total'
            ? `Överföringen tog längre än ${spokenTime(this.limits.putTotalMs)} och avbröts. Skicka filen igen över en snabbare förbindelse, eller släng den här uppladdningen (discard_upload) och låt Studio hämta filen (url).`
            : 'Överföringen avbröts. Skicka filen igen.'
      entry.received = 0
      entry.error = error
      this.changed()
      return { status: timedOut ? 408 : 400, body: { error } }
    } finally {
      clearTimeout(total)
      req.off('error', broken)
      req.off('close', broken)
      // The body is in (or gone): the connection's idle limit goes back to the server's own.
      req.setTimeout(0)
    }
    entry.request = undefined
    if (!this.isLive(entry)) {
      await rm(part, { force: true }).catch(() => {})
      return { status: 410, body: { error: this.goneMessage(id) } }
    }
    if (received !== limit) {
      await rm(part, { force: true }).catch(() => {})
      const error = `Bara ${received} av ${limit} byte kom fram. Skicka filen igen.`
      entry.received = 0
      entry.error = error
      this.changed()
      return { status: 400, body: { error } }
    }
    entry.sha256 = hash.digest('hex')
    await this.finish(entry, part)
    // finish() moved the status on (TypeScript still sees it as 'receiving').
    if ((entry.status as UploadStatus) === 'ready') {
      return { status: 201, body: { upload_id: entry.id, status: 'ready', bytes: entry.bytes, sha256: entry.sha256 } }
    }
    return { status: 422, body: { error: entry.error } }
  }

  // ── Fetching a URL ─────────────────────────────────────────────────────────

  /**
   * Fetches a URL upload. Its size is only known once the server answers (if then), so the staged total and the
   * free-disk floor are checked again when it may start (the uploads ahead of it in the queue may have taken the
   * room), as soon as the server announces a size, and while the bytes arrive; past either limit the download stops
   * with the same refusal begin gives.
   */
  private async download(entry: Live, url: string, rules: AddressRules): Promise<void> {
    entry.queued = true
    const release = await this.fetchSlot()
    entry.queued = false
    // Waiting for a slot wasn't idling: the 30 minutes without a byte count from now.
    entry.lastActivity = Date.now()
    const controller = new AbortController()
    /** Why this upload was stopped here (a limit), rather than the abort's own "Hämtningen avbröts.". */
    let refused: string | undefined
    try {
      // Thrown away, or ended otherwise, while it waited: nothing is fetched.
      if (!this.stillToFetch(entry)) return
      if (this.staged(entry) >= this.limits.stagedBytes) throw new Error(this.stagedFull())
      if ((await freeBytes(entry.dir)) - this.outstanding() < this.limits.freeBytes) {
        throw new Error(this.diskFull(entry.client, entry))
      }
      if (!this.stillToFetch(entry)) return
      entry.controller = controller
      entry.lastActivity = Date.now()
      const refuse = (message: string): void => {
        if (refused) return
        refused = message
        controller.abort()
      }
      let checking = false
      let checkedAt = Date.now()
      let checkedBytes = 0
      let announced = false
      /** The disk keeps its floor with what every transfer still has to write (this one's announced rest too). */
      const checkDisk = (): void => {
        if (checking || refused) return
        checking = true
        checkedAt = Date.now()
        checkedBytes = entry.received
        void freeBytes(entry.dir).then((free) => {
          checking = false
          if (!this.isLive(entry) || entry.controller !== controller) return
          if (free - this.outstanding() < this.limits.freeBytes) refuse(this.diskFull(entry.client, entry))
        })
      }
      const part = join(entry.dir, PART)
      const result = await fetchToFile({
        url,
        dest: part,
        maxBytes: UPLOAD_CAPS[entry.kind].bytes,
        tooLarge: tooLargeMessage(entry.kind),
        totalMs: entry.kind === 'video' ? this.limits.videoFetchMs : this.limits.fetchMs,
        rules,
        userAgent: this.opts.userAgent,
        signal: controller.signal,
        resolve: this.opts.resolve,
        onProgress: (received, total) => {
          entry.received = received
          if (total !== undefined) entry.bytes = total
          entry.lastActivity = Date.now()
          if (this.staged(entry) + Math.max(entry.bytes ?? 0, received) > this.limits.stagedBytes) {
            refuse(this.stagedFull())
          } else if (total !== undefined && !announced) {
            announced = true
            checkDisk()
          } else if (Date.now() - checkedAt >= DISK_CHECK_MS || received - checkedBytes >= DISK_CHECK_BYTES) {
            checkDisk()
          }
          this.progressed()
        }
      })
      entry.controller = undefined
      if (!this.stillToFetch(entry)) return
      entry.bytes = result.bytes
      entry.received = result.bytes
      entry.sha256 = result.sha256
      await this.finish(entry, part)
    } catch (err) {
      entry.controller = undefined
      // Not when it was already ended (failed by the idle sweep, say): its reason stays.
      if (this.stillToFetch(entry)) await this.fail(entry, refused ?? errorText(err))
    } finally {
      release()
    }
  }

  /** Waits for one of the URL fetch slots; resolves with its release. */
  private fetchSlot(): Promise<() => void> {
    const take = (): (() => void) => {
      this.fetching++
      let released = false
      return () => {
        if (released) return
        released = true
        this.fetching--
        this.fetchQueue.shift()?.()
      }
    }
    if (this.fetching < this.limits.fetches) return Promise.resolve(take())
    return new Promise((resolve) => this.fetchQueue.push(() => resolve(take())))
  }

  // ── Checking ───────────────────────────────────────────────────────────────

  /** The bytes are in (`part`): checksum, what they are, then Studio's own checks. Ends ready or failed. */
  private async finish(entry: Live, part: string): Promise<void> {
    entry.status = 'checking'
    entry.lastActivity = Date.now()
    this.changed()
    try {
      if (entry.expectedSha && entry.sha256 !== entry.expectedSha)
        throw new Error('Kontrollsumman stämmer inte (sha256).')
      const sniffed = sniff(entry.kind, await readHead(part, HEAD_BYTES))
      if (!sniffed) throw new Error(notOfKind(entry.kind))
      const stem = safeName(basename(entry.fileName, extname(entry.fileName)), { fallback: FALLBACK_NAME[entry.kind] })
      const file = join(entry.dir, `${stem.replace(/^\.+/, '') || FALLBACK_NAME[entry.kind]}${sniffed.ext}`)
      await rename(part, file)
      const checked = await checkUpload(entry.kind, file, sniffed)
      if (!this.isLive(entry)) return
      const now = Date.now()
      entry.path = checked.path
      entry.mime = checked.mime
      entry.info = checked.info
      entry.status = 'ready'
      entry.readyAt = now
      entry.expiresAt = now + this.limits.readyMs
      entry.error = undefined
      this.changed()
      this.wake(entry)
      this.settled(entry)
    } catch (err) {
      if (this.isLive(entry)) await this.fail(entry, errorText(err))
    }
  }

  /**
   * Tells the activity log how a URL or PUT upload ended (an inline one is told by its own tool call) – a moment
   * later, so a tool call that was waiting for it and reports it itself (markReported) goes first.
   */
  private settled(entry: Live): void {
    if (entry.status !== 'ready' && entry.status !== 'failed') return
    if (!entry.host && !entry.viaPut) return
    const view = this.view(entry)
    setTimeout(() => {
      if (entry.reported) return
      entry.reported = true
      try {
        this.opts.onSettled?.(view)
      } catch (err) {
        console.warn('Recording an upload failed:', err)
      }
    }, 0)
  }

  /** The tool call that waited for this upload says how it ended itself; the activity log needs no entry of its own. */
  markReported(id: string): void {
    const entry = this.entries.get(id)
    if (entry) entry.reported = true
  }

  /**
   * Marks the upload failed with its Swedish reason (local folders left out: it is told to the agent); its files go
   * (resolves once they are gone).
   */
  private fail(entry: Live, message: string): Promise<void> {
    entry.status = 'failed'
    entry.error = withoutLocalPaths(message)
    entry.path = undefined
    entry.expiresAt = Date.now() + this.limits.failedMs
    entry.controller?.abort()
    entry.request?.destroy()
    const removed = rm(entry.dir, { recursive: true, force: true }).catch(() => {})
    this.changed()
    this.wake(entry)
    this.settled(entry)
    return removed
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** The upload, or undefined when there is none by that id (any more). */
  get(id: string): UploadEntry | undefined {
    this.sweep()
    const entry = this.entries.get(id)
    return entry ? this.view(entry) : undefined
  }

  /** The upload, or the Swedish reason there is none. */
  require(id: string): UploadEntry {
    const entry = this.get(id)
    if (!entry) throw new Error(this.goneMessage(id))
    return entry
  }

  /**
   * A ready upload of the given kind, for a tool to copy in; throws why it can't be used (gone, not ready, failed,
   * another kind).
   */
  resolve(id: string, kind?: UploadKind): UploadEntry & { path: string } {
    const entry = this.require(id)
    if (entry.status === 'failed') throw new Error(`Uppladdningen ${id} misslyckades: ${entry.error ?? 'okänt fel'}`)
    if (entry.status !== 'ready' || !entry.path) throw new Error(`Uppladdningen är inte klar än (${entry.status}).`)
    if (kind && entry.kind !== kind) {
      throw new Error(`Uppladdningen är ${KIND_WORDS[entry.kind].one}, inte ${KIND_WORDS[kind].one}.`)
    }
    if (!existsSync(entry.path)) {
      this.drop(id, 'filen finns inte längre')
      throw new Error(this.goneMessage(id))
    }
    return entry as UploadEntry & { path: string }
  }

  /**
   * Resolves once the upload is ready or failed (or gone), or after `ms` with it as it is then; undefined when there
   * is no such upload.
   */
  async waitSettled(id: string, ms: number): Promise<UploadEntry | undefined> {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (entry.status === 'ready' || entry.status === 'failed' || ms <= 0) return this.view(entry)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      entry.waiters.push(done)
    })
    return this.get(id)
  }

  /** Uploads that are still coming in or being checked (Pågår och klart). */
  active(): UploadWork[] {
    return [...this.entries.values()]
      .filter((e) => PENDING.has(e.status))
      .map((e) => ({
        id: e.id,
        client: e.client,
        fileName: e.fileName,
        kind: e.kind,
        status: e.status as UploadWork['status'],
        received: e.received,
        ...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
        startedAt: e.createdAt,
        ...(e.host ? { host: e.host } : {})
      }))
  }

  // ── Ending ─────────────────────────────────────────────────────────────────

  /** Throws the upload away (a transfer in progress is stopped). Scratch only: nothing in the library changes. */
  discard(id: string): boolean {
    const known = this.entries.has(id)
    if (known) this.drop(id, 'den slängdes med discard_upload')
    return known
  }

  /**
   * Ends every upload: transfers stopped, files removed. On a new token, a library switch or move, and when the
   * connection is switched off – what was sent for the old situation must not be used in the new one.
   */
  expireAll(reason: string): void {
    const ids = [...this.entries.keys()]
    for (const id of ids) this.drop(id, reason, false)
    if (ids.length) this.changed()
  }

  dispose(): void {
    clearInterval(this.sweeper)
    this.expireAll('Studio avslutades.')
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  private drop(id: string, reason: string, announce = true): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.controller?.abort()
    entry.request?.destroy()
    void rm(entry.dir, { recursive: true, force: true }).catch(() => {})
    this.goneReasons.set(id, reason)
    while (this.goneReasons.size > REMEMBERED_REASONS)
      this.goneReasons.delete(this.goneReasons.keys().next().value as string)
    this.wake(entry)
    if (announce) this.changed()
  }

  /** Expires what has run out: ready ones after two hours, stalled transfers after 30 minutes, old failures. */
  private sweep(): void {
    const now = Date.now()
    let changed = false
    for (const entry of [...this.entries.values()]) {
      if (entry.status === 'ready' && now > entry.expiresAt) {
        this.drop(entry.id, 'den gällde i två timmar', false)
        changed = true
      } else if (
        (entry.status === 'receiving' || (entry.status === 'downloading' && !entry.queued)) &&
        now - entry.lastActivity > this.limits.idleMs
      ) {
        void this.fail(entry, 'Inget kom fram på 30 minuter, så uppladdningen avbröts.')
      } else if (entry.status === 'failed' && now > entry.expiresAt) {
        this.entries.delete(entry.id)
        this.goneReasons.set(entry.id, `den misslyckades: ${entry.error ?? 'okänt fel'}`)
        changed = true
      }
    }
    if (changed) this.changed()
  }

  /**
   * Throws the refusal when `count` more uploads would pass the live limit, naming this agent's own live uploads so
   * it can use or discard them.
   */
  assertRoom(count: number, client: string): void {
    this.sweep()
    const live = [...this.entries.values()].filter((e) => e.status !== 'failed')
    if (live.length + count <= this.limits.live) return
    const own = live.filter((e) => e.client === client).map((e) => e.id)
    const head =
      count === 1
        ? `Det finns redan ${this.limits.live} uppladdningar.`
        : `Det finns redan ${live.length === 1 ? '1 uppladdning' : `${live.length} uppladdningar`} och högst ${this.limits.live} får finnas samtidigt, så ${count} till får inte plats.`
    throw new Error(
      `${head} Använd eller släng några (discard_upload) först.${own.length ? ` Dina: ${own.join(', ')}.` : ''}`
    )
  }

  /** What the uploads (but `except`) hold or will hold on disk: a known size, else what has arrived. */
  private staged(except?: Live): number {
    let sum = 0
    for (const e of this.entries.values()) {
      if (e !== except && e.status !== 'failed') sum += Math.max(e.bytes ?? 0, e.received)
    }
    return sum
  }

  /**
   * What transfers (but `except`) still have to write, less what came: a download's announced size, and a PUT's
   * declared one while its bytes can come soon (see reserves).
   */
  private outstanding(except?: Live): number {
    const now = Date.now()
    let sum = 0
    for (const e of this.entries.values()) {
      if (e !== except && this.reserves(e, now)) sum += Math.max(0, (e.bytes ?? 0) - e.received)
    }
    return sum
  }

  /**
   * Whether an upload's bytes still to come count as taken on the disk: a download's, and a PUT's while one is
   * sending or – none tried yet – within putReserveMs of begin_upload. A PUT that broke off, was stopped or was never
   * sent holds no room after that; checkPut checks the disk again before one is read.
   */
  private reserves(e: Live, now: number): boolean {
    if (e.status === 'downloading') return true
    if (e.status !== 'receiving') return false
    return !!e.request || (!e.putTried && now - e.createdAt < this.limits.putReserveMs)
  }

  /** The free-disk refusal, naming this agent's own uploads (but `except`) that hold room for bytes still to come. */
  private diskFull(client: string, except?: Live): string {
    const now = Date.now()
    const own = [...this.entries.values()]
      .filter((e) => e !== except && e.client === client && this.reserves(e, now) && (e.bytes ?? 0) > e.received)
      .map((e) => e.id)
    return own.length
      ? `${DISK_FULL} Plats hålls för dina uppladdningar som inte har kommit in än: ${own.join(', ')}. Släng de du inte längre skickar (discard_upload) först.`
      : DISK_FULL
  }

  private stagedFull(): string {
    return `Det väntar redan för mycket uppladdat i Studio (högst ${Math.round(this.limits.stagedBytes / GB)} GB tillsammans). Använd eller släng uppladdningar (discard_upload) först.`
  }

  private goneMessage(id: string): string {
    const reason = this.goneReasons.get(id)
    return reason
      ? `Uppladdningen ${id} finns inte längre (${reason.replace(/\.$/, '')}). Ladda upp filen igen.`
      : `Uppladdningen ${id} finns inte längre (den gäller i två timmar). Ladda upp filen igen.`
  }

  private isLive(entry: Live): boolean {
    return this.entries.get(entry.id) === entry
  }

  /** A URL upload still to be fetched: listed, and not ended (failed) meanwhile. */
  private stillToFetch(entry: Live): boolean {
    return this.isLive(entry) && entry.status === 'downloading'
  }

  private wake(entry: Live): void {
    for (const done of entry.waiters.splice(0)) done()
  }

  private view(entry: Live): UploadEntry {
    const {
      dir: _dir,
      viaPut: _p,
      reported: _rep,
      lastActivity: _a,
      controller: _c,
      request: _r,
      waiters: _w,
      ...rest
    } = entry
    return { ...rest }
  }

  private changed(): void {
    try {
      this.opts.notify?.('structure')
    } catch (err) {
      console.warn('Announcing an upload change failed:', err)
    }
  }

  private progressed(): void {
    const now = Date.now()
    if (now - this.lastProgress < PROGRESS_MS) return
    this.lastProgress = now
    try {
      this.opts.notify?.('progress')
    } catch (err) {
      console.warn('Announcing upload progress failed:', err)
    }
  }
}

/** "60 sekunder", "30 minuter". */
function spokenTime(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minuter` : `${Math.round(ms / 1000)} sekunder`
}

/** Free bytes on the volume of `dir`; Infinity when it can't be told (the copy itself then fails clearly). */
async function freeBytes(dir: string): Promise<number> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
