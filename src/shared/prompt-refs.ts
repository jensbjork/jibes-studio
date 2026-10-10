// Reference tokens in prompts: @ImageN for the reference images and @AudioN for the reference audio clips
// (voices, sounds). Finding them, spotting near misses ("@Image 3", "@img3", "@Bild3", "@Ljud1", "@Voice1"…)
// and checking them against what a generation sends. In reference mode the model is given the pictures and
// the audio clips in order and the prompt points at them as @Image1, @Image2 … and @Audio1, @Audio2 …; a token
// that names the wrong one, or none, quietly spoils a paid generation. Pure, so the prompt editor (renderer),
// the guard in front of every submission (main) and the agent tools all apply exactly the same rules.

import {
  KINDS,
  MAX_AUDIO_CLIP_SECONDS,
  MAX_REFERENCE_AUDIO_SECONDS,
  MIN_AUDIO_CLIP_SECONDS,
  imageToVideoVariant,
  isAudioClipTooShort,
  kindOfModelId,
  maxReferenceAudios,
  maxReferenceImages,
  referenceAudioWindow,
  sanitizeReferenceAudios,
  supportsAudioInput,
  type Kind
} from './models'
import type { GenerationParams } from './types'

/** A canonical reference token: "@Image3" or "@Audio2", in any letter case ("@image3" counts too). */
export interface PromptToken {
  /** N in @ImageN (or @AudioN), 1-based. */
  index: number
  start: number
  end: number
  raw: string
}

/** What a token refers to: a reference image (@ImageN) or a reference audio clip (@AudioN). */
export type ReferenceKind = 'image' | 'audio'

export type PromptIssueCode =
  | 'no-references'
  | 'out-of-range'
  | 'over-model-limit'
  | 'malformed'
  | 'unused-reference'
  | 'not-reference-mode'
  /** @AudioN past the audio clips there are (or none are chosen). */
  | 'audio-out-of-range'
  /** @AudioN past what the model takes (error), or clips the model's limit drops (warning). */
  | 'audio-over-limit'
  /** Audio named in a mode or with a model that sends none (error), or clips that won't be sent (warning). */
  | 'audio-not-supported'
  /** A clip's window is shorter than 2 s or longer than 15 s. */
  | 'audio-length'
  /** The clips together are longer than 15 s. */
  | 'audio-too-long'
  /** An audio clip the prompt never mentions. */
  | 'unused-audio'

export interface PromptIssue {
  /** Errors block a submission; warnings are advice. */
  severity: 'error' | 'warning'
  code: PromptIssueCode
  /** Swedish, user-facing, e.g. "@Image7 finns inte – bara 5 bilder är valda." */
  message: string
  /** The offending text in the prompt the issue was found in, when it is about one place. */
  start?: number
  end?: number
  /** Set to 'audio' when the issue is about reference audio (an @AudioN token, a clip, a near miss of one). */
  ref?: 'audio'
}

/** Something that looks like an attempt at a reference but isn't one the model understands. */
export interface MalformedToken {
  start: number
  end: number
  raw: string
  /** The canonical text to put in its place, when it is clear what was meant ("@Image 3" → "@Image3"). */
  suggestion?: string
  /** Whether it was meant as a picture (@ImageN) or an audio clip (@AudioN). */
  ref: ReferenceKind
}

export interface ValidateOptions {
  /** The mode of the model the prompt is sent with; only reference mode sends reference images and audio. */
  kind: Kind
  /** How many reference images the model takes (maxReferenceImages); later ones are not sent. */
  maxImages: number
  /**
   * A sequence clip that continues from the previous clip: image-to-video from that clip's last frame, a mode
   * it can't leave, so references in it are reported with what can be done about them there (the same words
   * as blockingContinuationError) rather than "switch to reference mode".
   */
  continuing?: boolean
  /**
   * A sequence clip that continues from the previous clip in reference mode: after the reference images counted here,
   * the previous clip's last frame is sent as one more (@Image{count+1}), and the instruction Studio puts in front of
   * the prompt names it. So the clip needs no reference image of its own, the frame's token is valid and never
   * "unused", and the frame takes the model's last place: a reference image that has to give way for it is not sent,
   * and a token naming that one is an error.
   */
  continuationFrame?: boolean
  /**
   * The reference audio clips in the params, in order (@Audio1 is the first): each one's window length in
   * seconds, or undefined where it isn't known yet (main measures the files before anything is sent).
   * Omitted: no audio clips.
   */
  audioLengths?: readonly (number | undefined)[]
  /**
   * Whether the model takes reference audio (supportsAudioInput). false: @AudioN tokens are errors and the
   * clips are not sent. Omitted: not known, so tokens are only checked against the clips there are.
   */
  audioInput?: boolean
  /** How many audio clips the model takes (maxReferenceAudios); later ones are not sent. Default 3. */
  maxAudios?: number
  /**
   * Reference videos sent with the prompt (Seedance reference-to-video edits from Redigera, named <Video 1>…).
   * They are references too, so a prompt with videos but no images is not missing its references. Default 0.
   */
  referenceVideos?: number
}

