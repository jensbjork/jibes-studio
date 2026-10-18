import { execFile } from 'node:child_process'
import { open, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { probeAudio } from '../ffmpeg'
import { inspectVideoFiles } from '../imports'
import { decodeImageFile } from '../input-image'

// What an agent's upload is, told from its bytes – never from its name or a server's Content-Type – and then checked
// the way Studio itself would read it: a picture must decode (and not be a decompression bomb), a sound must have
// sound, a video must pass the own-clip import's inspection. HEIC photos (iPhone) are converted to JPEG with macOS'
// own `sips`, since nothing else in Studio reads them.

const execFileAsync = promisify(execFile)

export type UploadKind = 'image' | 'audio' | 'video'

export const UPLOAD_KINDS = ['image', 'audio', 'video'] as const satisfies readonly UploadKind[]

const MB = 1024 * 1024

/** The largest file Studio takes of each kind, and how the limit is said. */
export const UPLOAD_CAPS: Readonly<Record<UploadKind, { bytes: number; label: string }>> = {
  image: { bytes: 30 * MB, label: '30 MB' },
  audio: { bytes: 100 * MB, label: '100 MB' },
  video: { bytes: 4 * 1024 * MB, label: '4 GB' }
}

/** A picture larger than this on a side, or with more pixels in all, is refused before it is decoded. */
export const MAX_IMAGE_SIDE = 16_384
export const MAX_IMAGE_PIXELS = 80_000_000

/** Below this a file has no sound worth the name (the same floor as the Editor's own audio). */
const MIN_SOUND_SECONDS = 0.05

const SIPS = '/usr/bin/sips'
const SIPS_TIMEOUT_MS = 120_000

/** "an image" / "images" … for the messages. */
export const KIND_WORDS: Readonly<Record<UploadKind, { one: string; plural: string }>> = {
  image: { one: 'an image', plural: 'images' },
  audio: { one: 'a sound', plural: 'sounds' },
  video: { one: 'a video', plural: 'videos' }
}

/** Says that the bytes are not what the agent said they were. */
export function notOfKind(kind: UploadKind): string {
  if (kind === 'image') return 'The file is not an image in JPG, PNG, WebP or HEIC.'
  if (kind === 'audio') return 'The file is not a sound in MP3, WAV, AIFF, FLAC, OGG, M4A or AAC.'
  return 'The file is not a video in MP4, MOV, M4V, WebM or MKV.'
}

export function tooLargeMessage(kind: UploadKind): string {
  return `The file is larger than Studio takes for ${KIND_WORDS[kind].plural} (at most ${UPLOAD_CAPS[kind].label}).`
}

export const IMAGE_TOO_LARGE = 'The image is too large: at most 16,384 pixels on a side and 80 megapixels.'
export const NO_SOUND = 'There is no sound in the file.'

/** What the first bytes say a file is. */
export interface Sniffed {
  /** With the dot, e.g. ".jpg": the staged file's extension always comes from here. */
  ext: string
  mime: string
  /** A HEIC/HEIF photo, converted to JPEG before anything else reads it. */
  heic?: boolean
}

/** How many leading bytes sniffing and the picture headers need (a JPEG's size can sit behind large EXIF blocks). */
export const HEAD_BYTES = 4 * MB

const ascii = (b: Buffer, from: number, to: number): string =>
  b.length >= to ? b.subarray(from, to).toString('latin1') : ''

/** The major brand of an ISO-BMFF file ("ftyp" box first), or undefined. */
function ftypBrand(b: Buffer): string | undefined {
  return ascii(b, 4, 8) === 'ftyp' ? ascii(b, 8, 12) : undefined
}

/** The compatible brands of the ftyp box (bounded by the box's size). */
function ftypCompatible(b: Buffer): string[] {
  if (ascii(b, 4, 8) !== 'ftyp' || b.length < 16) return []
  const size = Math.min(b.readUInt32BE(0), b.length, 4096)
  const out: string[] = []
  for (let i = 16; i + 4 <= size; i += 4) out.push(ascii(b, i, i + 4))
  return out
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])

