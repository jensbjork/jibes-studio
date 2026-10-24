import { useEffect, useRef } from 'react'
import { directorDefaults, resolveDirector } from '@shared/direction'
import {
  DEFAULT_MODEL,
  KINDS,
  PREFERRED,
  audioForModel,
  kindOfModelId,
  maxReferenceAudios,
  maxReferenceImages,
  paramsForSubmit,
  pickOption,
  referenceVideoLimits,
  referenceVideosOf,
  supportsAudioInput,
  supportsEndImage,
  type Kind
} from '@shared/models'
import { canonicalizeTokens, findAudioTokens, findImageTokens, findMalformedTokens } from '@shared/prompt-refs'
import { outfitWearersAmong, sanitizeOutfitWearers } from '@shared/outfits'
import { sanitizeDescriptionFlags } from '@shared/prompt-compose'
import { referenceMoves, reorderReferences } from '@shared/prompt-remap'
import { swapReferenceAsset, swapReferenceImage } from '@shared/reference-swap'
import { isMediaTab, type MediaTab } from '@shared/session'
import type {
  AgentCommand,
  AgentCommandReply,
  AgentFormAudioReference,
  AgentFormReference,
  AgentFormState,
  AgentOpenResult,
  Asset,
  AssetKind,
  GenerationParams,
  ReferenceAudio,
  ReferenceVideo,
  VideoModel
} from '@shared/types'
import { modelForKind } from '../components/ParamsForm'
import { addPaths, sameList } from '../components/pickers/assetRefs'
import { addAudios, audioSourcesByPath, sameAudios, windowOf } from '../components/pickers/audioRefs'
import { appendVideoWindows } from '../components/pickers/videoRefs'
import { ASSET_VIEW } from './assets'
import { directorById, isPresetId } from './directors'
import { followGenerateAudio, generateParamsFrozen, getGenerateParams, setGenerateParams } from './generateStore'
import { SERVICE_NAME, ipcErrorMessage, loadModels } from './hooks'
import { SELECTED_ASSET_KEYS, fileName, followAssetImages, isAbsolutePath, readRememberedImageIds } from './library'
import { getMediaTab, setMediaTab } from './mediaTab'
import type { Intent, Navigate, View } from './navigation'
import { promptIssuesOf } from './promptIssues'
import { openEditInEditor, openInSequenceEditor, openStoryboard } from './workspace'

// The renderer half of the agent connection. Tools that read or fill the Generate form (get_workspace,
// set_form, set_references, reorder_references, swap_reference) and open_in_studio (Generate or a clip in its drawer, Media
// on a tab or with a clip, picture or film open, a sequence, a storyboard or one of its transitions, an edit or one
// of its versions in the Editor, an asset, the prompt library) reach main's MCP server as an 'agent:command';
// this applies them to the form store with the same rules the form itself uses (mode switching, model options,
// the reference caps for images and audio, tokens following a reorder, names following a swap) and answers with
// 'agent:reply'.
// Everything else the agent does goes straight to main's services. Error messages are shown to the agent, which
// relays them to the user.

/** An image of the form tied to the library photo it is (asset, photo number), like a reference minus its token. */
export type FormImage = Omit<AgentFormReference, 'token'>

/**
 * The answer to get_form, set_form, set_references, reorder_references and swap_reference. `params` is what a
 * generation would send now (inputs the mode doesn't use are left out); `references` are in order, @Image1 first, only in reference mode and
 * only the images the model takes; `audioReferences` likewise, @Audio1 first, only when the model takes audio.
 */
export interface FormSnapshot extends AgentFormState {
  view: View
  /** The Media tab on screen (view 'media'). */
  mediaTab?: MediaTab
  /** The start (and end) image in image-to-video mode, tied to its library photo. */
  startImage?: FormImage
  endImage?: FormImage
  /** What the command adjusted on its own, e.g. a mode switch or images that didn't fit. */
  notes?: string[]
}

/** A refusal with a message meant for the agent (nothing was changed). */
export class BridgeError extends Error {}

type Args = Record<string, unknown>

function asArgs(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Args) : {}
}

/** A tool argument by its snake_case name, or the camelCase spelling main may pass instead. */
function field(args: Args, snake: string): unknown {
  if (args[snake] !== undefined) return args[snake]
  return args[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null
}

// ── Modes and models ────────────────────────────────────────────────────────

const MODE_ALIASES: Record<string, Kind> = {
  'text-to-video': 'text-to-video',
  text: 'text-to-video',
  t2v: 'text-to-video',
  'image-to-video': 'image-to-video',
  image: 'image-to-video',
  i2v: 'image-to-video',
  'start-image': 'image-to-video',
  start_image: 'image-to-video',
  startbild: 'image-to-video',
  'reference-to-video': 'reference-to-video',
  reference: 'reference-to-video',
  references: 'reference-to-video',
  r2v: 'reference-to-video',
  referens: 'reference-to-video'
}

/** "“Reference” (reference-to-video)": the tab name the user sees and the id the agent uses. */
function modeName(kind: Kind): string {
  return `“${KINDS.find((k) => k.id === kind)?.label ?? kind}” (${kind})`
}

function parseMode(value: unknown): Kind {
  const kind = typeof value === 'string' ? MODE_ALIASES[value.trim().toLowerCase()] : undefined
  if (!kind) {
    throw new BridgeError(
      `Unknown mode “${String(value)}”. Use text-to-video, image-to-video (start image) or reference-to-video (reference images).`
    )
  }
  return kind
}

/** Duration, resolution, aspect ratio and audio snapped to what the model supports, as the form does. */
function snapToModel(params: GenerationParams, model: VideoModel | undefined): GenerationParams {
  if (!model) return params
  return {
    ...params,
    duration: pickOption(model.durations, params.duration, PREFERRED.durations) ?? params.duration,
    resolution: pickOption(model.resolutions, params.resolution, PREFERRED.resolutions),
    aspectRatio: pickOption(model.aspectRatios, params.aspectRatio, PREFERRED.aspectRatios),
    audio: audioForModel(model, params.audio)
  }
}

/** Notes for the settings a model change adjusted without being asked. */
function adjustedNotes(before: GenerationParams, after: GenerationParams, explicit: Set<string>): string[] {
  const labels: [keyof GenerationParams, string, string][] = [
    ['duration', 'duration', 'The duration'],
    ['resolution', 'resolution', 'The resolution'],
    ['aspectRatio', 'aspect_ratio', 'The aspect ratio']
  ]
  return labels.flatMap(([key, arg, label]) =>
    !explicit.has(arg) && before[key] !== after[key] && after[key] !== undefined
      ? [`${label} changed to ${String(after[key])}, which the model supports.`]
      : []
  )
}

/** "8" or 8 → "8s"; anything else as written. */
function normalizeDuration(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}s`
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase().replace(/\s+/g, '')
  return /^\d+(\.\d+)?$/.test(v) ? `${v}s` : v
}

/** "720" or 720 → "720p". */
function normalizeResolution(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}p`
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  return /^\d+$/.test(v) ? `${v}p` : v
}