// ── Scanning ──────────────────────────────────────────────────────────────────

/** Why a near miss isn't a reference, which decides its message. */
type MalformedReason = 'typo' | 'no-number' | 'zero' | 'range' | 'hidden' | 'glued'

type Scanned =
  | { type: 'token'; ref: ReferenceKind; start: number; end: number; raw: string; index: number }
  | {
      type: 'malformed'
      ref: ReferenceKind
      start: number
      end: number
      raw: string
      reason: MalformedReason
      suggestion?: string
      /** The numbers it most likely meant; they count as mentioned for the unused-image/audio advice. */
      meant: number[]
    }
  /** "@Anna": an @-name that is no reference at all; the model just gets the text. */
  | {
      type: 'mention'
      start: number
      end: number
      raw: string
      name: string
      /** A word for sound ("@Röst", "@voice"), so the advice is about audio references. */
      audioWord: boolean
    }

type ScannedToken = Extract<Scanned, { type: 'token' }>
type ScannedMalformed = Extract<Scanned, { type: 'malformed' }>
type ScannedReference = ScannedToken | ScannedMalformed

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

/** The word the model knows for each kind of reference. Both have five letters, which canonicalText relies on. */
const REF_WORD: Record<ReferenceKind, string> = { image: 'Image', audio: 'Audio' }
const CANONICAL_WORD: Record<ReferenceKind, RegExp> = { image: /^image$/i, audio: /^audio$/i }

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

/**
 * Words for sound, voice or an audio clip, which people write instead of "Audio": with a number after them
 * ("@Ljud1", "@Voice1", "@Röst1", "@sound1") they are near misses of @AudioN; without one they are only text,
 * but the advice about them then talks about audio references.
 */
