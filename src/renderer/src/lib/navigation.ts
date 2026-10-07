export type View =
  | 'generate'
  | 'characters'
  | 'environments'
  | 'outfits'
  | 'poses'
  | 'prompts'
  | 'sequences'
  | 'storyboards'
  | 'settings'

/** Cross-view requests, e.g. "generate with this character". Consumed once by the target view. */
export type Intent =
  /**
   * Generate view: add the asset's photos in reference mode (with a character's default outfit, and its first
   * voice clip when the model takes audio).
   */
  | { type: 'use-asset'; assetId: string }
  /** Library views (Karaktärer, Miljöer, Kläder, Poser): select that asset. */
  | { type: 'open-asset'; assetId: string }
  | { type: 'use-prompt'; promptId: string }
  /** Sequences view: open that sequence, on the given clip (else the newest one). */
  | { type: 'open-sequence'; sequenceId: string; segmentId?: string }
  /** Storyboards view: open that storyboard. */
  | { type: 'open-storyboard'; storyboardId: string }

export type Navigate = (view: View, intent?: Intent) => void
