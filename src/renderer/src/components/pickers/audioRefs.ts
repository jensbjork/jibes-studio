// How library audio clips (a character's voice, an environment's sound) map onto a form's reference audio, and
// the edits the chips, the pickers and the agent bridge make to that list. Pure functions, like assetRefs.
//
// The form always stores an explicit window (start, length) for each clip: what is sent is then exactly what
// the form shows, whichever way the main process would resolve a missing one. When the window of a library clip
// is changed in the library, a form that still uses the old window follows it (see followLibraryAudio).

import {
  DEFAULT_AUDIO_CLIP_SECONDS,
  MAX_REFERENCE_AUDIO_SECONDS,
  MIN_AUDIO_CLIP_SECONDS,
  isAudioClipTooShort
} from '@shared/models'
import type { Asset, AssetAudio, AssetKind, PromptLanguage, ReferenceAudio } from '@shared/types'
import { formatClipSeconds } from './text'

/** A library audio clip with the asset it belongs to. */
export interface AudioSource {
  asset: Asset
  audio: AssetAudio
  /** 1-based position among the asset's clips ("voice 2"). */
  clip: number
}

/** An asset's clips; [] for kinds without audio, and for an asset from a main process older than audio. */
export function clipsOf(asset: Pick<Asset, 'audio'>): AssetAudio[] {
  return Array.isArray(asset.audio) ? asset.audio : []
}

/** Clip path → the library clip and its asset. */
export function audioSourcesByPath(assets: readonly Asset[]): Map<string, AudioSource> {
  const map = new Map<string, AudioSource>()
  for (const asset of assets) clipsOf(asset).forEach((audio, i) => map.set(audio.path, { asset, audio, clip: i + 1 }))
  return map
}

/**
 * The clip that comes along when a character is added to a form: its first voice clip. One too short to send
 * doesn't come along (addAudios leaves it out with a note); see bringsVoice.
 */
export function voiceOf(asset: Asset): AssetAudio | undefined {
  return asset.kind === 'character' ? clipsOf(asset)[0] : undefined
}

/** Whether adding the character brings its voice: it has one, long enough to be sent ("+ voice" in the pickers). */
export function bringsVoice(asset: Asset): boolean {
  const voice = voiceOf(asset)
  return !!voice && !isAudioClipTooShort(voice.clipLength)
}

/** Seconds to the millisecond, so windows compare and add up without floating-point crumbs. */
function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/** Slack when comparing a total with a limit (Venice counts milliseconds, not float crumbs). */
const EPSILON = 0.001

/** A library clip as a reference: its file and its reference window. */
export function referenceAudioOf(audio: AssetAudio): ReferenceAudio {
  return { path: audio.path, start: ms(audio.clipStart), length: ms(audio.clipLength) }
}

/**
 * The window a reference sends, in seconds: its own, else the library clip's (when it gives neither start nor
 * length), else from 0 for at most the default length (and never past the end of a known file).
 */
export function windowOf(ref: ReferenceAudio, source?: AudioSource): { start: number; length: number } {
  const clip = source?.audio
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  const own = valid(ref.start) || valid(ref.length)
  const start = valid(ref.start) ? ref.start : !own && clip ? clip.clipStart : 0
  const fallback = !own && clip ? clip.clipLength : DEFAULT_AUDIO_CLIP_SECONDS
  const room = clip ? Math.max(0, clip.duration - start) : Infinity
  const length = valid(ref.length) ? ref.length : Math.min(fallback, room)
  return { start: Math.max(0, start), length: Math.max(0, length) }
}

/** The total length of the windows, in seconds. */
export function totalSeconds(refs: readonly ReferenceAudio[], byPath: ReadonlyMap<string, AudioSource>): number {
  return ms(refs.reduce((sum, ref) => sum + windowOf(ref, byPath.get(ref.path)).length, 0))
}

/** Same files with the same windows, in the same order. */
export function sameAudios(a: readonly ReferenceAudio[], b: readonly ReferenceAudio[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.path === b[i].path && x.start === b[i].start && x.length === b[i].length)
  )
}

// ── The form's audio as the prompt sees it (@AudioN) ─────────────────────────

/** One reference audio clip of a form: the N in @AudioN and what it is. */
export interface FormAudio {
  /** N in @AudioN, 1-based. */
  index: number
  path: string
  /** The window sent, in seconds. */
  start: number
  length: number
  /** The library clip; undefined for a file that isn't (or no longer is) one. */
  source?: AudioSource
  /** False when it isn't sent: the model takes no audio, or it is past the model's limit. */
  sent: boolean
}

/**
 * The form's reference audio as @AudioN references. `supported`: the model is a reference-to-video model that
 * takes audio; otherwise none of it is sent.
 */
export function formAudios(
  refs: readonly ReferenceAudio[],
  byPath: ReadonlyMap<string, AudioSource>,
  max: number,
  supported: boolean
): FormAudio[] {
  return refs.map((ref, i) => {
    const source = byPath.get(ref.path)
    return { index: i + 1, path: ref.path, ...windowOf(ref, source), source, sent: supported && i < max }
  })
}

