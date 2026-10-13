import { maxReferenceImages } from '@shared/models'
import { findAudioTokens, findImageTokens, findMalformedTokens } from '@shared/prompt-refs'
import type { GenerationParams } from '@shared/types'
import {
  AssetIndex,
  audioTokenMap,
  descriptionInfo,
  issueList,
  promptIssues,
  q,
  tokenMap
} from './studio'

// Reordering a reference list (the Generate form's or a sequence clip's) the way dragging a thumbnail does it in
// Studio: every picture and audio clip stays the same, only their numbers change, and the prompt's tokens follow
// them (the shared reorderReferences in prompt-remap.ts). Here: reading the order an agent asks for – by token, by
// photo or clip id, or by asset – and saying what moved and what is past the model's limit.

export type ReferenceKind = 'image' | 'audio'

const pathKey = (path: string): string => path.normalize('NFC')

interface Words {
  token: string
  plural: string
  list: string
  /** What a token of the other list is, with its pronoun: "ett ljudklipp – ange det". */
  other: string
  otherList: string
}

const WORDS: Record<ReferenceKind, Words> = {
  image: {
    token: '@Image',
    plural: 'referensbilder',
    list: 'images',
    other: 'ett ljudklipp – ange det',
    otherList: 'audios'
  },
  audio: { token: '@Audio', plural: 'ljudreferenser', list: 'audios', other: 'en bild – ange den', otherList: 'images' }
}

/** "formuläret" → "Formuläret", for a message that starts with where. */
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** "@Image1–@Image4", the tokens a list of n references has. */
function tokenRange(kind: ReferenceKind, n: number): string {
  const t = WORDS[kind].token
  return n === 1 ? `${t}1` : `${t}1–${t}${n}`
}

/** The token an entry is, when the whole entry is one ("@image3" and "@Image3" alike); 1-based. */
function tokenNumber(entry: string, kind: ReferenceKind): number | undefined {
  const found = (kind === 'image' ? findImageTokens : findAudioTokens)(entry)
  return found.length === 1 && found[0].start === 0 && found[0].end === entry.length ? found[0].index : undefined
}

/** The 0-based positions in `paths` that an agent's entry names (several for an asset id). */
function positionsOf(
  kind: ReferenceKind,
  raw: string,
  paths: readonly string[],
  index: AssetIndex,
  where: string
): number[] {
  const entry = raw.trim()
  const words = WORDS[kind]
  const n = tokenNumber(entry, kind)
  if (n !== undefined) {
    if (n > paths.length) {
      throw new Error(
        paths.length
          ? `${words.token}${n} finns inte: ${where} har ${paths.length} ${words.plural} (${tokenRange(kind, paths.length)}).`
          : `${capitalized(where)} har inga ${words.plural}.`
      )
    }
    return [n - 1]
  }
  const other: ReferenceKind = kind === 'image' ? 'audio' : 'image'
  if (tokenNumber(entry, other) !== undefined) {
    throw new Error(`${entry} är ${words.other} i ${words.otherList}, inte i ${words.list}.`)
  }
  const malformed = findMalformedTokens(entry)[0]
  if (malformed) {
    throw new Error(
      `”${entry}” är ingen giltig referens${malformed.suggestion ? ` – menade du ${malformed.suggestion}?` : '.'}`
    )
  }
  const keys = paths.map(pathKey)
  const at = (path: string): number => keys.indexOf(pathKey(path))
  if (kind === 'image') {
    const photo = index.image(entry)
    if (photo) {
      const i = at(photo.path)
      if (i < 0) {
        throw new Error(
          `Bilden ${entry} (${photo.asset.name}, foto ${photo.photoNumber}) är inte en av ${words.plural}na i ${where}.`
        )
      }
      return [i]
    }
  } else {
    const clip = index.audioById(entry)
    if (clip) {
      const i = at(clip.audio.path)
      if (i < 0) {
        throw new Error(
          `Ljudklippet ${entry} (${clip.asset.name}, klipp ${clip.clipNumber}) är inte en av ${words.plural}na i ${where}.`
        )
      }
      return [i]
    }
  }
  const asset = index.get(entry)
  if (asset) {
    const own = new Set(
      (kind === 'image' ? asset.images.map((img) => img.path) : (asset.audio ?? []).map((a) => a.path)).map(pathKey)
    )
    const found = keys.flatMap((key, i) => (own.has(key) ? [i] : []))
    if (!found.length) {
      const none = kind === 'image' ? 'inga bilder' : 'inga ljudklipp'
      throw new Error(`${q(asset.name)} har ${none} bland ${words.plural}na i ${where}.`)
    }
    return found
  }
  const id = kind === 'image' ? 'bild-id (image_id)' : 'ljud-id (audio_id)'
  throw new Error(
    `”${entry}” är varken en referens (${words.token}1 …), ett ${id} eller ett tillgångs-id. Använd tokens från get_workspace eller get_sequence.`
  )
}

/**
 * The references the agent named, as 0-based positions in the current list, in the order named. A reference is
 * named by its token in the current numbering ("@Image3"), its photo or audio clip id, or its asset's id (all of
 * that asset's items in the list, in their current order). Throws (in Swedish) on a name that is no reference of
 * the list or one named twice. `where` names the list for messages ("formuläret").
 */
