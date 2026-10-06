import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { DEFAULT_PARAMS } from '@shared/models'
import type { GenerationParams } from '@shared/types'
import { LAST_PARAMS_KEY } from './library'

// The Generate form lives here, above the views, rather than in GenerateView: it survives switching views,
// and an agent connected over MCP can read and fill it while the user has another view open (see agentBridge).
// Every change is written to localStorage right away, so the form is the same after a restart and a library
// switch can rewrite the remembered paths (see rememberAfterSwitch).

function loadRemembered(): GenerationParams {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_PARAMS_KEY) ?? '{}')
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved)
    return { ...DEFAULT_PARAMS, ...(valid ? (saved as Partial<GenerationParams>) : {}) }
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
  return () => {
    listeners.delete(listener)
  }
}

/** The Generate form, as a [value, setter] pair shaped like useState so ParamsForm can use it unchanged. */
export function useGenerateParams(): [GenerationParams, Dispatch<SetStateAction<GenerationParams>>] {
  return [useSyncExternalStore(subscribe, getGenerateParams), setGenerateParams]
}
