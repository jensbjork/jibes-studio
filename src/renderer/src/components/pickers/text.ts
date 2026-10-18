// Small text helpers shared by the pickers and the params form.

import type { AssetKind, PromptLanguage } from '@shared/types'
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

/** "@Audio1, @Audio2" for 1-based reference audio indices (always spelled out: there are at most a few). */
export function formatAudioRefs(indices: readonly number[]): string {
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => `@Audio${i}`)
    .join(', ')
}

/**
 * The word in front of an asset's @AudioN inside its brackets, in the prompt language: a character's clip is its
 * voice ("Anna (@Image1, voice @Audio1)"), anything else a sound ("Stranden (@Image4, sound @Audio2)").
 */
export function audioWord(kind: AssetKind | undefined, language: PromptLanguage): string {
  if (kind === 'character') return language === 'sv' ? 'röst' : 'voice'
  return language === 'sv' ? 'ljud' : 'sound'
}

/**
 * What goes inside an asset's brackets: its @ImageN tokens, then its @AudioN tokens each with the word that says
 * what the sound is ("@Image1, @Image2, voice @Audio1"). Every index is spelled out because the model reads each
 * token on its own.
 */
export function referenceTokens(indices: readonly number[], audios: readonly number[] = [], word = 'voice'): string {
  return [
    ...[...indices].sort((a, b) => a - b).map((i) => `@Image${i}`),
    ...[...audios].sort((a, b) => a - b).map((i) => `${word} @Audio${i}`)
  ].join(', ')
}

/**
 * Prompt text that ties a library asset to its reference images (and audio), e.g. "Strandpromenaden (@Image4)"
 * or "Anna (@Image1, @Image2, voice @Audio1)".
 */
export function assetReference(
  name: string,
  indices: readonly number[],
  audios: readonly number[] = [],
  word = 'voice'
): string {
  return `${name} (${referenceTokens(indices, audios, word)})`
}

/** The word between a character and its clothes in the prompt language ("Prompt language" in Settings). */
const WEARING: Record<PromptLanguage, string> = { en: 'wearing', sv: 'i' }

/** "A", "A and B", "A, B and C" in the prompt language. */
export function promptList(items: string[], language: PromptLanguage): string {
  if (language === 'sv') return swedishList(items)
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What the clothes add after a character's reference: " wearing Red dress (@Image3)", or ''. */
export function wearingText(outfits: { name: string; indices: number[] }[], language: PromptLanguage): string {
  if (!outfits.length) return ''
  return ` ${WEARING[language]} ${promptList(
    outfits.map((o) => assetReference(o.name, o.indices)),
    language
  )}`
}

/**
 * A character with its voice and what it wears, e.g. "Anna (@Image1, @Image2, voice @Audio1) wearing Red dress
 * (@Image3)" (or "Anna (@Image1, @Image2, röst @Audio1) i …" when prompts are written in Swedish), so the model
 * knows whose voice the audio is and whose clothes the outfit images are.
 */
export function characterReference(
  name: string,
  indices: number[],
  outfits: { name: string; indices: number[] }[] = [],
  language: PromptLanguage = 'en',
  voices: readonly number[] = []
): string {
  return assetReference(name, indices, voices, audioWord('character', language)) + wearingText(outfits, language)
}

/** The words between the people and a pose: "Anna (@Image1) and Erik (@Image3) posed as in Kram (@Image5)". */
const POSED_AS_IN: Record<PromptLanguage, string> = { en: 'posed as in', sv: 'i posen' }

/**
 * A pose with the characters it applies to: "Anna (@Image1) and Erik (@Image3) posed as in Kram (@Image5)", or
 * "Anna (@Image1) och Erik (@Image3) i posen Kram (@Image5)" in Swedish. The characters are named with their own
 * photos only, so it says who takes which position without repeating their voices or clothes. Without any
 * characters it is just "posed as in Kram (@Image5)".
 */
export function poseReference(
  pose: { name: string; indices: readonly number[] },
  people: readonly { name: string; indices: readonly number[] }[],
  language: PromptLanguage = 'en'
): string {
  const who = promptList(
    people.map((p) => assetReference(p.name, p.indices)),
    language
  )
  return `${who ? `${who} ` : ''}${POSED_AS_IN[language]} ${assetReference(pose.name, pose.indices)}`
}

/** The word between a character and the product it holds: "Anna (@Image1) holding Kaffeburken (@Image4)". */
const HOLDING: Record<PromptLanguage, string> = { en: 'holding', sv: 'håller' }

/**
 * A product, held by a character when one is chosen: "Anna (@Image1) holding Kaffeburken (@Image4)", or "Anna
 * (@Image1) håller Kaffeburken (@Image4)" in Swedish. The holder is named with its own photos only (as a pose names
 * its people), so the sentence says who holds it without repeating the character's voice or clothes. Without a
 * holder it is just "Kaffeburken (@Image4)".
 */
export function productReference(
  product: { name: string; indices: readonly number[] },
  holder: { name: string; indices: readonly number[] } | undefined,
  language: PromptLanguage = 'en'
): string {
  const item = assetReference(product.name, product.indices)
  return holder ? `${assetReference(holder.name, holder.indices)} ${HOLDING[language]} ${item}` : item
}

/** "1 image", "3 images". */
export function imageCount(n: number): string {
  return `${n} ${n === 1 ? 'image' : 'images'}`
}

/** "1 sound clip", "3 sound clips". */
export function clipCount(n: number): string {
  return `${n} ${n === 1 ? 'sound clip' : 'sound clips'}`
}

/** Seconds as the form shows them: "8 s", "7.5 s" (one decimal). */
export function formatClipSeconds(seconds: number): string {
  const rounded = Math.round(Math.max(0, seconds) * 10) / 10
  return `${String(rounded)} s`
}

/** "(@Image1, @Image2, voice @Audio1)": a bracket holding nothing but reference tokens. */
const TOKEN_BRACKET =
  /\(\s*(?:(?:voice|sound|röst|ljud)\s+)?@(?:Image|Audio)\d+(?:\s*[,–-]\s*(?:(?:voice|sound|röst|ljud)\s+)?@(?:Image|Audio)\d+)*\s*\)/gi

/** A short title from the first words of a prompt, without @Image and @Audio tokens. */
export function titleFromPrompt(body: string, maxWords = 6, maxChars = 48): string {
  const clean = body
    .replace(TOKEN_BRACKET, '')
    .replace(/@(?:Image|Audio)\d+/gi, '')
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
  const terms = query.toLocaleLowerCase('en').split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = haystack.toLocaleLowerCase('en')
  return terms.every((t) => text.includes(t))
}
