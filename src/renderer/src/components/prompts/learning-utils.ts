// Searching and filtering learnings ("Lärdomar"), and how they are described in the list.

import type { Learning } from '@shared/types'
import { REVIEW_TAGS } from '../feed/feedText'
import { fold } from './prompt-utils'

/** The same fallback main uses for an untitled learning, so the UI shows what will be stored. */
export { titleFromBody as titleFromInsight } from '@shared/prompts'

/** Main's limits (src/main/reviews.ts), shown before the user runs into them. */
export const MAX_TITLE_LENGTH = 200
export const MAX_INSIGHT_LENGTH = 4000

export type AuthorFilter = 'user' | 'agents'

export interface LearningFilters {
  query: string
  pinnedOnly: boolean
  author?: AuthorFilter
  /** A model id; learnings for every model match too. */
  model?: string
  /** Folded tags that must all be present. */
  tags: string[]
}

export const NO_LEARNING_FILTERS: LearningFilters = { query: '', pinnedOnly: false, tags: [] }

/** Every whitespace-separated term must occur in the title, insight, model or tags. */
export function matchesLearningQuery(l: Learning, query: string): boolean {
  const terms = fold(query)
    .split(/\s+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean)
  if (!terms.length) return true
  const text = fold([l.title, l.insight, l.model ?? '', ...l.tags].join('\n'))
  return terms.every((t) => text.includes(t))
}

export function matchesLearningFilters(l: Learning, f: LearningFilters): boolean {
  if (f.pinnedOnly && !l.pinned) return false
  if (f.author === 'user' && l.author !== 'user') return false
  if (f.author === 'agents' && l.author === 'user') return false
  if (f.model && l.model && l.model !== f.model) return false
  if (f.tags.length) {
    const own = new Set(l.tags.map(fold))
    if (!f.tags.every((t) => own.has(t))) return false
  }
  return matchesLearningQuery(l, f.query)
}

export function hasLearningFilters(f: LearningFilters): boolean {
  return !!(f.query.trim() || f.pinnedOnly || f.author || f.model || f.tags.length)
}

/** Tags in use, most used first, then the review vocabulary agents draw on, for the tag field's suggestions. */
export function learningTagSuggestions(learnings: readonly Learning[]): string[] {
  const counts = new Map<string, { label: string; count: number }>()
  for (const l of learnings) {
    for (const tag of l.tags) {
      const key = fold(tag)
      if (!key) continue
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { label: tag.trim(), count: 1 })
    }
  }
  const used = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'sv'))
  const seen = new Set(used.map((u) => fold(u.label)))
  return [...used.map((u) => u.label), ...REVIEW_TAGS.map((t) => t.tag).filter((t) => !seen.has(t))]
}

/** "1 klipp", "3 klipp" as evidence. */
export function evidenceText(n: number): string {
  return `${n} klipp`
}

// ── The Prompter view's tab ──────────────────────────────────────────────────

export type PromptsTab = 'prompts' | 'learnings'

const TAB_KEY = 'prompts:tab'

export function loadTab(): PromptsTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'learnings' ? 'learnings' : 'prompts'
  } catch {
    return 'prompts'
  }
}

export function saveTab(tab: PromptsTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Remembering the tab is only a convenience.
  }
}
