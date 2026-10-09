// Which files an agent may hand to Studio's services. Agents run on other machines and never pass local paths: a
// file reaches Studio as an upload, staged in the library's .studio/tmp/agent-uploads, or it is a file the library
// already records (an asset photo, a still, an edit's audio …) that a tool looked up by its id. Handlers that take
// file paths (assets:addImages, imports:import, segments:setImage with a file …) call assertAgentFiles first, so an
// agent's call can never make Studio read, copy or import anything else on this Mac, however the path is spelt.

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { isAgentCall } from './agent/local-ipc'
import * as db from './db'
import {
  agentUploadsDir,
  agentUploadsPath,
  FOLDERS,
  isInsideRoot,
  LEGACY_FOLDERS,
  libraryRoot,
  toStoredPath
} from './paths'

export { agentUploadsDir }

/** The refusal of a path an agent may not hand over (Swedish, shown to the agent as the tool's error). */
export const AGENT_FILES_REFUSED =
  'Agenter kan bara lämna filer som laddats upp till Studio (begin_upload) eller som redan finns i biblioteket.'

/** How paths are compared: the way macOS volumes compare names (letter case and Unicode form ignored). */
const fold = (p: string): string => p.normalize('NFC').toLowerCase()

/** The library's own top-level folders (as paths.isLibraryRelative knows them), folded. */
const LIBRARY_TOP_FOLDERS = new Set([...Object.values(FOLDERS), ...Object.values(LEGACY_FOLDERS)].map(fold))

/** The real path (symlinks resolved), or undefined when it doesn't exist or can't be read. */
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p)
  } catch {
    return undefined
  }
}

/**
 * The folded POSIX path of `inner` relative to `outer` when it lies strictly inside it (both real paths), else
 * undefined.
 */
function inside(outer: string, inner: string): string | undefined {
  const rel = relative(fold(outer), fold(inner))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

function isRegularFile(real: string): boolean {
  try {
    return statSync(real).isFile()
  } catch {
    return false
  }
}

/** A file staged for an agent upload: its real path lies inside the real staging folder. */
function isStagedUpload(real: string): boolean {
  const staging = agentUploadsPath()
  const realStaging = staging ? realPath(staging) : undefined
  return !!realStaging && inside(realStaging, real) !== undefined
}

/**
 * A file the library records (see db.isStoredPathRecorded) in one of its own folders, and really there: a symlink
 * that leads out of the library doesn't count, whatever the database says.
 */
function isRecordedLibraryFile(path: string, real: string): boolean {
  if (!db.isDbOpen() || !isInsideRoot(path)) return false
  const stored = toStoredPath(path)
  if (isAbsolute(stored) || !db.isStoredPathRecorded(stored)) return false
  let realRoot: string | undefined
  try {
    realRoot = realPath(libraryRoot())
  } catch {
    return false
  }
  const rel = realRoot ? inside(realRoot, real) : undefined
  return rel !== undefined && LIBRARY_TOP_FOLDERS.has(rel.split('/')[0])
}

/** Whether an agent may hand this path to a service (see assertAgentFiles). */
export function isAgentFileAllowed(path: unknown): boolean {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) return false
  const resolved = resolve(path)
  const real = realPath(resolved)
  if (!real || !isRegularFile(real)) return false
  return isStagedUpload(real) || isRecordedLibraryFile(resolved, real)
}

/**
 * For an agent's call every path must realpath to inside realpath(agentUploadsDir()) (both sides resolved, so a
 * symlinked library root still matches and a symlink inside staging pointing out does not), or be a file the library
 * records (isInsideRoot + db.isStoredPathRecorded: an asset photo, a still, an edit's media…), and be a regular file.
 * Every consumer copies or clones such a file, never moves it. A window's call (and callApproved's) passes untouched.
 * Throws "Agenter kan bara lämna filer som laddats upp till Studio (begin_upload) eller som redan finns i biblioteket."
 */
export function assertAgentFiles(e: IpcMainInvokeEvent | undefined, paths: readonly unknown[]): void {
  if (!isAgentCall(e)) return
  if (!Array.isArray(paths) || !paths.every(isAgentFileAllowed)) throw new Error(AGENT_FILES_REFUSED)
}
