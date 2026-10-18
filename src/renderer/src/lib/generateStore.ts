import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { DEFAULT_PARAMS, sanitizeReferenceAudios } from '@shared/models'
import { sanitizeOutfitWearers } from '@shared/outfits'
import { sanitizeDescriptionFlags } from '@shared/prompt-compose'
import type { Asset, AssetAudio, GenerationParams } from '@shared/types'
import { clipsById, followLibraryAudio } from '../components/pickers/audioRefs'
import { LAST_PARAMS_KEY } from './library'

// The Generate form lives here, above the views, rather than in GenerateView: it survives switching views,
// and an agent connected over MCP can read and fill it while the user has another view open (see agentBridge).
// Every change is written to localStorage right away, so the form is the same after a restart and a library
// switch can rewrite the remembered paths (see rememberAfterSwitch).

/** Which library clip each remembered audio path is (path → clip id), so the form can follow a renamed asset. */
const AUDIO_IDS_KEY = 'generate:lastParamsAudioIds:v1'

function loadRemembered(): GenerationParams {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_PARAMS_KEY) ?? '{}')
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved)
    const params: GenerationParams = { ...DEFAULT_PARAMS, ...(valid ? (saved as Partial<GenerationParams>) : {}) }
    // Written by an older or newer version, or edited by hand: keep only clips that can be read.
    const audios = sanitizeReferenceAudios(params.referenceAudios)
    if (audios) params.referenceAudios = audios
    else delete params.referenceAudios
    // The description switches and "worn by" choices as the form writes them (defaults left out), never malformed
    // ones from storage.
    const { includeDescriptions: _include, excludedDescriptionAssetIds: _excluded, outfitWearers, ...rest } = params
    const wearers = sanitizeOutfitWearers(outfitWearers)
    return { ...rest, ...sanitizeDescriptionFlags(params), ...(wearers ? { outfitWearers: wearers } : {}) }
  } catch {
    return { ...DEFAULT_PARAMS }
  }
}

function persist(params: GenerationParams): void {
  try {
    localStorage.setItem(LAST_PARAMS_KEY, JSON.stringify(params))
  } catch {
    // Storage full or unavailable; remembering the form is only a convenience.
  }
}

let current: GenerationParams | undefined
const listeners = new Set<() => void>()
/** See freezeGenerateParams. */
let frozen = false

/**
 * A library switch went through: rememberAfterSwitch has written the form as it fits the new library, and the
 * window reloads in a moment. Until then nothing may write this (the old library's) form over it again, such
 * as an agent's set_form; the agent bridge refuses form commands meanwhile.
 */
export function freezeGenerateParams(): void {
  frozen = true
}

export function generateParamsFrozen(): boolean {
  return frozen
}

/** The form as it is now (read from localStorage the first time). */
export function getGenerateParams(): GenerationParams {
  current ??= loadRemembered()
  return current
}

/** Replaces the form, or updates it from its latest value like a React state setter. */
export function setGenerateParams(update: SetStateAction<GenerationParams>): void {
  const before = getGenerateParams()
  const next = typeof update === 'function' ? update(before) : update
  if (next === before) return
  current = next
  if (!frozen) persist(next)
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  startFollowingLibrary()
  return () => {
    listeners.delete(listener)
  }
}

/** The Generate form, as a [value, setter] pair shaped like useState so ParamsForm can use it unchanged. */
export function useGenerateParams(): [GenerationParams, Dispatch<SetStateAction<GenerationParams>>] {
  return [useSyncExternalStore(subscribe, getGenerateParams), setGenerateParams]
}

// ── Following the library's audio clips ─────────────────────────────────────
// A character's voice clip moves with its folder when the character is renamed, and its reference window can
// be changed in the library. The photos are followed by GenerateView (followAssetImages); the clips are followed
// here, on every library change, so the form never sends a file that moved or a window the user changed.

/** Clip id → clip, as the library was at the last look; undefined before the first. */
let lastLook: Map<string, AssetAudio> | undefined
let following = false

function readAudioIds(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(AUDIO_IDS_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rememberAudioIds(ids: Record<string, string>): void {
  try {
    localStorage.setItem(AUDIO_IDS_KEY, JSON.stringify(ids))
  } catch {
    // Storage unavailable; following moved clips is only a convenience.
  }
}

/**
 * Points the form's audio at where the library's clips are now (and at their current windows, where the form
 * kept the library's window). Called with every fresh asset list: on library changes, and by the agent bridge
 * before it reads the form.
 */
export function followGenerateAudio(assets: readonly Asset[]): void {
  if (frozen) return
  const previous = lastLook
  lastLook = clipsById(assets)
  const refs = getGenerateParams().referenceAudios
  if (!refs?.length) return
  const { audios, ids } = followLibraryAudio(refs, assets, previous, readAudioIds())
  rememberAudioIds(ids)
  if (audios) {
    // Built on the form as it is now: the user may have changed it while the list was loading.
    setGenerateParams((p) => (p.referenceAudios === refs ? { ...p, referenceAudios: audios } : p))
  }
}

/** Starts following the library once, when something first shows the form. */
function startFollowingLibrary(): void {
  if (following || typeof window === 'undefined' || !window.studio) return
  following = true
  let latest = 0
  const look = (): void => {
    const n = ++latest
    window.studio.listAssets().then(
      (assets) => {
        if (n === latest) followGenerateAudio(assets)
      },
      () => {
        // No library open (or switching); the next change looks again.
      }
    )
  }
  window.studio.onLibraryChange(look)
  look()
}
