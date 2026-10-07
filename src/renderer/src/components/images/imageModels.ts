// Image models, prices, stills and the small helpers the image dialogs share (CreateImageDialog,
// FramePickerDialog, StillViewer, StillThumb). Everything that talks to Venice or the disk goes through
// window.studio; this file only shapes what the dialogs show.

import { useEffect, useState } from 'react'
import { pickOption } from '@shared/models'
import type { ImageModel, Still, StillParams } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { samePath } from '../../lib/library'

/**
 * Seedream by default: the same family as the Seedance video models, and about $0.06 a picture at 1K. With
 * reference images the edit model combines them; without, the text-to-image model draws from the prompt alone.
 */
export const DEFAULT_IMAGE_MODEL = { text: 'seedream-v5-pro', edit: 'seedream-v5-pro-edit' } as const

/** text: a picture from the prompt alone (/image/generate). edit: reference images combined (/image/multi-edit). */
export type ImageMode = keyof typeof DEFAULT_IMAGE_MODEL

/** Venice's default when an edit model doesn't say how many images it takes. */
export const DEFAULT_MAX_INPUT_IMAGES = 3

/** Preferred values when a model is (re)selected and the current value isn't one of its options. */
export const PREFERRED_IMAGE = {
  aspectRatios: ['16:9'],
  resolutions: ['1K'],
  // Medium is a fraction of "high" on the models that have both (e.g. $0.07 vs $0.26 at 1K) and is plenty for a
  // keyframe; the live price shows what a higher setting would cost.
  qualities: ['medium', 'high']
}

// ── Model list ────────────────────────────────────────────────────────────────

// The list rarely changes; one request is shared by every dialog. A failed fetch is forgotten so the next
// dialog tries again (e.g. after the API key was added).
let imageModelsPromise: Promise<ImageModel[]> | undefined

export function loadImageModels(): Promise<ImageModel[]> {
  if (!imageModelsPromise) {
    const request = window.studio.listImageModels()
    imageModelsPromise = request
    request.catch(() => {
      if (imageModelsPromise === request) imageModelsPromise = undefined
    })
  }
  return imageModelsPromise
}

export function useImageModels(): { models: ImageModel[]; loaded: boolean; error?: string } {
  const [state, setState] = useState<{ models: ImageModel[]; loaded: boolean; error?: string }>({
    models: [],
    loaded: false
  })
  useEffect(() => {
    let active = true
    loadImageModels().then(
      (models) => active && setState({ models, loaded: true }),
      (e: unknown) => active && setState({ models: [], loaded: true, error: ipcErrorMessage(e) })
    )
    return () => {
      active = false
    }
  }, [])
  return state
}

export function modeOf(referenceCount: number): ImageMode {
  return referenceCount > 0 ? 'edit' : 'text'
}

/** The models offered for a mode, online ones first, each group by name. */
export function modelsForMode(models: readonly ImageModel[], mode: ImageMode): ImageModel[] {
  return models
    .filter((m) => m.edit === (mode === 'edit'))
    .sort((a, b) => Number(a.offline) - Number(b.offline) || a.name.localeCompare(b.name, 'sv'))
}

/**
 * The model to use for a mode: the wanted one (the user's last choice) if it is listed and online, else the
 * default, else the first online one. Undefined until the list has loaded (or when it has nothing for the mode).
 */
export function pickImageModel(
  models: readonly ImageModel[],
  mode: ImageMode,
  wanted: string | undefined
): ImageModel | undefined {
  const list = modelsForMode(models, mode)
  const usable = (id: string | undefined) => (id ? list.find((m) => m.id === id && !m.offline) : undefined)
  return usable(wanted) ?? usable(DEFAULT_IMAGE_MODEL[mode]) ?? list.find((m) => !m.offline)
}

export function maxInputImages(model: ImageModel | undefined): number {
  return model?.maxInputImages && model.maxInputImages > 0 ? model.maxInputImages : DEFAULT_MAX_INPUT_IMAGES
}

export interface ImageOptions {
  aspectRatio?: string
  resolution?: string
  quality?: string
}

/** "16:9" → 1.777…; undefined for "auto" or anything else that isn't a ratio. */
export function ratioOf(aspect: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '')
  const w = m ? Number(m[1]) : 0
  const h = m ? Number(m[2]) : 0
  return w > 0 && h > 0 ? w / h : undefined
}

