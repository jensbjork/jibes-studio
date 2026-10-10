// The descriptions of the library assets a generation refers to, appended to its prompt as a "References" legend
// when it is sent:
//
//   <the user's prompt>
//
//   References:
//   - Anna (@Image1, @Image2; voice @Audio1): tall woman in her thirties, short red hair
//   - Stranden (@Image3): a windswept pebble beach at dawn
//
// Composed at send time, never written into the editor's text: a description edited in the library applies to the
// next generation, the prompt stays readable, and "Använd igen" can't append it twice. Pure and shared, so the
// editor's "Läggs till i prompten" box (renderer), the submit (main) and the agent tools all compose exactly the
// same text.

import { pathKey } from './generation-filter'
import { paramsForSubmit } from './models'
import type {
  Asset,
  ComposedPrompt,
  ComposeOptions,
  DescribedAsset,
  DescriptionEntry,
  GenerationParams,
  PromptLanguage,
  VideoModel
} from './types'

export type { ComposedPrompt, ComposeOptions, DescribedAsset, DescriptionEntry } from './types'

/** The legend's heading, per prompt language. */
const HEADING: Record<PromptLanguage, string> = { en: 'References:', sv: 'Referenser:' }

/** The word in front of an asset's @AudioN tokens: a character's voice, any other asset's sound. */
const AUDIO_WORD: Record<PromptLanguage, { voice: string; sound: string }> = {
  en: { voice: 'voice', sound: 'sound' },
  sv: { voice: 'röst', sound: 'ljud' }
}

/** What is put after a shortened description. */
const ELLIPSIS = '…'

/**
 * The instruction a sequence clip that continues from the previous clip in reference mode is sent with, in front of
 * its prompt (never written into the prompt the user edits): the previous clip's last frame goes along as the last
 * reference image, @Image{frameToken}, and the model is told to start on it. Per prompt language.
 */
export function continuationLeadIn(frameToken: number, language: PromptLanguage): string {
  const token = `@Image${Math.max(1, Math.floor(frameToken) || 1)}`
  return language === 'sv'
    ? `Börja exakt på ${token} (sista bildrutan i föregående klipp) och fortsätt handlingen därifrån.`
    : `Start exactly on ${token} (the last frame of the previous shot) and continue the action from there.`
}

/** Options for composePrompt beyond the stored ComposeOptions. */
export interface ComposeExtras {
  /**
   * Text sent in front of the user's prompt, separated by a blank line (continuationLeadIn). Counted against the
   * character limit like the prompt; not sent with an empty prompt (nothing is).
   */
  leadIn?: string
}

/** "@" and its full-width form: what starts a reference token (prompt-refs). */
const AT_SIGNS = /[@\uFF20]/g

/**
 * Text from the library as the legend writes it: every run of whitespace (line breaks included) one space, and
 * no "@". A description is free text written once for every prompt that will use the asset: an "@Image1" or
 * "@Anna" in it would point at whatever happens to be first in this generation, or be refused as a broken token,
 * so in the legend it is just the word.
 */
function legendText(text: string): string {
  return (typeof text === 'string' ? text : '').replace(AT_SIGNS, '').replace(/\s+/g, ' ').trim()
}

/** Whether the params append the descriptions at all ("Ta med beskrivningar"): on unless switched off. */
export function includesDescriptions(params: Pick<GenerationParams, 'includeDescriptions'>): boolean {
  return params.includeDescriptions !== false
}

/**
 * The options a submission composes with for these params: the switches stored in them, the prompt language
 * and the model's prompt limit. The renderer's box and main's submit both go through here.
 */
export function composeOptionsFor(
  params: Pick<GenerationParams, 'includeDescriptions' | 'excludedDescriptionAssetIds'>,
  language: PromptLanguage,
  characterLimit?: number
): ComposeOptions {
  const excluded = params.excludedDescriptionAssetIds
  return {
    language,
    include: includesDescriptions(params),
    ...(Array.isArray(excluded) && excluded.length ? { excludedAssetIds: [...excluded] } : {}),
    ...(isLimit(characterLimit) ? { characterLimit } : {})
  }
}

