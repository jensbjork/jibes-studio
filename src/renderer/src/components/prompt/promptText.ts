// Pure helpers behind the prompt editor: which picture each @ImageN token names, what to highlight, what the
// "@" menu offers, and the text edits its choices and the quick fixes make. No DOM and no React here.

import type { Kind } from '@shared/models'
import { findImageTokens, findMalformedTokens, type PromptIssue } from '@shared/prompt-refs'
import { ASSET_KINDS, type Asset, type AssetKind, type PromptLanguage } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { assetReference, imageCount, wearingText } from '../pickers/text'

// ── References ───────────────────────────────────────────────────────────────

/** One reference image as the prompt sees it: the N in @ImageN and what the picture shows. */
export interface PromptReference {
  /** N in @ImageN, 1-based. */
  index: number
  path: string
  /** The library asset the photo belongs to; undefined for a picture added from disk. */
  asset?: Asset
  /** 1-based position of the photo among the asset's photos ("foto 2"). */
  photo?: number
  /** False for pictures past the model's limit: they are not sent. */
  sent: boolean
}

/** The form's reference images as @ImageN references. */
export function promptReferences(
  refs: readonly string[],
  byPath: ReadonlyMap<string, Asset>,
  max: number
): PromptReference[] {
  return refs.map((path, i) => {
    const asset = byPath.get(path)
    const photo = asset ? asset.images.findIndex((img) => img.path === path) + 1 : 0
    return { index: i + 1, path, asset, photo: photo || undefined, sent: i < max }
  })
}

/** "Anna · foto 2", or "Egen bild · strand.jpg" for a picture that isn't a library photo. */
export function referenceLabel(ref: PromptReference): string {
  if (!ref.asset) return `Egen bild · ${fileName(ref.path)}`
  return ref.photo ? `${ref.asset.name} · foto ${ref.photo}` : ref.asset.name
}

