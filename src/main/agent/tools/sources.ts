import { basename } from 'node:path'
import { z } from 'zod'
import type { AssetFileOrigin, Still } from '@shared/types'
import { checkUrl, MAX_URL_LENGTH } from '../fetch-url'
import { callService } from '../local-ipc'
import { StillIndex, requireLibrary, type ReferenceItem } from '../studio'
import type { UploadKind } from '../upload-check'
import type { UploadEntry } from '../uploads'
import { afterCall, type ToolContext } from './kit'

// Files for the content tools. A tool never takes a path from an agent: a file is an upload (upload_id, see
// begin_upload) or a URL, which is fetched exactly as begin_upload({url}) fetches it – the same address rules, the
// same checks – and then used like an upload. A tool waits for its URLs at most URL_WAIT_MS in all; past that it
// fails without changing anything and names the uploads still on their way, so the agent can wait for them and go
// on with their ids. The uploads a call fetched are its own otherwise: they go once the call has answered (copied
// in, or of no use after a failure), so they never fill the upload limit unseen.

/** How long one tool call waits for the URLs it was given, all together. */
export const URL_WAIT_MS = 45_000

export const uploadSource = z
  .object({ upload_id: z.string().describe('A ready upload (begin_upload) of the right kind.') })
  .strict()

export const urlSource = z
  .object({
    url: z
      .string()
      .min(1)
      .max(MAX_URL_LENGTH)
      .describe("An http(s) URL Studio fetches (public addresses, or your own machine's). Same as begin_upload({url}).")
  })
  .strict()

export type FileSource = { upload_id: string } | { url: string }

/** A staged file a tool copies in. */
export interface StagedFile {
  path: string
  uploadId: string
  /** The name the agent gave it. */
  fileName: string
  /** Fetched from this host. */
  host?: string
}

/** What a URL's last path segment must end in to be taken as a file name, by kind. */
const NAME_EXTENSIONS: Record<UploadKind, ReadonlySet<string>> = {
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']),
  audio: new Set(['mp3', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'oga', 'm4a', 'aac']),
  video: new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv'])
}

/** A longer name than this from a URL is more likely an id than a name someone gave the file. */
const MAX_URL_NAME = 80

/** A run of 16 or more letters and digits with a digit in it: a token, a hash or an id rather than words. */
const TOKEN_RUN = /(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}/

/**
 * Whether a name reads like a random id even where '-', '_' or '.' break it up (base64url, nanoid: "Xk3_9fP-qL2mZ8vR",
 * "sk_live_51H8xQ2-AbCdEfGh"): inside its words it switches between letters and digits, or from a small letter to a
 * capital, at almost every other character. Names people give do so seldom ("IMG_20241009_WA0003", "MyHolidayPhoto2024",
 * "Screenshot 2024-05-12").
 */
function switchesLikeAnId(stem: string): boolean {
  let switches = 0
  let chars = 0
  for (const word of stem.split(/[^A-Za-z0-9]+/)) {
    chars += word.length
    for (let i = 1; i < word.length; i++) {
      const a = word[i - 1]
      const b = word[i]
      const digitA = a >= '0' && a <= '9'
      const digitB = b >= '0' && b <= '9'
      if (digitA !== digitB || (a >= 'a' && a <= 'z' && b >= 'A' && b <= 'Z')) switches++
    }
  }
  return chars >= 10 && switches >= 4 && switches / chars >= 0.3
}

/**
 * "IMG_2041.jpg" from a URL's path, when its last segment looks like a file name someone gave it (a short name with
 * the extension of the kind) – else a plain fallback. A URL's path often is its secret (a signed or capability link,
 * /d/8f3a9c…), and the name ends up in the library and the activity log, which must never hold a token.
 */
export function fileNameFromUrl(raw: string, kind: UploadKind): string {
  const fallback = kind === 'image' ? 'image' : kind === 'audio' ? 'sound' : 'film'
  try {
    const name = decodeURIComponent(basename(new URL(raw).pathname)).trim()
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : ''
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    const compact = stem.replace(/[-_.\s]/g, '')
    const tokenLike = TOKEN_RUN.test(stem) || /^[0-9a-f]{16,}$/i.test(compact) || switchesLikeAnId(stem)
    if (!stem || !NAME_EXTENSIONS[kind].has(ext) || name.length > MAX_URL_NAME || tokenLike) return fallback
    return name
  } catch {
    return fallback
  }
}

/** Begins a URL upload for this agent (the address rules know its machine and Studio's own port). */
export function beginUrlUpload(
  ctx: ToolContext,
  kind: UploadKind,
  url: string,
  fileName?: string
): Promise<UploadEntry> {
  return ctx.uploads.begin({
    client: ctx.clientName(),
    peer: ctx.peer(),
    kind,
    fileName: fileName ?? fileNameFromUrl(url, kind),
    source: { url, rules: { peer: ctx.peer(), ownPort: ctx.agentPort() } }
  })
}

const asEntry = (e: UploadEntry & { path: string }): StagedFile => ({
  path: e.path,
  uploadId: e.id,
  fileName: e.fileName,
  ...(e.host ? { host: e.host } : {})
})

