// Generera's list shows what was made there in this session: since Studio started, until it quits (closing the
// window keeps the session). Older work is in the Mediabank. Main owns the session's start; the window, the work
// summary and the agents' list_generations({session: true}) read the same rule from here.

import type { Generation } from './types'

/** What the session rule reads of a generation. */
export type SessionGeneration = Pick<
  Generation,
  'id' | 'createdAt' | 'status' | 'source' | 'segmentId' | 'editId' | 'recipe'
>

/** This session as the rule reads it (main/session.ts). */
export interface GenerateSession {
  /** When Studio started (ms). */
  startedAt: number
  /**
   * Made in Generera before the session and still queued or at Venice when it started (or when a library was opened
   * in it): they stay in its list once they are done or have failed, rather than leaving it as they settle.
   */
  carriedOver: readonly string[]
}

/**
 * Made in Generera: a generation from its form (the user's or an agent's request_generation) or an own film imported
 * into the feed. Not a take of a sequence clip or a storyboard transition, a version or AI take of an edit, or the copy
 * of an exported film that Redigera opens.
 */
export function isGenerateOrigin(g: Pick<Generation, 'source' | 'segmentId' | 'editId' | 'recipe'>): boolean {
  if (g.segmentId || g.editId || g.source === 'edit') return false
  return !(g.source === 'import' && g.recipe?.export)
}

/**
 * In Generera's list now: made there since the session started, or on its way (queued or at Venice) from before – a
 * video doesn't leave the list while it is being made, nor when it settles in this session (`carriedOver`).
 */
export function inGenerateSession(g: SessionGeneration, session: GenerateSession): boolean {
  if (!isGenerateOrigin(g)) return false
  if (g.createdAt >= session.startedAt || g.status === 'queued' || g.status === 'processing') return true
  return session.carriedOver.includes(g.id)
}

/** The Mediabank's tabs: videos (every generation, own film and version), pictures (stills) and exported films. */
export type MediaTab = 'videos' | 'pictures' | 'films'

export const MEDIA_TABS: readonly MediaTab[] = ['videos', 'pictures', 'films']

export function isMediaTab(value: unknown): value is MediaTab {
  return value === 'videos' || value === 'pictures' || value === 'films'
}
