// Who wears which outfit in a generation ("worn by"): the form's chips, the References legend (prompt-compose.ts) and
// the agents' tools decide it the same way. A choice stored in the params (GenerationParams.outfitWearers) wins while
// that character is among the references; otherwise an outfit is worn by the character whose default outfit it is,
// else by the only character there.

import type { AssetKind, GenerationParams } from './types'

/** What the rule reads of an asset among the references. */
export interface WearerCandidate {
  id: string
  kind: AssetKind
  defaultOutfitId?: string
}

/**
 * Outfit id → id of the character wearing it, for the assets among the references (in reference order). `chosen` is
 * GenerationParams.outfitWearers: a character id, or null for nobody; a choice naming a character that isn't among
 * the references falls back to the default.
 */
export function resolveOutfitWearers(
  present: readonly WearerCandidate[],
  chosen: Readonly<Record<string, string | null>> | undefined
): Map<string, string> {
  const characters = present.filter((a) => a.kind === 'character')
  const ids = new Set(characters.map((c) => c.id))
  const wearers = new Map<string, string>()
  for (const asset of present) {
    if (asset.kind !== 'outfit' || wearers.has(asset.id)) continue
    const choice = chosen?.[asset.id]
    if (choice === null) continue
    if (choice !== undefined && ids.has(choice)) {
      wearers.set(asset.id, choice)
      continue
    }
    const owner =
      characters.find((c) => c.defaultOutfitId === asset.id) ?? (characters.length === 1 ? characters[0] : undefined)
    if (owner) wearers.set(asset.id, owner.id)
  }
  return wearers
}

/**
 * GenerationParams.outfitWearers as stored, from the window, an agent or JSON: distinct non-empty outfit ids mapped to
 * a non-empty character id or null; undefined when nothing is left (the default for every outfit).
 */
export function sanitizeOutfitWearers(input: unknown): GenerationParams['outfitWearers'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const out: Record<string, string | null> = {}
  for (const [outfit, wearer] of Object.entries(input as Record<string, unknown>)) {
    if (!outfit) continue
    if (wearer === null) out[outfit] = null
    else if (typeof wearer === 'string' && wearer) out[outfit] = wearer
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The choices with one outfit's wearer set: a character id, null for nobody, undefined to go back to the default.
 * undefined when nothing is left.
 */
export function withOutfitWearer(
  chosen: GenerationParams['outfitWearers'],
  outfitId: string,
  wearer: string | null | undefined
): GenerationParams['outfitWearers'] {
  const { [outfitId]: _, ...rest } = chosen ?? {}
  return sanitizeOutfitWearers(wearer === undefined ? rest : { ...rest, [outfitId]: wearer })
}

/**
 * The choices kept to the references: those whose outfit – and chosen character – are still among them (`present`:
 * ids of the assets with a photo there, also past the model's limit). A choice for an outfit that left is forgotten,
 * so adding it again starts from its default wearer. undefined when nothing is left.
 */
export function outfitWearersAmong(
  chosen: GenerationParams['outfitWearers'],
  present: ReadonlySet<string>
): GenerationParams['outfitWearers'] {
  if (!chosen) return undefined
  const kept = Object.entries(chosen).filter(
    ([outfit, wearer]) => present.has(outfit) && (wearer === null || present.has(wearer))
  )
  return kept.length === Object.keys(chosen).length ? chosen : sanitizeOutfitWearers(Object.fromEntries(kept))
}
