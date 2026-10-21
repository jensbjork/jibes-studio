import type { MediaTab } from '@shared/session'

export type View =
  | 'generate'
  | 'media'
  | 'characters'
  | 'environments'
  | 'products'
  | 'outfits'
  | 'poses'
  | 'directors'
  | 'prompts'
  | 'sequences'
  | 'storyboards'
  | 'editor'
  | 'settings'

/**
 * Cross-view requests, e.g. "generate with this character". Consumed once by the target view.
 *
 * Every intent may carry `source: 'agent'` (set by the agent bridge's open_in_studio). The target view then opens
 * the place without the "explicit choice" seen marks of Activity: opening a clip drawer or showing a version
 * because an agent asked is not the user looking at it, so nothing is marked seen on open (playing it still is).
 */
export type Intent = (
  /**
   * Generate view: add the asset's photos in reference mode (with a character's default outfit, and its first
   * voice clip when the model takes audio).
   */
  | { type: 'use-asset'; assetId: string }
  /**
   * Library views (Characters, Environments, Products, Outfits, Poses, Directors): select that asset; audioId scrolls to
   * the clip in Voice, jobId to a voice design that failed. In Directors the id may be a ready-made director's
   * ("preset:…").
   */
  | { type: 'open-asset'; assetId: string; audioId?: string; jobId?: string }
  | { type: 'use-prompt'; promptId: string }
  /** Generate view: direct the form with that director (an asset id or a ready-made one's), with its defaults. */
  | { type: 'use-director'; directorId: string }
  /** Sequences view: open that sequence, on the given clip (else the newest one); generationId focuses that take. */
  | { type: 'open-sequence'; sequenceId: string; segmentId?: string; generationId?: string }
  /** Sequences view: "New sequence from a song…" – pick an audio file, then the song's dialog. */
  | { type: 'new-sequence-from-song' }
  /** Storyboards view: open that storyboard; transitionId opens the transition editor, boardId flashes the board. */
  | { type: 'open-storyboard'; storyboardId: string; transitionId?: string; boardId?: string }
  /**
   * Editor: open an edit. editId opens that one. generationId opens the edit made from that clip (asking
   * "Open the edit" / "New edit" when there already is one) or creates one; an id that is itself a
   * version of an edit opens that edit. exportId does the same for an exported film (a new edit clones it in).
   * versionId shows that version in the player.
   */
  | { type: 'open-editor'; editId?: string; generationId?: string; exportId?: string; versionId?: string }
  /** Generate: open that clip in the detail drawer (one from outside this session's list opens in Media). */
  | { type: 'open-generation'; generationId: string }
  /**
   * Media: show a tab; generationId opens that clip in the Videos drawer (lifting a filter that hides it, with a
   * note), stillId that picture in Images, exportId that film in Films.
   */
  | { type: 'open-media'; tab?: MediaTab; generationId?: string; stillId?: string; exportId?: string }
  /** Generate: fill the form with that clip's settings ("Use again" from Media). */
  | { type: 'use-generation'; generationId: string }
) & {
  /** Opened by an agent (open_in_studio): no seen marks on opening. */
  source?: 'agent'
}

export type Navigate = (view: View, intent?: Intent) => void

/** True when the intent came from an agent, so opening its place must not mark anything seen. */
export function openedByAgent(intent: Intent | undefined): boolean {
  return intent?.source === 'agent'
}