/** An asset as composePrompt reads it. */
export function describedAsset(asset: Asset): DescribedAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    description: asset.description ?? '',
    imagePaths: (asset.images ?? []).map((img) => img.path),
    // Kinds without sound (and assets from a main process older than audio) may have no list at all.
    audioPaths: (Array.isArray(asset.audio) ? asset.audio : []).map((clip) => clip.path)
  }
}

/** The library as composePrompt reads it. */
export function describedAssets(assets: readonly Asset[]): DescribedAsset[] {
  return assets.map(describedAsset)
}

/**
 * The two description switches as stored in params, from the window, an agent or JSON. Each is left out while it
 * has its default (on, nothing excluded) – so params from before the switches existed, and a switch turned off and
 * on again, compare equal – and when malformed: `includeDescriptions` is kept only as false, the excluded ids as
 * distinct non-empty strings.
 */
export function sanitizeDescriptionFlags(
  input: unknown
): Pick<GenerationParams, 'includeDescriptions' | 'excludedDescriptionAssetIds'> {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<
    Record<'includeDescriptions' | 'excludedDescriptionAssetIds', unknown>
  >
  const out: Pick<GenerationParams, 'includeDescriptions' | 'excludedDescriptionAssetIds'> = {}
  if (p.includeDescriptions === false) out.includeDescriptions = false
  if (Array.isArray(p.excludedDescriptionAssetIds)) {
    const ids = [
      ...new Set(p.excludedDescriptionAssetIds.filter((id): id is string => typeof id === 'string' && id !== ''))
    ]
    if (ids.length) out.excludedDescriptionAssetIds = ids
  }
  return out
}

