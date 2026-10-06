import type { FolderInspection, LibraryMode, LibraryStatus } from '@shared/types'
import { displayPath, isWithin, samePath } from '../../lib/library'

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
 * The library that "Flytta mitt bibliotek hit" would move, if there is one. legacy: it is the library found
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

/** "”Genereringar” och ”Sekvenser”" */
function quotedList(names: string[]): string {
  const quoted = names.map((n) => `”${n}”`)
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} och ${quoted[quoted.length - 1]}`
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
        ? 'Det här är biblioteksmappen som inte gick att öppna. Försök igen, eller välj en annan mapp.'
        : ins.exists
          ? 'Det är den här mappen Studio letar efter. Tryck på Försök igen för att öppna den.'
          : 'Det är den här mappen Studio letar efter, men den går inte att nå. Anslut disken och försök igen.'
    )
  }
  if (status.state === 'ready' && (ins.isCurrent || samePath(ins.path, status.root))) {
    return blocked('Det här är redan din biblioteksmapp.')
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
        ? 'ditt nuvarande bibliotek'
        : status.legacy && !status.legacy.hasContent
          ? `det tomma Studio-biblioteket${status.legacy.oldLayout ? ' från en tidigare version' : ''}`
          : 'ditt gamla bibliotek'
    return blocked(
      `Mappen ligger inuti ${which}${container ? ` (${displayPath(container)})` : ''}. Välj en mapp som ligger utanför det.`
    )
  }
  if (!ins.writable) {
    return blocked('Studio får inte spara filer i den här mappen. Välj en annan mapp, till exempel i din hemmapp.')
  }

  const notes: FolderPlan['notes'] = []
  if (ins.cloudSynced) {
    notes.push({
      tone: 'warning',
      text:
        'Mappen synkas med molnet (iCloud, Dropbox eller liknande). Databasen kan skadas om den synkas medan ' +
        'Studio arbetar, så en vanlig mapp på datorn eller en extern disk är säkrare.'
    })
  }
  if (ins.oldLayout) {
    notes.push({
      tone: 'info',
      text: legacyHere
        ? 'Här ligger biblioteket från en tidigare version av Studio. Det ordnas om till den nya mappstrukturen – ' +
          'inget raderas.'
        : 'Biblioteket i mappen är från en tidigare version av Studio. När Studio öppnar det flyttas och döps ' +
          'filerna om till den nya mappstrukturen – inget raderas.'
    })
  } else if (legacyHere) {
    notes.push({ tone: 'info', text: 'Här ligger ett Studio-bibliotek som redan har den nya mappstrukturen.' })
  } else if (!ins.exists) {
    notes.push({ tone: 'info', text: 'Mappen finns inte än och skapas.' })
  } else if (!ins.empty && !ins.hasLibrary) {
    // Folders that already carry the names of Studio's own would be taken for the library's: their files
    // count as its own, and moving the library takes them along.
    const one = ins.conflicts.length === 1
    notes.push(
      ins.conflicts.length
        ? {
            tone: 'warning',
            text:
              `Mappen har redan ${quotedList(ins.conflicts)} med innehåll. Studio använder ${one ? 'det namnet' : 'de namnen'} ` +
              `för sina egna mappar, så det som ligger i ${one ? 'den' : 'dem'} räknas till biblioteket och följer med ` +
              `om du flyttar det. Döp om ${one ? 'mappen' : 'mapparna'} i Finder först, eller välj en annan mapp.`
          }
        : {
            tone: 'info',
            text: 'Mappen innehåller redan andra filer. De lämnas orörda – Studios mappar läggs bredvid dem.'
          }
    )
  }

  const left = from ? ` ${from.legacy ? 'Det gamla biblioteket' : 'Ditt nuvarande bibliotek'} ligger kvar orört i ${displayPath(from.path)}.` : ''

  if (legacyHere) {
    return {
      notes,
      actions: [
        {
          // Main reorganizes an old-layout library in place when it opens the folder.
          mode: ins.hasLibrary ? 'open' : 'new',
          label: 'Använd biblioteket i mappen',
          description: !ins.oldLayout
            ? 'Studio börjar använda biblioteket i mappen.'
            : status.state === 'ready' && status.root
              ? `Studio byter till det gamla biblioteket och ordnar det. Ditt nuvarande bibliotek ligger kvar orört i ${displayPath(status.root)}.`
              : 'Karaktärer, videor och sekvenser sorteras in i de nya mapparna.',
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
          label: 'Öppna biblioteket i mappen',
          description: ins.oldLayout
            ? `Mappen innehåller ett Studio-bibliotek från en tidigare version. Studio byter till det och ordnar om dess filer i de nya mapparna.${left}`
            : `Mappen innehåller redan ett Studio-bibliotek. Studio byter till det.${left}`,
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
          label: 'Flytta mitt bibliotek hit',
          description: from.oldLayout
            ? 'Karaktärer, videor och sekvenser från det gamla biblioteket flyttas hit och sorteras in i de nya mapparna.'
            : from.legacy
              ? 'Allt i biblioteket flyttas hit. Den gamla mappen tas bort om den blir tom – inget annat raderas.'
              : 'Allt i ditt nuvarande bibliotek flyttas hit. Den gamla mappen tas bort om den blir tom – inget annat raderas.',
          primary: true,
          disabled: ins.conflicts.length
            ? `Går inte: mappen har redan ${quotedList(ins.conflicts)} med innehåll. Välj en tom mapp, eller flytta undan ${ins.conflicts.length === 1 ? 'den' : 'dem'} först.`
            : undefined
        },
        {
          mode: 'new',
          label: 'Börja med ett tomt bibliotek',
          description: `Studio börjar om från noll i den här mappen.${left} Du kan byta tillbaka när du vill.`,
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
        label: status.state === 'missing' ? 'Börja med ett tomt bibliotek här' : 'Spara allt i den här mappen',
        description:
          status.state === 'missing' && status.root
            ? `Biblioteket i ${displayPath(status.root)} används inte längre, men finns kvar och kan öppnas igen när mappen går att nå.`
            : 'Studio skapar mapparna ovan här och sparar allt du gör i dem.',
        primary: true
      }
    ]
  }
}
