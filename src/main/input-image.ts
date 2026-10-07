// Pictures read for sending to Venice (keyframes, reference images) and for agents to look at, decoded the way
// Studio's own <img> shows them. Electron's nativeImage ignores a JPEG's EXIF orientation, so a portrait phone photo
// that every view shows upright would otherwise be sent sideways (and an image-to-video take, which takes its shape
// from the start image, come out rotated); and it can't decode WebP at all, which ffmpeg can.

import { readFile } from 'node:fs/promises'
import { nativeImage, type NativeImage } from 'electron'
import { stillToPng } from './ffmpeg'

const isJpeg = (bytes: Uint8Array): boolean => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8

const isWebp = (bytes: Buffer): boolean =>
  bytes.length >= 12 &&
  bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
  bytes.subarray(8, 12).toString('latin1') === 'WEBP'

/**
 * The EXIF orientation of a JPEG (1–8; 1, upright, when it has none or it can't be read): the tag 0x0112 of the
 * first image directory of its APP1 "Exif" segment.
 */
export function jpegOrientation(bytes: Buffer): number {
  if (!isJpeg(bytes)) return 1
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1
    const marker = bytes[at + 1]
    // Fill bytes, and markers without a length.
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    // Start of scan or end of image: the metadata segments all come before.
    if (marker === 0xda || marker === 0xd9) return 1
    const length = bytes.readUInt16BE(at + 2)
    if (length < 2) return 1
    const start = at + 4
    const end = Math.min(bytes.length, at + 2 + length)
    if (marker === 0xe1 && end - start > 14 && bytes.subarray(start, start + 6).toString('latin1') === 'Exif\0\0') {
      const orientation = tiffOrientation(bytes.subarray(start + 6, end))
      if (orientation) return orientation
    }
    at = at + 2 + length
  }
  return 1
}

/** The orientation tag of a TIFF block's first directory (EXIF is TIFF inside the APP1 segment), or undefined. */
function tiffOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined
  const order = tiff.subarray(0, 2).toString('latin1')
  if (order !== 'II' && order !== 'MM') return undefined
  const little = order === 'II'
  const u16 = (o: number): number => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number): number => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  const dir = u32(4)
  if (dir + 2 > tiff.length) return undefined
  const count = u16(dir)
  for (let i = 0; i < count; i++) {
    const entry = dir + 2 + i * 12
    if (entry + 12 > tiff.length) return undefined
    if (u16(entry) !== 0x0112) continue
    // A SHORT, stored in the first two bytes of the value field.
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? value : undefined
  }
  return undefined
}

/**
 * The picture turned the way EXIF orientation `orientation` says it is shown: 2 mirrored, 3 turned half round,
 * 4 flipped, 5 transposed, 6 turned a quarter clockwise, 7 transversed, 8 turned a quarter anticlockwise. Works on
 * the raw pixels, which are moved as whole 4-byte pixels, so their byte order doesn't matter.
 */
export function orientImage(image: NativeImage, orientation: number): NativeImage {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return image
  const { width: w, height: h } = image.getSize()
  if (!w || !h) return image
  const raw = image.toBitmap()
  // A Uint32Array view needs a 4-byte aligned offset; a copy has one.
  const bytes = raw.byteOffset % 4 === 0 ? raw : Buffer.from(raw)
  const from = new Uint32Array(bytes.buffer, bytes.byteOffset, w * h)
  const sideways = orientation >= 5
  const W = sideways ? h : w
  const H = sideways ? w : h
  const out = new Uint32Array(W * H)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let nx: number
      let ny: number
      switch (orientation) {
        case 2:
          nx = w - 1 - x
          ny = y
          break
        case 3:
          nx = w - 1 - x
          ny = h - 1 - y
          break
        case 4:
          nx = x
          ny = h - 1 - y
          break
        case 5:
          nx = y
          ny = x
          break
        case 6:
          nx = h - 1 - y
          ny = x
          break
        case 7:
          nx = h - 1 - y
          ny = w - 1 - x
          break
        default:
          nx = y
          ny = w - 1 - x
      }
      out[ny * W + nx] = from[row + x]
    }
  }
  return nativeImage.createFromBitmap(Buffer.from(out.buffer), { width: W, height: H })
}

/**
 * A picture file decoded as it is shown: a JPEG turned upright by its EXIF orientation, a WebP decoded by ffmpeg.
 * Undefined when it can't be decoded (no ffmpeg for a WebP, say); the caller then has only the file's bytes, which
 * it is given too.
 */
export async function decodeImageFile(path: string): Promise<{ image?: NativeImage; bytes: Buffer }> {
  const bytes = await readFile(path)
  if (isWebp(bytes)) {
    try {
      const image = nativeImage.createFromBuffer(await stillToPng(path))
      return { image: image.isEmpty() ? undefined : image, bytes }
    } catch (err) {
      console.warn(`Could not decode ${path} with ffmpeg:`, err)
      return { bytes }
    }
  }
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return { bytes }
  return { image: orientImage(image, jpegOrientation(bytes)), bytes }
}
