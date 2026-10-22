// Reference videos (Seedance 2.x reference-to-video) on their way to Venice: the files measured, their windows filled
// in and checked before anything is paid for (resolveReferenceVideos), the quote's total length
// (referenceVideoSeconds), and the small proxy of each window that is actually sent (referenceVideoProxy): H.264/AAC,
// ≤ 720p, ≤ 30 fps (ffmpeg.ts makeReferenceVideoProxy), cached in .studio/tmp/referensvideor/ by the source file's
// identity and the window, so "×4", a take made again or the same video in several clips is cut only once. The cache
// lives as long as the library is open (tmp is cleared whenever one is opened) and is kept under PROXY_CACHE_BYTES.
// Only references go through here: the Editor's video to edit (referenceTask 'edit') is its own proxy, sent whole.

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { referenceVideosOf, referenceVideoWindow, videosAreReferences } from '@shared/models'
import { videoToken } from '@shared/prompt-refs'
import type { GenerationParams, ReferenceVideo, ReferenceVideoInfo } from '@shared/types'
import { extractFrames, makeReferenceVideoProxy, probe, REFERENCE_PROXY } from './ffmpeg'
import { appDataDir, APP_DATA } from './paths'

/** Inside .studio/tmp: the proxies of reference video windows (see the top of this file). */
export const REFERENCE_PROXY_FOLDER = 'reference-videos'
/** The proxy cache is pruned (least recently used first) down to this. */
const PROXY_CACHE_BYTES = 400 * 1024 ** 2

