import { deflateSync } from 'node:zlib'
import { BrowserWindow, nativeImage, type NativeImage } from 'electron'

// Windows' stand-ins for the Dock: the count of new and failed work becomes a red dot over Studio's taskbar button
// (Windows has no badge with a number; the dot's description, read by screen readers, has the count), and a request
// that needs the user flashes the taskbar button until Studio's window is in front. macOS uses app.dock instead
// (index.ts, agent/service.ts); nothing here runs there.

let count = 0
let dot: NativeImage | undefined

/** The number of new and failed work on the taskbar button: a dot while it isn't 0. */
export function setTaskbarBadge(n: number): void {
  count = n
  for (const win of BrowserWindow.getAllWindows()) applyBadge(win)
}

/** A window opened after the badge was set gets it too (Windows draws it per window). */
export function showTaskbarBadgeOn(win: BrowserWindow): void {
  if (count) applyBadge(win)
}

function applyBadge(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (!count) {
    win.setOverlayIcon(null, '')
    return
  }
  dot ??= nativeImage.createFromBuffer(badgeDotPng(32), { scaleFactor: 2 })
  win.setOverlayIcon(dot, count === 1 ? '1 new or failed' : `${count} new or failed`)
}

/** Flashes the taskbar button of a window that isn't in front, until it is. */
export function flashTaskbar(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.isFocused()) continue
    win.flashFrame(true)
    win.once('focus', () => {
      if (!win.isDestroyed()) win.flashFrame(false)
    })
  }
}

// ── The dot ──────────────────────────────────────────────────────────────────

/**
 * A `size`×`size` PNG of a red dot (the colour of macOS' badge) with a thin white rim, so it reads on a light and a
 * dark taskbar; its edge is anti-aliased. Drawn here rather than shipped as a file.
 */
export function badgeDotPng(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4)
  const centre = size / 2
  const outer = size / 2 - 0.5
  const rim = Math.max(1, size / 16)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre)
      const coverage = Math.min(1, Math.max(0, outer - d + 0.5))
      if (!coverage) continue
      const inRim = Math.min(1, Math.max(0, d - (outer - rim) + 0.5))
      const i = (y * size + x) * 4
      // Red #FF3B30 inside, white at the rim.
      rgba[i] = 0xff
      rgba[i + 1] = Math.round(0x3b * (1 - inRim) + 0xff * inRim)
      rgba[i + 2] = Math.round(0x30 * (1 - inRim) + 0xff * inRim)
      rgba[i + 3] = Math.round(255 * coverage)
    }
  }
  return png(size, size, rgba)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An 8-bit RGBA PNG of the pixels (rows top to bottom, no filtering). */
function png(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