const AUDIO_WORDS = new Set([
  'audio',
  'audios',
  'audioclip',
  'audiofile',
  'ljud',
  'ljudet',
  'ljuden',
  'ljudklipp',
  'ljudklippet',
  'ljudfil',
  'ljudfilen',
  'ljudreferens',
  'voice',
  'voices',
  'voiceover',
  'röst',
  'rösten',
  'röster',
  'sound',
  'sounds',
  'music',
  'musik'
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

/**
 * Whether the word after an @ was meant as "Audio" (lower-cased, NFKC). Only with a number after it does a
 * word for sound count ("@Ljud1", "@Voice2", "@aud1", "@Adio1"): "@Röst" alone is as likely a name. Without a
 * number only "@Audio" itself is an attempt at a reference. Looser spellings must start like "audio", so
 * "@Studio1" or "@Radio2" stay text.
 */
function isAudioWord(word: string, numbered: boolean): boolean {
  if (!word) return false
  if (!numbered) return word === 'audio' || word === 'audios'
  if (AUDIO_WORDS.has(word)) return true
  if (word.length >= 3 && 'audio'.startsWith(word)) return true
  const distance = editDistance(word, 'audio')
  if (distance <= 1) return word.length >= 4
  return distance === 2 && word[0] === 'a' && Math.abs(word.length - 5) <= 1
}

/** What a word after an @ was meant to refer to; images first, so their rules are exactly what they were. */
function refOf(word: string, numbered: boolean): ReferenceKind | undefined {
  if (isImageWord(word, numbered)) return 'image'
  if (isAudioWord(word, numbered)) return 'audio'
  return undefined
}

/** Worth looking past a space or dash for a number: "@Image 3", "@audio 1", "@Ljud 2". */
function mayHaveSeparatedNumber(word: string): boolean {
  return isImageWord(word, false) || AUDIO_WORDS.has(word) || (word.length >= 4 && editDistance(word, 'audio') <= 1)
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

/** "@Image3" or "@Audio3". Numbers may come as text, so even an absurdly long one is shown as written. */
const token = (ref: ReferenceKind, n: number | string): string => `@${REF_WORD[ref]}${n}`

/**
 * A canonical token spelled as the model expects: "@image3" → "@Image3", "@AUDIO2" → "@Audio2". Its raw text is
 * "@", the five letters of the word, then the digits.
 */
const canonicalText = (t: { raw: string; ref: ReferenceKind }): string => token(t.ref, t.raw.slice(6))

/** "@Image1, @Image2, @Image3" for a written-out range, or undefined when it doesn't make sense. */
function spelledRange(ref: ReferenceKind, from: number, to: number): string | undefined {
  if (from < 1 || to <= from || to - from >= MAX_RANGE) return undefined
  const all: string[] = []
  for (let n = from; n <= to; n++) all.push(token(ref, n))
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
  // Glued to a word in front, like an e-mail address ("info@img.example.com"): only the exact word counts.
  const attached = WORD_CHAR.test(charBefore(text, start))

  let digits = readDigits(text, wordEnd)
  let separated = false
  if (!digits && mayHaveSeparatedNumber(lower)) {
    // "@Image 3", "@Image-3", "@Image #3", "@audio 1": a few separators, then the number.
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
    // "@3": a reference without its word, read as a picture. Times and amounts ("@3pm", "@3:30") are left alone.
    if (!digits || attached) return undefined
    const next = text.slice(digitsEnd, digitsEnd + 2)
    if (GLUED.test(charAt(text, digitsEnd)) || /^[:.,/][0-9]/.test(next)) return undefined
    return malformedNumber(text, start, digitsEnd, digits, hidden ? 'hidden' : 'typo', 'image')
  }

  const ref = refOf(lower, !!digits)
  if (!ref) {
    if (attached) return undefined
    let end = afterAt
    while (end < text.length) {
      const ch = charAt(text, end)
      if (!WORD_CHAR.test(ch) && !INVISIBLE.test(ch)) break
      end += ch.length
    }
    return { type: 'mention', start, end, raw: text.slice(start, end), name: word, audioWord: AUDIO_WORDS.has(lower) }
  }

  if (attached && lower !== REF_WORD[ref].toLowerCase()) return undefined

  if (!digits) {
    return {
      type: 'malformed',
      ref,
      start,
      end: wordEnd,
      raw: text.slice(start, wordEnd),
      reason: 'no-number',
      meant: []
    }
  }

  const canonical =
    ats === 1 &&
    !fullWidthAt &&
    !hidden &&
    !separated &&
    CANONICAL_WORD[ref].test(word) &&
    /^[1-9][0-9]*$/.test(digits)
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
        ref,
        start,
        end: rangeEnd,
        raw: text.slice(start, rangeEnd),
        reason: 'range',
        suggestion: spelledRange(ref, n, to),
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
      ref,
      start,
      end,
      raw: text.slice(start, end),
      reason: n === 0 ? 'zero' : 'glued',
      suggestion: n === 0 ? undefined : `${token(ref, number)} ${glued}`,
      meant: n === 0 ? [] : [n]
    }
  }

  if (canonical) return { type: 'token', ref, start, end: digitsEnd, raw: text.slice(start, digitsEnd), index: n }
  return malformedNumber(text, start, digitsEnd, digits, reason, ref)
}

function malformedNumber(
  text: string,
  start: number,
  end: number,
  digits: string,
  reason: MalformedReason,
  ref: ReferenceKind
): Scanned {
  const number = canonicalNumber(digits)
  const raw = text.slice(start, end)
  if (number === '0') return { type: 'malformed', ref, start, end, raw, reason: 'zero', meant: [] }
  return { type: 'malformed', ref, start, end, raw, reason, suggestion: token(ref, number), meant: [Number(number)] }
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

const isToken = (ref: ReferenceKind) => (s: Scanned): s is ScannedToken => s.type === 'token' && s.ref === ref
const isMalformed = (ref: ReferenceKind) => (s: Scanned): s is ScannedMalformed =>
  s.type === 'malformed' && s.ref === ref
const isReference = (s: Scanned): s is ScannedReference => s.type !== 'mention'

// ── Public helpers ────────────────────────────────────────────────────────────

/** The canonical @ImageN tokens, case-insensitive ("@image3" counts), in order. "@Image10" is image 10. */
export function findImageTokens(prompt: string): PromptToken[] {
  return scan(prompt).flatMap((s) =>
    isToken('image')(s) ? [{ index: s.index, start: s.start, end: s.end, raw: s.raw }] : []
  )
}

/** The canonical @AudioN tokens, case-insensitive ("@audio2" counts), in order. "@Audio10" is clip 10. */
export function findAudioTokens(prompt: string): PromptToken[] {
  return scan(prompt).flatMap((s) =>
    isToken('audio')(s) ? [{ index: s.index, start: s.start, end: s.end, raw: s.raw }] : []
  )
}

/**
 * Near misses the model won't read as references: "@Image 3", "@img3", "@Bild3", "@image03", "@Image" without
 * a number, "@Image0", "@Image1-3", "@Image3rd", "@@Image3", or a token broken by an invisible character; and
 * the same for audio clips: "@audio 1", "@Ljud1", "@Voice1", "@Röst1", "@sound1", "@Audio" … (`ref` says which).
 */
export function findMalformedTokens(prompt: string): MalformedToken[] {
  return scan(prompt).flatMap((s) =>
    s.type === 'malformed'
      ? [{ start: s.start, end: s.end, raw: s.raw, ref: s.ref, ...(s.suggestion ? { suggestion: s.suggestion } : {}) }]
      : []
  )
}

/** "@image3" → "@Image3", "@audio1" → "@Audio1". Near misses are left as they are: what they meant is a guess. */
export function canonicalizeTokens(prompt: string): string {
  if (typeof prompt !== 'string') return prompt
  let out = ''
  let last = 0
  for (const t of scan(prompt)) {
    if (t.type !== 'token') continue
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
  return token('image', index)
}

/** "@Audio2". */
export function audioToken(index: number): string {
  return token('audio', index)
}

// ── Messages ──────────────────────────────────────────────────────────────────

/** "A", "A och B", "A, B och C". */
function swedishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
}

/** "@Image2", "@Image2 och @Image4", "@Image5–@Image9" for listing numbers in a message. */
function describeNumbers(numbers: readonly number[], ref: ReferenceKind = 'image'): string {
  const runs: [number, number][] = []
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else runs.push([n, n])
  }
  const parts = runs.flatMap(([a, b]) =>
    a === b ? [token(ref, a)] : b === a + 1 ? [token(ref, a), token(ref, b)] : [`${token(ref, a)}–${token(ref, b)}`]
  )
  return swedishList(parts)
}

const quoted = (raw: string): string => `”${raw.replace(INVISIBLE_ALL, '')}”`

/** Why a reference image gives way in a continuation sent in reference mode (see ValidateOptions.continuationFrame). */
const FRAME_PLACE = 'plats behövs för startbilden (sista bildrutan i föregående klipp)'

/**
 * "Referensbild 9 skickas inte – plats behövs för startbilden (…)": the reference images (1-based numbers) a
 * continuation in reference mode leaves out to make room for the previous clip's last frame.
 */
export function droppedForFrameMessage(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b).map(String)
  return `Referensbild ${swedishList(sorted)} skickas inte – ${FRAME_PLACE}.`
}

