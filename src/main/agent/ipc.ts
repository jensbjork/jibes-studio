import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isAgentCall } from './local-ipc'
import type { AgentService } from './service'

const USER_ONLY = 'Only you can do this in Studio.'

/**
 * The connection's own settings and the user's answers belong to the window. No tool calls these channels; the
 * refusal is a second line of defence should one ever try (callService records every handler).
 */
function userOnly(e: IpcMainInvokeEvent): void {
  if (isAgentCall(e)) throw new Error(USER_ONLY)
}

/** The window's side of the agent connection: Settings, the activity drawer and the approval dialog. */
export function registerAgentIpc(agent: AgentService): void {
  ipcMain.handle('agent:status', () => agent.status())
  ipcMain.handle('agent:setEnabled', (e, enabled: unknown) => {
    userOnly(e)
    return agent.setEnabled(enabled === true)
  })
  ipcMain.handle('agent:setPort', (e, port: unknown) => {
    userOnly(e)
    return agent.setPort(Number(port))
  })
  ipcMain.handle('agent:restart', (e) => {
    userOnly(e)
    return agent.restart()
  })
  ipcMain.handle('agent:token', (e) => {
    userOnly(e)
    return agent.getToken()
  })
  ipcMain.handle('agent:regenerateToken', (e) => {
    userOnly(e)
    return agent.regenerateToken()
  })
  ipcMain.handle('agent:activity:list', () => agent.activity.list())
  ipcMain.handle('agent:approvals:list', () => agent.approvals.list())
  ipcMain.handle('agent:approvals:resolve', (e, id: unknown, approve: unknown, reason?: unknown) => {
    userOnly(e)
    return agent.approvals.resolve(String(id), approve === true, typeof reason === 'string' ? reason : undefined)
  })
  // The delete dialog's live check (every 2 s and on focus): null while the request can still be approved.
  ipcMain.handle('agent:verifyApproval', (e, id: unknown) => {
    userOnly(e)
    return agent.approvals.check(String(id))
  })
}
