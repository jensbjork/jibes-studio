// @ImageN reference tokens in prompts: finding them, spotting near misses ("@Image 3", "@img3", "@Bild3"…)
// and checking them against the reference images a generation sends. In reference mode the model is given
// the pictures in order and the prompt points at them as @Image1, @Image2 …; a token that names the wrong
// picture, or none, quietly spoils a paid generation. Pure, so the prompt editor (renderer), the guard in
// front of every submission (main) and the agent tools all apply exactly the same rules.

import { KINDS, imageToVideoVariant, kindOfModelId, maxReferenceImages, type Kind } from './models'
import type { GenerationParams } from './types'

/** A canonical reference token: "@Image3", in any letter case ("@image3" counts too). */
export interface PromptToken {
  /** N in @ImageN, 1-based. */
  index: number
  start: number
  end: number
  raw: string
}

export type PromptIssueCode =
  | 'no-references'
  | 'out-of-range'
  | 'over-model-limit'
  | 'malformed'
  | 'unused-reference'
  | 'not-reference-mode'

export interface PromptIssue {
  /** Errors block a submission; warnings are advice. */
  severity: 'error' | 'warning'
  code: PromptIssueCode
  /** Swedish, user-facing, e.g. "@Image7 finns inte – bara 5 bilder är valda." */
  message: string
  /** The offending text in the prompt the issue was found in, when it is about one place. */
  start?: number
  end?: number
}

/** Something that looks like an attempt at a reference but isn't one the model understands. */
export interface MalformedToken {
  start: number
  end: number
  raw: string
  /** The canonical text to put in its place, when it is clear what was meant ("@Image 3" → "@Image3"). */
  suggestion?: string
}

export interface ValidateOptions {
  /** The mode of the model the prompt is sent with; only reference mode sends reference images. */
  kind: Kind
  /** How many reference images the model takes (maxReferenceImages); later ones are not sent. */
  maxImages: number
  /**
   * A sequence clip that continues from the previous clip: image-to-video from that clip's last frame, a mode
   * it can't leave, so references in it are reported with what can be done about them there (the same words
   * as blockingContinuationError) rather than "switch to reference mode".
   */
  continuing?: boolean
}

// ── Scanning ──────────────────────────────────────────────────────────────────

/** Why a near miss isn't a reference, which decides its message. */
type MalformedReason = 'typo' | 'no-number' | 'zero' | 'range' | 'hidden' | 'glued'

type Scanned =
  | { type: 'token'; start: number; end: number; raw: string; index: number }
  | {
      type: 'malformed'
      start: number
      end: number
      raw: string
      reason: MalformedReason
      suggestion?: string
      /** The picture numbers it most likely meant; they count as mentioned for the unused-image advice. */
      meant: number[]
    }
  /** "@Anna": an @-name that is no reference at all; the model just gets the text. */
  | { type: 'mention'; start: number; end: number; raw: string; name: string }

const AT = /[@\uFF20]/
/** Characters that don't show but break a token apart, e.g. pasted from a web page or a chat. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'gu')
const LETTER = /[\p{L}\p{M}]/u
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u
const DIGIT = /[0-9\uFF10-\uFF19]/
/** What people put between "Image" and the number by mistake: "@Image 3", "@Image-3", "@Image #3", "@Image_3". */
const SEPARATOR = /[ \t\u00A0\u2009\u202F_#\-\u2010-\u2015\u2212\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/u
const MAX_SEPARATORS = 3
/** Letters right after the number ("@Image3rd"). Other scripts are written without spaces, so only Latin counts. */
const GLUED = /[\p{Script=Latin}_]/u
const GLUED_RUN = /^[\p{Script=Latin}\p{N}_]+/u
/** "@Image1-3", meant as images 1 to 3; the model reads only @Image1. */
const RANGE = /^[-\u2010-\u2015\u2212]([0-9]+)/
/** How long a range is spelled out in a suggestion. */
const MAX_RANGE = 20

/** Words that mean "picture" or "reference", which people write instead of "Image". */
const IMAGE_WORDS = new Set([
  'image',
  'images',
  'img',
  'imgs',
  'pic',
  'pics',
  'picture',
  'pictures',
  'photo',
  'photos',
  'foto',
  'fotot',
  'fotos',
  'bild',
  'bilde',
  'bilden',
  'bilder',
  'bilderna',
  'ref',
  'refs',
  'reference',
  'references',
  'referens',
  'referensen',
  'referenser',
  'referensbild',
  'referensbilden'
])

/** Optimal-string-alignment distance (edits incl. swapped neighbours); stops early when clearly far apart. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  const d: number[][] = []
  for (let i = 0; i <= a.length; i++) d.push([i, ...new Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

/**
 * Whether the word after an @ was meant as "Image" (lower-cased, NFKC). A number right after it is strong
 * evidence, so then a looser match counts ("@img3", "@page3"); without one only close spellings do.
 */
function isImageWord(word: string, numbered: boolean): boolean {
  if (!word) return false
  if (IMAGE_WORDS.has(word) || 'image'.startsWith(word)) return true
  const distance = editDistance(word, 'image')
  if (word.length >= 4) return distance <= (numbered ? 2 : 1)
  return numbered && word.length === 3 && distance <= 2
}

/** The code point that ends at `index` ('' at the start). */
function charBefore(text: string, index: number): string {
  if (index <= 0) return ''
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index)
  }
  return text[index - 1]
}

