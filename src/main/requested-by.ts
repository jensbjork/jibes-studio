import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FOLDERS, isLibraryReady, libraryRoot } from './paths'

// Paid work the user has already said yes to, and who asked for it.
//
// An agent's paid request runs only once the user approves it in Studio, and a "Generate missing" run is checked once
// against the budget, with its total, when it starts. What such work sends – right away or later, in the run's loop or
// the Editor job it starts – runs inside runConfirmed, so the budget check (budget.ts) doesn't ask about it again.
//
// The same context names the agent whose request it is: every paid row made inside it (a Venice generation, a still,
// an Editor job or a voice design) is noted in the library's ledger, `.studio/requested-by.json` ({id: agent}), which
// Settings → Spending and get_spending read to say what each agent asked for. The library database has no column for
// it; the ledger is a file of the library (it goes along with an export), and a row missing from it was the user's.

interface Confirmed {
  /** The agent whose approved request this is; undefined: the user's own. */
  by?: string
}

const context = new AsyncLocalStorage<Confirmed>()

/**
 * Runs `fn` as paid work the user has said yes to (an approved request, a run checked when it started): the budget isn't
 * checked again for what it sends, also later from work it starts. `by`: the agent that asked; nested inside an agent's
 * request, that agent stays the one named.
 */
export function runConfirmed<T>(fn: () => T, by?: string): T {
  const outer = context.getStore()
  return context.run({ by: by ?? outer?.by }, fn)
}

/** Whether the code running now belongs to paid work the user has already said yes to (see runConfirmed). */
export function isConfirmedHere(): boolean {
  return context.getStore() !== undefined
}

/** The agent whose approved request the code running now carries out; undefined for the user's own work. */
export function requestedByHere(): string | undefined {
  return context.getStore()?.by
}

// ── The ledger ───────────────────────────────────────────────────────────────

const LEDGER_FILE = 'requested-by.json'

interface LedgerFile {
  version: 1
  /** Generation, still or Editor job id → the agent's name. */
  items: Record<string, string>
}

let cache: { root: string; items: Map<string, string> } | undefined

function ledgerPath(root: string): string {
  return join(root, FOLDERS.appData, LEDGER_FILE)
}

function load(root: string): Map<string, string> {
  if (cache?.root === root) return cache.items
  const items = new Map<string, string>()
  const file = ledgerPath(root)
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerFile>
      for (const [id, agent] of Object.entries(parsed.items ?? {})) {
        if (typeof agent === 'string' && agent) items.set(id, agent)
      }
    } catch (err) {
      console.warn('The requested-by ledger could not be read; spending is shown as the user’s:', err)
    }
  }
  cache = { root, items }
  return items
}

/** Written to a temp file and renamed, so a crash mid-write can't leave half a ledger. */
function save(root: string, items: Map<string, string>): void {
  const file = ledgerPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const data: LedgerFile = { version: 1, items: Object.fromEntries(items) }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

/**
 * Notes that the paid row `id` (a generation, a still, an Editor job) was made for the agent whose approved request is
 * running now; does nothing for the user's own work. Never throws: it is bookkeeping beside a row already paid for.
 */
export function noteRequestedBy(id: string): void {
  const by = requestedByHere()
  if (!by || !isLibraryReady()) return
  try {
    const root = libraryRoot()
    const items = load(root)
    if (items.get(id) === by) return
    items.set(id, by)
    save(root, items)
  } catch (err) {
    console.warn('Could not note which agent asked for a paid item:', err)
  }
}

/** Who asked for each paid row an agent asked for, in the open library (empty without one). */
export function requestedByLedger(): ReadonlyMap<string, string> {
  if (!isLibraryReady()) return new Map()
  try {
    return load(libraryRoot())
  } catch {
    return new Map()
  }
}
