// Pure helpers behind the prompt editor: which picture each @ImageN token names and which clip each @AudioN
// token names, what to highlight, what the "@" menu offers, and the text edits its choices and the quick fixes
// make. No DOM and no React here.

import type { Kind } from '@shared/models'
import {
  findAudioTokens,
  findImageTokens,
  findMalformedTokens,
  type PromptIssue,
  type ReferenceKind
} from '@shared/prompt-refs'
import { ASSET_KINDS, type Asset, type AssetKind, type PromptLanguage } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { audioRole, bringsVoice, type FormAudio } from '../pickers/audioRefs'
import {
  audioWord,
  clipCount,
  imageCount,
  poseReference,
  productReference,
  referenceTokens,
  wearingText
} from '../pickers/text'

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

/** "@Audio1 · Anna (röst)", the hover card's title line for a clip. */
export function audioTitle(audio: FormAudio): string {
  const s = audio.source
  if (!s) return `@Audio${audio.index} · eget ljud`
  return `@Audio${audio.index} · ${s.asset.name} (${audioRole(s.asset.kind)})`
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/** The numbers in a near miss's suggested spelling ("@Image1, @Image2" for "@Image1-2"; "@Audio1" for "@Ljud1"). */
function suggestedNumbers(suggestion: string | undefined, ref: ReferenceKind): number[] {
  if (!suggestion) return []
  const pattern = ref === 'audio' ? /@Audio(\d+)/g : /@Image(\d+)/g
  return [...suggestion.matchAll(pattern)].map((m) => Number(m[1]))
}

/**
 * The @ImageN numbers the prompt mentions: its tokens, and what its misspelled ones clearly meant (those are
 * errors of their own, so the picture isn't also reported as unmentioned).
 */
export function mentionedIndices(prompt: string): Set<number> {
  return new Set([
    ...findImageTokens(prompt).map((t) => t.index),
    ...findMalformedTokens(prompt).flatMap((m) => (m.ref === 'image' ? suggestedNumbers(m.suggestion, 'image') : []))
  ])
}

/** The @AudioN numbers the prompt mentions, the same way. */
export function mentionedAudioIndices(prompt: string): Set<number> {
  return new Set([
    ...findAudioTokens(prompt).map((t) => t.index),
    ...findMalformedTokens(prompt).flatMap((m) => (m.ref === 'audio' ? suggestedNumbers(m.suggestion, 'audio') : []))
  ])
}

/** The pictures that are sent but never mentioned in the prompt. */
export function unusedReferences(prompt: string, references: readonly PromptReference[]): PromptReference[] {
  const used = mentionedIndices(prompt)
  return references.filter((r) => r.sent && !used.has(r.index))
}

/** The audio clips that are sent but never mentioned in the prompt. */
export function unusedAudios(prompt: string, audios: readonly FormAudio[]): FormAudio[] {
  const used = mentionedAudioIndices(prompt)
  return audios.filter((a) => a.sent && !used.has(a.index))
}

// ── Inserting references ─────────────────────────────────────────────────────

/**
 * An asset among the references, as the prompt names it: "Anna (@Image1, @Image2, voice @Audio1) wearing …",
 * for a pose "Anna (@Image1) and Erik (@Image3) posed as in Kram (@Image5)", for a product held by a character
 * "Anna (@Image1) holding Kaffeburken (@Image4)".
 */
export interface ReferenceGroup {
  name: string
  /** Its @ImageN numbers. */
  indices: number[]
  /** The asset's kind: decides the word in front of its audio tokens and how a pose is worded. */
  kind?: AssetKind
  /** Its @AudioN numbers: a character's voice, an environment's sound. */
  audios?: number[]
  /** For a character: the outfits it wears in the form. */
  outfits?: { name: string; indices: number[] }[]
  /** For a pose: the characters that take it (their names and @ImageN numbers). */
  people?: { name: string; indices: number[] }[]
  /** For a product: the character holding it ("hålls av"); undefined: nobody. */
  holder?: { name: string; indices: number[] }
}

export interface AssetGroup extends ReferenceGroup {
  asset: Asset
}

/** What goes inside the group's brackets: "@Image1, @Image2, voice @Audio1". */
function groupTokens(group: ReferenceGroup, language: PromptLanguage): string {
  return referenceTokens(group.indices, group.audios ?? [], audioWord(group.kind, language))
}

/**
 * The whole reference for a group: "Anna (@Image1, @Image2, voice @Audio1) wearing Röd klänning (@Image3)", for
 * a pose the characters that take it and the pose ("Anna (@Image1) and Erik (@Image3) posed as in Kram
 * (@Image5)"), for a product the character holding it, if any ("Anna (@Image1) holding Kaffeburken (@Image4)").
 */
export function groupText(group: ReferenceGroup, language: PromptLanguage): string {
  if (group.kind === 'pose') return poseReference(group, group.people ?? [], language)
  if (group.kind === 'product') return productReference(group, group.holder, language)
  return `${group.name} (${groupTokens(group, language)})${wearingText(group.outfits ?? [], language)}`
}

/**
 * What choosing a group inserts, given the text in front of the insertion point:
 * - after "(" only the tokens ("@Image1, @Image2, voice @Audio1"): the brackets are being written by hand;
 * - right after the name ("Anna ") the bracketed tokens and the clothes (a pose's people and a product's holder
 *   come before its name, so there they are left out);
 * - otherwise the whole reference (see groupText).
 */
export function groupInsertText(group: ReferenceGroup, language: PromptLanguage, before: string): string {
  if (/\(\s*$/.test(before)) return groupTokens(group, language)
  const head = before.replace(/\s+$/, '')
  const name = group.name.trim()
  if (name && head.toLocaleLowerCase('sv').endsWith(name.toLocaleLowerCase('sv'))) {
    const prev = head.slice(0, head.length - name.length)
    if (!prev || /[^\p{L}\p{N}]$/u.test(prev)) {
      // A pose's people and a product's holder are written before its name, which is already in the text.
      const clothed = group.kind !== 'pose' && group.kind !== 'product'
      const outfits = clothed ? wearingText(group.outfits ?? [], language) : ''
      return `(${groupTokens(group, language)})${outfits}`
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

/** "(@Image1, @Image2)" or "(@Image1, voice @Audio1)": a bracket holding nothing but reference tokens. */
const TOKEN_BRACKET_BODY =
  /^\s*(?:(?:voice|sound|röst|ljud)\s+)?@(?:image|audio)\d+(?:\s*,\s*(?:(?:voice|sound|röst|ljud)\s+)?@(?:image|audio)\d+)*\s*$/iu

/**
 * Puts an asset's clip into its reference already in the prompt: "Anna (@Image1, @Image2)" → "Anna (@Image1,
 * @Image2, voice @Audio1)". The bracket must hold one of the asset's @ImageN tokens and nothing but tokens.
 * Undefined when there is no such bracket.
 */
export function audioIntoReference(
  prompt: string,
  imageIndices: readonly number[],
  audioIndex: number,
  word: string
): { start: number; end: number; text: string } | undefined {
  const wanted = new Set(imageIndices)
  for (const t of findImageTokens(prompt)) {
    if (!wanted.has(t.index)) continue
    const open = prompt.lastIndexOf('(', t.start)
    const close = prompt.indexOf(')', t.end)
    if (open === -1 || close === -1) continue
    const body = prompt.slice(open + 1, close)
    if (!TOKEN_BRACKET_BODY.test(body)) continue
    const end = open + 1 + body.replace(/\s+$/, '').length
    return { start: end, end, text: `, ${word} @Audio${audioIndex}` }
  }
  return undefined
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

/** A highlighted stretch of the prompt: a reference token, a near miss, or an @-name that is no reference. */
export interface PromptMark {
  start: number
  end: number
  /** valid: names something that is sent. error: blocks generating. warning: advice ("@Anna" is plain text). */
  tone: 'valid' | 'error' | 'warning'
  /** What it refers to (or was meant to): a picture or an audio clip. */
  ref?: ReferenceKind
  /** N of the @ImageN / @AudioN token (for a near miss: of its suggested spelling). */
  index?: number
  /** Kind of the asset a valid token's picture or clip belongs to; undefined for a file from disk. */
  kind?: AssetKind
  /** What is wrong (Swedish). */
  problem?: string
  /** The right spelling of a near miss, e.g. "@Image3" for "@img3". */
  suggestion?: string
}

/** "image:3" / "audio:1": which picture or clip a mark (or a row of the key) is about, for linked highlighting. */
export function markKey(ref: ReferenceKind | undefined, index: number | undefined): string | undefined {
  return index === undefined ? undefined : `${ref ?? 'image'}:${index}`
}

export const NOT_REFERENCE_MODE =
  'Referensbilder används bara i läget Referens – i det här läget skickas inga referensbilder.'

export const AUDIO_NOT_SENT = 'Ljudklipp skickas bara i läget Referens, med en modell som tar emot ljud.'

function missingImageText(n: number, count: number): string {
  if (!count) return `@Image${n} finns inte – inga referensbilder är valda än.`
  return `@Image${n} finns inte – bara ${imageCount(count)} ${count === 1 ? 'är vald' : 'är valda'}.`
}

function missingAudioText(n: number, count: number): string {
  if (!count) return `@Audio${n} finns inte – inga ljudklipp är valda än.`
  return `@Audio${n} finns inte – bara ${clipCount(count)} ${count === 1 ? 'är valt' : 'är valda'}.`
}

/** What the prompt's references are checked against, for highlighting. */
export interface MarkContext {
  references: readonly PromptReference[]
  audios: readonly FormAudio[]
  kind: Kind
  maxImages: number
  maxAudios: number
  /** The model takes reference audio (reference-to-video with audio input). */
  audioInput: boolean
}

/**
 * What to highlight, in order and without overlaps. Tokens are checked here too, so they can be coloured
 * by the asset they name; whatever the shared rules (prompt-refs) report about a place in the text wins,
 * with their wording, so what blocks a generation is always visible where it is.
 */
export function promptMarks(prompt: string, ctx: MarkContext, issues: readonly PromptIssue[]): PromptMark[] {
  const { references, audios, kind, maxImages, maxAudios } = ctx
  const reference = kind === 'reference-to-video'
  // Outside reference mode (or without audio input) the rules report the first token only; its message covers
  // them all.
  const notReference = reference
    ? undefined
    : (issues.find((i) => i.code === 'not-reference-mode')?.message ?? NOT_REFERENCE_MODE)
  const audioRefused =
    reference && ctx.audioInput
      ? undefined
      : (issues.find((i) => i.severity === 'error' && i.code === 'audio-not-supported')?.message ??
        issues.find((i) => i.code === 'not-reference-mode')?.message ??
        AUDIO_NOT_SENT)
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
      ref: 'image',
      index: t.index,
      kind: ref?.asset?.kind,
      problem
    })
  }
  for (const t of findAudioTokens(prompt)) {
    const audio = audios[t.index - 1]
    const problem =
      audioRefused ??
      (!audio
        ? missingAudioText(t.index, audios.length)
        : t.index > maxAudios
          ? `@Audio${t.index} skickas inte – modellen tar max ${clipCount(maxAudios)}.`
          : undefined)
    marks.push({
      start: t.start,
      end: t.end,
      tone: problem ? 'error' : 'valid',
      ref: 'audio',
      index: t.index,
      kind: audio?.source?.asset.kind,
      problem
    })
  }
  for (const m of findMalformedTokens(prompt)) {
    const numbers = suggestedNumbers(m.suggestion, m.ref)
    const audio = m.ref === 'audio'
    marks.push({
      start: m.start,
      end: m.end,
      tone: 'error',
      ref: m.ref,
      index: numbers.length === 1 ? numbers[0] : undefined,
      suggestion: m.suggestion,
      problem:
        (audio ? audioRefused : notReference) ??
        (m.suggestion
          ? `Felstavad hänvisning – skrivs ${m.suggestion}.`
          : audio
            ? 'Ofullständig hänvisning – skriv @Audio och ljudklippets nummer, t.ex. @Audio1.'
            : 'Ofullständig hänvisning – skriv @Image och bildens nummer, t.ex. @Image1.')
    })
  }
  for (const issue of issues) {
    if (issue.start === undefined || issue.end === undefined || issue.end <= issue.start) continue
    // These name the first token only; the message is already on every token above.
    if (issue.code === 'not-reference-mode' || (issue.code === 'audio-not-supported' && issue.severity === 'error')) {
      continue
    }
    const { start, end } = issue
    const hit = marks.filter((m) => m.start < end && start < m.end)
    if (issue.severity === 'error') {
      for (const m of hit) {
        m.tone = 'error'
        m.problem = issue.message
      }
      if (!hit.length) marks.push({ start, end, tone: 'error', problem: issue.message, ref: issue.ref })
    } else if (!hit.length) {
      marks.push({ start, end, tone: 'warning', problem: issue.message, ref: issue.ref })
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
 * "Anna walks", "(@Image1, @Image7)" → "(@Image1)", "(@Image1, voice @Audio2)" → "(@Image1)", and no doubled
 * spaces or space before punctuation.
 */
export function removeRanges(text: string, ranges: readonly TextRange[]): string {
  let out = text
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = removeOne(out, r.start, r.end)
  return out
}

/** "voice " / "röst " in front of an @AudioN inside a reference: it goes with the token. */
const AUDIO_WORD_BEFORE = /(?:voice|sound|röst|ljud)[ \t]+$/iu

function removeOne(text: string, start: number, end: number): string {
  let left = text.slice(0, start)
  let right = text.slice(end)
  if (/^@audio/i.test(text.slice(start, end))) {
    const word = AUDIO_WORD_BEFORE.exec(left)
    // Only inside a reference's brackets ("(@Image1, voice @Audio1)"), where the word belongs to the token.
    if (word && /[\s(,]$/.test(left.slice(0, word.index)) && /\([^()]*$/.test(left)) {
      left = left.slice(0, word.index)
    }
  }
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

/** Every token and near miss in the prompt (pictures and audio), for "remove all references". */
export function allTokenRanges(prompt: string): TextRange[] {
  return [...findImageTokens(prompt), ...findAudioTokens(prompt), ...findMalformedTokens(prompt)]
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start)
}

/** Every @AudioN token and near miss of one, for "remove the audio references". */
export function audioTokenRanges(prompt: string): TextRange[] {
  return [...findAudioTokens(prompt), ...findMalformedTokens(prompt).filter((m) => m.ref === 'audio')]
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start)
}

// ── The "@" menu ─────────────────────────────────────────────────────────────

export type MenuItem =
  /** An asset among the references: inserts "Anna (@Image1, @Image2, voice @Audio1) …". */
  | { type: 'group'; key: string; group: AssetGroup }
  /** One reference image: inserts "@Image3". */
  | { type: 'image'; key: string; reference: PromptReference }
  /** One reference audio clip: inserts "@Audio1". */
  | { type: 'audio'; key: string; audio: FormAudio }
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

/** Words an audio clip is found by in the "@" menu, besides its asset's name. */
const AUDIO_SEARCH_WORDS = 'audio ljud röst voice sound ljudmiljö'

/** How a library asset fits among the references, as AssetPicker reports it. */
function libraryStatus(
  asset: Asset,
  inRefs: ReadonlySet<string>,
  free: number,
  byId: ReadonlyMap<string, Asset>,
  withVoice: boolean
): { status: string; warning?: string; disabled: boolean } {
  const total = asset.images.length
  if (!total) return { status: `${ASSET_COPY[asset.kind].singular} · inga bilder än`, disabled: true }
  const used = asset.images.filter((img) => inRefs.has(img.path)).length
  const pending = total - used
  const voice = withVoice && bringsVoice(asset)
  const status =
    `${ASSET_COPY[asset.kind].singular} · ${imageCount(total)}` +
    (voice ? ' + röst' : '') +
    (used ? ` · ${used} redan tillagda` : '')
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
 * The "@" menu: the references first (each asset, then its pictures and clips), then library assets that can be
 * added. `query` is what follows the "@"; it matches @ImageN / @AudioN numbers, names and kinds by word start.
 * `only` limits it to pictures or clips (choosing what a wrong token should name).
 */
export function tokenMenuSections(options: {
  query: string
  references: readonly PromptReference[]
  audios?: readonly FormAudio[]
  groups: readonly AssetGroup[]
  /** The whole library; omit to leave out "Lägg till från biblioteket". */
  library?: readonly Asset[]
  maxImages: number
  /** The model takes reference audio: adding a character from the library brings its voice. */
  audioInput?: boolean
  only?: ReferenceKind
}): MenuSection[] {
  const { references, groups, library, maxImages, only } = options
  const audios = options.audios ?? []
  const q = options.query.toLocaleLowerCase('sv').replace(/^@/, '')
  const sections: MenuSection[] = []

  const referenceItems: MenuItem[] = []
  const imageMatches = (r: PromptReference): boolean =>
    `image${r.index}`.startsWith(q) ||
    String(r.index).startsWith(q) ||
    (!!r.asset && (startsWord(r.asset.name, q) || startsWord(kindWords(r.asset.kind), q)))
  const audioMatches = (a: FormAudio): boolean =>
    `audio${a.index}`.startsWith(q) ||
    startsWord(AUDIO_SEARCH_WORDS, q) ||
    (!!a.source && (startsWord(a.source.asset.name, q) || startsWord(kindWords(a.source.asset.kind), q)))
  const listed = new Set<string>()
  const audioListed = new Set<number>()
  const pushAudiosOf = (assetId: string | undefined): void => {
    if (only === 'image') return
    for (const a of audios) {
      if (a.source?.asset.id !== assetId || audioListed.has(a.index) || !audioMatches(a)) continue
      audioListed.add(a.index)
      referenceItems.push({ type: 'audio', key: `audio:${a.index}`, audio: a })
    }
  }
  for (const r of references) {
    if (r.asset) {
      if (listed.has(r.asset.id)) continue
      listed.add(r.asset.id)
      const group = groups.find((g) => g.asset.id === r.asset!.id)
      if (only !== 'audio' && group && (startsWord(group.name, q) || startsWord(kindWords(group.asset.kind), q))) {
        referenceItems.push({ type: 'group', key: `group:${group.asset.id}`, group })
      }
      if (only !== 'audio') {
        for (const own of references) {
          if (own.asset?.id === r.asset.id && imageMatches(own)) {
            referenceItems.push({ type: 'image', key: `image:${own.index}`, reference: own })
          }
        }
      }
      pushAudiosOf(r.asset.id)
    } else if (only !== 'audio' && (imageMatches(r) || (!!q && startsWord('egen bild', q)))) {
      referenceItems.push({ type: 'image', key: `image:${r.index}`, reference: r })
    }
  }
  // Clips whose asset has no pictures among the references, and clips that aren't library clips.
  if (only !== 'image') {
    for (const a of audios) {
      if (audioListed.has(a.index)) continue
      if (!audioMatches(a) && !(!!q && !a.source && startsWord('eget ljud', q))) continue
      audioListed.add(a.index)
      referenceItems.push({ type: 'audio', key: `audio:${a.index}`, audio: a })
    }
  }
  if (referenceItems.length) {
    const title = only === 'audio' ? 'Ljudklipp' : audios.length && only !== 'image' ? 'Referenser' : 'Referensbilder'
    sections.push({ key: 'references', title, items: referenceItems, more: 0 })
  }

  if (library && !only) {
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
      ...libraryStatus(a, inRefs, free, byId, !!options.audioInput)
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
