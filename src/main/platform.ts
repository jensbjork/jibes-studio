// What differs between the operating systems Studio runs on, for main's own code and the words it uses. Studio is
// built for macOS (Apple Silicon) and Windows (x64); everything here keeps macOS exactly as it always was and only
// changes the words and behaviour on Windows (and, untested, Linux).

import { execFile } from 'node:child_process'
import { join } from 'node:path'

export const IS_MAC = process.platform === 'darwin'
export const IS_WINDOWS = process.platform === 'win32'

/** Where the user sees the library's files, as in "moved or deleted in Finder". */
export const FILE_MANAGER = IS_MAC ? 'Finder' : IS_WINDOWS ? 'File Explorer' : 'the file manager'

/** Where deleted files go, with its article: "moved to the Trash". */
export const TRASH = IS_WINDOWS ? 'the Recycle Bin' : 'the Trash'

/** The computer Studio runs on, as the user and the agents read it: "free, on this Mac". */
export const THIS_COMPUTER = IS_MAC ? 'this Mac' : IS_WINDOWS ? 'this PC' : 'this computer'

/** The same, from an agent's side: "Studio runs on the user's Mac". */
/** The menu command that ends the app: Quit on a Mac, Exit on Windows. */
export const QUIT = IS_WINDOWS ? 'Exit' : 'Quit'

export const USERS_COMPUTER = IS_MAC ? "the user's Mac" : IS_WINDOWS ? "the user's PC" : "the user's computer"

/**
 * Windows: marks a folder hidden (`attrib +h`), as its leading dot hides the library's `.studio` on a Mac. Best effort
 * and in the background: it never fails or delays what called it. Does nothing elsewhere.
 */
export function hideFolderOnWindows(dir: string): void {
  if (!IS_WINDOWS) return
  const attrib = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'attrib.exe')
  try {
    execFile(attrib, ['+h', dir], { windowsHide: true, timeout: 10_000 }, (err) => {
      if (err) console.warn(`Could not hide ${dir}: ${err.message}`)
    })
  } catch (err) {
    console.warn(`Could not hide ${dir}:`, err)
  }
}
