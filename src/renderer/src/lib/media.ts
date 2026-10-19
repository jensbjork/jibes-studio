import { isWindows } from './platform'

/**
 * URL for a local file, served by the main process's media:// protocol. A Windows path goes in the way a file URL
 * writes it (D:\Studio\a.mp4 as /D:/Studio/a.mp4, a network share's \\server\share as //server/share): main turns
 * it back into the path.
 */
export function mediaUrl(path: string): string {
  const urlPath = isWindows ? `${/^[A-Za-z]:/.test(path) ? '/' : ''}${path.replace(/\\/g, '/')}` : path
  return `media://local${urlPath.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The absolute path behind a media:// URL (the inverse of mediaUrl), or undefined for any other URL. Players add
 * fragments and queries (`#t=0.5` posters, `#t=a,b` audio windows), which are dropped first; then each segment is
 * decoded the way mediaUrl encoded it. NFC, so a name stored decomposed matches the same name composed.
 */
export function mediaPathOf(url: string | undefined): string | undefined {
  if (!url || !url.startsWith('media://local/')) return undefined
  const end = url.search(/[?#]/)
  const encoded = (end < 0 ? url : url.slice(0, end)).slice('media://local'.length)
  try {
    const path = encoded.split('/').map(decodeURIComponent).join('/').normalize('NFC')
    return isWindows ? path.replace(/^\/(?=[A-Za-z]:)/, '').replace(/\//g, '\\') : path
  } catch {
    // A malformed escape: not one of ours.
    return undefined
  }
}

export function formatUsd(v: number | undefined): string {
  if (v === undefined) return '–'
  return `$${v.toFixed(v < 0.1 ? 3 : 2)}`
}

export function formatSeconds(ms: number | undefined): string {
  if (ms === undefined) return '–'
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}