/** The @AudioN numbers of an asset's clips in the form. */
export function audioIndicesOf(audios: readonly FormAudio[], assetId: string): number[] {
  return audios.filter((a) => a.source?.asset.id === assetId).map((a) => a.index)
}

/** "voice", "soundscape", "sound": what a clip of the kind is called in the form. */
export function audioRole(kind: AssetKind | undefined): string {
  return kind === 'character' ? 'voice' : kind === 'environment' ? 'soundscape' : 'sound'
}

/** What a clip is, in two parts: "Anna" and "voice" ("voice 2" when it has several), or "Own sound" and its file. */
export function audioLabelParts(audio: Pick<FormAudio, 'path' | 'source'>): { name: string; detail: string } {
  const s = audio.source
  if (!s) return { name: 'Own sound', detail: audio.path.split('/').pop() ?? audio.path }
  const several = clipsOf(s.asset).length > 1
  return { name: s.asset.name, detail: `${audioRole(s.asset.kind)}${several ? ` ${s.clip}` : ''}` }
}

/** "Anna · voice", "Anna · voice 2" (when it has several), "Own sound · interview.mp3". */
export function audioLabel(audio: Pick<FormAudio, 'path' | 'source'>): string {
  const { name, detail } = audioLabelParts(audio)
  return `${name} · ${detail}`
}

/** "0:03–0:11 (8 s)": where in the file the window is. */
export function windowLabel(audio: Pick<FormAudio, 'start' | 'length'>): string {
  const clock = (s: number): string => {
    const t = Math.max(0, Math.round(s))
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  }
  return `${clock(audio.start)}–${clock(audio.start + audio.length)} (${formatClipSeconds(audio.length)})`
}

/** "Anna" → "Annas" (Swedish genitive), "Anna's" (English); names ending in s get only the mark. */
export function possessive(name: string, language: PromptLanguage): string {
  const n = name.trim()
  if (language === 'sv') return /[sxz]$/i.test(n) ? n : `${n}s`
  return /s$/i.test(n) ? `${n}'` : `${n}'s`
}

/**
 * What clicking an audio chip inserts: "Anna's voice (@Audio1)" / "Annas röst (@Audio1)" for a character,
 * "the sound of Stranden (@Audio2)" / "ljudet från Stranden (@Audio2)" for an environment, else the token.
 */
