// English folder names on disk (schema 15; the names and the path rewrite are in src/shared/folder-names.ts). A
// library from before is moved to the English names once, the first time this version opens it:
// renameFoldersToEnglish renames its folders in place before anything else touches the base folder (library-root.ts),
// and the database's migration to 15 then rewrites every stored path (db.ts). Both only rename – no file is copied or
// removed, apart from an empty folder in the way; the timeline cache's paths are rewritten – and both can run again: a
// migration cut off halfway (a crash, the power) finishes the next time the library is opened.
//
// No imports from paths.ts or db.ts (db.ts imports this): the English names are written out in shared, and a test
// checks that they are paths.ts's.

import { readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  APP_DATA_FOLDER,
  APP_DATA_NAMES,
  englishPath,
  SUBFOLDER_NAMES,
  TOP_FOLDER_NAMES
} from '@shared/folder-names'
import { FILE_MANAGER } from './platform'

export { ENGLISH_FOLDERS_SCHEMA_VERSION, englishPath, TOP_FOLDER_NAMES } from '@shared/folder-names'

/** Files Finder and File Explorer leave in a folder: one holding nothing else counts as empty. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** The asset kinds' folders, whose asset folders each mirror the description in a text file (assets.ts). */
const ASSET_KIND_FOLDERS = ['Characters', 'Environments', 'Products', 'Outfits', 'Poses', 'Directors']
const DESCRIPTION_FILE = { swedish: 'Beskrivning.txt', english: 'Description.txt' }

type FolderState = 'missing' | 'empty' | 'full' | 'file'

function stateOf(path: string): FolderState {
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return 'missing'
  }
  if (!isDir) return 'file'
  return readdirSync(path).every((name) => SYSTEM_FILES.has(name)) ? 'empty' : 'full'
}

/** One change on disk, in the order they are made. */
type Step = { kind: 'rename'; from: string; to: string } | { kind: 'removeEmpty'; path: string }

/** Thrown before anything is renamed when a folder with an English name already holds files of its own. */
export class FolderNameConflictError extends Error {}

/**
 * The steps that move the folder `name` to `english` – looked at in `dir`, where it is now, and named in `final`, where
 * it will be once its parent is renamed (the same folder for a top-level one) – or what is in the way.
 */
function plan(dir: string, final: string, name: string, english: string, steps: Step[], conflicts: string[]): void {
  const source = stateOf(join(dir, name))
  // Not there, or a file of that name: nothing of Studio's to rename.
  if (source === 'missing' || source === 'file') return
  const target = stateOf(join(dir, english))
  const from = join(final, name)
  const to = join(final, english)
  if (target === 'file') conflicts.push(join(dir, english))
  else if (target === 'missing') steps.push({ kind: 'rename', from, to })
  // Both there: an empty one is what a cut-off run (or an older Studio opening the library meanwhile) left behind.
  else if (target === 'empty') steps.push({ kind: 'removeEmpty', path: to }, { kind: 'rename', from, to })
  else if (source === 'empty') steps.push({ kind: 'removeEmpty', path: from })
  else conflicts.push(join(dir, english))
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Every change renameFoldersToEnglish would make in `root`, or a FolderNameConflictError naming what is in the way. */
export function planFolderRenames(root: string): Step[] {
  const steps: Step[] = []
  const conflicts: string[] = []
  for (const [swedish, english] of Object.entries(TOP_FOLDER_NAMES)) plan(root, root, swedish, english, steps, conflicts)
  const appData = join(root, APP_DATA_FOLDER)
  for (const [swedish, english] of Object.entries(APP_DATA_NAMES)) {
    plan(appData, appData, swedish, english, steps, conflicts)
  }
  // Inside each sequence's, storyboard's and edit's folder: looked at where it is now (in the Swedish parent until
  // that is renamed), renamed once the parents have been.
  for (const [parent, subs] of Object.entries(SUBFOLDER_NAMES)) {
    const swedish = Object.keys(TOP_FOLDER_NAMES).find((k) => TOP_FOLDER_NAMES[k] === parent)
    const now = swedish && stateOf(join(root, swedish)) === 'full' ? join(root, swedish) : join(root, parent)
    for (const name of subfolders(now)) {
      for (const [from, to] of Object.entries(subs)) {
        plan(join(now, name), join(root, parent, name), from, to, steps, conflicts)
      }
    }
  }
  if (conflicts.length) {
    const one = conflicts.length === 1
    const holds = one ? 'a folder of that name already holds' : 'folders of those names already hold'
    const names = conflicts.map((c) => `"${relative(root, c)}"`).join(', ')
    const it = one ? 'it' : 'them'
    throw new FolderNameConflictError(
      `Studio's folders have English names now, but ${holds} files: ${names}. Move ${it} out of the library folder ` +
        `or rename ${it} in ${FILE_MANAGER}, and try again. Nothing has been changed.`
    )
  }
  return steps
}

/** Windows may hold a folder or file for a moment (the indexer, an antivirus): a few tries before giving up. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt)
    }
  }
}

function removeEmptyDir(path: string): void {
  for (const name of readdirSync(path)) {
    if (SYSTEM_FILES.has(name)) unlinkSync(join(path, name))
  }
  rmdirSync(path)
}

/**
 * The timeline cache (.studio/timeline/*.json) keeps the absolute paths of its filmstrip pictures: they follow.
 * Anything unreadable is left alone (the cache makes it again).
 */
function rewriteTimelineCache(root: string): void {
  const dir = join(root, APP_DATA_FOLDER, APP_DATA_NAMES.tidslinje)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const text = readFileSync(file, 'utf8')
      const json = JSON.parse(text) as unknown
      let changed = false
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
          const next = englishPath(v, root)
          if (next !== v) changed = true
          return next
        }
        if (Array.isArray(v)) return v.map(walk)
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
        return v
      }
      const next = walk(json)
      if (changed) writeFileSync(file, JSON.stringify(next))
    } catch {
      // A cache file: leave it as it is.
    }
  }
}

/**
 * Each asset folder's description file: Beskrivning.txt becomes Description.txt (a copy of the description in the
 * database, for Finder). Where both are there – the user's own file, say – both stay.
 */
function renameDescriptionFiles(root: string): void {
  for (const kind of ASSET_KIND_FOLDERS) {
    for (const name of subfolders(join(root, kind))) {
      const from = join(root, kind, name, DESCRIPTION_FILE.swedish)
      const to = join(root, kind, name, DESCRIPTION_FILE.english)
      if (stateOf(from) === 'file' && stateOf(to) === 'missing') renameWithRetry(from, to)
    }
  }
}

/**
 * Renames a library's Swedish folders to their English names in place (schema ≤ 14; the database's paths follow in
 * its migration to 15). Refuses with a FolderNameConflictError, before changing anything, when a folder with an
 * English name already holds files. Returns the number of folders renamed. Safe to run again.
 */
export function renameFoldersToEnglish(root: string): number {
  const steps = planFolderRenames(root)
  let renamed = 0
  for (const step of steps) {
    if (step.kind === 'removeEmpty') removeEmptyDir(step.path)
    else {
      renameWithRetry(step.from, step.to)
      renamed++
    }
  }
  renameDescriptionFiles(root)
  rewriteTimelineCache(root)
  return renamed
}
