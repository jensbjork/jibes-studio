// Directors as main sends with them: an id (GenerationParams.director, a sequence's or storyboard's) resolved against
// the open library – an asset of kind 'director' – or the ready-made ones (shared/directors.ts), and params directed
// by it (shared/direction.ts withDirection). Read at the moment of the call, like the descriptions: a director edited
// a moment ago already counts.

import {
  composeDirection,
  directorDefaults,
  isDirectorPresetId,
  resolveDirector,
  resolvedDirectorOf,
  withDirection,
  type DirectionFacts,
  type ResolvedDirector
} from '@shared/direction'
import { DIRECTOR_PRESETS } from '@shared/directors'
import type { Asset, ComposedDirection, GenerationParams, PromptLanguage, VideoModel } from '@shared/types'
import { findDirectorAsset, listAssets } from './assets'
import { isDbOpen } from './db'

/**
 * The director an id names: a ready-made one, or the library's director with that id (needs an open library);
 * undefined for none – no id, an unknown ready-made one, a deleted director or an asset of another kind.
 */
export function libraryDirector(id: string | null | undefined): ResolvedDirector | undefined {
  if (typeof id !== 'string' || !id) return undefined
  if (isDirectorPresetId(id)) return resolveDirector(id, [])
  if (!isDbOpen()) return undefined
  const asset = findDirectorAsset(id)
  return asset ? resolvedDirectorOf(asset) : undefined
}

/** The params as sent when their director (params.director) directs them (withDirection); unchanged without one. */
export function directParams(params: GenerationParams, facts: DirectionFacts = {}): GenerationParams {
  return withDirection(params, libraryDirector(params.director), facts)
}

/** Whether an id names a director that exists (ready-made, or in the open library). */
export function directorExists(id: string): boolean {
  return !!libraryDirector(id)
}

/**
 * A director id from the window or an agent, checked: null for none, the id of a director that exists, or an error
 * naming what is wrong.
 */
export function checkedDirectorId(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('The director must be a director’s id, or null for none.')
  if (!libraryDirector(value)) {
    throw new Error(
      isDirectorPresetId(value)
        ? `There is no ready-made director ${value}. The ready-made ones are ${DIRECTOR_PRESETS.map((p) => p.id).join(', ')}.`
        : 'The director no longer exists. Choose another one (list_directors).'
    )
  }
  return value
}

/** Every director there is: the library's own (by name), then the ready-made ones. */
export function allDirectors(): ResolvedDirector[] {
  const own = isDbOpen() ? listAssets('director').map((a: Asset) => resolvedDirectorOf(a)) : []
  return [...own, ...DIRECTOR_PRESETS.map((p) => resolveDirector(p.id, [])!)]
}

/** The Direction section a director adds to params as sent (composeDirection), without a limit: for previews. */
export function directionPreview(
  params: GenerationParams,
  director: ResolvedDirector,
  language: PromptLanguage
): ComposedDirection {
  return composeDirection(withDirection(params, director), director, { language })
}

/** What choosing a director sets in a sequence's or storyboard's defaults (directorDefaults), from the model list. */
export function defaultsOnChoosing(
  current: Pick<GenerationParams, 'model'> & Partial<Pick<GenerationParams, 'aspectRatio' | 'resolution'>>,
  director: ResolvedDirector | undefined,
  models: readonly VideoModel[] | undefined
): Partial<Pick<GenerationParams, 'model' | 'aspectRatio' | 'resolution'>> {
  return director ? directorDefaults(current, director.direction, models ?? []) : {}
}