/** The EBML DocType ("webm" or "matroska") of a Matroska-family file, from its header. */
function ebmlDocType(b: Buffer): string | undefined {
  const limit = Math.min(b.length, 256)
  for (let i = 4; i + 3 < limit; i++) {
    if (b[i] !== 0x42 || b[i + 1] !== 0x82) continue
    // The size is an EBML variable-length integer; doc types are short, so one length byte is the norm.
    const first = b[i + 2]
    let width = 1
    while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++
    if (width > 8 || i + 2 + width > limit) return undefined
    let size = first & (0xff >> width)
    for (let k = 1; k < width; k++) size = size * 256 + b[i + 2 + k]
    const start = i + 2 + width
    return size > 0 && size < 32 && start + size <= b.length ? ascii(b, start, start + size) : undefined
  }
  return undefined
}

/** MPEG audio frame sync (an MP3 without an ID3 tag): 11 sync bits, a valid version and a layer other than 00. */
function mpegAudioFrame(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return false
  const version = (b[1] >> 3) & 3
  const layer = (b[1] >> 1) & 3
  const bitrate = b[2] >> 4
  const rate = (b[2] >> 2) & 3
  return version !== 1 && layer !== 0 && bitrate !== 0x0f && rate !== 3
}

/** ADTS AAC: 12 sync bits and layer 00 (FFF1, FFF9…). */
function adts(b: Buffer): boolean {
  return b.length >= 7 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0
}

/**
 * What the file is, from its first bytes, if it is something Studio takes as `kind`; undefined otherwise. The
 * kind is the agent's word for it: an MP4 is a video when asked for one and its sound (".m4a") when asked for audio.
 */
export function sniff(kind: UploadKind, b: Buffer): Sniffed | undefined {
  if (kind === 'image') {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { ext: '.png', mime: 'image/png' }
    }
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
    const brand = ftypBrand(b)
    if (brand && (HEIF_BRANDS.has(brand) || ftypCompatible(b).some((c) => c === 'heic' || c === 'heix'))) {
      return { ext: '.heic', mime: 'image/heic', heic: true }
    }
    return undefined
  }
  if (kind === 'audio') {
    if (ascii(b, 0, 3) === 'ID3' || mpegAudioFrame(b)) return { ext: '.mp3', mime: 'audio/mpeg' }
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { ext: '.wav', mime: 'audio/wav' }
    if (ascii(b, 0, 4) === 'FORM' && (ascii(b, 8, 12) === 'AIFF' || ascii(b, 8, 12) === 'AIFC')) {
      return { ext: '.aiff', mime: 'audio/aiff' }
    }
    if (ascii(b, 0, 4) === 'fLaC') return { ext: '.flac', mime: 'audio/flac' }
    if (ascii(b, 0, 4) === 'OggS') return { ext: '.ogg', mime: 'audio/ogg' }
    // Any ISO-BMFF file ("M4A ", "M4B ", "mp42", "isom"…): its sound is read as an .m4a.
    if (ftypBrand(b)) return { ext: '.m4a', mime: 'audio/mp4' }
    if (adts(b)) return { ext: '.aac', mime: 'audio/aac' }
    return undefined
  }
  const brand = ftypBrand(b)
  if (brand) {
    if (HEIF_BRANDS.has(brand)) return undefined
    if (brand === 'qt  ') return { ext: '.mov', mime: 'video/quicktime' }
    if (brand.startsWith('M4V')) return { ext: '.m4v', mime: 'video/x-m4v' }
    return { ext: '.mp4', mime: 'video/mp4' }
  }
  // Older QuickTime files start with another top-level box.
  if (b.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(b, 4, 8))) {
    return { ext: '.mov', mime: 'video/quicktime' }
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return ebmlDocType(b) === 'webm' ? { ext: '.webm', mime: 'video/webm' } : { ext: '.mkv', mime: 'video/x-matroska' }
  }
  return undefined
}

export interface Size {
  width: number
  height: number
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** A JPEG's size from its frame header (stored, before any EXIF rotation; the limits are the same either way). */
function jpegSize(b: Buffer): Size | undefined {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return undefined
    const length = b.readUInt16BE(i + 2)
    if (length < 2) return undefined
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) return undefined
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  return undefined
}

function webpSize(b: Buffer): Size | undefined {
  const chunk = ascii(b, 12, 16)
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  return undefined
}

/** A picture's size as its header states it, read before anything decodes it; undefined when it can't be read. */
export function headerSize(sniffed: Sniffed, b: Buffer): Size | undefined {
  if (sniffed.mime === 'image/jpeg') return jpegSize(b)
  if (sniffed.mime === 'image/png') {
    return ascii(b, 12, 16) === 'IHDR' && b.length >= 24
      ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
      : undefined
  }
  if (sniffed.mime === 'image/webp') return webpSize(b)
  return undefined
}

