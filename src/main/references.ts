// Reference material: start/end/reference images, reference audio clips and reference videos picked from outside the
// library are copied into Referensbilder/<day>/ when a generation is submitted (a video cloned on the library's
// volume), so the generation (and its "use again") keeps working after the originals are moved or deleted, and the
// user finds the material next to the output.
// Also the file-placement helpers the other media modules share: everything that lands in a visible folder
// is written to the library's scratch folder first and then moved into place under a free name.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, type Stats } from 'node:fs'
import { constants, copyFile, readdir, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { referenceVideosOf } from '@shared/models'
import type { GenerationParams } from '@shared/types'
import { isInsideRoot, movePath, referencesDayDir, safeName, tmpDir, uniqueName } from './paths'

/** How many times a placement retries when another writer (Finder, another module) takes the name first. */
const PLACE_ATTEMPTS = 5
/** Forget cached hashes beyond this; they are cheap to recompute for the few files a day folder holds. */
const MAX_CACHED_HASHES = 2000

/** Runs the tasks given to it one at a time, in call order; a failing task doesn't block the next. */
export function serialized(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
}

/** A short reason for a failed file operation, for messages like "Could not copy x: <reason>." */
export function fileErrorReason(err: unknown): string {
  switch ((err as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
      return 'the file does not exist'
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EISDIR':
      return 'it is a folder'
    case 'ENOSPC':
      return 'the disk is full'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

const placing = serialized()

/**
 * Moves src (normally a finished file in the scratch folder) into dir as "<base><ext>", or "<base> (2)<ext>" …
 * when that name is taken, and returns the new absolute path. Serialized, so two placements in the same
 * folder can't both pick the same free name; never overwrites anything.
 */
export function placeFile(src: string, dir: string, base: string, ext: string): Promise<string> {
  return placing(async () => {
    for (let attempt = 1; ; attempt++) {
      const target = join(dir, uniqueName(dir, base, ext))
      try {
        await movePath(src, target)
        return target
      } catch (err) {
        // Someone else created that name between the check and the move: take the next free one.
        if (attempt < PLACE_ATTEMPTS && existsSync(src) && existsSync(target)) continue
        throw err
      }
    }
  })
}

/**
 * Copies src into dir under a free name derived from base (see placeFile), going through the scratch
 * folder so a half-copied file never shows up in a visible folder. The source is left untouched.
 */
export async function copyInto(src: string, dir: string, base: string, ext: string): Promise<string> {
  const tmp = join(tmpDir(), `${randomUUID()}${ext}`)
  try {
    await copyFile(src, tmp, constants.COPYFILE_EXCL)
    const [from, to] = await Promise.all([stat(src), stat(tmp)])
    if (from.size !== to.size) throw new Error('the copy was incomplete')
    return await placeFile(tmp, dir, base, ext)
  } finally {
    // Gone already when the placement succeeded.
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function abortError(): Error {
  return Object.assign(new Error('Cancelled.'), { name: 'AbortError' })
}

/**
 * Copies src to dest (which must not exist) as a stream, reporting progress and stopping on `signal`; a partial
 * dest is removed on failure. For multi-GB films, which fs.copyFile could neither report on nor stop.
 */
async function streamCopy(
  src: string,
  dest: string,
  size: number,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void }
): Promise<void> {
  let copied = 0
  let reported = -1
  const input = createReadStream(src)
  input.on('data', (chunk) => {
    copied += chunk.length
    const fraction = size > 0 ? Math.min(1, copied / size) : 1
    // At most every whole percent, so a big file doesn't flood the window with events.
    if (opts.onProgress && Math.floor(fraction * 100) !== reported) {
      reported = Math.floor(fraction * 100)
      opts.onProgress(fraction)
    }
  })
  try {
    await pipeline(input, createWriteStream(dest, { flags: 'wx' }), { signal: opts.signal })
  } catch (err) {
    // 'wx' failing means dest belongs to someone else: leave it alone.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await rm(dest, { force: true }).catch(() => {})
    if (opts.signal?.aborted) throw abortError()
    throw err
  }
}

/** Whether src lies on the same volume as the library (an APFS clone can't cross volumes). */
async function onLibraryVolume(src: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(src), stat(tmpDir())])
    return a.dev === b.dev
  } catch {
    return false
  }
}

/**
 * Like copyInto, but as an APFS clone when the source is on the library's volume (instant, and it takes no extra
 * space until one of the two changes). From another volume the file is copied as a stream, so a big film reports
 * progress and stops on `signal` (the half-made copy is removed; the source is never touched). Resolves with the
 * new absolute path, as copyInto.
 */
export async function cloneInto(
  src: string,
  dir: string,
  base: string,
  ext: string,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<string> {
  if (opts.signal?.aborted) throw abortError()
  const tmp = join(tmpDir(), `${randomUUID()}${ext}`)
  try {
    const from = await stat(src)
    if (await onLibraryVolume(src)) {
      // COPYFILE_FICLONE: macOS clones where the file system can (APFS) and copies where it can't. (FICLONE_FORCE,
      // which would fail instead, isn't implemented on macOS: ENOSYS.)
      await copyFile(src, tmp, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
    } else {
      await streamCopy(src, tmp, from.size, opts)
    }
    const to = await stat(tmp)
    if (from.size !== to.size) throw new Error('the copy was incomplete')
    if (opts.signal?.aborted) throw abortError()
    opts.onProgress?.(1)
    return await placeFile(tmp, dir, base, ext)
  } finally {
    // Gone already when the placement succeeded.
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** Whether a clone of src into the library would work: both on the same volume (VideoFileInfo.cloneable). */
export function canCloneIntoLibrary(src: string): Promise<boolean> {
  return onLibraryVolume(src)
}

// ── Content hashes ───────────────────────────────────────────────────────────

const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>()

function sha1(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function fileHash(path: string, info: Stats): Promise<string> {
  const cached = hashCache.get(path)
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.hash
  const hash = await sha1(path)
  if (hashCache.size >= MAX_CACHED_HASHES) hashCache.clear()
  hashCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash })
  return hash
}

/** A file in dir with exactly this content, if there is one. */
async function findIdentical(dir: string, size: number, hash: string): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile() && info.size === size && (await fileHash(path, info)) === hash) return path
    } catch {
      // Removed or unreadable meanwhile: not a match.
    }
  }
  return undefined
}

// ── Import ───────────────────────────────────────────────────────────────────

type Material = 'image' | 'audio' | 'video'

/** The library copy of one outside file: an identical file already in today's folder, or a new copy. */
async function importFile(src: string, dir: string, material: Material, keptAs?: string): Promise<string> {
  const name = basename(src)
  try {
    const info = await stat(src)
    if (!info.isFile()) throw Object.assign(new Error('it is a folder'), { code: 'EISDIR' })
    const existing = await findIdentical(dir, info.size, await fileHash(src, info))
    if (existing) return existing
    const ext = extname(src)
    const fallback = material === 'audio' ? 'Referensljud' : material === 'video' ? 'Referensvideo' : 'Referensbild'
    const base = safeName(keptAs ? basename(keptAs, extname(keptAs)) : basename(src, ext), { fallback })
    // A video can be large: cloned on the library's volume (instant, no extra space), else copied as a stream.
    const copy =
      material === 'video'
        ? await cloneInto(src, dir, base, ext.toLowerCase())
        : await copyInto(src, dir, base, ext.toLowerCase())
    // The copy has the same content; remember that so the next lookup doesn't read it again.
    const cached = hashCache.get(src)
    const copied = await stat(copy).catch(() => undefined)
    if (cached && copied) hashCache.set(copy, { size: copied.size, mtimeMs: copied.mtimeMs, hash: cached.hash })
    return copy
  } catch (err) {
    const what = material === 'audio' ? 'the audio file' : material === 'video' ? 'the video' : 'the image'
    throw new Error(`Could not copy ${what} ${name} to the library: ${fileErrorReason(err)}.`)
  }
}

/**
 * An outside file copied into Referensbilder/<today>/ (an identical one already there is reused): an agent's uploaded
 * reference video, so the form or clip never points into the scratch folder, which is cleared at every library open.
 * `name` is the name the file is kept under (its own when left out). Resolves with the library copy.
 */
export function importReferenceFile(src: string, material: Material, name?: string): Promise<string> {
  return importing(async () => {
    const dir = referencesDayDir(new Date())
    return importFile(src, dir, material, name)
  })
}

/**
 * Every file the params send, with what it is (for the wording when it can't be copied): images, reference audio,
 * and the source and reference videos of video-to-video models.
 */
export function referencedFiles(params: GenerationParams): { path: string; material: Material }[] {
  const images = [params.startImage, params.endImage, ...(params.referenceImages ?? [])].map((path) => ({
    path,
    material: 'image' as const
  }))
  const audio = (params.referenceAudios ?? []).map((clip) => ({ path: clip?.path, material: 'audio' as const }))
  const videos = [params.sourceVideo, ...referenceVideosOf(params).map((v) => v.path)].map((path) => ({
    path,
    material: 'video' as const
  }))
  return [...images, ...audio, ...videos].filter(
    (f): f is { path: string; material: Material } => typeof f.path === 'string' && f.path !== ''
  )
}

const importing = serialized()

/**
 * Copies every start/end/reference image, reference audio clip and source/reference video that lies outside the
 * library into Referensbilder/<today>/ (keeping its original name, made unique) and returns params pointing at the
 * copies (each audio clip and reference video keeps its window). An edit's proxies are made in its Underlag/ folder,
 * so of videos in practice only reference videos (Generate, a sequence clip) are ever copied: the whole file, so the
 * window can still be moved on "Use again". Files already in the library (photos and voice clips of assets, earlier
 * references, continuation frames) are left as they are, and a file whose exact content is already in today's
 * folder is reused instead of copied again.
 */
export function importExternalReferences(params: GenerationParams): Promise<GenerationParams> {
  const external = new Map<string, Material>()
  for (const f of referencedFiles(params)) {
    if (isAbsolute(f.path) && !isInsideRoot(f.path) && !external.has(f.path)) external.set(f.path, f.material)
  }
  if (!external.size) return Promise.resolve(params)
  // One import at a time, so the same file used by two submits at once is copied only once.
  return importing(async () => {
    const dir = referencesDayDir(new Date())
    const copies = new Map<string, string>()
    for (const [src, material] of external) copies.set(src, await importFile(src, dir, material))
    const local = (p: string): string => copies.get(p) ?? p
    const result: GenerationParams = { ...params }
    if (params.startImage) result.startImage = local(params.startImage)
    if (params.endImage) result.endImage = local(params.endImage)
    if (params.referenceImages) result.referenceImages = params.referenceImages.map(local)
    if (params.referenceAudios) {
      result.referenceAudios = params.referenceAudios.map((clip) =>
        clip?.path ? { ...clip, path: local(clip.path) } : clip
      )
    }
    if (params.sourceVideo) result.sourceVideo = local(params.sourceVideo)
    if (Array.isArray(params.referenceVideos)) {
      result.referenceVideos = referenceVideosOf(params).map((v) => ({ ...v, path: local(v.path) }))
    }
    return result
  })
}