/** "16x9" → "16:9". */
function normalizeAspect(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().replace(/^(\d+)\s*[x/]\s*(\d+)$/i, '$1:$2') : undefined
}

function choices(options: readonly string[]): string {
  return options.join(', ')
}

// ── Commands (pure, so they can be tested without a window) ─────────────────

export interface FormChange {
  params: GenerationParams
  notes: string[]
}

/**
 * Applies set_form's arguments to the form. Everything is checked before anything changes: one invalid value
 * refuses the whole command with every problem listed. Choosing a mode picks a model of that mode in the
 * same family (like the mode tabs); a start image without a mode switches to image-to-video.
 */
export function applySetForm(
  current: GenerationParams,
  rawArgs: unknown,
  models: readonly VideoModel[],
  modelsError?: string,
  assets: readonly Asset[] = []
): FormChange {
  const args = asArgs(rawArgs)
  const modeValue = field(args, 'mode')
  const modelValue = field(args, 'model')
  const durationValue = field(args, 'duration')
  const resolutionValue = field(args, 'resolution')
  const aspectValue = field(args, 'aspect_ratio')
  const audioValue = field(args, 'audio')
  const promptValue = field(args, 'prompt')
  const negativeValue = field(args, 'negative_prompt')
  const startValue = field(args, 'start_image')
  const endValue = field(args, 'end_image')
  const includeValue = field(args, 'include_descriptions')
  const excludedValue = field(args, 'excluded_description_asset_ids')
  const wearersValue = field(args, 'outfit_wearers')
  const directorValue = field(args, 'director')
  const explicit = new Set(
    ['duration', 'resolution', 'aspect_ratio', 'audio'].filter((key) => given(field(args, key)))
  )

  const needsModels = [
    modeValue,
    modelValue,
    durationValue,
    resolutionValue,
    aspectValue,
    audioValue,
    startValue,
    endValue
  ].some(given)
  if (needsModels && !models.length) {
    throw new BridgeError(
      `Studio couldn't fetch the model list from ${SERVICE_NAME}${modelsError ? ` (${modelsError})` : ''}. Try again in a moment.`
    )
  }

  const errors: string[] = []
  const notes: string[] = []
  const mode = given(modeValue) ? parseMode(modeValue) : undefined

  // Mode and model first: the other values are checked against the model they end up with.
  let modelId = current.model
  if (given(modelValue)) {
    const id = typeof modelValue === 'string' ? modelValue.trim() : ''
    const chosen = models.find((m) => m.id === id)
    if (!chosen) errors.push(`The model “${String(modelValue)}” doesn't exist. See list_models for the ones that do.`)
    else if (chosen.offline) errors.push(`${chosen.name} is offline right now – pick another model.`)
    else if (mode && kindOfModelId(chosen.id) !== mode) {
      errors.push(`${chosen.name} belongs to the mode ${modeName(kindOfModelId(chosen.id))}, not ${modeName(mode)}.`)
    } else modelId = chosen.id
  } else {
    const currentKind = kindOfModelId(current.model)
    const picture = given(startValue) || given(endValue)
    const wanted = mode ?? (picture && currentKind !== 'image-to-video' ? 'image-to-video' : undefined)
    if (wanted && wanted !== currentKind) {
      const id = modelForKind([...models], current.model, wanted)
      if (!id) errors.push(`There is no model available for the mode ${modeName(wanted)} right now.`)
      else {
        modelId = id
        const slot = given(startValue) ? 'the start image' : 'the end image'
        if (!mode) notes.push(`Switched to the mode ${modeName(wanted)} for ${slot}.`)
      }
    }
  }

  const model = models.find((m) => m.id === modelId)
  const modelLabel = model?.name ?? modelId
  const modelChanged = modelId !== current.model
  const before: GenerationParams = { ...current, model: modelId }
  const next = snapToModel(before, model)
  if (modelChanged) {
    notes.push(...adjustedNotes(current, next, explicit))
    const audios = current.referenceAudios?.length ?? 0
    if (audios && supportsAudioInput(current.model) && !supportsAudioInput(model ?? modelId)) {
      notes.push(
        `${modelLabel} doesn't take sound references – the sound (${audios} ${audios === 1 ? 'clip' : 'clips'}) stays in the form but isn't sent.`
      )
    }
    // Reference videos: kept in the form, but only a Seedance 2.x reference model sends them, within its family's limits.
    const videos = referenceVideosOf(current).length
    const was = referenceVideoLimits(current.model)
    const now = referenceVideoLimits(modelId)
    if (videos && was && !now) {
      notes.push(
        `${modelLabel} doesn't take reference videos – the ${videos === 1 ? 'video stays' : `${videos} videos stay`} in the form but ${videos === 1 ? "isn't" : "aren't"} sent.`
      )
    } else if (videos && now && was && now.family !== was.family && videos > now.maxVideos) {
      notes.push(
        `${now.family} takes at most ${now.maxVideos} reference videos – the last ${videos - now.maxVideos} of ${videos} ${videos - now.maxVideos === 1 ? "isn't" : "aren't"} sent.`
      )
    }
  }

  const unknownModel = () =>
    errors.push(`The model ${modelLabel} isn't in ${SERVICE_NAME}'s model list – pick another one with model.`)

  if (given(durationValue)) {
    const duration = normalizeDuration(durationValue)
    if (!model) unknownModel()
    else if (!duration || !model.durations.includes(duration)) {
      errors.push(`The duration ${String(durationValue)} doesn't work with ${modelLabel}. Choose from: ${choices(model.durations)}.`)
    } else next.duration = duration
  }

  if (given(resolutionValue)) {
    const resolution = normalizeResolution(resolutionValue)
    if (!model) unknownModel()
    else if (!model.resolutions.length) errors.push(`${modelLabel} has no resolution to choose.`)
    else if (!resolution || !model.resolutions.includes(resolution)) {
      errors.push(
        `The resolution ${String(resolutionValue)} doesn't work with ${modelLabel}. Choose from: ${choices(model.resolutions)}.`
      )
    } else next.resolution = resolution
  }

  if (given(aspectValue)) {
    const aspect = normalizeAspect(aspectValue)
    if (!model) unknownModel()
    else if (!model.aspectRatios.length) errors.push(`${modelLabel} has no aspect ratio to choose.`)
    else if (!aspect || !model.aspectRatios.includes(aspect)) {
      errors.push(
        `The aspect ratio ${String(aspectValue)} doesn't work with ${modelLabel}. Choose from: ${choices(model.aspectRatios)}.`
      )
    } else next.aspectRatio = aspect
  }

  if (given(audioValue)) {
    if (typeof audioValue !== 'boolean') errors.push('audio must be true or false.')
    else if (!model) unknownModel()
    else if (!model.audio) {
      if (audioValue) errors.push(`${modelLabel} can't generate audio.`)
    } else if (!model.audioConfigurable && !audioValue) errors.push(`Audio can't be turned off for ${modelLabel}.`)
    else next.audio = audioValue
  }

  if (promptValue !== undefined) {
    if (promptValue === null) next.prompt = ''
    else if (typeof promptValue !== 'string') errors.push('prompt must be text.')
    else next.prompt = canonicalizeTokens(promptValue)
  }

  if (negativeValue !== undefined) {
    if (negativeValue === null) next.negativePrompt = undefined
    else if (typeof negativeValue !== 'string') errors.push('negative_prompt must be text.')
    else next.negativePrompt = negativeValue.trim() ? negativeValue : undefined
  }

  if (startValue !== undefined) {
    if (startValue === null) next.startImage = undefined
    else {
      const path = typeof startValue === 'string' ? startValue : asArgs(startValue).path
      const kind = kindOfModelId(next.model)
      if (typeof path !== 'string' || !isAbsolutePath(path)) errors.push("The start image couldn't be found in the library.")
      else if (kind !== 'image-to-video') {
        errors.push(`A start image is only used in the mode ${modeName('image-to-video')}, not ${modeName(kind)}.`)
      } else next.startImage = path
    }
  }

  // The end image, as the form's own slot takes it: only for an image-to-video model that takes one.
  if (endValue !== undefined) {
    if (endValue === null) next.endImage = undefined
    else {
      const path = typeof endValue === 'string' ? endValue : asArgs(endValue).path
      const kind = kindOfModelId(next.model)
      if (typeof path !== 'string' || !isAbsolutePath(path)) errors.push("The end image couldn't be found in the library.")
      else if (kind !== 'image-to-video') {
        errors.push(`An end image is only used in the mode ${modeName('image-to-video')}, not ${modeName(kind)}.`)
      } else if (!supportsEndImage(next.model)) {
        errors.push(`${modelLabel} takes no end image. Pick an image-to-video model that does.`)
      } else next.endImage = path
    }
  }

  // The description switches ("Include descriptions" and each asset's own), stored as the form's own box stores
  // them: left out while they have their default, so the form compares equal to one never switched.
  if (includeValue !== undefined) {
    if (includeValue === null || includeValue === true) delete next.includeDescriptions
    else if (includeValue === false) next.includeDescriptions = false
    else errors.push('include_descriptions must be true or false.')
  }
  if (excludedValue !== undefined) {
    if (excludedValue === null) delete next.excludedDescriptionAssetIds
    else if (!Array.isArray(excludedValue) || excludedValue.some((id) => typeof id !== 'string' || !id.trim())) {
      errors.push('excluded_description_asset_ids must be a list of asset ids.')
    } else {
      const ids = sanitizeDescriptionFlags({ excludedDescriptionAssetIds: excludedValue.map((id) => id.trim()) })
      if (ids.excludedDescriptionAssetIds) next.excludedDescriptionAssetIds = ids.excludedDescriptionAssetIds
      else delete next.excludedDescriptionAssetIds
    }
  }

  // Who wears each outfit ("worn by"), as the chips store it: main checked the outfits and characters and sends the
  // whole set of choices (null: none left, every outfit worn by its default).
  if (wearersValue !== undefined) {
    if (wearersValue === null) delete next.outfitWearers
    else if (typeof wearersValue !== 'object' || Array.isArray(wearersValue)) {
      errors.push("outfit_wearers couldn't be read.")
    } else {
      const wearers = sanitizeOutfitWearers(wearersValue)
      if (wearers) next.outfitWearers = wearers
      else delete next.outfitWearers
    }
  }

  // The director (an asset id or a ready-made one's; null: none), as the form's picker sets it: choosing one applies
  // its defaults – model, aspect ratio, resolution – where the models offer them, unless the same call sets them.
  if (directorValue !== undefined) {
    if (directorValue === null || directorValue === '') delete next.director
    else if (typeof directorValue !== 'string') errors.push('director must be a director id, or null for none.')
    else {
      const director = resolveDirector(directorValue.trim(), assets)
      if (!director) {
        errors.push(`The director “${directorValue}” doesn't exist. See list_directors for the ones that do.`)
      } else {
        next.director = director.id
        const set = directorDefaults(next, director.direction, models.filter((m) => !m.offline))
        const keep = {
          ...(set.model && !given(modelValue) && !mode ? { model: set.model } : {}),
          ...(set.aspectRatio && !explicit.has('aspect_ratio') ? { aspectRatio: set.aspectRatio } : {}),
          ...(set.resolution && !explicit.has('resolution') ? { resolution: set.resolution } : {})
        }
        if (keep.model) {
          const chosen = models.find((m) => m.id === keep.model)
          Object.assign(next, snapToModel({ ...next, model: keep.model }, chosen), keep)
          notes.push(`${director.name} chose the model ${chosen?.name ?? keep.model}.`)
        } else Object.assign(next, keep)
        if (keep.aspectRatio) notes.push(`${director.name} set the aspect ratio to ${keep.aspectRatio}.`)
        if (keep.resolution) notes.push(`${director.name} set the resolution to ${keep.resolution}.`)
      }
    }
  }

  const limit = model?.promptCharacterLimit
  if (limit && next.prompt.length > limit && (promptValue !== undefined || modelChanged)) {
    errors.push(`The prompt is ${next.prompt.length} characters – ${modelLabel} takes at most ${limit}. Shorten it.`)
  }

  if (errors.length) throw new BridgeError(`Nothing was changed. ${errors.join(' ')}`)
  return { params: next, notes }
}

