// English folder names (schema 15): the names, and stored paths with them. Up to schema 14 a library's folders had
// Swedish names – Karaktärer, Sekvenser/<name>/Tagningar, .studio/miniatyrer … – and so did the paths its database
// stores and the window remembers. main renames the folders and the database's paths (src/main/folder-names.ts, db.ts);
// the window follows with the paths it remembers (generateStore). Names the user gave – an asset's, a sequence's or an
// edit's folder, any file – never change, even when one happens to be one of the Swedish words.

/** The schema version from which a library's folders have English names. */
export const ENGLISH_FOLDERS_SCHEMA_VERSION = 15

/** The visible folders in the base folder: Swedish (schema ≤ 14) → English (paths.ts FOLDERS). */
export const TOP_FOLDER_NAMES: Readonly<Record<string, string>> = {
  Karaktärer: 'Characters',
  Miljöer: 'Environments',
  Produkter: 'Products',
  Kläder: 'Outfits',
  Poser: 'Poses',
  Regissörer: 'Directors',
  Referensbilder: 'Reference images',
  Genereringar: 'Generations',
  Sekvenser: 'Sequences',
  'Egna klipp': 'Own clips',
  Redigeringar: 'Edits'
}

export const APP_DATA_FOLDER = '.studio'

/** The folders in .studio (paths.ts APP_DATA); tmp keeps its name. */
export const APP_DATA_NAMES: Readonly<Record<string, string>> = {
  miniatyrer: 'thumbnails',
  bildrutor: 'frames',
  stammar: 'stems',
  redigering: 'edit-jobs',
  tidslinje: 'timeline'
}

/**
 * The folders inside each sequence's, storyboard's and edit's own folder, by the English name of the folder that
 * holds them (a sequence's Storyboard/ keeps its name, and so does Storyboards/).
 */
export const SUBFOLDER_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Sequences: { Tagningar: 'Takes', Ljud: 'Audio' },
  Storyboards: { Övergångar: 'Transitions', Bilder: 'Images' },
  Edits: { Tagningar: 'Takes', Ljud: 'Audio', Underlag: 'Inputs' }
}

const own = (map: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

/**
 * A relative stored path with English folder names, in the places Studio's own folders are; see englishPath. A part
 * is only a folder when something comes after it: a file that happens to be called "Ljud" keeps its name.
 */
function englishRelative(path: string): string {
  const sep = path.includes('/') ? '/' : path.includes('\\') ? '\\' : undefined
  if (!sep) return path
  const parts = path.split(sep)
  const first = parts[0].normalize('NFC')
  if (first === APP_DATA_FOLDER) {
    const renamed = parts.length >= 3 ? own(APP_DATA_NAMES, parts[1].normalize('NFC')) : undefined
    if (renamed) parts[1] = renamed
    return parts.join(sep)
  }
  const top = (parts.length >= 2 ? own(TOP_FOLDER_NAMES, first) : undefined) ?? first
  if (top !== first) parts[0] = top
  const subs = SUBFOLDER_NAMES[top]
  const sub = subs && parts.length >= 4 ? own(subs, parts[2].normalize('NFC')) : undefined
  if (sub) parts[2] = sub
  return parts.join(sep)
}

/**
 * A stored path with the English folder names: only in the places Studio's own folders are – the first part (a
 * top-level folder), the second inside .studio, the third inside a sequence's, storyboard's or edit's folder – so a
 * name the user gave stays as it is. Relative paths (with '/', or '\' as Windows stores them) and absolute ones inside
 * `root`; anything else – a file elsewhere on the computer, a path already in English – comes back as it is.
 */
export function englishPath(path: string, root?: string): string {
  if (!path || path.includes('\n')) return path
  if (root) {
    for (const sep of ['/', '\\']) {
      const prefix = root.endsWith(sep) ? root : root + sep
      if (path.startsWith(prefix)) return prefix + englishRelative(path.slice(prefix.length))
    }
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  return englishRelative(path)
}
