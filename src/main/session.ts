import { ipcMain } from 'electron'
import type { GenerateSession } from '@shared/session'

// This session: from Studio's start until it quits (closing the window keeps it). Generera's list shows what was made
// there since then (shared/session.ts); main's work summary and the agents' list_generations({session: true}) use the
// same session.

export const SESSION_STARTED_AT = Date.now()

/** Generera's generations that were still being made when a library opened in this session (JobManager.resume). */
const carriedOver = new Set<string>()

export function noteCarriedOver(ids: Iterable<string>): void {
  for (const id of ids) carriedOver.add(id)
}

export function currentSession(): GenerateSession {
  return { startedAt: SESSION_STARTED_AT, carriedOver: [...carriedOver] }
}

export function registerSessionIpc(): void {
  ipcMain.handle('app:session', () => currentSession())
}
