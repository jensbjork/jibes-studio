// fal.ai's HTTP API, with nothing but fetch: the queue every model runs on (submit, status, result, cancel), the
// storage files are uploaded to (fal's models take files as links) and a key check. The key is sent as
// "Authorization: Key …". Studio asks fal not to keep a request's inputs and outputs in its request history
// (X-Fal-Store-IO: 0) and lets uploaded and generated files expire after a day (X-Fal-Object-Lifecycle-Preference):
// Studio has downloaded its result long before. Without stored payloads fal keeps a finished result for an hour, so
// a job must be fetched within the hour it is done (index.ts asks before quitting while one runs).

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { fetchOrExplain, networkError, NetworkError, ServiceError } from './service-error'

const QUEUE_URL = 'https://queue.fal.run'
const STORAGE_URL = 'https://rest.fal.ai/storage'
const API_URL = 'https://api.fal.ai/v1'

/** How long fal keeps a file Studio uploads or a model makes: a day. */
const FILE_TTL_SECONDS = 24 * 3600
/** An upload is reused this long (well within FILE_TTL_SECONDS), e.g. by ×4 variants of the same references. */
const UPLOAD_REUSE_MS = 6 * 3600_000

/** fal answered with an error (see ServiceError); the message is already the one to show. */
export class FalError extends ServiceError {}

export { NetworkError }

/** A queued request's state: waiting (with its place in the queue), running, or done (its result can be fetched). */
export type FalStatus = { state: 'queued'; position?: number } | { state: 'running' } | { state: 'done' }

/** The `owner/app` a queue URL is built on: fal's request URLs use only the endpoint id's first two parts. */
function appOf(endpoint: string): string {
  const parts = endpoint.split('/').filter(Boolean)
  return parts.slice(0, 2).join('/')
}

const NO_KEY = 'No fal.ai API key is set. Add it in Settings.'

/** A plain message from one of fal's error bodies (model errors, queue errors, the platform API's). */
export function falErrorMessage(status: number, body: unknown, text: string): string {
  const b = body as {
    detail?: unknown
    error?: { type?: string; message?: string } | string
    message?: string
  }
  const details = Array.isArray(b?.detail) ? (b.detail as { msg?: string; type?: string; loc?: unknown[] }[]) : []
  if (details.some((d) => d?.type === 'content_policy_violation')) {
    return 'fal.ai refused the content: it breaks the content policy of fal or the model. Change the prompt or the pictures.'
  }
  const detail = details.length
    ? details
        .map((d) => {
          const where = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : ''
          return [where, d.msg].filter(Boolean).join(': ')
        })
        .filter(Boolean)
        .join('; ')
    : typeof b?.detail === 'string'
      ? b.detail
      : typeof b?.error === 'string'
        ? b.error
        : (b?.error?.message ?? b?.message ?? text.slice(0, 300))
  if (status === 401) return "fal.ai didn't accept the API key. Check it in Settings."
  if (status === 403) {
    return `fal.ai refused the request: the key may not be allowed to use this model, or the account is out of credits${detail ? ` (${detail})` : ''}.`
  }
  if (status === 404) return `fal.ai doesn't know this model or request${detail ? ` (${detail})` : ''}.`
  if (status === 413) return 'The input is too large for fal.ai.'
  if (status === 429) return 'fal.ai is busy right now (too many requests). Studio tries again.'
  return detail ? `fal.ai: ${detail}` : `fal.ai answered ${status}.`
}

async function errorFrom(res: Response): Promise<FalError> {
  const text = await res.text().catch(() => '')
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON; keep the text.
  }
  return new FalError(falErrorMessage(res.status, body, text), res.status, body)
}

/** The MIME type a file is uploaded as, from its name. */
export function mimeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    default:
      return 'video/mp4'
  }
}

export class FalClient {
  private readonly uploads = new Map<string, { at: number; url: string }>()

  constructor(private readonly getKey: () => string | null) {}

  hasKey(): boolean {
    return !!this.getKey()
  }

