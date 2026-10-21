// The descriptions of the library assets a prompt refers to, which are appended to it as a "References" legend
// when it is sent. The legend itself is written by the shared composePrompt (src/shared/prompt-compose.ts), the
// same function main sends with, so what the "Added to the prompt" box shows is exactly what Venice gets. This
// file only asks it the box's questions (which assets, which of them are sent, shortened or left out), keeps the
// two flags in the params tidy, and splits a sent prompt back into the user's text and the legend for display.
// Pure: no React.

import { pathKey } from '@shared/generation-filter'
import {
  composeOptionsFor,
  composePrompt,
  describedAssets,
  explainedReferences,
  includesDescriptions,
  type ComposedPrompt
} from '@shared/prompt-compose'
import type { ResolvedDirector } from '@shared/direction'
import type { ValidateOptions } from '@shared/prompt-refs'
import type { Asset, ComposedDirection, GenerationParams, PromptLanguage } from '@shared/types'

/** One described asset among the sent references (or an outfit somebody wears), as the box lists it. */
export interface DescriptionRow {
  asset: Asset
  /** Its @ImageN tokens in reference order, then its @AudioN tokens. */
  tokens: string[]
  /** The description as the legend writes it in full (whitespace collapsed); '' for a worn outfit without one. */
  description: string
  /** An outfit: the character wearing it, as the legend names it ("worn by Anna (@Image1)"; shared/outfits.ts). */
  wornBy?: { asset: Asset; tokens: string[] }
  /** Its own toggle: not in excludedDescriptionAssetIds. */
  on: boolean
  /** In the legend that is sent: its toggle and the master switch are on, and the legend fits the model's limit. */
  sent: boolean
  /**
   * What is sent instead when the description had to be shortened to fit the model's limit; '' when not even
   * its first word fitted, so only the name and tokens are sent.
   */
  shortened?: string
}

export interface DescriptionsView {
  /** Every described asset (and worn outfit) among the sent references, in the legend's order (by first token). */
  rows: DescriptionRow[]
  /** Assets among the sent references that have no description, so nothing of theirs is added. */
  undescribed: Asset[]
  /** The master switch. */
  include: boolean
  /** The prompt as it will be sent, with the legend (if any). */
  composed: ComposedPrompt
  /** The prompt is blank: nothing is appended to it yet (and it can't be sent). */
  blank: boolean
  /** The model's prompt limit, when it has one. */
  limit?: number
  /** Descriptions were shortened (or some left out) so the prompt fits the limit. */
  truncated: boolean
  /** Not even names and tokens fit the limit, so no legend is sent at all. */
  dropped: boolean
  /**
   * The @ImageN / @AudioN numbers the legend that is sent explains (ValidateOptions.explained), and the @ImageN /
   * @VideoN of a director's style frames and videos: the prompt checks don't report those as unmentioned.
   */
  explained: NonNullable<ValidateOptions['explained']>
  /** The director's Direction section, when one directs the params (composed.direction). */
  direction?: ComposedDirection
  /** What the director adds to the negative prompt (its `avoid`), when it directs the params. */
  directionAvoid?: string
}

/**
 * What the box shows for a set of params: the rows (also the ones switched off, so they can be switched on
 * again), the referenced assets without a description, and the composed prompt with its length – and which
 * references the sent legend explains, for the prompt checks. `director`: the one directing the params (which are
 * then withDirection's): its Direction section is composed after the legend, as main composes it.
 */