/** "@Image3 · Anna (foto 2)", the hover card's title line. */
export function referenceTitle(ref: PromptReference): string {
  if (!ref.asset) return `@Image${ref.index} · egen bild`
  return `@Image${ref.index} · ${ref.asset.name}${ref.photo ? ` (foto ${ref.photo})` : ''}`
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * The @ImageN numbers the prompt mentions: its tokens, and what its misspelled ones clearly meant (those are
 * errors of their own, so the picture isn't also reported as unmentioned).
 */
export function mentionedIndices(prompt: string): Set<number> {
  return new Set([
    ...findImageTokens(prompt).map((t) => t.index),
    ...findMalformedTokens(prompt).flatMap((m) => suggestedNumbers(m.suggestion))
  ])
}

/** The pictures that are sent but never mentioned in the prompt. */
export function unusedReferences(prompt: string, references: readonly PromptReference[]): PromptReference[] {
  const used = mentionedIndices(prompt)
  return references.filter((r) => r.sent && !used.has(r.index))
}

// ── Inserting references ─────────────────────────────────────────────────────

/** An asset among the references, as the prompt names it: "Anna (@Image1, @Image2) wearing …". */
export interface ReferenceGroup {
  name: string
  /** Its @ImageN numbers. */
  indices: number[]
  /** For a character: the outfits it wears in the form. */
  outfits?: { name: string; indices: number[] }[]
}

export interface AssetGroup extends ReferenceGroup {
  asset: Asset
}

function tokenList(indices: readonly number[]): string {
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => `@Image${i}`)
    .join(', ')
}

/** The whole reference for a group: "Anna (@Image1, @Image2) wearing Röd klänning (@Image3)". */
export function groupText(group: ReferenceGroup, language: PromptLanguage): string {
  return assetReference(group.name, group.indices) + wearingText(group.outfits ?? [], language)
}

/**
 * What choosing a group inserts, given the text in front of the insertion point:
 * - after "(" only the tokens ("@Image1, @Image2"): the brackets are being written by hand;
 * - right after the name ("Anna ") the bracketed tokens and the clothes;
 * - otherwise the whole reference (see groupText).
 */
export function groupInsertText(group: ReferenceGroup, language: PromptLanguage, before: string): string {
  if (/\(\s*$/.test(before)) return tokenList(group.indices)
  const head = before.replace(/\s+$/, '')
  const name = group.name.trim()
  if (name && head.toLocaleLowerCase('sv').endsWith(name.toLocaleLowerCase('sv'))) {
    const prev = head.slice(0, head.length - name.length)
    if (!prev || /[^\p{L}\p{N}]$/u.test(prev)) {
      return `(${tokenList(group.indices)})${wearingText(group.outfits ?? [], language)}`
    }
  }
  return groupText(group, language)
}

/** `text` with the spaces it needs to sit between `before` and `after` (none before "(" or punctuation). */
export function spacedInsert(before: string, after: string, text: string): string {
  const lead = before && !/[\s(]$/.test(before) ? ' ' : ''
  const trail = !after || !/^[\s,.;:!?)]/.test(after) ? ' ' : ''
  return lead + text + trail
}

// ── The "@" being typed ──────────────────────────────────────────────────────

export interface AtQuery {
  /** Position of the "@". */
  start: number
  /** End of the word being typed (the caret, or further when typing inside a word). */
  end: number
  /** What follows the "@" up to the caret. */
  query: string
}

// An "@" at the start or after a space, bracket, quote or punctuation – not inside an e-mail address.
const AT_QUERY = /(?:^|[\s([{"'“‘,;:])@([\p{L}\p{N}_-]{0,40})$/u
const WORD_TAIL = /^[\p{L}\p{N}_-]*/u

/** The "@word" the caret is in, if any. */
export function atQueryAt(text: string, caret: number): AtQuery | undefined {
  const head = text.slice(Math.max(0, caret - 64), caret)
  const m = AT_QUERY.exec(head)
  if (!m) return undefined
  const query = m[1]
  const tail = WORD_TAIL.exec(text.slice(caret))?.[0] ?? ''
  return { start: caret - query.length - 1, end: caret + tail.length, query }
}

// ── Highlighting ─────────────────────────────────────────────────────────────

/** A highlighted stretch of the prompt: an @ImageN token, a near miss, or an @-name that is no reference. */
export interface PromptMark {
  start: number
  end: number
  /** valid: names a picture that is sent. error: blocks generating. warning: advice ("@Anna" is plain text). */
  tone: 'valid' | 'error' | 'warning'
  /** N of an @ImageN token (for a near miss: of its suggested spelling). */
  index?: number
  /** Kind of the asset a valid token's picture belongs to; undefined for a picture from disk. */
  kind?: AssetKind
  /** What is wrong (Swedish). */
  problem?: string
  /** The right spelling of a near miss, e.g. "@Image3" for "@img3". */
  suggestion?: string
}

export const NOT_REFERENCE_MODE =
  'Referensbilder används bara i läget Referens – i det här läget skickas inga referensbilder.'

function missingImageText(n: number, count: number): string {
  if (!count) return `@Image${n} finns inte – inga referensbilder är valda än.`
  return `@Image${n} finns inte – bara ${imageCount(count)} ${count === 1 ? 'är vald' : 'är valda'}.`
}

/** The @ImageN numbers in a suggested spelling ("@Image1, @Image2" for "@Image1-2"). */
function suggestedNumbers(suggestion: string | undefined): number[] {
  return suggestion ? [...suggestion.matchAll(/@Image(\d+)/g)].map((m) => Number(m[1])) : []
}

/**
 * What to highlight, in order and without overlaps. Tokens are checked here too, so they can be coloured
 * by the asset they name; whatever the shared rules (prompt-refs) report about a place in the text wins,
 * with their wording, so what blocks a generation is always visible where it is.
 */
export function promptMarks(
  prompt: string,
  references: readonly PromptReference[],
  kind: Kind,
  maxImages: number,
  issues: readonly PromptIssue[]
): PromptMark[] {
  const reference = kind === 'reference-to-video'
  // Outside reference mode the rules report the first token only; its message covers them all.
  const notReference = reference
    ? undefined
    : (issues.find((i) => i.code === 'not-reference-mode')?.message ?? NOT_REFERENCE_MODE)
  const marks: PromptMark[] = []
  for (const t of findImageTokens(prompt)) {
    const ref = references[t.index - 1]
    const problem =
      notReference ??
      (!ref
        ? missingImageText(t.index, references.length)
        : !ref.sent
          ? `@Image${t.index} skickas inte – modellen tar max ${imageCount(maxImages)}.`
          : undefined)
    marks.push({
      start: t.start,
      end: t.end,
      tone: problem ? 'error' : 'valid',
      index: t.index,
      kind: ref?.asset?.kind,
      problem
    })
  }
  for (const m of findMalformedTokens(prompt)) {
    const numbers = suggestedNumbers(m.suggestion)
    marks.push({
      start: m.start,
      end: m.end,
      tone: 'error',
      index: numbers.length === 1 ? numbers[0] : undefined,
      suggestion: m.suggestion,
      problem:
        notReference ??
        (m.suggestion
          ? `Felstavad hänvisning – skrivs ${m.suggestion}.`
          : 'Ofullständig hänvisning – skriv @Image och bildens nummer, t.ex. @Image1.')
    })
  }
  for (const issue of issues) {
    if (issue.start === undefined || issue.end === undefined || issue.end <= issue.start) continue
    if (issue.code === 'not-reference-mode') continue
    const { start, end } = issue
    const hit = marks.filter((m) => m.start < end && start < m.end)
    if (issue.severity === 'error') {
      for (const m of hit) {
        m.tone = 'error'
        m.problem = issue.message
      }
      if (!hit.length) marks.push({ start, end, tone: 'error', problem: issue.message })
    } else if (!hit.length) {
      marks.push({ start, end, tone: 'warning', problem: issue.message })
    }
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: PromptMark[] = []
  let reached = 0
  for (const m of marks) {
    const end = Math.min(m.end, prompt.length)
    if (m.start < reached || end <= m.start) continue
    out.push({ ...m, end })
    reached = end
  }
  return out
}

/** A stretch of the prompt as the editor's mirror layer renders it. */
export interface PromptSegment {
  start: number
  end: number
  /** Index into the marks, for highlighted stretches. */
  mark?: number
}

export function segmentsOf(length: number, marks: readonly PromptMark[]): PromptSegment[] {
  const out: PromptSegment[] = []
  let pos = 0
  marks.forEach((m, i) => {
    if (m.start > pos) out.push({ start: pos, end: m.start })
    out.push({ start: m.start, end: m.end, mark: i })
    pos = m.end
  })
  if (pos < length) out.push({ start: pos, end: length })
  return out
}

// ── Edits ────────────────────────────────────────────────────────────────────

export interface TextRange {
  start: number
  end: number
}

export interface TextEdit extends TextRange {
  text: string
}

/** Applies non-overlapping edits. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/** The single smallest edit that turns `a` into `b`, or undefined when they are equal. */
export function diffEdit(a: string, b: string): TextEdit | undefined {
  if (a === b) return undefined
  let start = 0
  const max = Math.min(a.length, b.length)
  while (start < max && a[start] === b[start]) start++
  let tail = 0
  while (tail < max - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { start, end: a.length - tail, text: b.slice(start, b.length - tail) }
}

/**
 * The text without the given stretches (tokens), tidied the way a person would: "Anna (@Image7) walks" →
 * "Anna walks", "(@Image1, @Image7)" → "(@Image1)", and no doubled spaces or space before punctuation.
 */
export function removeRanges(text: string, ranges: readonly TextRange[]): string {
  let out = text
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = removeOne(out, r.start, r.end)
  return out
}

function removeOne(text: string, start: number, end: number): string {
  let left = text.slice(0, start)
  let right = text.slice(end)
  const open = /\([ \t]*$/.exec(left)
  const close = /^[ \t]*\)/.exec(right)
  const commaBefore = /[ \t]*,[ \t]*$/.exec(left)
  const commaAfter = /^[ \t]*,[ \t]*/.exec(right)
  if (open && close) {
    // "(T)": the brackets go too.
    left = left.slice(0, open.index)
    right = right.slice(close[0].length)
  } else if (commaAfter && (open || commaBefore || !left || /\s$/.test(left))) {
    // "(T, X", ", T, X" or "blurry T, X": the comma after it goes, with its space.
    right = right.slice(commaAfter[0].length)
    if (left && !/[\s(]$/.test(left)) right = ` ${right}`
  } else if (commaBefore && (close || /^[ \t]*(?:$|\r?\n|[.;:!?])/.test(right))) {
    // ", T)" or ", T." at the end of a list: the comma before it goes.
    left = left.slice(0, commaBefore.index)
  }
  if (!right || /^\r?\n/.test(right)) left = left.replace(/[ \t]+$/, '')
  else if (!left || /\n$/.test(left)) right = right.replace(/^[ \t]+/, '')
  else if (/[ \t]$/.test(left) && /^[ \t]/.test(right)) right = right.replace(/^[ \t]+/, '')
  else if (/[ \t]$/.test(left) && /^[,.;:!?)]/.test(right)) left = left.replace(/[ \t]+$/, '')
  return left + right
}

/** Every token and near miss in the prompt, for "remove all references". */
export function allTokenRanges(prompt: string): TextRange[] {
  return [...findImageTokens(prompt), ...findMalformedTokens(prompt)]
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start)
}

// ── The "@" menu ─────────────────────────────────────────────────────────────

export type MenuItem =
  /** An asset among the references: inserts "Anna (@Image1, @Image2) …". */
  | { type: 'group'; key: string; group: AssetGroup }
  /** One reference image: inserts "@Image3". */
  | { type: 'image'; key: string; reference: PromptReference }
  /** A library asset not (fully) among the references: adds its photos and inserts its reference. */
  | { type: 'library'; key: string; asset: Asset; status: string; warning?: string; disabled: boolean }

export interface MenuSection {
  key: 'references' | 'library'
  title: string
  items: MenuItem[]
  /** Matches left out to keep the list short. */
  more: number
}

/** True when `query` starts the text or one of its words (case-insensitive). */
export function startsWord(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLocaleLowerCase('sv')
  return t.startsWith(query) || t.split(/[\s\-–_(),.:;/]+/).some((w) => w.startsWith(query))
}

function kindWords(kind: AssetKind): string {
  const copy = ASSET_COPY[kind]
  return `${copy.singular} ${copy.plural}`
}

/** How a library asset fits among the references, as AssetPicker reports it. */
function libraryStatus(
  asset: Asset,
  inRefs: ReadonlySet<string>,
  free: number,
  byId: ReadonlyMap<string, Asset>
): { status: string; warning?: string; disabled: boolean } {
  const total = asset.images.length
  if (!total) return { status: `${ASSET_COPY[asset.kind].singular} · inga bilder än`, disabled: true }
  const used = asset.images.filter((img) => inRefs.has(img.path)).length
  const pending = total - used
  const status =
    `${ASSET_COPY[asset.kind].singular} · ${imageCount(total)}` + (used ? ` · ${used} redan tillagda` : '')
  if (!free) return { status, warning: 'får inte plats', disabled: true }
  if (pending > free) return { status, warning: `bara ${free} får plats`, disabled: false }
  const outfit =
    asset.kind === 'character' && asset.defaultOutfitId ? byId.get(asset.defaultOutfitId) : undefined
  const outfitPending = outfit?.kind === 'outfit' ? outfit.images.filter((img) => !inRefs.has(img.path)).length : 0
  if (outfitPending > free - pending) return { status, warning: 'kläderna får inte plats', disabled: false }
  return { status, disabled: false }
}

const LIBRARY_ROWS = { browsing: 6, searching: 12 }

/**
 * The "@" menu: the references first (each asset, then its pictures), then library assets that can be
 * added. `query` is what follows the "@"; it matches @ImageN numbers, names and kinds by word start.
 */
export function tokenMenuSections(options: {
  query: string
  references: readonly PromptReference[]
  groups: readonly AssetGroup[]
  /** The whole library; omit to leave out "Lägg till från biblioteket". */
  library?: readonly Asset[]
  maxImages: number
}): MenuSection[] {
  const { references, groups, library, maxImages } = options
  const q = options.query.toLocaleLowerCase('sv').replace(/^@/, '')
  const sections: MenuSection[] = []

  const referenceItems: MenuItem[] = []
  const imageMatches = (r: PromptReference): boolean =>
    `image${r.index}`.startsWith(q) ||
    String(r.index).startsWith(q) ||
    (!!r.asset && (startsWord(r.asset.name, q) || startsWord(kindWords(r.asset.kind), q)))
  const listed = new Set<string>()
  for (const r of references) {
    if (r.asset) {
      if (listed.has(r.asset.id)) continue
      listed.add(r.asset.id)
      const group = groups.find((g) => g.asset.id === r.asset!.id)
      if (group && (startsWord(group.name, q) || startsWord(kindWords(group.asset.kind), q))) {
        referenceItems.push({ type: 'group', key: `group:${group.asset.id}`, group })
      }
      for (const own of references) {
        if (own.asset?.id === r.asset.id && imageMatches(own)) {
          referenceItems.push({ type: 'image', key: `image:${own.index}`, reference: own })
        }
      }
    } else if (imageMatches(r) || (!!q && startsWord('egen bild', q))) {
      referenceItems.push({ type: 'image', key: `image:${r.index}`, reference: r })
    }
  }
  if (referenceItems.length) sections.push({ key: 'references', title: 'Referensbilder', items: referenceItems, more: 0 })

  if (library) {
    const inRefs = new Set(references.map((r) => r.path))
    const free = Math.max(0, maxImages - references.length)
    const byId = new Map(library.map((a) => [a.id, a]))
    const candidates = ASSET_KINDS.flatMap((k) => library.filter((a) => a.kind === k)).filter(
      (a) =>
        !(a.images.length && a.images.every((img) => inRefs.has(img.path))) &&
        (a.images.length > 0 || q.length > 0) &&
        (startsWord(a.name, q) || startsWord(kindWords(a.kind), q))
    )
    const limit = q ? LIBRARY_ROWS.searching : LIBRARY_ROWS.browsing
    const items: MenuItem[] = candidates.slice(0, limit).map((a) => ({
      type: 'library',
      key: `library:${a.id}`,
      asset: a,
      ...libraryStatus(a, inRefs, free, byId)
    }))
    if (items.length) {
      sections.push({
        key: 'library',
        title: 'Lägg till från biblioteket',
        items,
        more: candidates.length - items.length
      })
    }
  }
  return sections
}

export function isDisabled(item: MenuItem): boolean {
  return item.type === 'library' && item.disabled
}
