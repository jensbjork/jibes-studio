import type { StudioPlatform } from '@shared/types'

// What differs with the operating system the window runs on: the key shortcuts are pressed with (⌘ on macOS, Ctrl
// on Windows), how they are written, and the names of the system's own places. The copy is written for macOS, as
// it always was: on a Mac every helper here gives back exactly that, and on Windows its counterpart.

/**
 * Known before anything renders: the preload sets it from Node's process.platform. A Mac where there is no preload
 * (the renderer's pure modules also run under Node).
 */
export const platform: StudioPlatform =
  (typeof window === 'undefined' ? undefined : window.studio?.platform) ?? 'darwin'
export const isMac = platform === 'darwin'
/** Paths with drive letters and backslashes ("C:\Users\…"). */
export const isWindows = platform === 'win32'
/** What a path is split on: "/", and on Windows "\" as well. */
export const PATH_SEPARATOR: string | RegExp = isWindows ? /[\\/]/ : '/'

// ── Words ────────────────────────────────────────────────────────────────────

// The same words as main's (src/main/platform.ts); Linux, which isn't built, gets plain ones.

/** "Finder" / "File Explorer": "Show in Finder", "moved or deleted in Finder". */
export const FILE_MANAGER = isMac ? 'Finder' : isWindows ? 'File Explorer' : 'the file manager'
/** "the Trash" / "the Recycle Bin": where deleted files go. */
export const TRASH = isWindows ? 'the Recycle Bin' : 'the Trash'
/** "the Dock" / "the taskbar": where Studio's icon is. */
export const DOCK = isMac ? 'the Dock' : 'the taskbar'
/** "Mac" / "PC": "another Mac", "your Mac's calendar". */
export const COMPUTER = isMac ? 'Mac' : isWindows ? 'PC' : 'computer'
/** "this Mac" / "this PC": "free, on this Mac". */
export const THIS_COMPUTER = `this ${COMPUTER}`
/** "JIBES Studio.app" / "the installed JIBES Studio": what the development version is kept apart from. */
export const INSTALLED_APP = isMac ? 'JIBES Studio.app' : 'the installed JIBES Studio'
/**
 * Why the library can't be exported or imported as a zip here: main packs and unpacks it with macOS' own tools
 * (library-archive.ts) and refuses elsewhere with this same sentence. Undefined on a Mac.
 */
export const ARCHIVE_UNAVAILABLE = isMac
  ? undefined
  : 'Exporting and importing a library is only available on macOS for now.'
/** How ffmpeg is got back when it is missing: Homebrew's on a Mac; on Windows it comes with Studio. */
export const FFMPEG_INSTALL = isMac ? 'brew install ffmpeg' : isWindows ? 'reinstall Studio' : 'install ffmpeg'

// ── Shortcuts ────────────────────────────────────────────────────────────────

/** The modifier shortcuts are pressed with, as written: ⌘ or Ctrl. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl'

/** Windows' words for the Mac glyphs, in the order Windows writes them (Ctrl+Alt+Shift+…). */
const WINDOWS_MODIFIERS: [glyph: string, word: string][] = [
  ['⌃', 'Ctrl'],
  ['⌘', 'Ctrl'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift']
]

/**
 * Shortcuts whose Windows keys aren't the glyphs read one by one: ⌃⌘ would be Ctrl twice, so the sidebar takes
 * Shift for the ⌃; redo is Ctrl+Y, as everywhere on Windows (Ctrl+Shift+Z works too).
 */
const WINDOWS_SPECIAL: Record<string, string> = {
  '⌃⌘S': 'Ctrl+Shift+S',
  '⌘⇧Z': 'Ctrl+Y'
}

// A run of glyphs and what it is pressed with: right after it ("⌘K", "⌥←"), after " + " or "-" ("⌘ + Enter",
// "⌥-click"), or a lone capital after a space ("⌘ F"). A glyph on its own ("hold ⌥") is just the key.
const GLYPHS = /([⌃⌘⌥⇧]+)(?:(?: \+ |-)([A-Za-z]+)|([A-Z][a-z]+|[A-Z0-9←→↑↓↵])|\s([A-Z0-9])(?![A-Za-z]))?/gu

/**
 * Shortcut text as the app shows it: written with the Mac glyphs ("⌘K", "⌘⇧F", "⌃⌘S", "⌘ + Enter", "⌥← / ⌥→",
 * "⌥-click"), it comes back unchanged on a Mac and in Windows' words elsewhere ("Ctrl+K", "Ctrl+Shift+F",
 * "Ctrl+Shift+S", "Ctrl+Enter", "Alt+← / Alt+→", "Alt+click"). Works on whole sentences: only the glyphs change.
 */
export function shortcut(mac: string): string {
  if (isMac) return mac
  return mac.replace(GLYPHS, (whole: string, glyphs: string, word?: string, key?: string, spaced?: string) => {
    const special = WINDOWS_SPECIAL[whole]
    if (special) return special
    const mods = WINDOWS_MODIFIERS.filter(([g]) => glyphs.includes(g)).map(([, w]) => w)
    const pressed = word ?? key ?? spaced
    return [...new Set(mods), ...(pressed ? [pressed] : [])].join('+')
  })
}

/** The modifier keys of a keyboard, mouse or wheel event. */
export interface Modifiers {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Whether the shortcut modifier is down: ⌘ on macOS, Ctrl on Windows. */
export function isModKey(e: Modifiers): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/** The shortcut modifier and no other: ⌘ without ⌃ ⌥ ⇧ on macOS, Ctrl without Alt, Shift or the Windows key. */
export function isModOnly(e: Modifiers): boolean {
  return isModKey(e) && !(isMac ? e.ctrlKey : e.metaKey) && !e.altKey && !e.shiftKey
}
