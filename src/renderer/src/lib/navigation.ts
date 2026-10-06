export type View = 'generate' | 'characters' | 'environments' | 'outfits' | 'prompts' | 'sequences' | 'settings'

/** Cross-view requests, e.g. "generate with this character". Consumed once by the target view. */
export type Intent =
  /** Generate view: add the asset's photos (and a character's default outfit) in reference mode. */
  | { type: 'use-asset'; assetId: string }
  /** Library views (Karaktärer, Miljöer, Kläder): select that asset. */
  | { type: 'open-asset'; assetId: string }
  | { type: 'use-prompt'; promptId: string }
  /** Sequences view: open that sequence, on the given clip (else the newest one). */
  | { type: 'open-sequence'; sequenceId: string; segmentId?: string }

export type Navigate = (view: View, intent?: Intent) => void