export function namedPositions(
  kind: ReferenceKind,
  wanted: readonly string[],
  paths: readonly string[],
  index: AssetIndex,
  where: string
): number[] {
  const first: number[] = []
  for (const entry of wanted) {
    for (const i of positionsOf(kind, entry, paths, index, where)) {
      if (first.includes(i)) {
        const { token, list } = WORDS[kind]
        throw new Error(`${token}${i + 1} nämns mer än en gång i ${list}. Ange varje referens en gång.`)
      }
      first.push(i)
    }
  }
  return first
}

/**
 * The new order of a reference list, as 0-based positions in the current one: the references the agent named
 * (namedPositions) come first, in the order named, and the others follow in their current order (so naming one
 * moves it to the front).
 */
export function newOrder(
  kind: ReferenceKind,
  wanted: readonly string[],
  paths: readonly string[],
  index: AssetIndex,
  where: string
): number[] {
  const first = namedPositions(kind, wanted, paths, index, where)
  return [...first, ...paths.map((_, i) => i).filter((i) => !first.includes(i))]
}

/** The list in the new order. */
export function inOrder<T>(list: readonly T[], order: readonly number[]): T[] {
  return order.map((i) => list[i])
}

/** Whether an order leaves the list as it is. */
export const unchanged = (order: readonly number[]): boolean => order.every((old, i) => old === i)

export interface MovedToken {
  from: string
  to: string
  asset_name?: string
  /** Photo number (images) or clip number (audio) within the asset. */
  number?: number
}

/**
 * Which tokens got new numbers: "@Image3 → @Image1" for every reference whose place changed, matched by path, so
 * it also describes a list the window reordered on its own terms.
 */
export function movedTokens(
  kind: ReferenceKind,
  before: readonly string[],
  after: readonly string[],
  index: AssetIndex
): MovedToken[] {
  const t = WORDS[kind].token
  const afterKeys = after.map(pathKey)
  return before.flatMap((path, i) => {
    const j = afterKeys.indexOf(pathKey(path))
    if (j < 0 || j === i) return []
    const photo = kind === 'image' ? index.photo(path) : undefined
    const clip = kind === 'audio' ? index.audio(path) : undefined
    const name = photo?.asset.name ?? clip?.asset.name
    const number = photo?.photoNumber ?? clip?.clipNumber
    const moved: MovedToken = { from: `${t}${i + 1}`, to: `${t}${j + 1}` }
    if (name) moved.asset_name = name
    if (number) moved.number = number
    return [moved]
  })
}

/**
 * The reference images past the model's limit, which stay in the list but aren't sent (Studio shows them as
 * "skickas inte"): with the place they have in the list, so reorder_references can move one forward.
 */
export function notSentInfo(paths: readonly string[], modelId: string, index: AssetIndex): Record<string, unknown> {
  const max = maxReferenceImages(modelId)
  if (paths.length <= max) return {}
  return {
    not_sent: tokenMap(paths, index).slice(max),
    not_sent_note: `The model takes ${max} reference images, so the ones in not_sent are not sent and their tokens can't be used in the prompt. Move one forward with reorder_references (by its token here or its image_id) to send it instead of the last one sent.`
  }
}

/** "(@Image3 → @Image1, @Audio2 → @Audio1)" for the activity log; at most four moves are named. */
export function movedSummary(moved: { images: MovedToken[]; audios: MovedToken[] }): string {
  const all = [...moved.images, ...moved.audios].map((m) => `${m.from} → ${m.to}`)
  if (!all.length) return ''
  return ` (${all.slice(0, 4).join(', ')}${all.length > 4 ? ' …' : ''})`
}

/**
 * What a change of a reference list answers with (reorder_references, swap_reference): the new token maps, what
 * changed (`change`: moved or swapped), the prompts as they read now, the composed prompt with its descriptions, the
 * images left over past the model's limit, and the token issues.
 */
export function referencesAnswer(
  params: GenerationParams,
  index: AssetIndex,
  change: Record<string, unknown>
): Record<string, unknown> {
  const all = params.referenceImages ?? []
  const audios = params.referenceAudios ?? []
  return {
    references: tokenMap(all.slice(0, maxReferenceImages(params.model)), index),
    ...notSentInfo(all, params.model, index),
    ...(audios.length ? { audio_references: audioTokenMap(audios, index) } : {}),
    ...change,
    prompt: params.prompt,
    ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
    ...descriptionInfo(params, index),
    issues: issueList(promptIssues(params))
  }
}

/** What reorder_references answers with: referencesAnswer with which tokens moved. */
export function reorderAnswer(
  params: GenerationParams,
  index: AssetIndex,
  moved: { images: MovedToken[]; audios: MovedToken[] }
): Record<string, unknown> {
  return referencesAnswer(params, index, {
    moved: {
      ...(moved.images.length ? { images: moved.images } : {}),
      ...(moved.audios.length ? { audios: moved.audios } : {})
    }
  })
}