function images(n: number): string {
  return n === 1 ? '1 bild' : `${n} bilder`
}

function clips(n: number): string {
  return `${n} ljudklipp`
}

/** Margin for window lengths that are sums or slider values (10 + 5 must not count as more than 15). */
const SECONDS_EPSILON = 0.005

/** "1,5 s", "18 s": rounded to tenths, or finer when that would make it read as `limit` itself. */
function seconds(value: number, limit?: number): string {
  let text = ''
  for (const decimals of [1, 2, 3]) {
    const f = 10 ** decimals
    const rounded = Math.round(value * f) / f
    text = `${String(rounded).replace('.', ',')} s`
    if (limit === undefined || rounded !== limit) break
  }
  return text
}

function malformedMessage(s: ScannedMalformed): string {
  const raw = quoted(s.raw)
  if (s.ref === 'audio') {
    switch (s.reason) {
      case 'no-number':
        return /^@audio$/i.test(s.raw)
          ? `${raw} saknar nummer – skriv t.ex. @Audio1.`
          : `${raw} är ingen giltig ljudreferens – skriv @Audio följt av ljudklippets nummer, t.ex. @Audio1.`
      case 'zero':
        return `${raw} finns inte – ljudklippen numreras från @Audio1.`
      case 'range':
        return s.suggestion
          ? `${raw} läses inte som flera ljudklipp – skriv ut vart och ett: ${s.suggestion}.`
          : `${raw} läses inte som flera ljudklipp – skriv ut vart och ett, t.ex. @Audio1, @Audio2.`
      case 'hidden':
        return `${raw} innehåller ett osynligt tecken (t.ex. från inklistrad text) och känns inte igen – skriv om den som ${s.suggestion}.`
      case 'glued':
      case 'typo':
        return `${raw} är ingen giltig ljudreferens – menade du ${s.suggestion}?`
    }
  }
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

/** "@Image1 och ”@img2”", or the first three "med flera" when there are many. */
function namedList(named: readonly ScannedReference[]): { shown: string; count: number } {
  const names = [...new Set(named.map((s) => (s.type === 'token' ? canonicalText(s) : quoted(s.raw))))]
  const shown = names.length > 4 ? `${names.slice(0, 3).join(', ')} med flera` : swedishList(names)
  return { shown, count: names.length }
}

function notReferenceModeMessage(kind: Kind, named: readonly ScannedReference[], field: Field): string {
  const { shown, count } = namedList(named)
  const subject = field === 'prompt' ? 'Prompten' : 'Den negativa prompten'
  const sends =
    kind === 'image-to-video'
      ? `läget ${modeLabel(kind)} skickar inga referensbilder, bara start- och slutbild`
      : `läget ${modeLabel(kind)} skickar inga bilder`
  const them = count === 1 ? 'hänvisningen' : 'hänvisningarna'
  return `${subject} hänvisar till ${shown}, men ${sends}. Ta bort ${them} eller byt till läget ${modeLabel('reference-to-video')}.`
}

/** Audio named in text-to-video or image-to-video, which send no audio clips. */
function audioModeMessage(kind: Kind, named: readonly ScannedReference[], field: Field): string {
  const { shown, count } = namedList(named)
  const subject = field === 'prompt' ? 'Prompten' : 'Den negativa prompten'
  const them = count === 1 ? 'hänvisningen' : 'hänvisningarna'
  return (
    `${subject} hänvisar till ${shown}, men läget ${modeLabel(kind)} skickar inga ljudklipp. Ta bort ${them} ` +
    `eller byt till läget ${modeLabel('reference-to-video')}.`
  )
}

/** Audio named with a reference model that takes no reference audio. */
function audioModelMessage(named: readonly ScannedReference[], field: Field): string {
  const { shown, count } = namedList(named)
  const subject = field === 'prompt' ? 'Prompten' : 'Den negativa prompten'
  const them = count === 1 ? 'hänvisningen' : 'hänvisningarna'
  return (
    `${subject} hänvisar till ${shown}, men modellen tar inte emot ljudreferenser. Ta bort ${them} eller ` +
    `byt till en modell som tar emot ljud (t.ex. Seedance).`
  )
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(prompt: string, referenceCount: number, opts: ValidateOptions, field: Field): PromptIssue[] {
  const text = typeof prompt === 'string' ? prompt : ''
  const count = Math.max(0, Math.floor(Number(referenceCount)) || 0)
  const max = Math.max(0, Math.floor(Number(opts.maxImages)) || 0)
  const scanned = scan(text)
  const tokens = scanned.filter(isToken('image'))
  const malformed = scanned.filter(isMalformed('image'))
  const prefix = field === 'negative' ? 'Negativ prompt: ' : ''

  const general: PromptIssue[] = []
  const placed: PromptIssue[] = []
  const advice: PromptIssue[] = []
  const at = (s: { start: number; end: number }): { start: number; end: number } => ({ start: s.start, end: s.end })

  const audioCount = Array.isArray(opts.audioLengths) ? opts.audioLengths.length : 0
  const maxAudios =
    opts.maxAudios === undefined ? maxReferenceAudios('') : Math.max(0, Math.floor(Number(opts.maxAudios)) || 0)
  /** Audio clips that go out with the prompt: only in reference mode, with a model that isn't known to refuse them. */
  const audioSent = opts.kind === 'reference-to-video' && opts.audioInput !== false ? Math.min(audioCount, maxAudios) : 0

  if (opts.kind !== 'reference-to-video') {
    // No reference images or audio are sent at all, so every token (or attempt at one) names nothing.
    const named = scanned.filter(isReference)
    const imagesNamed = named.filter((s) => s.ref === 'image')
    const audioNamed = named.filter((s) => s.ref === 'audio')
    if (opts.continuing) {
      if (named.length) {
        general.push({
          severity: 'error',
          code: 'not-reference-mode',
          message: continuationReferencesMessage(text, field === 'prompt' ? 'prompten' : 'den negativa prompten'),
          ...at(named[0]),
          ...(imagesNamed.length ? {} : { ref: 'audio' as const })
        })
      }
    } else {
      if (imagesNamed.length) {
        general.push({
          severity: 'error',
          code: 'not-reference-mode',
          message: notReferenceModeMessage(opts.kind, imagesNamed, field),
          ...at(imagesNamed[0])
        })
      }
      if (audioNamed.length) {
        general.push({
          severity: 'error',
          code: 'audio-not-supported',
          message: audioModeMessage(opts.kind, audioNamed, field),
          ...at(audioNamed[0]),
          ref: 'audio'
        })
      }
    }
  } else {
    const videosSent = Math.max(0, Math.floor(Number(opts.referenceVideos)) || 0)
    // A continuation in reference mode sends the previous clip's last frame after the pictures: they get every place
    // but the model's last, which is the frame's, and its token (frameIndex) names it. With more pictures than that
    // room, the frame takes the place of the last one that fits no more, and that number names no picture at all.
    const frame = !!opts.continuationFrame
    const room = frame ? Math.max(0, max - 1) : max
    const frameIndex = frame && count <= room ? count + 1 : 0
    if (count === 0 && field === 'prompt' && !frame && (videosSent === 0 || tokens.length > 0)) {
      // Venice refuses reference audio on its own, so that is worth saying when audio is all there is.
      const audioOnly = !tokens.length && audioSent > 0
      general.push({
        severity: 'error',
        code: 'no-references',
        message: tokens.length
          ? `Inga referensbilder är valda – lägg till bilderna som prompten hänvisar till (${swedishList([...new Set(tokens.map(canonicalText))])}).`
          : audioOnly
            ? 'Ljudreferenser skickas bara tillsammans med minst en referensbild – lägg till en bild, t.ex. på personen vars röst det är.'
            : 'Lägg till minst en referensbild.',
        ...(audioOnly ? { ref: 'audio' as const } : {})
      })
    }
    if (count > 0 || frame) {
      for (const t of tokens) {
        // The frame itself: named by the instruction in front of the prompt, and fine to name here too.
        if (t.index === frameIndex) continue
        if (t.index > count) {
          placed.push({
            severity: 'error',
            code: 'out-of-range',
            message: frame
              ? `${prefix}${canonicalText(t)} finns inte – klippet skickar ${count ? `${images(count)} och ` : ''}startbilden (${imageToken(Math.min(count, room) + 1)}).`
              : `${prefix}${canonicalText(t)} finns inte – bara ${images(count)} ${count === 1 ? 'är vald' : 'är valda'}.`,
            ...at(t)
          })
        } else if (frame && t.index > room) {
          placed.push({
            severity: 'error',
            code: 'over-model-limit',
            message: `${prefix}${canonicalText(t)} skickas inte – ${FRAME_PLACE}.`,
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
      const sent = Math.min(count, room)
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
                ? `${imageToken(unused[0])} nämns inte i prompten, så modellen vet inte vad bilden ska användas till.`
                : `${describeNumbers(unused)} nämns inte i prompten, så modellen vet inte vad bilderna ska användas till.`
        })
      }
      // A picture whose place the continuation frame takes is not sent (a token naming it is an error above).
      const givenWay: number[] = []
      for (let n = room + 1; n <= Math.min(count, max); n++) if (!mentioned.has(n)) givenWay.push(n)
      if (givenWay.length) {
        advice.push({ severity: 'warning', code: 'over-model-limit', message: droppedForFrameMessage(givenWay) })
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

    validateAudio(scanned, text, opts, field, audioCount, maxAudios, { general, placed, advice })
  }

  for (const s of scanned) {
    if (s.type !== 'mention') continue
    const aboutAudio = s.audioWord && opts.kind === 'reference-to-video' && opts.audioInput !== false
    advice.push({
      severity: 'warning',
      code: 'malformed',
      message: aboutAudio
        ? `${prefix}${quoted(s.raw)} är ingen ljudreferens och skickas som vanlig text – hänvisa till ljudklipp med @Audio och numret, t.ex. @Audio1.`
        : opts.kind === 'reference-to-video'
          ? `${prefix}${quoted(s.raw)} är ingen bildreferens och skickas som vanlig text – hänvisa till bilder med @Image och numret, t.ex. ”${s.name} (@Image1)”.`
          : `${prefix}${quoted(s.raw)} är ingen bildreferens och skickas som vanlig text.`,
      ...at(s),
      ...(aboutAudio ? { ref: 'audio' as const } : {})
    })
  }

  placed.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  return [...general, ...placed, ...advice]
}

/**
 * The @AudioN checks in reference mode: tokens against the clips there are and the model's limit, near misses,
 * and (main prompt only) each clip's window, the clips' total length and clips the prompt never mentions.
 */
function validateAudio(
  scanned: readonly Scanned[],
  text: string,
  opts: ValidateOptions,
  field: Field,
  count: number,
  max: number,
  out: { general: PromptIssue[]; placed: PromptIssue[]; advice: PromptIssue[] }
): void {
  const tokens = scanned.filter(isToken('audio'))
  const malformed = scanned.filter(isMalformed('audio'))
  const prefix = field === 'negative' ? 'Negativ prompt: ' : ''
  const at = (s: { start: number; end: number }): { start: number; end: number } => ({ start: s.start, end: s.end })

  if (opts.audioInput === false) {
    // Nothing goes out, so everything that names a clip names nothing; clips that are there are left behind.
    const named = scanned.filter((s): s is ScannedReference => isReference(s) && s.ref === 'audio')
    if (named.length) {
      out.general.push({
        severity: 'error',
        code: 'audio-not-supported',
        message: audioModelMessage(named, field),
        ...at(named[0]),
        ref: 'audio'
      })
    } else if (field === 'prompt' && count > 0) {
      out.advice.push({
        severity: 'warning',
        code: 'audio-not-supported',
        message: 'Modellen tar inte emot ljudreferenser – ljudklippen skickas inte.',
        ref: 'audio'
      })
    }
    return
  }

  for (const t of tokens) {
    if (t.index > count) {
      out.placed.push({
        severity: 'error',
        code: 'audio-out-of-range',
        message: count
          ? `${prefix}${canonicalText(t)} finns inte – bara ${clips(count)} ${count === 1 ? 'är valt' : 'är valda'}.`
          : `${prefix}${canonicalText(t)} finns inte – inga ljudklipp är valda.`,
        ...at(t),
        ref: 'audio'
      })
    } else if (t.index > max) {
      out.placed.push({
        severity: 'error',
        code: 'audio-over-limit',
        message: `${prefix}${canonicalText(t)} skickas inte – modellen tar max ${clips(max)}.`,
        ...at(t),
        ref: 'audio'
      })
    }
  }
  for (const m of malformed) {
    out.placed.push({ severity: 'error', code: 'malformed', message: prefix + malformedMessage(m), ...at(m), ref: 'audio' })
  }

  // The clips themselves are checked once, with the main prompt.
  if (field !== 'prompt' || count === 0) return
  const sent = Math.min(count, max)

  // Venice takes 2–15 s per clip and 15 s in all; a window outside that is refused (after a paid upload).
  const lengths = (opts.audioLengths ?? []).slice(0, sent)
  let clipTooLong = false
  let total = 0
  lengths.forEach((length, i) => {
    if (typeof length !== 'number' || !Number.isFinite(length)) return
    total += Math.max(0, length)
    if (isAudioClipTooShort(length)) {
      out.general.push({
        severity: 'error',
        code: 'audio-length',
        message: `${audioToken(i + 1)} är bara ${seconds(Math.max(0, length), MIN_AUDIO_CLIP_SECONDS)} – ett ljudklipp måste vara minst ${MIN_AUDIO_CLIP_SECONDS} s.`,
        ref: 'audio'
      })
    } else if (length > MAX_AUDIO_CLIP_SECONDS + SECONDS_EPSILON) {
      clipTooLong = true
      out.general.push({
        severity: 'error',
        code: 'audio-length',
        message: `${audioToken(i + 1)} är ${seconds(length, MAX_AUDIO_CLIP_SECONDS)} – ett ljudklipp får vara högst ${MAX_AUDIO_CLIP_SECONDS} s.`,
        ref: 'audio'
      })
    }
  })
  // A clip that is too long on its own already says what to shorten; the total follows from it.
  if (!clipTooLong && total > MAX_REFERENCE_AUDIO_SECONDS + SECONDS_EPSILON) {
    out.general.push({
      severity: 'error',
      code: 'audio-too-long',
      message: `Ljudreferenserna är ${seconds(total, MAX_REFERENCE_AUDIO_SECONDS)} – max ${MAX_REFERENCE_AUDIO_SECONDS} s totalt.`,
      ref: 'audio'
    })
  }

  const mentioned = new Set([...tokens.map((t) => t.index), ...malformed.flatMap((m) => m.meant)])
  const unused: number[] = []
  for (let n = 1; n <= sent; n++) if (!mentioned.has(n)) unused.push(n)
  if (unused.length && text.trim()) {
    out.advice.push({
      severity: 'warning',
      code: 'unused-audio',
      message:
        unused.length === sent && sent > 1 && !tokens.length
          ? 'Inget av ljudklippen nämns i prompten – skriv @Audio1, @Audio2 … där de ska användas (t.ex. efter personen vars röst det är), så att modellen vet vad varje ljudklipp är.'
          : unused.length === 1
            ? `${audioToken(unused[0])} nämns inte i prompten, så modellen vet inte vad ljudklippet ska användas till.`
            : `${describeNumbers(unused, 'audio')} nämns inte i prompten, så modellen vet inte vad ljudklippen ska användas till.`,
      ref: 'audio'
    })
  }
  // Clips past the model's limit are dropped when sending; tokens pointing at them are errors above.
  const dropped: number[] = []
  for (let n = max + 1; n <= count; n++) if (!mentioned.has(n)) dropped.push(n)
  if (dropped.length && max > 0) {
    out.advice.push({
      severity: 'warning',
      code: 'audio-over-limit',
      message: `Modellen tar max ${clips(max)} – ${describeNumbers(dropped, 'audio')} skickas inte.`,
      ref: 'audio'
    })
  }
}

/**
 * Checks a prompt's references against what the generation has. `referenceCount` is how many reference
 * images are in the form (in order: @Image1 is the first); only the first `opts.maxImages` of them are sent.
 * The audio clips come in `opts` (audioLengths, audioInput, maxAudios).
 * Errors (blocking): references in a mode that sends no reference images or audio, reference mode without any
 * images, @ImageN / @AudioN past what there is or past the model's limit, audio with a model that takes none,
 * malformed tokens, and audio clips outside Venice's 2–15 s each or 15 s in all. Warnings: images or clips the
 * prompt never mentions, ones the model's limit drops, and @-names that are no references ("@Anna"). Errors come
 * first, those about one place in prompt order.
 */
export function validatePromptReferences(prompt: string, referenceCount: number, opts: ValidateOptions): PromptIssue[] {
  return validate(prompt, referenceCount, opts, 'prompt')
}

/**
 * The same checks for the negative prompt, errors only and marked as being about it ("Negativ prompt: …");
 * start/end point into the negative prompt. Correct tokens are allowed there but don't count as mentioning
 * an image or a clip, and the clips' lengths are checked with the main prompt only.
 */
export function validateNegativePrompt(
  negativePrompt: string,
  referenceCount: number,
  opts: ValidateOptions
): PromptIssue[] {
  return validate(negativePrompt, referenceCount, opts, 'negative').filter((i) => i.severity === 'error')
}

type PromptParams = Pick<
  GenerationParams,
  'model' | 'prompt' | 'negativePrompt' | 'referenceImages' | 'referenceAudios' | 'referenceVideos'
>

/**
 * What the checks need to know about a generation's params: the mode and the limits come from the model, only
 * reference mode counts its reference images, and the audio clips count with their windows (a clip without a
 * set length has one only once main has measured the file). For editors that validate one prompt at a time.
 */
export function validationContext(
  params: PromptParams,
  extra: { continuing?: boolean; continuationFrame?: boolean } = {}
): { referenceCount: number; options: ValidateOptions } {
  const kind = kindOfModelId(params.model)
  const referenceCount = kind === 'reference-to-video' ? (params.referenceImages?.length ?? 0) : 0
  const audios = kind === 'reference-to-video' ? (sanitizeReferenceAudios(params.referenceAudios) ?? []) : []
  const videos = kind === 'reference-to-video' && Array.isArray(params.referenceVideos) ? params.referenceVideos.length : 0
  return {
    referenceCount,
    options: {
      kind,
      ...(videos ? { referenceVideos: videos } : {}),
      maxImages: maxReferenceImages(params.model),
      ...(extra.continuing ? { continuing: true } : {}),
      ...(extra.continuationFrame && kind === 'reference-to-video' ? { continuationFrame: true } : {}),
      audioLengths: audios.map((a) => (a.length === undefined ? undefined : referenceAudioWindow(a).length)),
      audioInput: supportsAudioInput(params.model),
      maxAudios: maxReferenceAudios(params.model)
    }
  }
}

/**
 * Both prompts of a generation checked as it would be sent (see validationContext). `continuationFrame`: a sequence
 * clip continuing in reference mode, whose params hold the references it carries (the previous clip's last frame is
 * sent after them; see ValidateOptions.continuationFrame).
 */
export function validateGenerationParams(
  params: PromptParams,
  extra: { continuationFrame?: boolean } = {}
): {
  prompt: PromptIssue[]
  negativePrompt: PromptIssue[]
} {
  const { referenceCount, options } = validationContext(params, extra)
  return {
    prompt: validatePromptReferences(params.prompt, referenceCount, options),
    negativePrompt: params.negativePrompt ? validateNegativePrompt(params.negativePrompt, referenceCount, options) : []
  }
}

/**
 * Why the params must not be sent, in Swedish (the first blocking issue, and how many more there are), or
 * undefined when nothing blocks. What the main process refuses a submission with.
 */
export function blockingPromptError(
  params: PromptParams,
  extra: { continuationFrame?: boolean } = {}
): string | undefined {
  const { prompt, negativePrompt } = validateGenerationParams(params, extra)
  const errors = [...prompt, ...negativePrompt].filter((i) => i.severity === 'error')
  if (!errors.length) return undefined
  const more = errors.length - 1
  if (!more) return errors[0].message
  return `${errors[0].message} Prompten har ${more === 1 ? 'ett fel' : `${more} fel`} till.`
}

/**
 * A continuing clip's text names reference images or audio, which it doesn't send: which ones, and what to do.
 * `referencesPossible`: the clip could be sent with references instead ("Med referensbilder"), so that is offered.
 */
function continuationReferencesMessage(text: string, where: string, referencesPossible = false): string {
  const named = scan(text).filter(isReference)
  const { shown } = namedList(named)
  const sends = named.some((s) => s.ref === 'audio') ? 'inga referensbilder eller ljudklipp' : 'inga referensbilder'
  const instead = referencesPossible
    ? 'eller välj ”Med referensbilder” för klippet'
    : 'eller slå av ”Fortsätt från föregående klipp”'
  return (
    `Klippet fortsätter från sista bildrutan i föregående klipp och skickar ${sends} – ta bort ` +
    `${shown} ur ${where}, ${instead}.`
  )
}

/**
 * blockingPromptError for a sequence clip that continues from the previous clip with an exact start frame ("Exakt
 * startbild"): it is generated image-to-video from that clip's last frame and sends no reference images or audio. Its
 * mode is fixed, so references in it are reported with what can be done about them there, rather than "switch to
 * reference mode". `referencesPossible`: the clip could continue in reference mode instead, which the message offers.
 */
export function blockingContinuationError(
  params: PromptParams,
  opts: { referencesPossible?: boolean } = {}
): string | undefined {
  const sent = { ...params, model: imageToVideoVariant(params.model), referenceAudios: undefined }
  const { prompt, negativePrompt } = validateGenerationParams(sent)
  const isModeIssue = (i: PromptIssue): boolean => i.code === 'not-reference-mode' || i.code === 'audio-not-supported'
  const possible = !!opts.referencesPossible
  if (prompt.some(isModeIssue)) return continuationReferencesMessage(sent.prompt, 'prompten', possible)
  if (negativePrompt.some(isModeIssue)) {
    return continuationReferencesMessage(sent.negativePrompt ?? '', 'den negativa prompten', possible)
  }
  return blockingPromptError(sent)
}

/** The params with the tokens of both prompts in canonical form ("@image3" → "@Image3", "@audio1" → "@Audio1"). */
export function canonicalizeParams<T extends Pick<GenerationParams, 'prompt' | 'negativePrompt'>>(params: T): T {
  const prompt = canonicalizeTokens(params.prompt)
  const negativePrompt = params.negativePrompt === undefined ? undefined : canonicalizeTokens(params.negativePrompt)
  if (prompt === params.prompt && negativePrompt === params.negativePrompt) return params
  return { ...params, prompt, negativePrompt }
}
