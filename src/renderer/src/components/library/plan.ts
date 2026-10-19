import type { FolderInspection, LibraryMode, LibraryStatus } from '@shared/types'
import { displayPath, isWithin, samePath } from '../../lib/library'
import { FILE_MANAGER } from '../../lib/platform'

/** What the user can do with a chosen folder, given the library Studio has now. */
export interface FolderPlan {
  /** Why nothing can be done with this folder; actions is empty then. */
  blocked?: string
  notes: { tone: 'info' | 'warning'; text: string }[]
  actions: PlanAction[]
}

export interface PlanAction {
  mode: LibraryMode
  label: string
  description: string
  primary: boolean
  /** Shown instead of the description when the action can't be used for this folder. */
  disabled?: string
}

/**
 * The library that "Move my library here" would move, if there is one. legacy: it is the library found
 * while no folder was chosen; oldLayout: it is in the layout of an earlier Studio version.
 */
export function movableLibrary(
  status: LibraryStatus
): { path: string; legacy: boolean; oldLayout: boolean } | undefined {
  if (status.state === 'ready' && status.root) return { path: status.root, legacy: false, oldLayout: false }
  if (status.state === 'unconfigured' && status.legacy?.hasContent) {
    return { path: status.legacy.path, legacy: true, oldLayout: status.legacy.oldLayout }
  }
  return undefined
}

