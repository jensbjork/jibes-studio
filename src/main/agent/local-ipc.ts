import { ipcMain, type IpcMainInvokeEvent } from 'electron'

// The agent's tools reach Studio's services through the very handlers the window calls (assets:save,
// segments:add, video:generate …). Every rule those handlers apply – validation, busy checks, folder moves,
// change notifications to the window – then applies to an agent exactly as it does to the user clicking in Studio,
// and nothing an agent does can take a shortcut past them.

type Handler = Parameters<typeof ipcMain.handle>[1]

const handlers = new Map<string, Handler>()
let recording = false

/**
 * Remembers every handler registered with ipcMain.handle from now on (they are still registered as usual).
 * Call once, before any module registers its handlers.
 */
export function recordIpcHandlers(): void {
  if (recording) return
  recording = true
  const register = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    handlers.set(channel, listener)
    register(channel, listener)
  }
}

/** Stands in for the IPC event of a call that comes from the agent rather than a window. */
const AGENT_EVENT = { sender: undefined, frameId: -1, processId: -1 } as unknown as IpcMainInvokeEvent

/** True when a handler is running for an agent's tool call rather than for a window. */
export function isAgentCall(event: IpcMainInvokeEvent | undefined): boolean {
  return event === AGENT_EVENT
}

/** Calls a Studio service the way the window would (e.g. 'segments:add'), in this process. */
export async function callService<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Studio saknar tjänsten ${channel}.`)
  return (await handler(AGENT_EVENT, ...args)) as T
}