export function sizeAllowed(size: Size): boolean {
  return (
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_IMAGE_SIDE &&
    size.height <= MAX_IMAGE_SIDE &&
    size.width * size.height <= MAX_IMAGE_PIXELS
  )
}

/** The first `bytes` bytes of a file. */
export async function readHead(path: string, bytes = HEAD_BYTES): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** The size sips reads from a HEIC's header (without decoding the picture). */
async function sipsSize(path: string): Promise<Size | undefined> {
  try {
    const { stdout } = await execFileAsync(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      timeout: SIPS_TIMEOUT_MS
    })
    const width = /pixelWidth:\s*(\d+)/.exec(stdout)
    const height = /pixelHeight:\s*(\d+)/.exec(stdout)
    return width && height ? { width: Number(width[1]), height: Number(height[1]) } : undefined
  } catch {
    return undefined
  }
}

/** A HEIC photo as a JPEG beside it (the HEIC is removed); the JPEG's path. */
async function heicToJpeg(path: string): Promise<string> {
  const out = join(dirname(path), `${basename(path, extname(path))}.jpg`)
  try {
    await execFileAsync(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', path, '--out', out], {
      timeout: SIPS_TIMEOUT_MS
    })
  } catch {
    await rm(out, { force: true }).catch(() => {})
    throw new Error("The HEIC image couldn't be converted to JPEG.")
  }
  await rm(path, { force: true }).catch(() => {})
  return out
}

/** What a checked upload is: images their size, sound its length, video what the import inspection found. */
export type UploadInfo =
  | { kind: 'image'; width: number; height: number }
  | { kind: 'audio'; duration: number }
  | { kind: 'video'; duration: number; width: number; height: number; fps: number; workingCopy: string[] }

export interface CheckedUpload {
  /** Where the file is now (a HEIC became a .jpg next to it). */
  path: string
  mime: string
  info: UploadInfo
}

/**
 * Checks a staged file that sniffed as `sniffed`: the picture's stated size first (bombs never reach a decoder),
 * HEIC converted, then decoded; a sound probed for sound; a video inspected like an own clip. Throws the
 * refusal; the caller removes the file.
 */
export async function checkUpload(kind: UploadKind, path: string, sniffed: Sniffed): Promise<CheckedUpload> {
  if (kind === 'image') {
    let file = path
    let mime = sniffed.mime
    if (sniffed.heic) {
      const stated = await sipsSize(path)
      if (!stated) throw new Error(notOfKind('image'))
      if (!sizeAllowed(stated)) throw new Error(IMAGE_TOO_LARGE)
      file = await heicToJpeg(path)
      mime = 'image/jpeg'
    } else {
      const stated = headerSize(sniffed, await readHead(path))
      if (!stated) throw new Error(notOfKind('image'))
      if (!sizeAllowed(stated)) throw new Error(IMAGE_TOO_LARGE)
    }
    const decoded = await decodeImageFile(file).catch(() => undefined)
    const image = decoded?.image
    if (!image || image.isEmpty()) throw new Error(notOfKind('image'))
    const { width, height } = image.getSize()
    if (!sizeAllowed({ width, height })) throw new Error(IMAGE_TOO_LARGE)
    return { path: file, mime, info: { kind: 'image', width, height } }
  }
  if (kind === 'audio') {
    let duration: number
    try {
      ;({ duration } = await probeAudio(path))
    } catch {
      throw new Error(NO_SOUND)
    }
    if (!(duration > MIN_SOUND_SECONDS)) throw new Error(NO_SOUND)
    return { path, mime: sniffed.mime, info: { kind: 'audio', duration } }
  }
  const [inspected] = await inspectVideoFiles([path])
  if (!inspected?.ok) {
    // The import's refusal names the staged file ("<namn>.mp4: …"); the reason is what matters.
    throw new Error(inspected?.error?.replace(/^[^:]*:\s*/, '') || notOfKind('video'))
  }
  return {
    path,
    mime: sniffed.mime,
    info: {
      kind: 'video',
      duration: inspected.duration ?? 0,
      width: inspected.width ?? 0,
      height: inspected.height ?? 0,
      fps: inspected.fps ?? 0,
      workingCopy: inspected.workingCopy
    }
  }
}