/** A number of seconds from the agent: undefined when left out, NaN when it isn't one. */
function seconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.NaN
}

/** set_references' `audios`: reference audio clips (main resolved the agent's audio ids and windows). */
function parseAudios(value: unknown): ReferenceAudio[] | undefined {
  if (value === undefined || value === null) return undefined
  const unreadable = "The sound references couldn't be read (audios must be a list of audio files and their excerpts)."
  if (!Array.isArray(value)) throw new BridgeError(unreadable)
  return value.map((item): ReferenceAudio => {
    const a = typeof item === 'string' ? { path: item } : asArgs(item)
    const start = seconds(a.start)
    const length = seconds(a.length)
    if (typeof a.path !== 'string' || !isAbsolutePath(a.path) || Number.isNaN(start) || Number.isNaN(length)) {
      throw new BridgeError(unreadable)
    }
    return {
      path: a.path,
      ...(start !== undefined ? { start } : {}),
      ...(length !== undefined ? { length } : {})
    }
  })
}

/** set_references' `videos`: reference videos with their windows (main resolved the agent's ids and measured them). */
function parseVideos(value: unknown): ReferenceVideo[] | undefined {
  if (value === undefined || value === null) return undefined
  const unreadable = "The reference videos couldn't be read (videos must be a list of video files and their windows)."
  if (!Array.isArray(value)) throw new BridgeError(unreadable)
  return value.map((item): ReferenceVideo => {
    const v = typeof item === 'string' ? { path: item } : asArgs(item)
    const start = seconds(v.start)
    const length = seconds(v.length)
    if (typeof v.path !== 'string' || !isAbsolutePath(v.path) || Number.isNaN(start) || Number.isNaN(length)) {
      throw new BridgeError(unreadable)
    }
    return {
      path: v.path,
      ...(start !== undefined ? { start } : {}),
      ...(length !== undefined ? { length } : {})
    }
  })
}

