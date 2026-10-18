import { GROUP_ORDER, GROUPS, type Entry, type GroupId } from './entries'
import { fold, queryTokens, wordPrefixAt } from './match'

// Ranking for ⌘K. Every word of the query must start a word of the entry: of its title, its other words or its
// detail. Where it matched decides how good the match is: the start of the title, a word of the title, the entry's
// other words, the detail (a prompt that is the title counts as one). A title that starts with the whole query, or
// is it, comes first, and then the words written together as in the query. Groups are listed by their best match;
// Clips, Images and Films list their matches newest first.

export interface Hit {
  entry: Entry
  score: number
}

export interface ResultGroup {
  id: GroupId
  label: string
  /** At most the group's cap. */
  hits: Hit[]
  /** How many matched in all. */
  total: number
}

interface Folded {
  title: string
  keywords: string
  detail: string
}

// Folded once per entry and kept for the palette's lifetime (the entries are rebuilt when it opens).
const folded = new WeakMap<Entry, Folded>()

function foldedOf(entry: Entry): Folded {
  let f = folded.get(entry)
  if (!f) {
    f = { title: fold(entry.title), keywords: fold(entry.keywords ?? ''), detail: fold(entry.detail ?? '') }
    folded.set(entry, f)
  }
  return f
}

/** A word that starts a word of the detail (or of a prompt that is the title). */
const DETAIL = 0.75

/** Places and actions win a tie with a library item of the same name ("Sequences" the view, before a sequence). */
const COMMAND_BONUS = 5

function score(entry: Entry, tokens: readonly string[], phrase: string): number | undefined {
  const f = foldedOf(entry)
  let sum = 0
  for (const token of tokens) {
    const at = wordPrefixAt(f.title, token)
    if (at === 0) sum += 3
    else if (at > 0) sum += entry.proseTitle ? DETAIL : 2
    else if (wordPrefixAt(f.keywords, token) !== -1) sum += 1.5
    else if (wordPrefixAt(f.detail, token) !== -1) sum += DETAIL
    else return undefined
  }
  if (entry.needsDetail && !tokens.some((t) => wordPrefixAt(f.detail, t) !== -1)) return undefined
  let total = (sum / tokens.length) * 100
  if (f.title === phrase) total += 100
  else if (f.title.startsWith(phrase)) total += 50
  // Several words written as they stand in the text ("change only the legs" in a prompt).
  else if (tokens.length > 1 && (wordPrefixAt(f.title, phrase) !== -1 || wordPrefixAt(f.detail, phrase) !== -1))
    total += 25
  if (entry.group === 'goto' || entry.group === 'actions') total += COMMAND_BONUS
  return total
}

const byTime = (a: Hit, b: Hit) => (b.entry.time ?? 0) - (a.entry.time ?? 0)
const byScore = (a: Hit, b: Hit) => b.score - a.score || byTime(a, b) || a.entry.title.localeCompare(b.entry.title, 'en')

function grouped(hits: Hit[]): ResultGroup[] {
  const byGroup = new Map<GroupId, Hit[]>()
  for (const hit of hits) {
    const list = byGroup.get(hit.entry.group)
    if (list) list.push(hit)
    else byGroup.set(hit.entry.group, [hit])
  }
  const groups = [...byGroup.entries()].map(([id, list]) => {
    const info = GROUPS[id]
    const best = Math.max(...list.map((h) => h.score))
    const sorted = list.sort(info.newestFirst ? byTime : byScore)
    return { id, label: info.label, hits: sorted.slice(0, info.cap), total: list.length, best }
  })
  groups.sort((a, b) => b.best - a.best || GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id))
  return groups.map(({ best: _best, ...group }) => group)
}

/**
 * The groups for a query. An empty query lists `recent` (newest first), then the places and actions marked
 * `initial`, in their own order.
 */
export function rank(entries: readonly Entry[], recent: readonly Entry[], query: string): ResultGroup[] {
  const tokens = queryTokens(query)
  if (!tokens.length) {
    const initial = entries.filter((e) => e.initial)
    const groups: ResultGroup[] = []
    if (recent.length) groups.push({ id: 'recent', label: GROUPS.recent.label, hits: recent.map(asHit), total: recent.length })
    for (const id of ['goto', 'actions'] as const) {
      const list = initial.filter((e) => e.group === id)
      if (list.length) groups.push({ id, label: GROUPS[id].label, hits: list.map(asHit), total: list.length })
    }
    return groups
  }
  const phrase = tokens.length === 1 ? tokens[0] : fold(query.trim()).replace(/\s+/gu, ' ')
  const hits: Hit[] = []
  for (const entry of entries) {
    const s = score(entry, tokens, phrase)
    if (s !== undefined) hits.push({ entry, score: s })
  }
  return grouped(hits)
}

function asHit(entry: Entry): Hit {
  return { entry, score: 0 }
}