export function audioInsertText(audio: Pick<FormAudio, 'index' | 'source'>, language: PromptLanguage): string {
  const token = `@Audio${audio.index}`
  const asset = audio.source?.asset
  if (asset?.kind === 'character') {
    return `${possessive(asset.name, language)} ${language === 'sv' ? 'röst' : 'voice'} (${token})`
  }
  if (asset?.kind === 'environment') {
    return `${language === 'sv' ? 'ljudet från' : 'the sound of'} ${asset.name} (${token})`
  }
  return token
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** A new audio list, and a note when not everything fitted. */
export interface AudiosChange {
  audios: ReferenceAudio[]
  note?: string
}

/** "the voice of Anna", "the soundscape of Stranden", "the sound interview.mp3": a clip named in a note. */
function clipName(ref: ReferenceAudio, source: AudioSource | undefined): string {
  if (!source) return `the sound ${ref.path.split('/').pop() ?? ref.path}`
  const kind = source.asset.kind
  const what = kind === 'character' ? 'the voice' : kind === 'environment' ? 'the soundscape' : 'the sound'
  return `${what} of ${source.asset.name}`
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Appends the clips whose files aren't in the list yet, in order, as long as they fit: at most the model's
 * number of clips and MAX_REFERENCE_AUDIO_SECONDS together. Every added clip gets an explicit window. A window
 * under MIN_AUDIO_CLIP_SECONDS (a recording that short) is left out with a note: it could never be sent, and in
 * the form it would only block generating.
 */
export function addAudios(
  current: readonly ReferenceAudio[],
  wanted: readonly ReferenceAudio[],
  byPath: ReadonlyMap<string, AudioSource>,
  max: number
): AudiosChange {
  const out = [...current]
  const have = new Set(current.map((a) => a.path))
  let total = totalSeconds(current, byPath)
  const full: string[] = []
  const tooLong: string[] = []
  const tooShort: string[] = []
  for (const ref of wanted) {
    if (!ref || typeof ref.path !== 'string' || have.has(ref.path)) continue
    const source = byPath.get(ref.path)
    const window = windowOf(ref, source)
    const name = clipName(ref, source)
    if (isAudioClipTooShort(window.length)) tooShort.push(name)
    else if (out.length >= max) full.push(name)
    else if (total + window.length > MAX_REFERENCE_AUDIO_SECONDS + EPSILON) tooLong.push(name)
    else {
      out.push({ path: ref.path, start: ms(window.start), length: ms(window.length) })
      have.add(ref.path)
      total = ms(total + window.length)
    }
  }
  const notes: string[] = []
  if (tooShort.length) {
    notes.push(
      `${capitalized(englishNames(tooShort))} ${tooShort.length === 1 ? 'is' : 'are'} shorter than ${MIN_AUDIO_CLIP_SECONDS} s and ` +
        `${tooShort.length === 1 ? 'wasn’t' : 'weren’t'} included – Venice doesn’t take sound clips that short.`
    )
  }
  if (full.length) {
    notes.push(`${capitalized(englishNames(full))} didn’t fit – the model takes at most ${max} sound ${max === 1 ? 'clip' : 'clips'}.`)
  }
  if (tooLong.length) {
    notes.push(
      `${capitalized(englishNames(tooLong))} didn’t fit – the sound references may be at most ` +
        `${MAX_REFERENCE_AUDIO_SECONDS} s together (now ${formatClipSeconds(total)}).`
    )
  }
  return { audios: out, ...(notes.length ? { note: notes.join(' ') } : {}) }
}

function englishNames(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Whether a clip would fit after the ones there: a free place and room in the total length. */
export function fitsAudio(
  current: readonly ReferenceAudio[],
  ref: ReferenceAudio,
  byPath: ReadonlyMap<string, AudioSource>,
  max: number
): { fits: boolean; reason?: string } {
  if (current.some((a) => a.path === ref.path)) return { fits: false, reason: 'already added' }
  const length = windowOf(ref, byPath.get(ref.path)).length
  if (isAudioClipTooShort(length)) return { fits: false, reason: `shorter than ${MIN_AUDIO_CLIP_SECONDS} s` }
  if (current.length >= max) return { fits: false, reason: `at most ${max} sound ${max === 1 ? 'clip' : 'clips'}` }
  if (totalSeconds(current, byPath) + length > MAX_REFERENCE_AUDIO_SECONDS + EPSILON) {
    return { fits: false, reason: `over ${MAX_REFERENCE_AUDIO_SECONDS} s in total` }
  }
  return { fits: true }
}

/** The list without the asset's clips. */
export function removeAudiosOf(current: readonly ReferenceAudio[], asset: Asset): ReferenceAudio[] {
  const paths = new Set(clipsOf(asset).map((a) => a.path))
  return current.filter((a) => !paths.has(a.path))
}

/**
 * The form's audio following the library: a clip whose file moved (its asset was renamed, "Tidy up" tidied
 * it) points at where it is now, and a clip whose window in the form is the window it had at the last look
 * (`previous`, clip id → clip) gets the window it has now – the user moved it in the library. Windows set
 * otherwise (by an agent, say) are left alone. Clips are recognised by path, else by the clip id remembered for
 * the path (`remembered`), else by the previous look. Returns the new list (undefined when nothing changed) and
 * the clip id of every library clip in it, to remember for next time.
 */
export function followLibraryAudio(
  refs: readonly ReferenceAudio[],
  assets: readonly Asset[],
  previous: ReadonlyMap<string, AssetAudio> | undefined,
  remembered: Readonly<Record<string, string>>
): { audios: ReferenceAudio[] | undefined; ids: Record<string, string> } {
  const byId = new Map<string, AssetAudio>()
  const byPath = new Map<string, AssetAudio>()
  for (const asset of assets) {
    for (const clip of clipsOf(asset)) {
      byId.set(clip.id, clip)
      byPath.set(clip.path, clip)
    }
  }
  const previousByPath = new Map([...(previous?.values() ?? [])].map((clip) => [clip.path, clip] as const))
  const ids: Record<string, string> = {}
  let changed = false
  const audios = refs.map((ref) => {
    const id = byPath.get(ref.path)?.id ?? remembered[ref.path] ?? previousByPath.get(ref.path)?.id
    const clip = id ? byId.get(id) : undefined
    if (!clip) {
      // Gone from the library (or never in it); keep what it was, in case it comes back.
      if (id) ids[ref.path] = id
      return ref
    }
    let next = clip.path === ref.path ? ref : { ...ref, path: clip.path }
    const was = previous?.get(clip.id)
    if (was) {
      const old = referenceAudioOf(was)
      const now = referenceAudioOf(clip)
      const followed = ref.start === old.start && ref.length === old.length
      if (followed && (now.start !== old.start || now.length !== old.length)) {
        next = { ...next, start: now.start, length: now.length }
      }
    }
    if (next !== ref) changed = true
    ids[next.path] = clip.id
    return next
  })
  return { audios: changed ? audios : undefined, ids }
}

/** Clip id → clip, for every clip in the library (the "previous look" of followLibraryAudio). */
export function clipsById(assets: readonly Asset[]): Map<string, AssetAudio> {
  return new Map(assets.flatMap((a) => clipsOf(a).map((clip) => [clip.id, clip] as const)))
}