/** The code point that starts at `index` ('' past the end). */
function charAt(text: string, index: number): string {
  const cp = text.codePointAt(index)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

function readDigits(text: string, from: number): string {
  let j = from
  while (j < text.length && DIGIT.test(text[j])) j++
  return text.slice(from, j)
}

/** The number as canonical ASCII digits without leading zeros ("０３" → "3"); "0" when it is zero. */
function canonicalNumber(digits: string): string {
  const ascii = digits.replace(/[\uFF10-\uFF19]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
  return ascii.replace(/^0+(?=[0-9])/, '')
}

/** "@Image3". Numbers may come as text, so even an absurdly long one is shown as written. */
const token = (n: number | string): string => `@Image${n}`

/** A canonical token spelled as the model expects: "@image3" → "@Image3". Its raw text is "@", 5 letters, digits. */
const canonicalText = (t: { raw: string }): string => token(t.raw.slice(6))

/** "@Image1, @Image2, @Image3" for a written-out range, or undefined when it doesn't make sense. */
function spelledRange(from: number, to: number): string | undefined {
  if (from < 1 || to <= from || to - from >= MAX_RANGE) return undefined
  const all: string[] = []
  for (let n = from; n <= to; n++) all.push(token(n))
  return all.join(', ')
}

function numbersIn(from: number, to: number): number[] {
  const out: number[] = []
  for (let n = from; n <= Math.min(to, from + MAX_RANGE); n++) out.push(n)
  return out
}

/** Reads what starts at the @ at `start`; undefined when it is no reference attempt (a lone "@", an e-mail…). */
function readAt(text: string, start: number): Scanned | undefined {
  let j = start
  let ats = 0
  let fullWidthAt = false
  while (j < text.length && AT.test(text[j])) {
    if (text[j] !== '@') fullWidthAt = true
    ats++
    j++
  }
  const afterAt = j

  // The word, with any invisible characters inside it noted ("@Ima\u200Bge3").
  let word = ''
  let hidden = false
  while (j < text.length) {
    const ch = charAt(text, j)
    if (LETTER.test(ch)) word += ch
    else if (INVISIBLE.test(ch)) hidden = true
    else break
    j += ch.length
  }
  const wordEnd = j
  const lower = word.normalize('NFKC').toLowerCase()
  // Glued to a word in front, like an e-mail address ("info@img.example.com"): only the exact word "image" counts.
  const attached = WORD_CHAR.test(charBefore(text, start))

  let digits = readDigits(text, wordEnd)
  let separated = false
  if (!digits && isImageWord(lower, false)) {
    // "@Image 3", "@Image-3", "@Image #3": a few separators, then the number.
    let k = wordEnd
    while (k < text.length && k - wordEnd < MAX_SEPARATORS && SEPARATOR.test(text[k])) k++
    const after = k > wordEnd ? readDigits(text, k) : ''
    if (after) {
      digits = after
      separated = true
      j = k
    }
  }
  const digitsEnd = j + digits.length

  if (!word) {
    // "@3": a reference without its word. Times and amounts ("@3pm", "@3:30") are left alone.
    if (!digits || attached) return undefined
    const next = text.slice(digitsEnd, digitsEnd + 2)
    if (GLUED.test(charAt(text, digitsEnd)) || /^[:.,/][0-9]/.test(next)) return undefined
    return malformedNumber(text, start, digitsEnd, digits, hidden ? 'hidden' : 'typo')
  }

  if (!isImageWord(lower, !!digits)) {
    if (attached) return undefined
    let end = afterAt
    while (end < text.length) {
      const ch = charAt(text, end)
      if (!WORD_CHAR.test(ch) && !INVISIBLE.test(ch)) break
      end += ch.length
    }
    return { type: 'mention', start, end, raw: text.slice(start, end), name: word }
  }

  if (attached && lower !== 'image') return undefined

  if (!digits) {
    return {
      type: 'malformed',
      start,
      end: wordEnd,
      raw: text.slice(start, wordEnd),
      reason: 'no-number',
      meant: []
    }
  }

  const canonical =
    ats === 1 && !fullWidthAt && !hidden && !separated && /^image$/i.test(word) && /^[1-9][0-9]*$/.test(digits)
  const reason: MalformedReason = hidden ? 'hidden' : 'typo'
  const number = canonicalNumber(digits)
  const n = Number(number)

  // "@Image1-3": the model reads @Image1 and a stray "-3".
  const range = RANGE.exec(text.slice(digitsEnd, digitsEnd + 12))
  if (range) {
    const rangeEnd = digitsEnd + range[0].length
    const following = charAt(text, rangeEnd)
    if (!DIGIT.test(following) && !GLUED.test(following)) {
      const to = Number(range[1])
      return {
        type: 'malformed',
        start,
        end: rangeEnd,
        raw: text.slice(start, rangeEnd),
        reason: 'range',
        suggestion: spelledRange(n, to),
        meant: n >= 1 && to >= n ? numbersIn(n, to) : []
      }
    }
  }

  // "@Image3rd": letters straight after the number.
  if (GLUED.test(charAt(text, digitsEnd))) {
    const glued = GLUED_RUN.exec(text.slice(digitsEnd))![0]
    const end = digitsEnd + glued.length
    return {
      type: 'malformed',
      start,
      end,
      raw: text.slice(start, end),
      reason: n === 0 ? 'zero' : 'glued',
      suggestion: n === 0 ? undefined : `${token(number)} ${glued}`,
      meant: n === 0 ? [] : [n]
    }
  }

  if (canonical) return { type: 'token', start, end: digitsEnd, raw: text.slice(start, digitsEnd), index: n }
  return malformedNumber(text, start, digitsEnd, digits, reason)
}

function malformedNumber(text: string, start: number, end: number, digits: string, reason: MalformedReason): Scanned {
  const number = canonicalNumber(digits)
  const raw = text.slice(start, end)
  if (number === '0') return { type: 'malformed', start, end, raw, reason: 'zero', meant: [] }
  return { type: 'malformed', start, end, raw, reason, suggestion: token(number), meant: [Number(number)] }
}

/** Every @-thing in the prompt, in order and without overlaps. */
function scan(prompt: string): Scanned[] {
  const text = typeof prompt === 'string' ? prompt : ''
  const out: Scanned[] = []
  let i = 0
  while (i < text.length) {
    if (!AT.test(text[i])) {
      i++
      continue
    }
    const found = readAt(text, i)
    if (found) {
      out.push(found)
      i = found.end
    } else {
      // Skip the whole run of @s, so "@@" isn't read again from its second @.
      while (i < text.length && AT.test(text[i])) i++
    }
  }
  return out
}

// ── Public helpers ────────────────────────────────────────────────────────────

/** The canonical @ImageN tokens, case-insensitive ("@image3" counts), in order. "@Image10" is image 10. */
export function findImageTokens(prompt: string): PromptToken[] {
  return scan(prompt).flatMap((s) =>
    s.type === 'token' ? [{ index: s.index, start: s.start, end: s.end, raw: s.raw }] : []
  )
}

/**
 * Near misses the model won't read as references: "@Image 3", "@img3", "@Bild3", "@image03", "@Image" without
 * a number, "@Image0", "@Image1-3", "@Image3rd", "@@Image3", or a token broken by an invisible character.
 */
export function findMalformedTokens(prompt: string): MalformedToken[] {
  return scan(prompt).flatMap((s) =>
    s.type === 'malformed'
      ? [{ start: s.start, end: s.end, raw: s.raw, ...(s.suggestion ? { suggestion: s.suggestion } : {}) }]
      : []
  )
}

/** "@image3" → "@Image3". Near misses are left as they are: what they meant is a guess, not a spelling. */
export function canonicalizeTokens(prompt: string): string {
  if (typeof prompt !== 'string') return prompt
  let out = ''
  let last = 0
  for (const t of findImageTokens(prompt)) {
    out += prompt.slice(last, t.start) + canonicalText(t)
    last = t.end
  }
  return last ? out + prompt.slice(last) : prompt
}

export function hasBlockingIssues(issues: readonly PromptIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

/** "@Image3". */
export function imageToken(index: number): string {
  return token(index)
}

// ── Messages ──────────────────────────────────────────────────────────────────

/** "A", "A och B", "A, B och C". */
function swedishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
}

/** "@Image2", "@Image2 och @Image4", "@Image5–@Image9" for listing picture numbers in a message. */
function describeNumbers(numbers: readonly number[]): string {
  const runs: [number, number][] = []
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else runs.push([n, n])
  }
  const parts = runs.flatMap(([a, b]) =>
    a === b ? [token(a)] : b === a + 1 ? [token(a), token(b)] : [`${token(a)}–${token(b)}`]
  )
  return swedishList(parts)
}

const quoted = (raw: string): string => `”${raw.replace(INVISIBLE_ALL, '')}”`

function images(n: number): string {
  return n === 1 ? '1 bild' : `${n} bilder`
}

function malformedMessage(s: Extract<Scanned, { type: 'malformed' }>): string {
  const raw = quoted(s.raw)
  switch (s.reason) {
    case 'no-number':
      return /^@image$/i.test(s.raw)
        ? `${raw} saknar nummer – skriv t.ex. @Image1.`
        : `${raw} är ingen giltig bildreferens – skriv @Image följt av bildens nummer, t.ex. @Image1.`
    case 'zero':
      return `${raw} finns inte – bilderna numreras från @Image1.`
    case 'range':
      return s.suggestion
        ? `${raw} läses inte som flera bilder – skriv ut varje bild: ${s.suggestion}.`
        : `${raw} läses inte som flera bilder – skriv ut varje bild, t.ex. @Image1, @Image2.`
    case 'hidden':
      return `${raw} innehåller ett osynligt tecken (t.ex. från inklistrad text) och känns inte igen – skriv om den som ${s.suggestion}.`
    case 'glued':
    case 'typo':
      return `${raw} är ingen giltig bildreferens – menade du ${s.suggestion}?`
  }
}

function modeLabel(kind: Kind): string {
  return KINDS.find((k) => k.id === kind)?.label ?? kind
}

/** Which prompt a message is about: the main prompt, or the negative prompt (prefixed so it is clear). */
type Field = 'prompt' | 'negative'

function notReferenceModeMessage(kind: Kind, named: readonly Scanned[], field: Field): string {
  const names = [...new Set(named.map((s) => (s.type === 'token' ? canonicalText(s) : quoted(s.raw))))]
  const shown = names.length > 4 ? `${names.slice(0, 3).join(', ')} med flera` : swedishList(names)
  const subject = field === 'prompt' ? 'Prompten' : 'Den negativa prompten'
  const sends =
    kind === 'image-to-video'
      ? `läget ${modeLabel(kind)} skickar inga referensbilder, bara start- och slutbild`
      : `läget ${modeLabel(kind)} skickar inga bilder`
  const them = names.length === 1 ? 'hänvisningen' : 'hänvisningarna'
  return `${subject} hänvisar till ${shown}, men ${sends}. Ta bort ${them} eller byt till läget ${modeLabel('reference-to-video')}.`
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(prompt: string, referenceCount: number, opts: ValidateOptions, field: Field): PromptIssue[] {
  const text = typeof prompt === 'string' ? prompt : ''
  const count = Math.max(0, Math.floor(Number(referenceCount)) || 0)
  const max = Math.max(0, Math.floor(Number(opts.maxImages)) || 0)
  const scanned = scan(text)
  const tokens = scanned.filter((s): s is Extract<Scanned, { type: 'token' }> => s.type === 'token')
  const malformed = scanned.filter((s): s is Extract<Scanned, { type: 'malformed' }> => s.type === 'malformed')
  const prefix = field === 'negative' ? 'Negativ prompt: ' : ''

  const general: PromptIssue[] = []
  const placed: PromptIssue[] = []
  const advice: PromptIssue[] = []
  const at = (s: { start: number; end: number }): { start: number; end: number } => ({ start: s.start, end: s.end })

  if (opts.kind !== 'reference-to-video') {
    // No reference images are sent at all, so every token (or attempt at one) names nothing.
    const named = scanned.filter((s) => s.type !== 'mention')
    if (named.length) {
      general.push({
        severity: 'error',
        code: 'not-reference-mode',
        message: opts.continuing
          ? continuationReferencesMessage(text, field === 'prompt' ? 'prompten' : 'den negativa prompten')
          : notReferenceModeMessage(opts.kind, named, field),
        ...at(named[0])
      })
    }
  } else {
    if (count === 0 && field === 'prompt') {
      general.push({
        severity: 'error',
        code: 'no-references',
        message: tokens.length
          ? `Inga referensbilder är valda – lägg till bilderna som prompten hänvisar till (${swedishList([...new Set(tokens.map(canonicalText))])}).`
          : 'Lägg till minst en referensbild.'
      })
    }
    if (count > 0) {
      for (const t of tokens) {
        if (t.index > count) {
          placed.push({
            severity: 'error',
            code: 'out-of-range',
            message: `${prefix}${canonicalText(t)} finns inte – bara ${images(count)} ${count === 1 ? 'är vald' : 'är valda'}.`,
            ...at(t)
          })
        } else if (t.index > max) {
          placed.push({
            severity: 'error',
            code: 'over-model-limit',
            message: `${prefix}${canonicalText(t)} skickas inte – modellen tar max ${images(max)}.`,
            ...at(t)
          })
        }
      }
    } else if (field === 'negative') {
      // In the main prompt "no references" says it once; here each token still names nothing.
      for (const t of tokens) {
        placed.push({
          severity: 'error',
          code: 'out-of-range',
          message: `${prefix}${canonicalText(t)} finns inte – inga bilder är valda.`,
          ...at(t)
        })
      }
    }
    for (const m of malformed) {
      placed.push({ severity: 'error', code: 'malformed', message: prefix + malformedMessage(m), ...at(m) })
    }

    // Advice is about the main prompt only: the negative prompt doesn't introduce the pictures.
    if (field === 'prompt' && count > 0) {
      const sent = Math.min(count, max)
      const mentioned = new Set([...tokens.map((t) => t.index), ...malformed.flatMap((m) => m.meant)])
      const unused: number[] = []
      for (let n = 1; n <= sent; n++) if (!mentioned.has(n)) unused.push(n)
      if (unused.length && text.trim()) {
        advice.push({
          severity: 'warning',
          code: 'unused-reference',
          message:
            unused.length === sent && sent > 1 && !tokens.length
              ? 'Ingen av bilderna nämns i prompten – skriv @Image1, @Image2 … där de ska användas, så att modellen vet vad varje bild föreställer.'
              : unused.length === 1
                ? `${token(unused[0])} nämns inte i prompten, så modellen vet inte vad bilden ska användas till.`
                : `${describeNumbers(unused)} nämns inte i prompten, så modellen vet inte vad bilderna ska användas till.`
        })
      }
      // Pictures past the model's limit are dropped when sending; tokens pointing at them are errors above.
      const dropped: number[] = []
      for (let n = max + 1; n <= count; n++) if (!mentioned.has(n)) dropped.push(n)
      if (dropped.length && max > 0) {
        advice.push({
          severity: 'warning',
          code: 'over-model-limit',
          message: `Modellen tar max ${images(max)} – ${describeNumbers(dropped)} skickas inte.`
        })
      }
    }
  }

  for (const s of scanned) {
    if (s.type !== 'mention') continue
    advice.push({
      severity: 'warning',
      code: 'malformed',
      message:
        opts.kind === 'reference-to-video'
          ? `${prefix}${quoted(s.raw)} är ingen bildreferens och skickas som vanlig text – hänvisa till bilder med @Image och numret, t.ex. ”${s.name} (@Image1)”.`
          : `${prefix}${quoted(s.raw)} är ingen bildreferens och skickas som vanlig text.`,
      ...at(s)
    })
  }

  placed.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  return [...general, ...placed, ...advice]
}

/**
 * Checks a prompt's references against the reference images the generation has. `referenceCount` is how many
 * are in the form (in order: @Image1 is the first); only the first `opts.maxImages` of them are sent.
 * Errors (blocking): references in a mode that sends no reference images, reference mode without any
 * images, @ImageN past the images there are or past the model's limit, and malformed tokens. Warnings:
 * images the prompt never mentions, images the model's limit drops, and @-names that are no references
 * ("@Anna"). Errors come first, those about one place in prompt order.
 */
export function validatePromptReferences(prompt: string, referenceCount: number, opts: ValidateOptions): PromptIssue[] {
  return validate(prompt, referenceCount, opts, 'prompt')
}

/**
 * The same checks for the negative prompt, errors only and marked as being about it ("Negativ prompt: …");
 * start/end point into the negative prompt. Correct tokens are allowed there but don't count as mentioning
 * an image.
 */
export function validateNegativePrompt(
  negativePrompt: string,
  referenceCount: number,
  opts: ValidateOptions
): PromptIssue[] {
  return validate(negativePrompt, referenceCount, opts, 'negative').filter((i) => i.severity === 'error')
}

type PromptParams = Pick<GenerationParams, 'model' | 'prompt' | 'negativePrompt' | 'referenceImages'>

/**
 * Both prompts of a generation checked as it would be sent: the mode and the image limit come from the model,
 * and only reference mode counts its reference images.
 */
export function validateGenerationParams(params: PromptParams): {
  prompt: PromptIssue[]
  negativePrompt: PromptIssue[]
} {
  const kind = kindOfModelId(params.model)
  const count = kind === 'reference-to-video' ? (params.referenceImages?.length ?? 0) : 0
  const opts: ValidateOptions = { kind, maxImages: maxReferenceImages(params.model) }
  return {
    prompt: validatePromptReferences(params.prompt, count, opts),
    negativePrompt: params.negativePrompt ? validateNegativePrompt(params.negativePrompt, count, opts) : []
  }
}

/**
 * Why the params must not be sent, in Swedish (the first blocking issue, and how many more there are), or
 * undefined when nothing blocks. What the main process refuses a submission with.
 */
export function blockingPromptError(params: PromptParams): string | undefined {
  const { prompt, negativePrompt } = validateGenerationParams(params)
  const errors = [...prompt, ...negativePrompt].filter((i) => i.severity === 'error')
  if (!errors.length) return undefined
  const more = errors.length - 1
  if (!more) return errors[0].message
  return `${errors[0].message} Prompten har ${more === 1 ? 'ett fel' : `${more} fel`} till.`
}

/** A continuing clip's text names reference images, which it doesn't send: which ones, and what to do. */
function continuationReferencesMessage(text: string, where: string): string {
  const named = scan(text).filter((s) => s.type !== 'mention')
  const names = [...new Set(named.map((s) => (s.type === 'token' ? canonicalText(s) : quoted(s.raw))))]
  const shown = names.length > 4 ? `${names.slice(0, 3).join(', ')} med flera` : swedishList(names)
  return (
    `Klippet fortsätter från sista bildrutan i föregående klipp och skickar inga referensbilder – ta bort ` +
    `${shown} ur ${where}, eller slå av ”Fortsätt från föregående klipp”.`
  )
}

/**
 * blockingPromptError for a sequence clip that continues from the previous clip: it is generated
 * image-to-video from that clip's last frame and sends no reference images. Its mode is fixed, so references
 * in it are reported with what can be done about them there, rather than "switch to reference mode".
 */
export function blockingContinuationError(params: PromptParams): string | undefined {
  const sent = { ...params, model: imageToVideoVariant(params.model) }
  const { prompt, negativePrompt } = validateGenerationParams(sent)
  const isModeIssue = (i: PromptIssue): boolean => i.code === 'not-reference-mode'
  if (prompt.some(isModeIssue)) return continuationReferencesMessage(sent.prompt, 'prompten')
  if (negativePrompt.some(isModeIssue)) {
    return continuationReferencesMessage(sent.negativePrompt ?? '', 'den negativa prompten')
  }
  return blockingPromptError(sent)
}

/** The params with the tokens of both prompts in canonical form ("@image3" → "@Image3"). */
export function canonicalizeParams<T extends Pick<GenerationParams, 'prompt' | 'negativePrompt'>>(params: T): T {
  const prompt = canonicalizeTokens(params.prompt)
  const negativePrompt = params.negativePrompt === undefined ? undefined : canonicalizeTokens(params.negativePrompt)
  if (prompt === params.prompt && negativePrompt === params.negativePrompt) return params
  return { ...params, prompt, negativePrompt }
}