function isLimit(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/** An entry being built: the asset and the 1-based numbers of its sent pictures and clips. */
interface Draft {
  asset: DescribedAsset
  name: string
  description: string
  images: number[]
  audios: number[]
}

/** "Anna (@Image1, @Image2; voice @Audio1)": an entry's name and tokens, what stays when its description can't. */
function label(d: Draft, language: PromptLanguage): string {
  const images = d.images.map((n) => `@Image${n}`).join(', ')
  const words = AUDIO_WORD[language]
  const audios = d.audios.length
    ? `${d.asset.kind === 'character' ? words.voice : words.sound} ${d.audios.map((n) => `@Audio${n}`).join(', ')}`
    : ''
  const tokens = [images, audios].filter(Boolean).join('; ')
  return d.name ? `${d.name} (${tokens})` : tokens
}

/** "\n- Anna (@Image1): tall woman …"; without ": …" when the description is empty. */
function line(d: Draft, description: string, language: PromptLanguage): string {
  return `\n- ${label(d, language)}${description ? `: ${description}` : ''}`
}

/**
 * `text` cut at a word boundary so that it, with "…" after it, is at most `max` characters; '' when not even the
 * first word fits. Punctuation left dangling at the cut goes, so it reads "short red hair…", not "hair,…".
 */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  if (max < 2) return ''
  let cut = text.slice(0, max - 1)
  // Cut inside a word: back to the space before it (a word that ends exactly at the cut is whole).
  if (!/\s/.test(text.charAt(max - 1))) cut = cut.replace(/\S*$/, '')
  cut = cut.replace(/[\s,;:.\-–—(]+$/u, '')
  return cut ? cut + ELLIPSIS : ''
}

/**
 * The prompt as it is sent: the user's prompt with a References legend appended that tells the model what each
 * referenced asset is, from the assets' descriptions.
 *
 * - One entry per asset that has a description (not blank), has at least one photo or audio clip among the
 *   references that are actually sent (paramsForSubmit: reference mode only, images within the model's cap, audio
 *   only with a model that takes it and within its limit) and is not excluded (`opts.excludedAssetIds`). Its tokens
 *   are its @ImageN in reference order, then its @AudioN; entries are ordered by their first token (pictures
 *   before audio-only entries). Photos and clips are matched to assets by path, as the library compares paths
 *   (pathKey: Unicode form and letter case ignored).
 * - The legend reads "\n\nReferences:\n- Anna (@Image1, @Image2; voice @Audio1): <description>" (Swedish:
 *   "Referenser:" and "röst"; another asset's clips are "sound"/"ljud"), each description with its whitespace
 *   collapsed to single spaces and without "@" (see legendText).
 * - The user's prompt is never changed: `prompt` is it with trailing whitespace trimmed and the legend appended,
 *   or exactly it when nothing is appended. A blank prompt gets no legend (there is nothing to explain, and a
 *   prompt made of descriptions alone must not be sent), though its entries are still listed.
 * - `opts.leadIn` (a continuation's instruction, continuationLeadIn) goes in front of a non-blank prompt with a blank
 *   line after it, counted against the limit like the prompt.
 * - With a character limit, descriptions that would take the prompt past it are shortened in proportion to their
 *   length, at word boundaries, ending in "…" (`truncated`); if not even the names and tokens fit, no legend is
 *   appended at all (`dropped`). Entries are listed either way.
 *
 * `opts` decide (`include` false: nothing); the params' own switches are not read here, so the editor can ask
 * for every candidate with `include: true`. composeOptionsFor gives the options a submission uses.
 */
export function composePrompt(
  params: GenerationParams,
  assets: readonly DescribedAsset[],
  opts: ComposeOptions & ComposeExtras
): ComposedPrompt {
  const userPrompt = typeof params.prompt === 'string' ? params.prompt : ''
  // The lead-in (a continuation's instruction) goes in front of a prompt that has something to say.
  const leadIn = typeof opts.leadIn === 'string' && userPrompt.trim() ? opts.leadIn.trim() : ''
  const lead = leadIn ? `${leadIn}\n\n` : ''
  const none: ComposedPrompt = { prompt: lead + userPrompt, legend: '', entries: [], truncated: false, dropped: false }
  if (!opts.include) return none
  const language: PromptLanguage = opts.language === 'sv' ? 'sv' : 'en'

  const excluded = new Set(opts.excludedAssetIds ?? [])
  const byImage = new Map<string, DescribedAsset>()
  const byAudio = new Map<string, DescribedAsset>()
  for (const asset of assets) {
    if (!asset || excluded.has(asset.id) || !legendText(asset.description)) continue
    // The first asset to claim a file keeps it.
    const claim = (index: Map<string, DescribedAsset>, paths: readonly string[] | undefined): void => {
      for (const p of paths ?? []) {
        if (typeof p === 'string' && p && !index.has(pathKey(p))) index.set(pathKey(p), asset)
      }
    }
    claim(byImage, asset.imagePaths)
    claim(byAudio, asset.audioPaths)
  }
  if (!byImage.size && !byAudio.size) return none

  const sent = paramsForSubmit(params)
  const drafts = new Map<string, Draft>()
  const draftOf = (asset: DescribedAsset): Draft => {
    let d = drafts.get(asset.id)
    if (!d) {
      d = { asset, name: legendText(asset.name), description: legendText(asset.description), images: [], audios: [] }
      drafts.set(asset.id, d)
    }
    return d
  }
  // Pictures first, then clips: a Map keeps insertion order, which is then the order of the first tokens.
  ;(sent.referenceImages ?? []).forEach((path, i) => {
    const asset = typeof path === 'string' ? byImage.get(pathKey(path)) : undefined
    if (asset) draftOf(asset).images.push(i + 1)
  })
  ;(sent.referenceAudios ?? []).forEach((clip, i) => {
    const asset = byAudio.get(pathKey(clip.path))
    if (asset) draftOf(asset).audios.push(i + 1)
  })
  const list = [...drafts.values()]
  if (!list.length) return none

  const entry = (d: Draft, description: string): DescriptionEntry => ({
    assetId: d.asset.id,
    kind: d.asset.kind,
    name: d.name,
    tokens: [...d.images.map((n) => `@Image${n}`), ...d.audios.map((n) => `@Audio${n}`)],
    description,
    ...(description !== d.description ? { shortened: true } : {})
  })
  const own = userPrompt.trimEnd()
  if (!own) return { ...none, entries: list.map((d) => entry(d, d.description)) }
  const base = lead + own

  const heading = `\n\n${HEADING[language]}`
  const full = heading + list.map((d) => line(d, d.description, language)).join('')
  const limit = isLimit(opts.characterLimit)
    ? opts.characterLimit
    : isLimit(opts.promptCharacterLimit)
      ? opts.promptCharacterLimit
      : undefined
  if (limit === undefined || base.length + full.length <= limit) {
    return {
      prompt: base + full,
      legend: full,
      entries: list.map((d) => entry(d, d.description)),
      truncated: false,
      dropped: false
    }
  }

  // Too long: first what can't be shortened – the prompt, the heading, every entry's name and tokens.
  const fixed = base.length + heading.length + list.reduce((sum, d) => sum + line(d, '', language).length, 0)
  if (fixed > limit) {
    const entries = list.map((d) => entry(d, d.description))
    return { prompt: lead + userPrompt, legend: '', entries, truncated: false, dropped: true }
  }
  const shortened = fitDescriptions(list.map((d) => d.description), limit - fixed)
  const legend = heading + list.map((d, i) => line(d, shortened[i], language)).join('')
  return {
    prompt: base + legend,
    legend,
    entries: list.map((d, i) => entry(d, shortened[i])),
    truncated: true,
    dropped: false
  }
}

/**
 * The descriptions shortened so that together, each with the ": " in front of it, they take at most `budget`
 * characters. Each gets a share in proportion to its length; one whose share can't hold even a word and "…" gives
 * its share up to the others and is left out (''). Whole words only (shorten), so the cuts leave a little room
 * over: it goes back to the descriptions that lost the most first (one left out can come back), as far as it lets
 * them keep another word.
 */
function fitDescriptions(descriptions: readonly string[], budget: number): string[] {
  const SEPARATOR = 2 // ": "
  let kept = descriptions.map((d, i) => (d ? i : -1)).filter((i) => i >= 0)
  let out: string[] = descriptions.map(() => '')
  for (;;) {
    const total = kept.reduce((sum, i) => sum + descriptions[i].length, 0)
    const room = budget - SEPARATOR * kept.length
    if (!kept.length || room <= 0) {
      out = descriptions.map(() => '')
      break
    }
    out = descriptions.map((d, i) => (kept.includes(i) ? shorten(d, Math.floor((room * d.length) / total)) : ''))
    // A description that came out empty frees its share and separator: share the room again without it.
    if (kept.every((i) => out[i])) break
    kept = kept.filter((i) => out[i])
  }
  const used = (text: string): number => (text ? SEPARATOR + text.length : 0)
  let spare = budget - out.reduce((sum, text) => sum + used(text), 0)
  /** How much of a description is left. */
  const left = (i: number): number => out[i].length / descriptions[i].length
  const order = [...descriptions.keys()]
    .filter((i) => descriptions[i] && out[i] !== descriptions[i])
    .sort((a, b) => left(a) - left(b) || a - b)
  for (const i of order) {
    // One left out needs its separator back as well.
    const longer = shorten(descriptions[i], out[i] ? out[i].length + spare : spare - SEPARATOR)
    if (used(longer) <= used(out[i])) continue
    spare -= used(longer) - used(out[i])
    out[i] = longer
  }
  return out
}

// ── Prompt limits of the models ───────────────────────────────────────────────
// The limit lives in the model list (VideoModel.promptCharacterLimit), which main fetches from Venice. What a
// submission composes with must not depend on which view happened to fetch the list, so main remembers the
// limits here when it gets the list (like rememberModelKinds in models.ts).

/** Model id → its prompt limit, null for a model without one. */
const knownLimits = new Map<string, number | null>()

/** Records the prompt limits from a fetched model list. */
export function rememberPromptLimits(models: readonly Pick<VideoModel, 'id' | 'promptCharacterLimit'>[]): void {
  for (const m of models) {
    if (!m || typeof m.id !== 'string') continue
    knownLimits.set(m.id, isLimit(m.promptCharacterLimit) ? m.promptCharacterLimit : null)
  }
}

/** The model's prompt limit from the remembered list; undefined when it has none or the list hasn't arrived. */
export function promptLimitOf(modelId: string): number | undefined {
  return knownLimits.get(modelId) ?? undefined
}

/** Whether the remembered list knows the model at all (with or without a limit). */
export function knowsPromptLimit(modelId: string): boolean {
  return knownLimits.has(modelId)
}
