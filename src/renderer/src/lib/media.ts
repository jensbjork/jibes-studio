/** URL for a local file, served by the main process's media:// protocol. */
export function mediaUrl(path: string): string {
  return `media://local${path.split('/').map(encodeURIComponent).join('/')}`
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