  private headers(extra: Record<string, string> = {}): Headers {
    const key = this.getKey()
    if (!key) throw new FalError(NO_KEY, 401)
    return new Headers({ Authorization: `Key ${key}`, ...extra })
  }

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    const res = await fetchOrExplain(url, init, what)
    if (!res.ok && res.status !== 202) throw await errorFrom(res)
    return res
  }

  /**
   * Sends a request to an endpoint's queue (paid once it runs). Resolves with fal's request id. Never retried by
   * Studio: a send that failed may still have been queued, and the caller says so.
   */
  async submit(endpoint: string, input: Record<string, unknown>): Promise<{ requestId: string }> {
    const res = await this.call(
      `${QUEUE_URL}/${endpoint}`,
      {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/json',
          'X-Fal-Store-IO': '0',
          'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: FILE_TTL_SECONDS })
        }),
        body: JSON.stringify(input)
      },
      'Could not reach fal.ai.'
    )
    const json = (await res.json().catch(() => ({}))) as { request_id?: unknown }
    if (typeof json.request_id !== 'string' || !json.request_id) {
      throw new FalError(
        'fal.ai answered without a request ID. It may have been charged anyway – check your usage.',
        502
      )
    }
    return { requestId: json.request_id }
  }

  /** Where a request stands. A finished one may still have failed: result() then throws its error. */
  async status(endpoint: string, requestId: string): Promise<FalStatus> {
    const res = await this.call(
      `${QUEUE_URL}/${appOf(endpoint)}/requests/${encodeURIComponent(requestId)}/status`,
      { headers: this.headers() },
      'Could not reach fal.ai.'
    )
    const json = (await res.json().catch(() => ({}))) as { status?: string; queue_position?: number }
    if (json.status === 'COMPLETED') return { state: 'done' }
    if (json.status === 'IN_PROGRESS') return { state: 'running' }
    return { state: 'queued', ...(typeof json.queue_position === 'number' ? { position: json.queue_position } : {}) }
  }

  /** A finished request's output, as the model's schema has it; throws the model's error for a failed one. */
  async result<T>(endpoint: string, requestId: string): Promise<T> {
    const res = await this.call(
      `${QUEUE_URL}/${appOf(endpoint)}/requests/${encodeURIComponent(requestId)}`,
      { headers: this.headers() },
      'Could not reach fal.ai.'
    )
    try {
      return (await res.json()) as T
    } catch (err) {
      throw networkError(err, 'The answer could not be read from fal.ai.')
    }
  }

  /** Asks fal to drop a request that hasn't started (one already running may still finish). */
  async cancel(endpoint: string, requestId: string): Promise<void> {
    await fetchOrExplain(
      `${QUEUE_URL}/${appOf(endpoint)}/requests/${encodeURIComponent(requestId)}/cancel`,
      { method: 'PUT', headers: this.headers() },
      'Could not reach fal.ai.'
    ).catch(() => {})
  }

  /**
   * Sends a request and waits for its output (images, speech, a transcript: a minute or two at most). `timeoutMs`
   * gives up waiting, not the request: it has been sent and may still be charged.
   */
  async run<T>(
    endpoint: string,
    input: Record<string, unknown>,
    o: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    const { requestId } = await this.submit(endpoint, input)
    return this.wait<T>(endpoint, requestId, o)
  }

  /** Polls a sent request until it is done, then returns its output (see run). */
  async wait<T>(
    endpoint: string,
    requestId: string,
    o: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    const deadline = Date.now() + o.timeoutMs
    let failures = 0
    for (;;) {
      if (o.signal?.aborted) throw new Error('Stopped.')
      try {
        const status = await this.status(endpoint, requestId)
        failures = 0
        if (status.state === 'done') return await this.result<T>(endpoint, requestId)
      } catch (err) {
        // A lost connection or fal's own trouble: keep asking until the deadline, the request is paid for.
        const transient =
          err instanceof NetworkError || (err instanceof FalError && (err.status >= 500 || err.status === 429))
        if (!transient || ++failures > 20) throw err
      }
      if (Date.now() > deadline) {
        throw new FalError('fal.ai took too long to answer. The request may still finish and be charged.', 504)
      }
      await new Promise((r) => setTimeout(r, o.pollMs ?? 1500))
    }
  }

  /**
   * Uploads bytes to fal's storage and returns their link, which a model's input can name. The file expires after
   * a day. The same bytes uploaded again within a few hours give the same link without a new upload.
   */
  async upload(data: Buffer, contentType: string, fileName: string): Promise<string> {
    const hash = createHash('sha256').update(data).update(contentType).digest('hex')
    const cached = this.uploads.get(hash)
    if (cached && Date.now() - cached.at < UPLOAD_REUSE_MS) return cached.url
    const lifecycle = JSON.stringify({ expiration_duration_seconds: FILE_TTL_SECONDS })
    const init = await this.call(
      `${STORAGE_URL}/upload/initiate?storage_type=fal-cdn-v3`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', 'X-Fal-Object-Lifecycle-Preference': lifecycle }),
        body: JSON.stringify({ file_name: fileName, content_type: contentType })
      },
      'Could not upload to fal.ai.'
    )
    const { upload_url: uploadUrl, file_url: fileUrl } = (await init.json().catch(() => ({}))) as {
      upload_url?: string
      file_url?: string
    }
    if (!uploadUrl || !fileUrl) throw new FalError('fal.ai gave no place to upload the file to.', 502)
    const put = await fetchOrExplain(
      uploadUrl,
      { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(data) },
      'Could not upload to fal.ai.'
    )
    if (!put.ok) throw await errorFrom(put)
    if (this.uploads.size > 500) this.uploads.clear()
    this.uploads.set(hash, { at: Date.now(), url: fileUrl })
    return fileUrl
  }

  /** A file on disk uploaded (see upload). */
  async uploadFile(path: string, contentType = mimeOf(path)): Promise<string> {
    return this.upload(await readFile(path), contentType, basename(path))
  }

  /**
   * Checks the key with a free call (fal's price list needs one). fal shows the balance only to keys made for billing,
   * so none is given.
   */
  async testKey(): Promise<void> {
    await this.call(
      `${API_URL}/models/pricing?endpoint_id=bytedance/seedance-2.5/text-to-video`,
      { headers: this.headers() },
      'Could not reach fal.ai.'
    )
  }

  /** Downloads a model's output file (fal's file links need no key). */
  async download(url: string, what = 'The file could not be downloaded from fal.ai.'): Promise<Buffer> {
    if (!url) throw new FalError('fal.ai sent no link to the result.', 502)
    const res = await fetchOrExplain(url, undefined, what)
    if (!res.ok) throw new FalError(`The download from fal.ai failed (${res.status}).`, res.status)
    try {
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      throw networkError(err, what)
    }
  }
}
