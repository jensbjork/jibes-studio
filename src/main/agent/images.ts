import { readFile, stat } from 'node:fs/promises'
import { nativeImage } from 'electron'

/** An MCP image content block. */
export interface ImageBlock {
  type: 'image'
  /** Base64. */
  data: string
  mimeType: string
}

/** An MCP audio content block. */
export interface AudioBlock {
  type: 'audio'
  /** Base64. */
  data: string
  mimeType: string
}

/** A JPEG ffmpeg made (a frame from a video) as image content, as it is. */
export function jpegBlock(jpeg: Buffer): ImageBlock {
  return { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }
}

/** An MP3 ffmpeg made (a voice's reference window, a clip's soundtrack) as audio content. */
export function mp3Block(mp3: Buffer): AudioBlock {
  return { type: 'audio', data: mp3.toString('base64'), mimeType: 'audio/mpeg' }
}

/** Longest side of the pictures agents get: enough for a vision model to judge faces, clothes and places. */
export const AGENT_IMAGE_MAX_SIDE = 768

/** Pictures nativeImage can't decode are passed on as they are, but only small ones. */
const MAX_PASSTHROUGH_BYTES = 1_500_000

/** The picture type from the file's first bytes (not its name), or undefined when it is no picture we know. */
function sniffType(head: Buffer): string | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** Recently converted pictures, so an agent looking at the same character twice doesn't decode it twice. */
const cache = new Map<string, ImageBlock>()
const CACHE_SIZE = 48

function remember(key: string, block: ImageBlock): ImageBlock {
  cache.delete(key)
  cache.set(key, block)
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return block
}

/**
 * A photo or poster frame as MCP image content: a JPEG at most AGENT_IMAGE_MAX_SIDE pixels on its long side.
 * Undefined when the file is missing or can't be read as a picture.
 */
export async function imageBlock(path: string, maxSide = AGENT_IMAGE_MAX_SIDE): Promise<ImageBlock | undefined> {
  let info
  try {
    info = await stat(path)
  } catch {
    return undefined
  }
  if (!info.isFile()) return undefined
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}\u0000${maxSide}`
  const cached = cache.get(key)
  if (cached) return remember(key, cached)

  let image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    if (info.size > MAX_PASSTHROUGH_BYTES) return undefined
    const bytes = await readFile(path)
    const mimeType = sniffType(bytes)
    if (!mimeType) return undefined
    return remember(key, { type: 'image', data: bytes.toString('base64'), mimeType })
  }
  const { width, height } = image.getSize()
  if (Math.max(width, height) > maxSide) {
    image = image.resize(width >= height ? { width: maxSide, quality: 'good' } : { height: maxSide, quality: 'good' })
  }
  return remember(key, { type: 'image', data: image.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' })
}