/**
 * Applies set_references: the given photos (main has resolved asset ids to paths) replace the reference
 * images or are added after them, as many as the model takes, and the same for the reference audio (`audios`;
 * left out, replace clears the audio and append keeps it) and the reference videos (`videos`, with their windows;
 * the same rule). Audio is only added for a model that takes it, as many clips as fit (count and total length);
 * videos only for a Seedance 2.x reference model, within its family's count and total. Switches to reference mode if
 * needed. The prompt is left alone: an agent typically writes it for the new lists right after. `assets` tells the
 * audio clips' windows when main left them out.
 */
export function applySetReferences(
  current: GenerationParams,
  rawArgs: unknown,
  models: readonly VideoModel[],
  assets: readonly Asset[] = []
): FormChange {
  const args = asArgs(rawArgs)
  const paths = args.paths
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !isAbsolutePath(p))) {
    throw new BridgeError("The reference images couldn't be read (paths must be a list of image paths).")
  }
  const mode = args.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'append') throw new BridgeError('mode must be “replace” or “append”.')
  const wantedAudios = parseAudios(field(args, 'audios'))
  const wantedVideos = parseVideos(field(args, 'videos'))

  const notes: string[] = []
  let next: GenerationParams = { ...current }
  if (kindOfModelId(current.model) !== 'reference-to-video') {
    const id = modelForKind([...models], current.model, 'reference-to-video') ?? DEFAULT_MODEL['reference-to-video']
    const model = models.find((m) => m.id === id)
    next = snapToModel({ ...next, model: id }, model)
    notes.push(`Switched to the mode ${modeName('reference-to-video')} with ${model?.name ?? id}.`)
  }

  const max = maxReferenceImages(next.model)
  const before = current.referenceImages ?? []
  const { refs, note } = addPaths(mode === 'append' ? before : [], paths as string[], max)
  if (note) notes.push(note)
  next.referenceImages = refs

  const audiosBefore = current.referenceAudios ?? []
  const base = mode === 'append' ? audiosBefore : []
  let audios = base
  if (wantedAudios?.length) {
    const model = models.find((m) => m.id === next.model)
    if (!supportsAudioInput(model ?? next.model)) {
      notes.push(
        `${model?.name ?? next.model} doesn't take sound references, so the sound wasn't added. Pick a ` +
          'reference model that takes audio to send voices.'
      )
    } else {
      const change = addAudios(base, wantedAudios, audioSourcesByPath(assets), maxReferenceAudios(next.model))
      audios = change.audios
      if (change.note) notes.push(change.note)
    }
  }
  next.referenceAudios = audios.length ? audios : undefined

  const videosBefore = referenceVideosOf(current)
  let videos = mode === 'append' ? videosBefore : []
  if (wantedVideos?.length) {
    const limits = referenceVideoLimits(next.model)
    const name = models.find((m) => m.id === next.model)?.name ?? next.model
    if (!limits) {
      notes.push(
        `${name} doesn't take reference videos, so the videos weren't added. Pick a Seedance 2.x reference model ` +
          'to send them.'
      )
    } else {
      const change = appendVideoWindows(videos, wantedVideos, limits)
      videos = change.videos
      if (change.note) notes.push(change.note)
    }
  }
  next.referenceVideos = videos.length ? videos : undefined
  // "worn by" choices for outfits (or characters) no longer among the pictures are forgotten, as the form does it.
  const owners = new Map(assets.flatMap((a) => a.images.map((img) => [pathKey(img.path), a.id] as const)))
  const present = new Set(refs.flatMap((path) => owners.get(pathKey(path)) ?? []))
  const wearers = outfitWearersAmong(next.outfitWearers, present)
  if (wearers) next.outfitWearers = wearers
  else delete next.outfitWearers

  if (mode === 'replace' && findImageTokens(next.prompt).length && !sameList(before, refs)) {
    notes.push("The prompt wasn't changed – make sure every @ImageN in it points at the right image in the new list.")
  }
  if (mode === 'replace' && findAudioTokens(next.prompt).length && !sameAudios(audiosBefore, audios)) {
    notes.push("The prompt wasn't changed – make sure every @AudioN in it points at the right sound in the new list.")
  }
  return { params: next, notes }
}

/** A token that moved with its picture or clip: "@Image3" → "@Image1". */
export interface MovedReference {
  from: string
  to: string
  path: string
}

/** What reorder_references did: the form, notes, and every token that got a new number. */
export interface ReorderChange extends FormChange {
  moved: { images: MovedReference[]; audios: MovedReference[]; videos: MovedReference[] }
}

/**
 * reorder_references' `videos`: tokens ("@Video2", or its number) or the form's own paths – main resolved the
 * agent's generation and export ids to paths. Undefined when the list was left out.
 */
function videoOrderEntries(value: unknown, paths: readonly string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new BridgeError('videos must be a list of references (@Video1 …) in the new order.')
  const keys = paths.map(pathKey)
  return value.map((item): string => {
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < 1) throw new BridgeError(`${item} isn't a valid @Video number.`)
      return `@Video${item}`
    }
    const raw = typeof item === 'string' ? item : asArgs(item).path
    if (typeof raw !== 'string' || !raw.trim()) throw new BridgeError('videos contains an empty or unreadable entry.')
    const entry = raw.trim()
    if (isAbsolutePath(entry)) {
      const i = keys.indexOf(pathKey(entry))
      return i === -1 ? entry : paths[i]
    }
    const bare = /^[@＠]?\s*video\s*0*([1-9][0-9]*)$/i.exec(entry)
    return bare ? `@Video${bare[1]}` : entry
  })
}

const pathKey = (path: string): string => path.normalize('NFC')

/** "Image3", "image 3", "@Bild3", "@Ljud2" (Swedish spellings too): a reference written loosely, as the token it means ("@Image3"). */
function looseToken(entry: string): string | undefined {
  const bare = /^[@＠]?\s*(image|audio)\s*0*([1-9][0-9]*)$/i.exec(entry)
  if (bare) return `@${bare[1].toLowerCase() === 'audio' ? 'Audio' : 'Image'}${bare[2]}`
  const written = /^[@＠]/.test(entry) ? entry : `@${entry}`
  const near = findMalformedTokens(written).find((m) => m.start === 0 && m.end === written.length)
  return near?.suggestion && /^@(Image|Audio)\d+$/.test(near.suggestion) ? near.suggestion : undefined
}

/**
 * reorder_references' `images` or `audios` as entries the shared reorder reads: tokens ("@Image3") and the form's
 * own paths. The agent may also name a reference by its 1-based number, a library photo or clip id
 * (image_id / audio_id), or an asset id – all of that asset's photos (or clips) in the form, in their current
 * order – or pass the items set_references takes ({path}). Undefined when the list was left out.
 */