/** "“Genereringar” and “Sekvenser”" (on-disk folder names, which stay as they are). */
function quotedList(names: string[]): string {
  const quoted = names.map((n) => `“${n}”`)
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

export function planFor(ins: FolderInspection, status: LibraryStatus): FolderPlan {
  const from = movableLibrary(status)
  // The library Studio found while no folder is chosen: choosing its folder uses it where it is (an
  // earlier version's layout is reorganized in place).
  const legacyHere = !!status.legacy && samePath(ins.path, status.legacy.path)
  const blocked = (reason: string): FolderPlan => ({ blocked: reason, notes: [], actions: [] })

  if (status.state === 'missing' && samePath(ins.path, status.root)) {
    return blocked(
      status.error
        ? "This is the library folder that couldn't be opened. Try again, or choose another folder."
        : ins.exists
          ? 'This is the folder Studio is looking for. Press Try again to open it.'
          : "This is the folder Studio is looking for, but it can't be reached. Connect the disk and try again."
    )
  }
  if (status.state === 'ready' && (ins.isCurrent || samePath(ins.path, status.root))) {
    return blocked('This is already your library folder.')
  }
  // Main may count the old-layout folder itself as "inside" the library it would take along; choosing that
  // folder is fine, it is reorganized in place. So is another library kept inside it (outside its own
  // folders): main lets that one be opened, which is the way back after starting anew in a folder around it.
  const nestedLibrary = ins.hasLibrary && !ins.insideCurrent && !samePath(ins.path, from?.path)
  if (!legacyHere && (ins.insideCurrent || (from && isWithin(ins.path, from.path) && !nestedLibrary))) {
    const container = status.state === 'ready' ? status.root : (from?.path ?? status.legacy?.path)
    // Named, since the setup screen doesn't mention a library without content.
    const which =
      status.state === 'ready'
        ? 'your current library'
        : status.legacy && !status.legacy.hasContent
          ? `the empty Studio library${status.legacy.oldLayout ? ' from an earlier version' : ''}`
          : 'your old library'
    return blocked(
      `The folder is inside ${which}${container ? ` (${displayPath(container)})` : ''}. Choose a folder outside it.`
    )
  }
  if (!ins.writable) {
    return blocked("Studio isn't allowed to save files in this folder. Choose another folder, for example in your home folder.")
  }

  const notes: FolderPlan['notes'] = []
  if (ins.cloudSynced) {
    notes.push({
      tone: 'warning',
      text:
        'The folder syncs with the cloud (iCloud, Dropbox or similar). The database can be damaged if it syncs while ' +
        'Studio is working, so a regular folder on your computer or an external disk is safer.'
    })
  }
  if (ins.oldLayout) {
    notes.push({
      tone: 'info',
      text: legacyHere
        ? 'The library from an earlier version of Studio is here. It is reorganized into the new folder structure – ' +
          'nothing is deleted.'
        : 'The library in the folder is from an earlier version of Studio. When Studio opens it, the files are moved ' +
          'and renamed into the new folder structure – nothing is deleted.'
    })
  } else if (legacyHere) {
    notes.push({ tone: 'info', text: 'A Studio library with the new folder structure is already here.' })
  } else if (!ins.exists) {
    notes.push({ tone: 'info', text: "The folder doesn't exist yet and will be created." })
  } else if (!ins.empty && !ins.hasLibrary) {
    // Folders that already carry the names of Studio's own would be taken for the library's: their files
    // count as its own, and moving the library takes them along.
    const one = ins.conflicts.length === 1
    notes.push(
      ins.conflicts.length
        ? {
            tone: 'warning',
            text:
              `The folder already has ${quotedList(ins.conflicts)} with content. Studio uses ${one ? 'that name' : 'those names'} ` +
              `for its own folders, so what is in ${one ? 'it' : 'them'} counts as part of the library and comes along ` +
              `if you move it. Rename ${one ? 'the folder' : 'the folders'} in ${FILE_MANAGER} first, or choose another folder.`
          }
        : {
            tone: 'info',
            text: "The folder already contains other files. They're left untouched – Studio's folders go next to them."
          }
    )
  }

  const left = from ? ` ${from.legacy ? 'The old library' : 'Your current library'} stays untouched in ${displayPath(from.path)}.` : ''

  if (legacyHere) {
    return {
      notes,
      actions: [
        {
          // Main reorganizes an old-layout library in place when it opens the folder.
          mode: ins.hasLibrary ? 'open' : 'new',
          label: 'Use the library in the folder',
          description: !ins.oldLayout
            ? 'Studio starts using the library in the folder.'
            : status.state === 'ready' && status.root
              ? `Studio switches to the old library and reorganizes it. Your current library stays untouched in ${displayPath(status.root)}.`
              : 'Characters, videos and sequences are sorted into the new folders.',
          primary: true
        }
      ]
    }
  }

  if (ins.hasLibrary) {
    return {
      notes,
      actions: [
        {
          mode: 'open',
          label: 'Open the library in the folder',
          description: ins.oldLayout
            ? `The folder contains a Studio library from an earlier version. Studio switches to it and reorganizes its files into the new folders.${left}`
            : `The folder already contains a Studio library. Studio switches to it.${left}`,
          primary: true
        }
      ]
    }
  }

  if (from) {
    return {
      notes,
      actions: [
        {
          mode: 'move',
          label: 'Move my library here',
          description: from.oldLayout
            ? 'Characters, videos and sequences from the old library are moved here and sorted into the new folders.'
            : from.legacy
              ? 'Everything in the library is moved here. The old folder is removed if it ends up empty – nothing else is deleted.'
              : 'Everything in your current library is moved here. The old folder is removed if it ends up empty – nothing else is deleted.',
          primary: true,
          disabled: ins.conflicts.length
            ? `Not possible: the folder already has ${quotedList(ins.conflicts)} with content. Choose an empty folder, or move ${ins.conflicts.length === 1 ? 'it' : 'them'} out of the way first.`
            : undefined
        },
        {
          mode: 'new',
          label: 'Start with an empty library',
          description: `Studio starts from scratch in this folder.${left} You can switch back whenever you like.`,
          primary: false
        }
      ]
    }
  }

  return {
    notes,
    actions: [
      {
        mode: 'new',
        label: status.state === 'missing' ? 'Start with an empty library here' : 'Save everything in this folder',
        description:
          status.state === 'missing' && status.root
            ? `The library in ${displayPath(status.root)} is no longer used, but it stays and can be opened again when the folder can be reached.`
            : 'Studio creates the folders above here and saves everything you do in them.',
        primary: true
      }
    ]
  }
}
