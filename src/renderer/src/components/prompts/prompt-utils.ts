import type { SavedPrompt } from '@shared/types'

/** The backend's fallback title, so the UI shows exactly what will be stored for an untitled prompt. */
export { titleFromBody } from '@shared/prompts'

export type SortKey = 'updated' | 'used' | 'lastUsed' | 'title'

export const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'updated', label: 'Senast ändrad' },
  { id: 'used', label: 'Mest använd' },
  { id: 'lastUsed', label: 'Senast använd' },
  { id: 'title', label: 'Namn A–Ö' }
]

export function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((o) => o.id === value)
}

/** Comparison key for text; tags are unique per prompt ignoring case (the backend dedupes that way). */
export const fold = (s: string): string => s.trim().toLocaleLowerCase('sv')

export interface TagInfo {
  /** Folded, used for filtering. */
  key: string
  /** As first written. */
  label: string
  count: number
}

/** Every tag in use, most used first. */
export function collectTags(prompts: SavedPrompt[]): TagInfo[] {
  const tags = new Map<string, TagInfo>()
  for (const p of prompts) {
    for (const tag of p.tags) {
      const key = fold(tag)
      if (!key) continue
      const info = tags.get(key)
      if (info) info.count++
      else tags.set(key, { key, label: tag.trim(), count: 1 })
    }
  }
  return [...tags.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'sv'))
}

/** Every whitespace-separated term must occur in the title, body, negative prompt or tags. */
export function matchesQuery(p: SavedPrompt, query: string): boolean {
  const terms = fold(query)
    .split(/\s+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean)
  if (!terms.length) return true
  const text = fold([p.title, p.body, p.negativePrompt ?? '', ...p.tags].join('\n'))
  return terms.every((t) => text.includes(t))
}

export function hasTags(p: SavedPrompt, keys: string[]): boolean {
  if (!keys.length) return true
  const own = new Set(p.tags.map(fold))
  return keys.every((k) => own.has(k))
}

const comparators: Record<SortKey, (a: SavedPrompt, b: SavedPrompt) => number> = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  used: (a, b) => b.useCount - a.useCount || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
  lastUsed: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
  title: (a, b) => a.title.localeCompare(b.title, 'sv', { sensitivity: 'base' })
}

/** Favourites always come first, whatever the chosen order. */
export function sortPrompts(prompts: SavedPrompt[], key: SortKey): SavedPrompt[] {
  return [...prompts].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || comparators[key](a, b) || b.updatedAt - a.updatedAt
  )
}

/** Splits comma/newline separated input into trimmed, non-empty tags. */
export function parseTags(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Appends the tags that aren't already present, ignoring case. */
export function addTags(current: string[], added: string[]): string[] {
  const seen = new Set(current.map(fold))
  const next = [...current]
  for (const tag of added) {
    const key = fold(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    next.push(tag.trim())
  }
  return next
}

const timeFormat = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' })
const fullFormat = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' })

/** "i dag 14:32", "i går 09:10", "3 okt." or "3 okt. 2025". */
export function formatWhen(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  if (ts >= today) return `i dag ${timeFormat.format(date)}`
  if (ts >= yesterday) return `i går ${timeFormat.format(date)}`
  return date.getFullYear() === now.getFullYear() ? dayFormat.format(date) : fullFormat.format(date)
}

export function formatUses(count: number): string {
  if (count === 0) return 'Aldrig använd'
  return count === 1 ? 'Använd 1 gång' : `Använd ${count} gånger`
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // The async clipboard API refuses while the window isn't focused; fall back to the legacy path.
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    el.remove()
  }
}