function orderEntries(
  value: unknown,
  kind: 'image' | 'audio',
  paths: readonly string[],
  assets: readonly Asset[]
): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const word = kind === 'image' ? 'Image' : 'Audio'
  const list = kind === 'image' ? 'images' : 'audios'
  if (!Array.isArray(value)) {
    throw new BridgeError(`${list} must be a list of references (@${word}1 …) in the new order.`)
  }
  const keys = paths.map(pathKey)
  /** The form's own spelling of a path, so the shared reorder finds it whatever its Unicode normalization. */
  const formPath = (path: string): string | undefined => {
    const i = keys.indexOf(pathKey(path))
    return i === -1 ? undefined : paths[i]
  }
  const where = kind === 'image' ? 'the reference images' : 'the sound references'
  return value.flatMap((item): string[] => {
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < 1) throw new BridgeError(`${item} isn't a valid @${word} number.`)
      return [`@${word}${item}`]
    }
    const raw = typeof item === 'string' ? item : asArgs(item).path
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new BridgeError(`${list} contains an empty or unreadable entry.`)
    }
    const entry = raw.trim()
    if (isAbsolutePath(entry)) return [formPath(entry) ?? entry]
    for (const asset of assets) {
      if (kind === 'image') {
        const photo = asset.images.findIndex((img) => img.id === entry)
        if (photo !== -1) {
          const path = formPath(asset.images[photo].path)
          if (!path) throw new BridgeError(`Image ${photo + 1} of ${asset.name} isn't one of ${where} in the form.`)
          return [path]
        }
      } else {
        const clips = Array.isArray(asset.audio) ? asset.audio : []
        const clip = clips.findIndex((c) => c.id === entry)
        if (clip !== -1) {
          const path = formPath(clips[clip].path)
          if (!path) throw new BridgeError(`Sound clip ${clip + 1} of ${asset.name} isn't one of ${where} in the form.`)
          return [path]
        }
      }
    }
    const asset = assets.find((a) => a.id === entry)
    if (asset) {
      const own = (kind === 'image' ? asset.images : Array.isArray(asset.audio) ? asset.audio : []).map((x) =>
        pathKey(x.path)
      )
      const found = paths.filter((p) => own.includes(pathKey(p)))
      if (!found.length) {
        throw new BridgeError(`${asset.name} has ${kind === 'image' ? 'no images' : 'no sound'} among ${where}.`)
      }
      return found
    }
    return [looseToken(entry) ?? entry]
  })
}

/**
 * Applies reorder_references to the form: the reference images (`images`), audio clips (`audios`) and/or reference
 * videos (`videos`) in a new order – the ones named first, the rest after them in their current order – with every
 * @ImageN, @AudioN and @VideoN token of the prompt and the negative prompt renumbered so it still names the same
 * picture, clip or video, all in one change (the shared reorderReferences, which sequence clips use too). Nothing is
 * added or removed, so unlike set_references the prompt stays right. All or nothing: an entry that names no
 * reference refuses the command.
 */
export function applyReorderReferences(
  current: GenerationParams,
  rawArgs: unknown,
  assets: readonly Asset[] = []
): ReorderChange {
  const args = asArgs(rawArgs)
  const images = current.referenceImages ?? []
  const audios = current.referenceAudios ?? []
  const imageEntries = orderEntries(field(args, 'images') ?? field(args, 'paths'), 'image', images, assets)
  const audioEntries = orderEntries(field(args, 'audios'), 'audio', audios.map((a) => a.path), assets)
  const videoEntries = videoOrderEntries(field(args, 'videos'), referenceVideosOf(current).map((v) => v.path))
  if (!imageEntries && !audioEntries && !videoEntries) {
    throw new BridgeError('Give images, audios and/or videos: the references in the order they should have.')
  }
  if (kindOfModelId(current.model) !== 'reference-to-video') {
    throw new BridgeError(
      `The form is in the mode ${modeName(kindOfModelId(current.model))} – references are only used in the mode ` +
        `${modeName('reference-to-video')}. Switch modes with set_form first.`
    )
  }

  let next = current
  try {
    if (imageEntries?.length) next = reorderReferences(next, 'image', imageEntries)
    if (audioEntries?.length) next = reorderReferences(next, 'audio', audioEntries)
    if (videoEntries?.length) next = reorderReferences(next, 'video', videoEntries)
  } catch (e) {
    throw new BridgeError(`Nothing was changed. ${e instanceof Error ? e.message : String(e)}`)
  }

  const moved = {
    images: referenceMoves(current, next, 'image'),
    audios: referenceMoves(current, next, 'audio'),
    videos: referenceMoves(current, next, 'video')
  }
  const notes: string[] = []
  if (!moved.images.length && !moved.audios.length && !moved.videos.length) {
    notes.push('The references were already in that order – nothing was changed.')
    return { params: current, notes, moved }
  }
  const renumbered = (list: readonly MovedReference[]) => list.map((m) => `${m.from} → ${m.to}`).join(', ')
  if (moved.images.length) notes.push(`The images have new numbers: ${renumbered(moved.images)}.`)
  if (moved.audios.length) notes.push(`The sounds have new numbers: ${renumbered(moved.audios)}.`)
  if (moved.videos.length) notes.push(`The videos have new numbers: ${renumbered(moved.videos)}.`)
  const promptFollowed = next.prompt !== current.prompt
  const negativeFollowed = (next.negativePrompt ?? '') !== (current.negativePrompt ?? '')
  if (promptFollowed || negativeFollowed) {
    const which =
      promptFollowed && negativeFollowed
        ? 'The prompt and the negative prompt'
        : promptFollowed
          ? 'The prompt'
          : 'The negative prompt'
    notes.push(`${which} followed along: every @ reference points at the same image, sound or video as before.`)
  }
  notes.push(...capNotes(images, next.referenceImages ?? [], maxReferenceImages(current.model), assets))
  return { params: next, notes, moved }
}

/**
 * Applies swap_reference to the form: the picture in one place (`image`, by path – the place it is in now, `index`
 * telling which when it is there twice – and `path`, the new picture), or every place of one asset
 * (`from_asset_id`) taken by another (`to_asset_id`, with its voice), by the shared swapReferenceImage /
 * swapReferenceAsset that a click on a reference thumbnail uses: no number changes, and the name in front of fully
 * swapped token groups follows, in one change. All or nothing. The notes are the shared ones.
 */
