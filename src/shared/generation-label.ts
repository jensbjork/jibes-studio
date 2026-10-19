// How a generation is named and marked wherever it is listed: the feed, takes, frame pickers, file names and the
// agents' summaries. A Venice generation is named by its prompt; the user's own imported film ("Own clips") and a
// version made in the Editor have no prompt of their own and are named by their title instead (the file's name,
// "<edit> v3"), so they are never listed as an empty prompt. Pure (no Node or DOM), like everything in
// src/shared.

import { referenceVideosOf, videosAreReferences } from './models'
import type { Generation, GenerationSource } from './types'

/** What naming reads of a generation. A row without a source (from before own clips existed) is Venice's. */
export type LabelledGeneration = Pick<Generation, 'prompt'> &
  Partial<Pick<Generation, 'source' | 'title' | 'editId' | 'params'>>

/** The source of a row, with rows from before own clips existed counted as Venice generations. */
export function generationSource(g: Partial<Pick<Generation, 'source'>>): GenerationSource {
  return g.source === 'import' || g.source === 'edit' ? g.source : 'generated'
}

/** Made by Venice (also an AI take made in the Editor), as opposed to an import or a version. */
export function isVeniceGeneration(g: Partial<Pick<Generation, 'source'>>): boolean {
  return generationSource(g) === 'generated'
}

/** What a row without a prompt or title is called. */
function fallbackTitle(source: GenerationSource): string {
  switch (source) {
    case 'import':
      return 'Own clip'
    case 'edit':
      return 'Version'
    default:
      return 'No prompt'
  }
}

/** Shortens text to `max` characters (whitespace collapsed), at a word boundary when one is near, ending in "…". */
function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(flat)
  const limit = Math.max(2, Math.floor(max))
  if (chars.length <= limit) return flat
  let cut = chars.slice(0, limit - 1).join('')
  // Back to the last word boundary, unless the cut already falls on one.
  const space = cut.lastIndexOf(' ')
  if (chars[limit - 1] !== ' ' && space >= Math.floor(cut.length * 0.6)) cut = cut.slice(0, space)
  return `${cut.replace(/[\s,;:.\-–—]+$/u, '')}…`
}

/**
 * The name a generation is listed by: its title when it has one (an import's file name, a version's
 * "<edit> v3"), else its prompt, else "Own clip" / "Version" / "No prompt" by source. With `max` the
 * text is flattened to one line and shortened to at most that many characters ("…"); without it a prompt comes
 * back as written (several lines), for views that clamp it themselves.
 */
export function generationTitle(g: LabelledGeneration, max?: number): string {
  const title = typeof g.title === 'string' ? g.title.trim() : ''
  const prompt = typeof g.prompt === 'string' ? g.prompt : ''
  const text = title || (prompt.trim() ? prompt : '') || fallbackTitle(generationSource(g))
  return typeof max === 'number' && Number.isFinite(max) ? shorten(text, max) : text
}

/** What kind of badge a row gets in the feed: own clip, version, or an AI take made in the Editor. */
export type SourceBadgeKind = 'own' | 'edited' | 'edit-take'

export interface SourceBadge {
  kind: SourceBadgeKind
  /** Short label for the badge: "Own", "Edited", "Edit". */
  label: string
  /** For a tooltip. */
  description: string
}

/**
 * The feed's source badge: "Own" for the user's own imported film, "Edited" for a version made in the Editor,
 * "Edit" for an AI take made there; undefined for an ordinary Venice generation (no badge).
 */
export function sourceBadge(g: Partial<Pick<Generation, 'source' | 'editId'>>): SourceBadge | undefined {
  switch (generationSource(g)) {
    case 'import':
      return { kind: 'own', label: 'Own', description: 'Your own film, imported into the library.' }
    case 'edit':
      return { kind: 'edited', label: 'Edited', description: 'A version made in the Editor.' }
    default:
      return g.editId
        ? { kind: 'edit-take', label: 'Edit', description: 'An AI take made in the Editor.' }
        : undefined
  }
}

/**
 * Whether the row's settings can be put back in the Generate form ("Use again", "Use prompt"): only a Venice
 * generation made from a prompt, not an import, a version, or an Editor take (a video-to-video model's source video,
 * or Seedance's video to edit: an edit's proxy the form can't hold). Reference videos the form holds.
 */
export function canUseAgain(g: Partial<Pick<Generation, 'source' | 'params'>>): boolean {
  if (!isVeniceGeneration(g)) return false
  const p = g.params
  if (!p || typeof p !== 'object') return true
  // The Editor's edit sends its proxy as the video to edit; reference videos (Generate, clips) the form holds.
  return !p.sourceVideo && !(referenceVideosOf(p).length > 0 && !videosAreReferences(p))
}

/** The labels of the feed's "Source" filter, by source. */
export const SOURCE_LABELS: Readonly<Record<GenerationSource, string>> = {
  generated: 'Generated',
  import: 'Own clips',
  edit: 'Edited'
}
