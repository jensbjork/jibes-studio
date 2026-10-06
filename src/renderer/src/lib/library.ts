import type { Asset, AssetKind, GenerationParams, LibraryMode } from '@shared/types'

// localStorage keys that hold library data. Paths and ids in them belong to one library, so switching
// libraries has to rewrite or forget them (see rememberAfterSwitch).
// The version is bumped when the defaults change, so old remembered settings don't mask the new defaults.
export const LAST_PARAMS_KEY = 'generate:lastParams:v2'
/** Which asset image each remembered image path is (path → image id), so the form can follow it. */
export const LAST_PARAMS_IMAGE_IDS_KEY = 'generate:lastParamsImageIds:v1'
export const LAST_SEQUENCE_KEY = 'sequences:lastOpen'
/** The asset selected in each library view. */
export const SELECTED_ASSET_KEYS: Record<AssetKind, string> = {
  character: 'characters:selected',
  environment: 'environments:selected',
  outfit: 'outfits:selected'
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && trimSlash(a) === trimSlash(b)
}

/** True when path is dir itself or anything below it. */
export function isWithin(path: string, dir: string): boolean {
  const d = trimSlash(dir)
  return trimSlash(path) === d || path.startsWith(`${d}/`)
}

/** Shortens the home folder to "~" for display ("/Users/me/Movies/Studio" → "~/Movies/Studio"). */
export function displayPath(path: string): string {
  return trimSlash(path).replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

/** Last path segment, e.g. the folder name shown at the top of the folder tree. */
export function folderName(path: string): string {
  const trimmed = trimSlash(path)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** Applies fn to every image path in the params; fn returning undefined drops that image. */
export function mapParamImages(
  params: Partial<GenerationParams>,
  fn: (path: string) => string | undefined
): Partial<GenerationParams> {
  const next = { ...params }
  for (const key of ['startImage', 'endImage'] as const) {
    const path = params[key]
    if (!path) continue
    const mapped = fn(path)
    if (mapped) next[key] = mapped
    else delete next[key]
  }
  if (params.referenceImages) {
    const mapped = params.referenceImages.flatMap((p) => {
      const m = p ? fn(p) : undefined
      return m ? [m] : []
    })
    next.referenceImages = [...new Set(mapped)]
  }
  return next
}

// ── Following asset images ──────────────────────────────────────────────────

// The photos of a character, environment or outfit move when its folder follows a rename, or when "Städa upp"
// tidies them. Main rewrites the paths it stores; the Generate form's own copy (state and localStorage)
// follows by image id.

/** Anything with library images: an Asset, or a list item shaped like one. */
type WithImages = Pick<Asset, 'images'>

function imagePathsOf(params: Partial<GenerationParams>): string[] {
  return [params.startImage, params.endImage, ...(params.referenceImages ?? [])].filter(
    (p): p is string => typeof p === 'string' && p !== ''
  )
}

export function readRememberedImageIds(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_PARAMS_IMAGE_IDS_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function rememberImageIds(ids: Record<string, string>): void {
  try {
    localStorage.setItem(LAST_PARAMS_IMAGE_IDS_KEY, JSON.stringify(ids))
  } catch {
    // Storage unavailable; following moved images is only a convenience.
  }
}

/**
 * The image id of every asset image among the params' paths. A path that is no asset image any more keeps
 * the id it had (its image may just have moved and not been followed yet). Pass every kind of asset.
 */
export function assetImageIdsFor(
  params: Partial<GenerationParams>,
  assets: readonly WithImages[],
  previous: Record<string, string>
): Record<string, string> {
  const idByPath = new Map(assets.flatMap((a) => a.images.map((img) => [img.path, img.id] as const)))
  const ids: Record<string, string> = {}
  for (const path of imagePathsOf(params)) {
    const id = idByPath.get(path) ?? previous[path]
    if (id) ids[path] = id
  }
  return ids
}

/**
 * Points image paths that used to be an asset image (by remembered id) at where that image is now.
 * Undefined when nothing moved. Pass every kind of asset.
 */
export function followAssetImages<T extends Partial<GenerationParams>>(
  params: T,
  assets: readonly WithImages[],
  remembered: Record<string, string>
): T | undefined {
  const pathById = assetImageMap(assets)
  const current = new Set(pathById.values())
  let moved = false
  const next = mapParamImages(params, (path) => {
    if (current.has(path)) return path
    const id = remembered[path]
    const now = id ? pathById.get(id) : undefined
    if (!now || now === path) return path
    moved = true
    return now
  })
  return moved ? ({ ...params, ...next } as T) : undefined
}

/**
 * Pictures from outside the library are copied into Referensbilder when a generation is submitted (`sent` is
 * what was submitted, `stored` what the generation recorded). Returns `current` using those copies instead
 * of the originals, so the form keeps working when the originals are moved or deleted; undefined when no
 * picture was copied.
 */
export function withImportedCopies<T extends Partial<GenerationParams>>(
  current: T,
  sent: Partial<GenerationParams>,
  stored: Partial<GenerationParams>
): T | undefined {
  const copies = new Map<string, string>()
  const pair = (from: string | undefined, to: string | undefined): void => {
    if (from && to && from !== to) copies.set(from, to)
  }
  pair(sent.startImage, stored.startImage)
  pair(sent.endImage, stored.endImage)
  sent.referenceImages?.forEach((r, i) => pair(r, stored.referenceImages?.[i]))
  if (!copies.size) return undefined
  let changed = false
  const next = mapParamImages(current, (path) => {
    const copy = copies.get(path)
    if (!copy) return path
    changed = true
    return copy
  })
  return changed ? ({ ...current, ...next } as T) : undefined
}

// ── Switching libraries ─────────────────────────────────────────────────────

export interface SwitchMemory {
  mode: LibraryMode
  /** The library being left: the configured root, or the old-layout folder while unconfigured. */
  oldRoot?: string
  /** oldRoot is a library in the layout of an earlier Studio version, which is reorganized when adopted. */
  oldIsLegacy: boolean
  newRoot: string
}

/** Whether the old library's files end up in the new one (moved there, or the same library used in place). */
export function carriesOver(m: SwitchMemory): boolean {
  return m.mode === 'move' || samePath(m.oldRoot, m.newRoot)
}

// Old layout: characters/<characterId>/<imageId>.<ext>. The image id survives the reorganization, so it
// finds the image's new path.
const LEGACY_CHARACTER_IMAGE = /^characters\/[^/]+\/([^/]+)\.[^./]+$/

/** The legacy image id a remembered path refers to, if it is a character image of the old layout. */
function legacyImageId(path: string, m: SwitchMemory): string | undefined {
  if (!m.oldRoot || !m.oldIsLegacy || !isWithin(path, m.oldRoot)) return undefined
  return LEGACY_CHARACTER_IMAGE.exec(path.slice(trimSlash(m.oldRoot).length + 1))?.[1]
}

/** The library's own folders in the base folder: only these move with it (main's paths.FOLDERS). */
const LIBRARY_FOLDERS = new Set([
  'Karaktärer',
  'Miljöer',
  'Kläder',
  'Referensbilder',
  'Genereringar',
  'Sekvenser',
  '.studio'
])
/** An earlier Studio version's folders, reorganized into the ones above when such a library is adopted. */
const LEGACY_FOLDERS = new Set(['characters', 'generations', 'thumbs', 'exports', 'frames'])

/** The top-level folder of path inside root ("Karaktärer" for <root>/Karaktärer/Anna/a.jpg). */
function topFolder(path: string, root: string): string {
  return path.slice(trimSlash(root).length + 1).split('/')[0].normalize('NFC')
}

/**
 * Where a remembered path points after the switch. Paths outside the old library's folders are untouched,
 * also when they lie in the base folder (the user's own files there stay where they are). Inside them: a moved
 * library keeps its relative layout, so the path is rebased; a reorganized old-layout library only keeps
 * character images (found again by image id); anything else would point into a library that is no longer
 * open, so it is dropped.
 */
export function remapPath(path: string, m: SwitchMemory, imagesById?: ReadonlyMap<string, string>): string | undefined {
  if (!m.oldRoot || !isWithin(path, m.oldRoot)) return path
  const top = topFolder(path, m.oldRoot)
  const legacyFolder = m.oldIsLegacy && LEGACY_FOLDERS.has(top)
  if (!LIBRARY_FOLDERS.has(top) && !legacyFolder) return path
  if (!carriesOver(m)) return undefined
  if (!legacyFolder) return trimSlash(m.newRoot) + path.slice(trimSlash(m.oldRoot).length)
  const id = legacyImageId(path, m)
  return id ? imagesById?.get(id) : undefined
}

export function readRememberedParams(): Partial<GenerationParams> | undefined {
  try {
    const raw = localStorage.getItem(LAST_PARAMS_KEY)
    return raw ? (JSON.parse(raw) as Partial<GenerationParams>) : undefined
  } catch {
    return undefined
  }
}

/** True when resolving the remembered images needs the new library's asset list. */
export function needsImageLookup(snapshot: Partial<GenerationParams> | undefined, m: SwitchMemory): boolean {
  if (!snapshot || !carriesOver(m) || !m.oldIsLegacy) return false
  const paths = [snapshot.startImage, snapshot.endImage, ...(snapshot.referenceImages ?? [])]
  return paths.some((p) => !!p && !!legacyImageId(p, m))
}

/** Image id → path for every image of the assets. */
export function assetImageMap(assets: readonly WithImages[]): Map<string, string> {
  return new Map(assets.flatMap((a) => a.images.map((img) => [img.id, img.path] as const)))
}

/**
 * Rewrites what the renderer remembers in localStorage so it fits the library that is opened next.
 * Works from a snapshot taken before the switch, so it can run again with more information.
 */
export function rememberAfterSwitch(
  m: SwitchMemory,
  snapshot: Partial<GenerationParams> | undefined,
  imagesById?: ReadonlyMap<string, string>
): void {
  try {
    if (snapshot) {
      const next = mapParamImages(snapshot, (p) => remapPath(p, m, imagesById))
      localStorage.setItem(LAST_PARAMS_KEY, JSON.stringify(next))
    }
    // Selections are ids in the old library's database; a moved library keeps them.
    if (!carriesOver(m)) {
      localStorage.removeItem(LAST_SEQUENCE_KEY)
      for (const key of Object.values(SELECTED_ASSET_KEYS)) localStorage.removeItem(key)
    }
  } catch {
    // Storage unavailable; the remembered values are only a convenience.
  }
}
