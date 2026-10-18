// Matching for ⌘K: case- and accent-insensitive ("anna" finds "Änna", "cafe" finds "Café"), by word prefix ("sum"
// finds "Summer beach" and "a summer day", not "consume"), every word of the query somewhere in the entry. Text is
// folded once per entry and kept; only the rows on screen are folded again with a map back to the original, for the
// highlights.

/** Letters that don't decompose into a base letter and a mark. */
const SPECIAL: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' }
const SPECIAL_RE = /[øæœßłđðþı]/gu
const MARKS = /\p{M}/gu
const WORD_CHAR = /[\p{L}\p{N}]/u

/** Lower case, without accents. */
export function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(MARKS, '').replace(SPECIAL_RE, (c) => SPECIAL[c] ?? c)
}

/** The words of a query, folded; duplicates and words contained in a longer one dropped. */
export function queryTokens(query: string): string[] {
  const words = [...new Set(fold(query).split(/\s+/u).filter(Boolean))].sort((a, b) => b.length - a.length)
  return words.filter((w, i) => !words.slice(0, i).some((longer) => longer.startsWith(w)))
}

/** Where the token starts a word in the folded text, or -1. */
export function wordPrefixAt(text: string, token: string): number {
  let at = text.indexOf(token)
  while (at !== -1) {
    if (at === 0 || !WORD_CHAR.test(text[at - 1])) return at
    at = text.indexOf(token, at + 1)
  }
  return -1
}

/** A range [start, end) in a string. */
export type Range = [number, number]

/** A text folded character by character, with where each folded character came from. */
interface MappedFold {
  text: string
  /** Per folded UTF-16 unit: the start and end of the original character it came from. */
  starts: number[]
  ends: number[]
}

function foldMapped(source: string): MappedFold {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let i = 0
  for (const ch of source) {
    const next = i + ch.length
    const folded = fold(ch)
    for (let k = 0; k < folded.length; k++) {
      starts.push(i)
      ends.push(next)
    }
    text += folded
    i = next
  }
  return { text, starts, ends }
}

/** Overlapping or touching ranges joined, in order. */
function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Where the tokens are in `text` (original indices): each token's first word-prefix match. */
export function matchRanges(text: string, tokens: readonly string[]): Range[] {
  if (!tokens.length || !text) return []
  const mapped = foldMapped(text)
  const ranges: Range[] = []
  for (const token of tokens) {
    const at = wordPrefixAt(mapped.text, token)
    if (at === -1) continue
    ranges.push([mapped.starts[at], mapped.ends[at + token.length - 1]])
  }
  return merge(ranges)
}

/** Whitespace (new lines too) as single spaces, so a prompt shows on one line. */
export function flatten(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * At most about `max` characters of a flattened text, cut around its first highlight (with "…" where it was cut),
 * and the highlights moved along.
 */
export function excerpt(text: string, ranges: readonly Range[], max: number): { text: string; ranges: Range[] } {
  if (text.length <= max) return { text, ranges: [...ranges] }
  const first = ranges[0]?.[0] ?? 0
  // A little context before the match, from the start of a word.
  let start = Math.max(0, first - Math.floor(max / 4))
  if (start > 0) {
    const space = text.lastIndexOf(' ', start)
    start = space !== -1 && first - space <= max / 2 ? space + 1 : start
  }
  let end = Math.min(text.length, start + max)
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > start + max * 0.6) end = space
  }
  const lead = start > 0 ? '…' : ''
  const shift = lead.length - start
  return {
    text: `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    ranges: ranges
      .filter(([a, b]) => b > start && a < end)
      .map(([a, b]): Range => [Math.max(a, start) + shift, Math.min(b, end) + shift])
  }
}