export function applySwapReference(current: GenerationParams, rawArgs: unknown, assets: readonly Asset[] = []): FormChange {
  const args = asArgs(rawArgs)
  if (kindOfModelId(current.model) !== 'reference-to-video') {
    throw new BridgeError(
      `The form is in the mode ${modeName(kindOfModelId(current.model))} – references are only used in the mode ` +
        `${modeName('reference-to-video')}. Switch modes with set_form first.`
    )
  }
  const fromId = field(args, 'from_asset_id')
  const toId = field(args, 'to_asset_id')
  try {
    if (given(fromId) || given(toId)) {
      const from = assets.find((a) => a.id === fromId)
      const to = assets.find((a) => a.id === toId)
      if (!from || !to) throw new BridgeError("Nothing was changed: the asset doesn't exist (any more).")
      return swapReferenceAsset(current, from, to, assets)
    }
    const image = field(args, 'image')
    const path = field(args, 'path')
    const hint = field(args, 'index')
    if (typeof image !== 'string' || typeof path !== 'string' || !isAbsolutePath(image) || !isAbsolutePath(path)) {
      throw new BridgeError("The swap couldn't be read (image and path must be image paths).")
    }
    const images = current.referenceImages ?? []
    const key = pathKey(image)
    const at =
      typeof hint === 'number' && images[hint] !== undefined && pathKey(images[hint]) === key
        ? [hint]
        : images.flatMap((p, i) => (pathKey(p) === key ? [i] : []))
    if (at.length !== 1) {
      throw new BridgeError(
        'Nothing was changed: the image you wanted to swap is no longer in its place among the reference images (the form may have changed meanwhile). Read the form again with get_workspace.'
      )
    }
    return swapReferenceImage(current, at[0], path, assets)
  } catch (e) {
    if (e instanceof BridgeError) throw e
    throw new BridgeError(`Nothing was changed. ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Notes for the pictures a reorder moved past the model's limit (no longer sent) or back inside it. */
function capNotes(before: readonly string[], after: readonly string[], max: number, assets: readonly Asset[]): string[] {
  if (after.length <= max) return []
  const photos = photoIndex(assets)
  const name = (path: string): string => {
    const photo = photos.get(path)
    return photo?.assetName ? `${photo.assetName}, image ${photo.photoNumber}` : fileName(path)
  }
  const out: string[] = []
  after.forEach((path, i) => {
    const was = before.indexOf(path)
    if (i >= max && was < max) {
      out.push(`The image in place ${i + 1} (${name(path)}) is no longer sent – the model takes at most ${max} images.`)
    } else if (i < max && was >= max) {
      out.push(`The image that is now @Image${i + 1} (${name(path)}) is sent now – it was outside the model's limit before.`)
    }
  })
  return out
}

// ── Answers ─────────────────────────────────────────────────────────────────

function photoIndex(assets: readonly Asset[]): Map<string, FormImage> {
  const map = new Map<string, FormImage>()
  for (const a of assets) {
    a.images.forEach((img, i) =>
      map.set(img.path, { path: img.path, assetId: a.id, assetName: a.name, kind: a.kind, photoNumber: i + 1 })
    )
  }
  return map
}

/** A reference audio clip of the form tied to the library clip it is (asset, clip), with the window it sends. */
function audioReferences(audios: readonly ReferenceAudio[], assets: readonly Asset[]): AgentFormAudioReference[] {
  const sources = audioSourcesByPath(assets)
  return audios.map((audio, i) => {
    const source = sources.get(audio.path)
    const { start, length } = windowOf(audio, source)
    return {
      token: `@Audio${i + 1}`,
      ...(source
        ? { assetId: source.asset.id, assetName: source.asset.name, kind: source.asset.kind, audioId: source.audio.id }
        : {}),
      path: audio.path,
      start,
      length
    }
  })
}

/** The form as the agent should see it, with every image and audio clip tied to its library asset. */
export function describeForm(
  params: GenerationParams,
  assets: readonly Asset[],
  where: Where,
  notes: string[] = []
): FormSnapshot {
  const sent = paramsForSubmit(params)
  const photos = photoIndex(assets)
  const describe = (path: string): FormImage => photos.get(path) ?? { path }
  // Reference images past the model's limit stay in the form (the user may drag one forward) but aren't sent,
  // so they have no token; listed apart, with their place, so an agent can move one in with reorder_references.
  const max = maxReferenceImages(params.model)
  const unsent = kindOfModelId(params.model) === 'reference-to-video' ? (params.referenceImages ?? []).slice(max) : []
  return {
    ...where,
    params: sent,
    references: (sent.referenceImages ?? []).map((path, i) => ({ token: `@Image${i + 1}`, ...describe(path) })),
    ...(unsent.length
      ? { unsentReferences: unsent.map((path, i) => ({ position: max + i + 1, ...describe(path) })) }
      : {}),
    audioReferences: audioReferences(sent.referenceAudios ?? [], assets),
    ...(sent.startImage ? { startImage: describe(sent.startImage) } : {}),
    ...(sent.endImage ? { endImage: describe(sent.endImage) } : {}),
    issues: promptIssuesOf(params),
    ...(notes.length ? { notes } : {})
  }
}

// ── The bridge ──────────────────────────────────────────────────────────────

export interface BridgeContext {
  view: () => View
  /** Brings a view to the front (with an intent, e.g. which sequence to open). */
  show: (view: View, intent?: Intent) => void
}

/**
 * The active service's model list, waiting at most `ms` for it: a slow service must not hold up a command until main
 * gives up on the window (COMMAND_TIMEOUT_MS) and tells the agent Studio isn't answering.
 */