/**
 * Of the offered ratios, the wanted one, else the one that stretches it least (a 16:9 sequence gets 3:2 from a
 * model without 16:9, not its first ratio), else "auto" (the base image's shape), else the first.
 */
export function closestAspectRatio(offered: readonly string[], wanted: string): string | undefined {
  if (offered.includes(wanted)) return wanted
  const target = ratioOf(wanted)
  const ratios = offered.filter((r) => ratioOf(r) !== undefined)
  if (target === undefined || !ratios.length) return offered.includes('auto') ? 'auto' : offered[0]
  const stretch = (r: string) => Math.abs(Math.log(ratioOf(r)! / target))
  return ratios.reduce((best, r) => (stretch(r) < stretch(best) ? r : best))
}

/**
 * Snaps aspect ratio, resolution and quality to what the model offers: the current value when it has it, else
 * the sequence's aspect ratio (or the closest one) and the preferred resolution and quality, else the model's
 * first. A model without a list for an option gets none, so nothing it doesn't take is sent.
 */
export function snapImageOptions(model: ImageModel, current: ImageOptions, sequenceAspect?: string): ImageOptions {
  const keepAspect = current.aspectRatio && model.aspectRatios.includes(current.aspectRatio)
  return {
    aspectRatio: keepAspect
      ? current.aspectRatio
      : closestAspectRatio(model.aspectRatios, sequenceAspect ?? PREFERRED_IMAGE.aspectRatios[0]),
    resolution: pickOption(model.resolutions, current.resolution, PREFERRED_IMAGE.resolutions),
    quality: pickOption(model.qualities, current.quality, PREFERRED_IMAGE.qualities)
  }
}

// ── Remembered model choice (a per-window convenience) ──────────────────────

const MODEL_KEYS: Record<ImageMode, string> = { text: 'images:model:text', edit: 'images:model:edit' }

export function rememberedImageModel(mode: ImageMode): string | undefined {
  try {
    return localStorage.getItem(MODEL_KEYS[mode]) ?? undefined
  } catch {
    return undefined
  }
}

export function rememberImageModel(mode: ImageMode, id: string): void {
  try {
    localStorage.setItem(MODEL_KEYS[mode], id)
  } catch {
    // Storage can be unavailable; the default model is a fine fallback.
  }
}

// ── Wording ───────────────────────────────────────────────────────────────────

/**
 * "$0.06", "$0.0375": whole cents with two decimals, anything finer to a hundredth of a cent (Venice prices
 * additional input images in fractions of a cent), rounded up so a price is never shown lower than it is.
 */
export function formatImagePrice(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '–'
  // The epsilon keeps float noise (0.06 * 10000 = 600.0000000000001) from rounding a whole price up.
  const rounded = Math.ceil(usd * 10000 - 1e-6) / 10000
  return `$${rounded.toFixed(4).replace(/0{1,2}$/, '')}`
}

/** "16:9 · liggande", "Auto (som basbilden)". */
export function aspectRatioLabel(ratio: string): string {
  if (ratio === 'auto') return 'Auto (som basbilden)'
  const [w, h] = ratio.split(':').map(Number)
  if (!w || !h) return ratio
  return `${ratio} · ${w === h ? 'kvadrat' : w > h ? 'liggande' : 'stående'}`
}

const QUALITY_LABELS: Record<string, string> = { low: 'Låg', medium: 'Medel', high: 'Hög' }

export function qualityLabel(quality: string): string {
  return QUALITY_LABELS[quality] ?? quality
}

const SOURCE_LABELS: Record<Still['source'], string> = {
  generated: 'Skapad bild',
  upload: 'Egen bild',
  frame: 'Bildruta ur ett klipp'
}

export function stillSourceLabel(still: Pick<Still, 'source'>): string {
  return SOURCE_LABELS[still.source] ?? 'Bild'
}

/** "i dag 14:02", "3 okt. 14:02". */
export function formatStillTime(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  if (new Date().toDateString() === d.toDateString()) return `i dag ${time}`
  return `${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} ${time}`
}

/**
 * A video prompt made usable for an image model: the @ImageN/@AudioN tokens (and the "(@Image1, @Image2)" groups
 * the editor writes after a name) mean nothing to /image/generate, so they are taken out and the spacing tidied.
 */
