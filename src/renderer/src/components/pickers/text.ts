// Small text helpers shared by the pickers and the params form.

import type { PromptLanguage } from '@shared/types'
import { swedishList } from '../../lib/assets'

/** "@Image1–@Image3, @Image5" for 1-based reference indices. */
export function formatImageRefs(indices: number[]): string {
  const runs: [number, number][] = []
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && i === last[1] + 1) last[1] = i
    else runs.push([i, i])
  }
  return runs
    .map(([a, b]) => {
      if (a === b) return `@Image${a}`
      if (b === a + 1) return `@Image${a}, @Image${b}`
      return `@Image${a}–@Image${b}`
    })
    .join(', ')
}

/**
 * Prompt text that ties a library asset to its reference images, e.g. "Strandpromenaden (@Image4)".
 * Every index is spelled out because the model reads each @ImageN token on its own.
 */
export function assetReference(name: string, indices: number[]): string {
  return `${name} (${[...indices]
    .sort((a, b) => a - b)
    .map((i) => `@Image${i}`)
    .join(', ')})`
}

/** The word between a character and its clothes in the prompt language ("Promptspråk" in Settings). */
const WEARING: Record<PromptLanguage, string> = { en: 'wearing', sv: 'i' }

/** "A", "A and B", "A, B and C" in the prompt language. */
export function promptList(items: string[], language: PromptLanguage): string {
  if (language === 'sv') return swedishList(items)
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What the clothes add after a character's reference: " wearing Röd klänning (@Image3)", or ''. */
export function wearingText(outfits: { name: string; indices: number[] }[], language: PromptLanguage): string {
  if (!outfits.length) return ''
  return ` ${WEARING[language]} ${promptList(
    outfits.map((o) => assetReference(o.name, o.indices)),
    language
  )}`
}

/**
 * A character with what it wears, e.g. "Anna (@Image1, @Image2) wearing Röd klänning (@Image3)" (or "… i …"
 * when prompts are written in Swedish), so the model knows whose clothes the outfit images are.
 */
export function characterReference(
  name: string,
  indices: number[],
  outfits: { name: string; indices: number[] }[] = [],
  language: PromptLanguage = 'en'
): string {
  return assetReference(name, indices) + wearingText(outfits, language)
}

/** "1 bild", "3 bilder". */
export function imageCount(n: number): string {
  return `${n} ${n === 1 ? 'bild' : 'bilder'}`
}

/** A short title from the first words of a prompt, without @Image tokens. */
export function titleFromPrompt(body: string, maxWords = 6, maxChars = 48): string {
  const clean = body
    .replace(/\(\s*@Image\d+(?:\s*[,–-]\s*@Image\d+)*\s*\)/gi, '')
    .replace(/@Image\d+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  let title = clean.split(' ').slice(0, maxWords).join(' ')
  if (title.length > maxChars) title = title.slice(0, maxChars)
  title = title.replace(/[\s,.;:!?–-]+$/, '')
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** 83 → "1:23". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Case-insensitive match where every whitespace-separated term must occur somewhere in the haystack. */
export function matchesQuery(haystack: string, query: string): boolean {
  const terms = query.toLocaleLowerCase('sv').split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = haystack.toLocaleLowerCase('sv')
  return terms.every((t) => text.includes(t))
}