async function modelList(ms: number): Promise<{ models: VideoModel[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${SERVICE_NAME} isn't answering with the model list right now.`)), ms)
  })
  try {
    return { models: await Promise.race([loadModels(), timeout]) }
  } catch (e) {
    return { models: [], error: ipcErrorMessage(e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The library's assets, after pointing the form's photos and audio clips at where they are now: a renamed
 * character's photos and voice move with its folder (GenerateView and the store do the same on their own).
 */
async function assetsFollowingForm(): Promise<Asset[]> {
  const assets = await window.studio.listAssets()
  const followed = followAssetImages(getGenerateParams(), assets, readRememberedImageIds())
  if (followed) setGenerateParams(followed)
  followGenerateAudio(assets)
  return assets
}

/** Where the user is: the view, and the sequence and clip, the storyboard, the edit or the Media tab open in it. */
export interface Where {
  view: View
  sequenceId?: string
  segmentId?: string
  storyboardId?: string
  editId?: string
  mediaTab?: MediaTab
}

export function whereNow(view: View): Where {
  if (view === 'media') return { view, mediaTab: getMediaTab() }
  if (view === 'sequences') return { view, ...openInSequenceEditor() }
  if (view === 'storyboards') {
    const storyboardId = openStoryboard()
    return storyboardId ? { view, storyboardId } : { view }
  }
  if (view === 'editor') {
    const { editId } = openEditInEditor()
    return editId ? { view, editId } : { view }
  }
  return { view }
}

function snapshot(view: View, assets: readonly Asset[], notes?: string[]): FormSnapshot {
  return describeForm(getGenerateParams(), assets, whereNow(view), notes)
}

async function findSequenceOfSegment(segmentId: string): Promise<string | undefined> {
  for (const summary of await window.studio.listSequences()) {
    const sequence = await window.studio.getSequence(summary.id)
    if (sequence.segments.some((s) => s.id === segmentId)) return sequence.id
  }
  return undefined
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The library views, by the kind of asset they show. */
const ASSET_VIEWS = new Set<View>(Object.values(ASSET_VIEW))

/**
 * open_in_studio: brings a place to the front – the Generate view (or a clip in its drawer), Media (on a tab,
 * or with a clip, picture or film open), a sequence (and clip), a storyboard (or one of its transitions), an edit (or
 * one of its versions), an asset in its library view or the prompt library. Every intent is marked as the agent's
 * (`source: 'agent'`): opening a place for an agent never counts as the user having looked at it.
 */
export async function applyOpen(rawArgs: unknown, ctx: BridgeContext): Promise<AgentOpenResult> {
  const args = asArgs(rawArgs)
  const view = args.view as View
  if (view === 'media') return openMediaView(args, ctx)
  if (view === 'generate') {
    const generationId = optionalId(field(args, 'generation_id'))
    if (!generationId) {
      ctx.show('generate')
      return { view: 'generate' }
    }
    ctx.show('generate', { type: 'open-generation', generationId, source: 'agent' })
    return { view: 'generate', generationId }
  }
  if (view === 'prompts') {
    ctx.show('prompts')
    return { view: 'prompts' }
  }
  if (ASSET_VIEWS.has(view)) return openAssetView(view, args, ctx)
  if (args.view === 'storyboards' || args.view === 'storyboard') return openStoryboardView(args, ctx)
  if (view === 'editor') return openEditorView(args, ctx)
  if (args.view !== 'sequences' && args.view !== 'sequence') {
    throw new BridgeError(
      'view must be “generate”, “media”, “sequences”, “storyboards”, “editor”, “prompts” or a library view (“characters”, “environments”, “products”, “outfits”, “poses”, “directors”).'
    )
  }
  const segmentId = optionalId(field(args, 'segment_id'))
  const sequenceId = optionalId(field(args, 'sequence_id')) ?? (segmentId && (await findSequenceOfSegment(segmentId)))
  if (segmentId && !sequenceId) throw new BridgeError("The clip doesn't exist (any more).")
  if (!sequenceId) {
    ctx.show('sequences')
    return { view: 'sequences', ...openInSequenceEditor() }
  }
  const sequence = await window.studio.getSequence(sequenceId).catch(() => undefined)
  if (!sequence) throw new BridgeError("The sequence doesn't exist (any more).")
  if (segmentId && !sequence.segments.some((s) => s.id === segmentId)) {
    throw new BridgeError(`The clip isn't in the sequence “${sequence.name}”.`)
  }
  ctx.show('sequences', { type: 'open-sequence', sequenceId, segmentId, source: 'agent' })
  // Answer with the clip that is actually on screen once the sequence editor has loaded it.
  const shown = await settled(() => {
    const onScreen = openInSequenceEditor()
    return onScreen.sequenceId === sequenceId && !!onScreen.segmentId && (!segmentId || onScreen.segmentId === segmentId)
  })
  const onScreen = openInSequenceEditor()
  return {
    view: 'sequences',
    sequenceId,
    sequenceName: sequence.name,
    segmentId: onScreen.sequenceId === sequenceId ? onScreen.segmentId : undefined,
    ...(shown || !segmentId ? {} : { note: 'The sequence opened, but a different clip than the one asked for is shown.' })
  }
}

/** The Media tab each kind of item opens in. */
const MEDIA_ITEM_TABS = [
  ['generation_id', 'videos'],
  ['still_id', 'pictures'],
  ['export_id', 'films']
] as const satisfies readonly (readonly [string, MediaTab])[]

/**
 * Shows Media on a tab – the one an item is in, the one asked for, or the one it last showed – with a clip in
 * the Clips tab's drawer, a picture in Images or a film in Films (main has checked that it exists). The tab is set
 * before the view opens, so it opens on it.
 */
function openMediaView(args: Args, ctx: BridgeContext): AgentOpenResult {
  const asked = field(args, 'tab')
  if (given(asked) && !isMediaTab(asked)) throw new BridgeError('tab must be “videos”, “pictures” or “films”.')
  const items = MEDIA_ITEM_TABS.flatMap(([key, tab]) => {
    const id = optionalId(field(args, key))
    return id ? [{ key, tab, id }] : []
  })
  if (items.length > 1) throw new BridgeError('Give only one of generation_id, still_id and export_id.')
  const item = items[0]
  if (item && isMediaTab(asked) && asked !== item.tab) {
    throw new BridgeError(`${item.key} opens in the tab “${item.tab}”, not “${asked}”.`)
  }
  const tab = item?.tab ?? (isMediaTab(asked) ? asked : getMediaTab())
  const ids = {
    ...(item?.key === 'generation_id' ? { generationId: item.id } : {}),
    ...(item?.key === 'still_id' ? { stillId: item.id } : {}),
    ...(item?.key === 'export_id' ? { exportId: item.id } : {})
  }
  setMediaTab(tab)
  ctx.show('media', { type: 'open-media', tab, ...ids, source: 'agent' })
  return { view: 'media', tab, ...ids }
}

/** The asset a library view has selected (it remembers it as soon as it has taken the intent). */
function selectedAsset(kind: AssetKind): string | undefined {
  try {
    return localStorage.getItem(SELECTED_ASSET_KEYS[kind]) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Shows an asset in its library view (Characters, Environments, Products, Outfits, Poses or Directors); a ready-made
 * director's id ("preset:noir") opens it in Directors.
 */
async function openAssetView(view: View, args: Args, ctx: BridgeContext): Promise<AgentOpenResult> {
  const assetId = optionalId(field(args, 'asset_id'))
  if (!assetId) {
    ctx.show(view)
    return { view: view as AgentOpenResult['view'] }
  }
  if (isPresetId(assetId)) {
    const preset = directorById(assetId, [])
    if (!preset) throw new BridgeError("The ready-made director doesn't exist.")
    ctx.show('directors', { type: 'open-asset', assetId, source: 'agent' })
    const shown = await settled(() => selectedAsset('director') === assetId)
    return {
      view: 'directors',
      assetId,
      assetName: preset.name,
      ...(shown ? {} : { note: "The view is shown, but the director wasn't selected in time – ask the user to pick it in the list." })
    }
  }
  const asset = (await window.studio.listAssets()).find((a) => a.id === assetId)
  if (!asset) throw new BridgeError("The asset doesn't exist (any more).")
  // An asset is opened in its own kind's view, whichever view was named.
  const target = ASSET_VIEW[asset.kind]
  ctx.show(target, { type: 'open-asset', assetId, source: 'agent' })
  const shown = await settled(() => selectedAsset(asset.kind) === assetId)
  return {
    view: target as AgentOpenResult['view'],
    assetId,
    assetName: asset.name,
    ...(shown ? {} : { note: "The view is shown, but the asset wasn't selected in time – ask the user to pick it in the list." })
  }
}

/** Shows Storyboards, with the storyboard asked for open (or the one it last showed), and a transition if named. */
async function openStoryboardView(args: Args, ctx: BridgeContext): Promise<AgentOpenResult> {
  const storyboardId = optionalId(field(args, 'storyboard_id'))
  const transitionId = optionalId(field(args, 'transition_id'))
  if (!storyboardId) {
    ctx.show('storyboards')
    const shown = openStoryboard()
    return shown ? { view: 'storyboards', storyboardId: shown } : { view: 'storyboards' }
  }
  const storyboard = await window.studio.getStoryboard(storyboardId).catch(() => undefined)
  if (!storyboard) throw new BridgeError("The storyboard doesn't exist (any more).")
  if (transitionId && !storyboard.transitions.some((t) => t.id === transitionId)) {
    throw new BridgeError(`The transition isn't in the storyboard “${storyboard.name}” (any more).`)
  }
  ctx.show('storyboards', {
    type: 'open-storyboard',
    storyboardId,
    ...(transitionId ? { transitionId } : {}),
    source: 'agent'
  })
  // The view remembers the storyboard it shows as soon as it has taken the intent.
  const shown = await settled(() => openStoryboard() === storyboardId)
  return {
    view: 'storyboards',
    storyboardId,
    storyboardName: storyboard.name,
    ...(transitionId && shown ? { transitionId } : {}),
    ...(shown ? {} : { note: "Storyboards is shown, but the storyboard didn't open in time – ask the user to pick it in the list." })
  }
}

/**
 * Shows the Editor, with the edit asked for open (or the edit it opens by itself: the remembered one, else the most
 * recently changed), on a version if named.
 */
async function openEditorView(args: Args, ctx: BridgeContext): Promise<AgentOpenResult> {
  const editId = optionalId(field(args, 'edit_id'))
  const versionId = optionalId(field(args, 'version_id'))
  if (!editId) {
    ctx.show('editor')
    // With any edits at all, the view opens one as soon as its list is in: report that one.
    const edits = await window.studio.listEdits().catch(() => [])
    if (edits.length) await settled(() => !!openEditInEditor().editId)
    const shown = openEditInEditor().editId
    return shown ? { view: 'editor', editId: shown } : { view: 'editor' }
  }
  const edit = await window.studio.getEdit(editId).catch(() => undefined)
  if (!edit) throw new BridgeError("The edit doesn't exist (any more).")
  if (versionId && !edit.versions.some((v) => v.id === versionId)) {
    throw new BridgeError(`The version doesn't belong to the edit “${edit.name}”.`)
  }
  ctx.show('editor', { type: 'open-editor', editId, ...(versionId ? { versionId } : {}), source: 'agent' })
  // The view reports the edit (and the version in its player) as soon as it has taken the intent.
  const shown = await settled(() => {
    const onScreen = openEditInEditor()
    return onScreen.editId === editId && (!versionId || onScreen.versionId === versionId)
  })
  const onScreen = openEditInEditor()
  return {
    view: 'editor',
    editId,
    editName: edit.name,
    ...(onScreen.editId === editId && onScreen.versionId ? { versionId: onScreen.versionId } : {}),
    ...(shown
      ? {}
      : {
          note: versionId
            ? "The edit is shown, but the version wasn't shown in time – ask the user to pick it."
            : "The Editor is shown, but the edit didn't open in time – ask the user to pick it in the list."
        })
  }
}

/** Waits (up to `ms`) for the UI to get somewhere; true if it did. */
async function settled(done: () => boolean, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms
  while (!done()) {
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

/** Main has answered the command as failed already (it waited COMMAND_TIMEOUT_MS); it must not be applied. */
function expired(cmd: AgentCommand): boolean {
  return cmd.deadline !== undefined && Date.now() > cmd.deadline
}

const TOO_LATE = "Studio didn't answer in time, so nothing was changed. Try again."
const SWITCHING_LIBRARY = "Studio's library isn't open right now – try again in a moment."

async function run(cmd: AgentCommand, ctx: BridgeContext): Promise<unknown> {
  // Queued behind slow commands until main stopped waiting for it.
  if (expired(cmd)) throw new BridgeError(TOO_LATE)
  // During a library switch the paths and ids in the form belong to the library being left.
  const library = await window.studio.libraryStatus()
  if (library.state !== 'ready' || generateParamsFrozen()) throw new BridgeError(SWITCHING_LIBRARY)

  // Compared as text: a command this window doesn't know yet (main newer than the window) is refused below.
  const command: string = cmd.command
  if (command === 'open') return applyOpen(cmd.args, ctx)
  if (!['get_form', 'set_form', 'set_references', 'reorder_references', 'swap_reference'].includes(command)) {
    throw new BridgeError(`Studio doesn't recognise the command “${command}”.`)
  }

  // Loading the models also registers their modes, which decide the mode of ids that don't name it. Reading
  // the form or reordering it only needs that for unusual ids, so they wait less.
  const { models, error } = await modelList(command === 'set_form' || command === 'set_references' ? 4000 : 1500)
  const assets = await assetsFollowingForm()
  if (command === 'get_form') return snapshot(ctx.view(), assets)

  // Read after the awaits, so the change builds on the form as it is now (the user may have typed meanwhile).
  const change: FormChange & Partial<Pick<ReorderChange, 'moved'>> =
    command === 'set_form'
      ? applySetForm(getGenerateParams(), cmd.args, models, error, assets)
      : command === 'set_references'
        ? applySetReferences(getGenerateParams(), cmd.args, models, assets)
        : command === 'swap_reference'
          ? applySwapReference(getGenerateParams(), cmd.args, assets)
          : applyReorderReferences(getGenerateParams(), cmd.args, assets)
  // The awaits may have outlasted main's patience, or a library switch may have gone through meanwhile.
  if (expired(cmd)) throw new BridgeError(TOO_LATE)
  if (generateParamsFrozen()) throw new BridgeError(SWITCHING_LIBRARY)
  // One update for the lists and both prompts, like a drag in the form: the editor never shows a half-done
  // reorder, and ⌘Z in the prompt doesn't see the renumbering as typing.
  setGenerateParams(change.params)
  ctx.show('generate')
  const result = snapshot('generate', assets, change.notes)
  return change.moved ? { ...result, moved: change.moved } : result
}

/** Runs one command and says how it went; never throws. */
export async function handleAgentCommand(cmd: AgentCommand, ctx: BridgeContext): Promise<AgentCommandReply> {
  try {
    return { ok: true, result: await run(cmd, ctx) }
  } catch (e) {
    return { ok: false, error: e instanceof BridgeError ? e.message : ipcErrorMessage(e) }
  }
}

/**
 * Answers the agent's form commands while the workspace is open. Commands run one at a time, in the order
 * they arrive, so two quick edits can't overwrite each other.
 */
export function useAgentBridge(view: View, navigate: Navigate): void {
  const viewRef = useRef(view)
  const navigateRef = useRef(navigate)
  useEffect(() => {
    viewRef.current = view
    navigateRef.current = navigate
  })

  useEffect(() => {
    const ctx: BridgeContext = {
      view: () => viewRef.current,
      show: (target, intent) => {
        if (target === viewRef.current && !intent) return
        viewRef.current = target
        navigateRef.current(target, intent)
      }
    }
    let queue: Promise<void> = Promise.resolve()
    const off = window.studio.onAgentCommand((cmd) => {
      queue = queue
        .then(async () => window.studio.replyAgentCommand(cmd.id, await handleAgentCommand(cmd, ctx)))
        // Keep the queue going; main times the command out if no reply got through.
        .catch(() => {})
    })
    return off
  }, [])
}
