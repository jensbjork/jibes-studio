export type View =
  | 'generate'
  | 'characters'
  | 'environments'
  | 'outfits'
  | 'poses'
  | 'prompts'
  | 'sequences'
  | 'storyboards'
  | 'editor'
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
  /**
   * Redigera: open an edit. editId opens that one. generationId opens the edit made from that clip (asking
   * "Öppna redigeringen" / "Ny redigering" when there already is one) or creates one; an id that is itself a
   * version of an edit opens that edit. exportId does the same for an exported film (a new edit clones it in).
   */
  | { type: 'open-editor'; editId?: string; generationId?: string; exportId?: string }

export type Navigate = (view: View, intent?: Intent) => void