export function plainImagePrompt(text: string): string {
  return text
    .replace(/\s*\(\s*@(?:Image|Audio)\d+(?:\s*,\s*@(?:Image|Audio)\d+)*\s*\)/g, '')
    .replace(/@(?:Image|Audio)\d+/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim()
}

/** The params actually sent: references capped at the model's limit, the negative prompt only without them. */
export function stillParamsForSubmit(params: StillParams, model: ImageModel | undefined): StillParams {
  const references = (params.referenceImages ?? []).slice(0, maxInputImages(model))
  const negative = params.negativePrompt?.trim()
  return {
    ...params,
    prompt: params.prompt.trim(),
    negativePrompt: references.length || !negative ? undefined : negative,
    referenceImages: references.length ? references : undefined
  }
}

// ── Storyboard boards ─────────────────────────────────────────────────────────

/**
 * "Använd föregående bild som referens": the references with the previous board's image first (on) or without it
 * (off). The others keep their order; the previous image is never in the list twice.
 */
export function withPreviousReference(references: readonly string[], previous: string, on: boolean): string[] {
  const rest = references.filter((p) => p !== previous)
  return on ? [previous, ...rest] : rest
}

/**
 * Whether an image just made for a board may go on it without asking: the board is empty, still shows what it
 * showed when the image was asked for (`seen`; undefined for an empty board, null when that wasn't known), or shows
 * an image made in the same dialog. Anything else was put there meanwhile (in the storyboard, by an agent) and is
 * the user's newer choice.
 */
export function mayPlaceOnBoard(
  now: string | undefined,
  seen: string | undefined | null,
  madeHere: readonly string[]
): boolean {
  if (!now) return true
  if (madeHere.some((p) => samePath(p, now))) return true
  return seen !== null && samePath(now, seen)
}

// ── Live data ─────────────────────────────────────────────────────────────────

/**
 * The stills of a sequence (every still when sequenceId is undefined), newest first, kept live through
 * onStillsChange. `loaded` is false until the first answer, so views can tell "loading" from "empty".
 */
export function useStills(sequenceId?: string): { stills: Still[]; loaded: boolean } {
  const [state, setState] = useState<{ key: string; stills: Still[]; loaded: boolean }>({
    key: sequenceId ?? '',
    stills: [],
    loaded: false
  })
  useEffect(() => {
    let active = true
    let latest = 0
    const key = sequenceId ?? ''
    const refresh = () => {
      // Only the newest request may land, so a slow older answer can't bring back a deleted still.
      const n = ++latest
      window.studio.listStills(sequenceId).then(
        (stills) => {
          if (!active || n !== latest) return
          setState({ key, stills: [...stills].sort((a, b) => b.createdAt - a.createdAt), loaded: true })
        },
        () => {
          // Keep what was there; a failed first load still counts as answered, so views don't wait forever.
          if (!active || n !== latest) return
          setState((s) => (s.key === key ? { ...s, loaded: true } : { key, stills: [], loaded: true }))
        }
      )
    }
    refresh()
    const off = window.studio.onStillsChange((changed) => {
      // A change without a sequence can be a still moving out of one, so it always refreshes.
      if (!sequenceId || !changed || changed === sequenceId) refresh()
    })
    return () => {
      active = false
      off()
    }
  }, [sequenceId])
  return state.key === (sequenceId ?? '') ? state : { stills: [], loaded: false }
}

/** Live USD price of a still (Venice's model pricing via quoteStill); debounced while the options change. */
export function useStillQuote(params: StillParams | undefined): { price?: number; pending: boolean } {
  const [state, setState] = useState<{ key: string; price?: number }>({ key: '' })
  // The prompt doesn't change the price, so typing doesn't refetch it.
  const key = params
    ? JSON.stringify([
        params.model,
        params.referenceImages?.length ?? 0,
        params.aspectRatio,
        params.resolution,
        params.quality
      ])
    : ''
  useEffect(() => {
    if (!params) return
    let cancelled = false
    const t = setTimeout(() => {
      window.studio.quoteStill(params).then(
        (price) => !cancelled && setState({ key, price }),
        () => !cancelled && setState({ key, price: undefined })
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [key])
  if (!params) return { pending: false }
  return state.key === key ? { price: state.price, pending: false } : { pending: true }
}