/**
 * The files of upload and URL sources, ready to be copied in, in the order given. Uploads must be ready and of the
 * kind. URLs are all checked (and room made sure of) before the first is fetched, then fetched together and waited
 * for until `deadline` (epoch ms); one still on its way fails the call naming the uploads to go on with, one that
 * failed fails it with its reason. Nothing in the library has changed then. The URL uploads are the call's own: they
 * are thrown away once it has answered, except the ones an error names.
 */
export async function stageFiles(
  ctx: ToolContext,
  kind: UploadKind,
  sources: readonly FileSource[],
  deadline = Date.now() + URL_WAIT_MS
): Promise<StagedFile[]> {
  requireLibrary()
  // Uploads first: a wrong id is said before anything is fetched.
  for (const s of sources) if ('upload_id' in s) ctx.uploads.resolve(s.upload_id, kind)
  // Every address, and room for all of them, before the first fetch: a refusal leaves nothing behind.
  const urls = sources.filter((s): s is { url: string } => 'url' in s)
  for (const s of urls) checkUrl(s.url)
  if (urls.length) ctx.uploads.assertRoom(urls.length, ctx.clientName())
  const started = new Map<number, string>()
  /** Uploads an error hands to the agent by id, to go on with: kept. */
  const named = new Set<string>()
  afterCall(() => {
    for (const id of started.values()) if (!named.has(id)) ctx.uploads.discard(id)
  })
  for (const [i, s] of sources.entries()) {
    if ('url' in s) started.set(i, (await beginUrlUpload(ctx, kind, s.url)).id)
  }
  if (started.size) {
    const ids = [...started.values()]
    await Promise.all(ids.map((id) => ctx.uploads.waitSettled(id, Math.max(0, deadline - Date.now()))))
    const entries = ids.map((id) => ctx.uploads.get(id))
    // This call says how the fetches that ended went (its answer or its error); the log needs no entry of their own.
    for (const e of entries) if (e && (e.status === 'ready' || e.status === 'failed')) ctx.uploads.markReported(e.id)
    const failed = entries.find((e) => e?.status === 'failed')
    if (failed) {
      const others = entries.filter((e) => e && e.id !== failed.id && e.status !== 'failed').map((e) => e!.id)
      for (const id of others) named.add(id)
      throw new Error(
        `The download from ${failed.host ?? 'the address'} failed: ${failed.error ?? 'unknown error'}${
          others.length ? ` (The other files are there as upload_id ${others.join(', ')}.)` : ''
        }`
      )
    }
    const pending = entries.filter((e) => e && e.status !== 'ready').map((e) => e!.id)
    if (pending.length) {
      const ready = entries.filter((e) => e?.status === 'ready').map((e) => e!.id)
      for (const id of [...pending, ...ready]) named.add(id)
      throw new Error(
        `The download is still in progress (upload_id ${pending.join(', ')}). Wait with get_upload, then use {upload_id}.${
          ready.length ? ` The ones already done are there as upload_id ${ready.join(', ')}.` : ''
        }`
      )
    }
  }
  return sources.map((s, i) => asEntry(ctx.uploads.resolve('upload_id' in s ? s.upload_id : started.get(i)!, kind)))
}

/**
 * Who added files, for asset photos and sound clips: the agent, and the host when every file came from the same one
 * (a mix of hosts, or uploads alongside, names no host rather than a wrong one).
 */
export function originOf(ctx: ToolContext, files: readonly { host?: string }[]): Omit<AssetFileOrigin, 'at'> {
  const hosts = new Set(files.map((f) => f.host ?? ''))
  const host = hosts.size === 1 ? [...hosts][0] : ''
  return { agent: ctx.clientName().slice(0, 60), ...(host ? { host } : {}) }
}

/** An upload (or a URL) made a still: owned by a sequence or storyboard, or – without one – in "Referensbilder". */
export async function importAsStill(ctx: ToolContext, source: FileSource, ownerId?: string): Promise<Still> {
  const [file] = await stageFiles(ctx, 'image', [source])
  return callService<Still>('stills:import', file.path, ownerId)
}

/** A reference as an agent gives it: an asset's photos, a still, or an uploaded picture. */
export type ReferenceInput =
  | { asset_id: string; image_ids?: string[]; audio_ids?: string[]; include_voice?: boolean }
  | { still_id: string }
  | { upload_id: string }

/**
 * The references with loose pictures resolved to files: a still's picture; an upload made a still in "Referensbilder"
 * first (`importUploads`), so the form or clip never points into the scratch folder – or, for a check that changes
 * nothing (validate_prompt), the upload's own file.
 */
export async function resolvePictureReferences(
  ctx: ToolContext,
  items: readonly ReferenceInput[],
  importUploads: boolean
): Promise<ReferenceItem[]> {
  if (!items.some((i) => 'still_id' in i || 'upload_id' in i)) return items as ReferenceItem[]
  const stills = items.some((i) => 'still_id' in i) ? await StillIndex.load() : undefined
  const out: ReferenceItem[] = []
  for (const item of items) {
    if ('still_id' in item) out.push({ picture: stills!.require(item.still_id).path })
    else if ('upload_id' in item) {
      out.push({
        picture: importUploads
          ? (await importAsStill(ctx, { upload_id: item.upload_id })).path
          : ctx.uploads.resolve(item.upload_id, 'image').path
      })
    } else out.push(item)
  }
  return out
}
