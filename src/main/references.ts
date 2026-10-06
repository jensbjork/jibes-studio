// Reference material: start/end/reference images picked from outside the library are copied into
// Referensbilder/<day>/ when a generation is submitted, so the generation (and its "use again") keeps working
// after the originals are moved or deleted, and the user finds the material next to the output.
// Also the file-placement helpers the other media modules share: everything that lands in a visible folder
// is written to the library's scratch folder first and then moved into place under a free name.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, type Stats } from 'node:fs'
import { constants, copyFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
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

/** A short Swedish reason for a failed file operation, for messages like "Kunde inte kopiera x: <reason>." */
export function fileErrorReason(err: unknown): string {
  switch ((err as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
      return 'filen finns inte'
    case 'EACCES':
    case 'EPERM':
      return 'behörighet saknas'
    case 'EISDIR':
      return 'det är en mapp'
    case 'ENOSPC':
      return 'disken är full'
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
    if (from.size !== to.size) throw new Error('kopian blev ofullständig')
    return await placeFile(tmp, dir, base, ext)
  } finally {
    // Gone already when the placement succeeded.
    await rm(tmp, { force: true }).catch(() => {})
  }
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

/** The library copy of one outside image: an identical file already in today's folder, or a new copy. */
async function importImage(src: string, dir: string): Promise<string> {
  const name = basename(src)
  try {
    const info = await stat(src)
    if (!info.isFile()) throw Object.assign(new Error('det är en mapp'), { code: 'EISDIR' })
    const existing = await findIdentical(dir, info.size, await fileHash(src, info))
    if (existing) return existing
    const ext = extname(src)
    const copy = await copyInto(src, dir, safeName(basename(src, ext), { fallback: 'Referensbild' }), ext.toLowerCase())
    // The copy has the same content; remember that so the next lookup doesn't read it again.
    const cached = hashCache.get(src)
    const copied = await stat(copy).catch(() => undefined)
    if (cached && copied) hashCache.set(copy, { size: copied.size, mtimeMs: copied.mtimeMs, hash: cached.hash })
    return copy
  } catch (err) {
    throw new Error(`Kunde inte kopiera bilden ${name} till biblioteket: ${fileErrorReason(err)}.`)
  }
}

function imagePaths(params: GenerationParams): string[] {
  return [params.startImage, params.endImage, ...(params.referenceImages ?? [])].filter(
    (p): p is string => typeof p === 'string' && p !== ''
  )
}

const importing = serialized()

/**
 * Copies every start/end/reference image that lies outside the library into Referensbilder/<today>/ (keeping
 * its original name, made unique) and returns params pointing at the copies. Images already in the library
 * (photos of characters, environments and outfits, earlier references, continuation frames) are left as they
 * are, and an image whose exact content is already in today's folder is reused instead of copied again.
 */
export function importExternalImages(params: GenerationParams): Promise<GenerationParams> {
  const external = [...new Set(imagePaths(params).filter((p) => isAbsolute(p) && !isInsideRoot(p)))]
  if (!external.length) return Promise.resolve(params)
  // One import at a time, so the same picture used by two submits at once is copied only once.
  return importing(async () => {
    const dir = referencesDayDir(new Date())
    const copies = new Map<string, string>()
    for (const src of external) copies.set(src, await importImage(src, dir))
    const local = (p: string): string => copies.get(p) ?? p
    const result: GenerationParams = { ...params }
    if (params.startImage) result.startImage = local(params.startImage)
    if (params.endImage) result.endImage = local(params.endImage)
    if (params.referenceImages) result.referenceImages = params.referenceImages.map(local)
    return result
  })
}