export function descriptionsView(
  params: GenerationParams,
  assets: readonly Asset[],
  language: PromptLanguage,
  promptCharacterLimit?: number,
  director?: ResolvedDirector
): DescriptionsView {
  const described = describedAssets(assets)
  const byId = new Map(assets.map((a) => [a.id, a]))
  // Which assets count as sent references (the model's image cap, the audio rules, how paths are compared) and
  // what counts as a description are the shared module's decisions, so the box asks it rather than repeating
  // them: with a stand-in description for every asset it lists all referenced assets, with the real ones (and
  // nothing switched off or shortened) the described ones in full, and with the params' own options what is sent.
  const referenced = composePrompt(
    params,
    described.map((d) => ({ ...d, description: '–' })),
    { language, include: true }
  )
  const candidates = composePrompt(params, described, { language, include: true })
  const composed = composePrompt(params, described, {
    ...composeOptionsFor(params, language, promptCharacterLimit),
    ...(director ? { director } : {})
  })
  const include = includesDescriptions(params)
  const blank = !params.prompt.trim()
  const excluded = new Set(params.excludedDescriptionAssetIds ?? [])
  // A blank prompt gets no legend, but its entries say what will be appended once there is one.
  const appended = !composed.dropped && (blank || composed.legend !== '')
  const sentEntries = new Map(appended ? composed.entries.map((e) => [e.assetId, e]) : [])

  const rows: DescriptionRow[] = []
  for (const entry of candidates.entries) {
    const asset = byId.get(entry.assetId)
    if (!asset) continue
    const sent = sentEntries.get(asset.id)
    const wearer = entry.wornBy && byId.get(entry.wornBy.assetId)
    rows.push({
      asset,
      tokens: entry.tokens,
      description: entry.description,
      ...(wearer ? { wornBy: { asset: wearer, tokens: entry.wornBy!.tokens } } : {}),
      on: !excluded.has(asset.id),
      sent: !!sent,
      ...(sent?.shortened ? { shortened: sent.description } : {})
    })
  }
  const listed = new Set(rows.map((r) => r.asset.id))
  const undescribed = referenced.entries.flatMap((e) => {
    const asset = byId.get(e.assetId)
    return asset && !listed.has(asset.id) ? [asset] : []
  })
  return {
    rows,
    undescribed,
    include,
    composed,
    blank,
    ...(promptCharacterLimit ? { limit: promptCharacterLimit } : {}),
    truncated: composed.truncated && !composed.dropped,
    dropped: composed.dropped,
    explained: explainedReferences(composed),
    ...(composed.direction ? { direction: composed.direction } : {}),
    ...(director?.direction.avoid ? { directionAvoid: director.direction.avoid } : {})
  }
}

// ── The flags ────────────────────────────────────────────────────────────────
// Both are left out of the params while they have their default (on, nothing excluded), as
// sanitizeDescriptionFlags stores them, so params from before the feature, a switch turned off and on again, and
// a sequence clip's saved params all compare equal.

/** The params with the master switch ("Include descriptions") set. */
export function withDescriptionsIncluded(params: GenerationParams, on: boolean): GenerationParams {
  if (params.includeDescriptions === (on ? undefined : false)) return params
  const { includeDescriptions: _, ...rest } = params
  return on ? rest : { ...rest, includeDescriptions: false }
}

/** Ids of the library assets the form refers to at all: any reference image or clip, also ones not sent. */
export function assetIdsInForm(
  params: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'>,
  assets: readonly Asset[]
): Set<string> {
  const paths = new Set([
    ...(params.referenceImages ?? []).map(pathKey),
    ...(params.referenceAudios ?? []).map((a) => pathKey(a.path))
  ])
  const ids = new Set<string>()
  if (!paths.size) return ids
  for (const a of assets) {
    const files = [...a.images.map((img) => img.path), ...(a.audio ?? []).map((clip) => clip.path)]
    if (files.some((p) => paths.has(pathKey(p)))) ids.add(a.id)
  }
  return ids
}

/**
 * The params with one asset's description switched on or off. Ids of assets that have left the form are
 * forgotten on the way, so the list doesn't keep every asset ever switched off; one that is still there (also
 * past the model's limit, where reordering may bring it back) keeps its choice.
 */
export function withAssetDescription(
  params: GenerationParams,
  assetId: string,
  on: boolean,
  inForm: ReadonlySet<string>
): GenerationParams {
  const before = params.excludedDescriptionAssetIds ?? []
  const kept = [...new Set(before)].filter((id) => id !== assetId && inForm.has(id))
  const next = on ? kept : [...kept, assetId]
  if (next.length === before.length && next.every((id, i) => id === before[i])) return params
  const { excludedDescriptionAssetIds: _, ...rest } = params
  return next.length ? { ...rest, excludedDescriptionAssetIds: next } : rest
}

// ── Sent prompts ─────────────────────────────────────────────────────────────

/** Whether what was sent differs from the user's prompt in more than surrounding whitespace (a legend was added). */
export function sentPromptDiffers(prompt: string, sentPrompt: string | undefined): sentPrompt is string {
  return !!sentPrompt && sentPrompt.trim() !== prompt.trim()
}

/**
 * A sent prompt split into the user's text and what was appended to it (the legend, without the blank line
 * before it), so views can set the legend apart. When the sent prompt doesn't start with the user's text (it
 * was written some other way), all of it is `body`.
 */
export function splitComposedPrompt(prompt: string, sentPrompt: string): { body: string; legend: string } {
  const body = prompt.trimEnd()
  if (body && sentPrompt.length > body.length && sentPrompt.startsWith(body)) {
    const legend = sentPrompt.slice(body.length).replace(/^\s+/, '')
    if (legend) return { body, legend }
  }
  return { body: sentPrompt, legend: '' }
}
