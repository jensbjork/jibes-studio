import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import type { AgentCommandReply, AgentFormCommand } from '@shared/types'

// The Generate form lives in the window (it is what the user sees and edits), so the tools that read or fill it
// ask the window: main sends 'agent:command' and the window's agent bridge answers with 'agent:reply'.

/** What main asks the window (swap_reference: see agent/swap.ts). */
export type WindowCommand = AgentFormCommand

/** How long the window gets to answer. */
export const COMMAND_TIMEOUT_MS = 10_000

export const WINDOW_NOT_ANSWERING = 'Studio-fönstret svarar inte – är det öppet?'

interface Pending {
  /** The window the command went to; only it may answer. */
  webContentsId: number
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** The window an agent's command goes to: the focused one, else the first that is open. */
function targetWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
}

export class FormBridge {
  private readonly pending = new Map<string, Pending>()

  constructor() {
    ipcMain.on('agent:reply', (e: IpcMainEvent, id: unknown, reply: unknown) => this.onReply(e, id, reply))
  }

  /** Sends a command to the window and resolves with its answer; rejects (in Swedish) after the timeout. */
  send<T>(command: WindowCommand, args?: unknown): Promise<T> {
    const win = targetWindow()
    if (!win) return Promise.reject(new Error(WINDOW_NOT_ANSWERING))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(WINDOW_NOT_ANSWERING))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, {
        webContentsId: win.webContents.id,
        resolve: (result) => resolve(result as T),
        reject,
        timer
      })
      try {
        win.webContents.send('agent:command', { id, command, args: args ?? {}, deadline: Date.now() + COMMAND_TIMEOUT_MS })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(WINDOW_NOT_ANSWERING))
      }
    })
  }

  /** The window this command would go to, brought to the front (restored when minimized). */
  showWindow(): void {
    const win = targetWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
  }

  /** Fails every command still waiting (when the server stops). */
  cancelAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(WINDOW_NOT_ANSWERING))
      this.pending.delete(id)
    }
  }

  private onReply(e: IpcMainEvent, id: unknown, raw: unknown): void {
    if (typeof id !== 'string') return
    const p = this.pending.get(id)
    if (!p || e.sender?.id !== p.webContentsId) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    const reply = (raw ?? {}) as AgentCommandReply
    if (reply.ok) p.resolve(reply.result)
    else p.reject(new Error(typeof reply.error === 'string' && reply.error ? reply.error : 'Studio kunde inte utföra det.'))
  }
}