/** Milliseconds are plenty for a window, and keep the stored params readable. */
const toMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** A file's identity without reading it: device, inode, size and modification time. */
async function identity(path: string): Promise<string> {
  const s = await stat(path)
  if (!s.isFile()) throw Object.assign(new Error('It is a folder.'), { code: 'EISDIR' })
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`
}

/** What ffprobe said about a video, by file identity: a quote asks every time the form changes. */
const probed = new Map<string, { duration: number; width: number; height: number; hasAudio: boolean }>()

async function probeCached(path: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
  const key = `${path}\u0000${await identity(path)}`
  const known = probed.get(key)
  if (known) return known
  const { duration, width, height, hasAudio } = await probe(path)
  if (probed.size > 500) probed.clear()
  const info = { duration, width, height, hasAudio }
  probed.set(key, info)
  return info
}

/**
 * The length of a video file in seconds (ffprobe), remembered by the file's identity. Rejects with a plain reason
 * when the file is gone, is no video ffmpeg can read, or has no video track.
 */
export async function videoDuration(path: string): Promise<number> {
  return (await probeCached(path)).duration
}

/**
 * The length of a video file measured before (videoDuration) and unchanged since, or undefined: for answers that are
 * built synchronously (the agents' token maps). Never reads the file itself.
 */
export function knownVideoDuration(path: string): number | undefined {
  try {
    const s = statSync(path)
    return probed.get(`${path}\u0000${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`)?.duration
  } catch {
    return undefined
  }
}

/** "@Video2 (clip.mov): The file has no video track." (without the token for index -1). */
function videoError(clip: ReferenceVideo, index: number, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  const message = err instanceof Error ? err.message : String(err)
  const reason =
    code === 'ENOENT'
      ? 'The file no longer exists. Remove the video and choose it again.'
      : message.startsWith('Could not read the video file')
        ? "The file is not a video Studio can read (MP4 or MOV with H.264 or HEVC work best)."
        : message
  const what = index >= 0 ? `${videoToken(index + 1)} (${basename(clip.path)})` : basename(clip.path)
  return new Error(`${what}: ${reason}`, { cause: err })
}

/**
 * The reference videos exactly as they will be sent: each file measured with ffprobe and its window filled in (start
 * 0 and min(rest of the file, 5 s) unless chosen, never past the end of the file), so the family's per-video and
 * total limits can be checked on the real lengths before anything is paid for. Rejects when a file can't be read as a
 * video or its window starts after its end. Params without reference videos – or with the Editor's video to edit –
 * come back as they are.
 */
export async function resolveReferenceVideos(params: GenerationParams): Promise<GenerationParams> {
  const clips = referenceVideosOf(params)
  if (!clips.length || !videosAreReferences(params)) return params
  const resolved: ReferenceVideo[] = []
  for (const [i, clip] of clips.entries()) {
    let duration: number
    try {
      duration = await videoDuration(clip.path)
    } catch (err) {
      throw videoError(clip, i, err)
    }
    const window = referenceVideoWindow(clip, duration)
    if (window.length <= 0) {
      const seconds = String(Math.round(duration * 10) / 10)
      throw new Error(
        `${videoToken(i + 1)} starts after the end of ${basename(clip.path)}, which is only ${seconds} s long – move the selection.`
      )
    }
    resolved.push({ path: clip.path, start: toMs(window.start), length: toMs(window.length) })
  }
  return { ...params, referenceVideos: resolved }
}

/**
 * The seconds of reference video params send, for a Seedance quote (`reference_video_total_duration`): the windows'
 * total for references (as resolveReferenceVideos fills them in), the files' whole length for the Editor's video to
 * edit. Rounded to milliseconds; 0 without videos.
 */
export async function referenceVideoSeconds(params: GenerationParams): Promise<number> {
  const clips = referenceVideosOf(params)
  const references = videosAreReferences(params)
  let total = 0
  for (const [i, clip] of clips.entries()) {
    if (!existsSync(clip.path)) throw new Error(`A reference video no longer exists: ${basename(clip.path)}.`)
    let duration: number
    try {
      duration = await videoDuration(clip.path)
    } catch (err) {
      throw videoError(clip, i, err)
    }
    total += references ? referenceVideoWindow(clip, duration).length : duration
  }
  return toMs(total)
}

/**
 * What the window needs to show a reference video before it is sent (StudioApi.probeReferenceVideo): its length, size
 * and whether it has sound, and a poster – a JPEG (at most 512 px wide) of the frame at `at` seconds (default: 0, the
 * window's start is the usual choice), cached next to the proxies. Rejects with a plain reason when the file is no
 * video Studio can read. Only absolute paths; nothing is copied or sent.
 */
export async function probeReferenceVideo(path: unknown, at?: unknown): Promise<ReferenceVideoInfo> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('The reference video needs an absolute path.')
  const clip: ReferenceVideo = { path }
  let info: Awaited<ReturnType<typeof probeCached>>
  try {
    info = await probeCached(path)
  } catch (err) {
    throw videoError(clip, -1, err)
  }
  const time = typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.min(at, info.duration) : 0
  let poster: string | undefined
  try {
    const key = createHash('sha1')
      .update(JSON.stringify([await identity(path), toMs(time)]))
      .digest('hex')
    poster = join(cacheDir(), `${key}.jpg`)
    if (!existsSync(poster)) {
      const [frame] = await extractFrames(path, [time], 512)
      if (frame) await writeFile(poster, frame.jpeg)
      else poster = undefined
    }
  } catch (err) {
    console.warn('Could not make a poster of a reference video:', err)
    poster = undefined
  }
  return {
    path,
    duration: toMs(info.duration),
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    ...(poster ? { poster } : {})
  }
}

/** .studio/tmp/referensvideor, created when needed. */
function cacheDir(): string {
  return appDataDir(APP_DATA.tmp, REFERENCE_PROXY_FOLDER)
}

/** Proxies being made right now, by cache key: a second submit of the same window waits for the first. */
const making = new Map<string, Promise<string>>()

/** Removes the least recently used proxies until the cache is within PROXY_CACHE_BYTES. Never throws. */
async function pruneCache(dir: string, keep: string): Promise<void> {
  try {
    const files: { path: string; size: number; used: number }[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.mp4')) continue
      const path = join(dir, name)
      const s = await stat(path).catch(() => undefined)
      if (s?.isFile()) files.push({ path, size: s.size, used: s.mtimeMs })
    }
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= PROXY_CACHE_BYTES) break
      if (f.path === keep) continue
      await rm(f.path, { force: true })
      total -= f.size
    }
  } catch (err) {
    console.warn('Could not prune the reference video cache:', err)
  }
}

/**
 * The proxy Venice gets for one reference video's window (see the top of this file): from the cache when this window
 * of this very file was cut before, else made now. The window must be filled in (resolveReferenceVideos); one
 * without is cut as referenceVideoWindow says. Rejects with "@Video1 (file): <reason>" when it can't be made.
 */
export async function referenceVideoProxy(clip: ReferenceVideo, index: number): Promise<string> {
  let source: string
  try {
    source = await identity(clip.path)
  } catch (err) {
    throw videoError(clip, index, err)
  }
  const window = referenceVideoWindow(clip, clip.length === undefined ? await videoDuration(clip.path) : undefined)
  const key = createHash('sha1')
    .update(JSON.stringify([source, toMs(window.start), toMs(window.length), REFERENCE_PROXY]))
    .digest('hex')
  const dir = cacheDir()
  const path = join(dir, `${key}.mp4`)
  if (existsSync(path)) {
    // Touched: the cache is pruned least recently used first.
    const now = new Date()
    await utimes(path, now, now).catch(() => {})
    return path
  }
  const pending = making.get(key)
  if (pending) return pending
  const made = (async () => {
    try {
      await makeReferenceVideoProxy(clip.path, path, window)
    } catch (err) {
      throw videoError(clip, index, err)
    }
    await pruneCache(dir, path)
    return path
  })()
  making.set(key, made)
  try {
    return await made
  } finally {
    making.delete(key)
  }
}
