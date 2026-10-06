import { ipcMain } from 'electron'
import type { AgentService } from './service'

/** The window's side of the agent connection: Settings, the activity drawer and the approval dialog. */
export function registerAgentIpc(agent: AgentService): void {
  ipcMain.handle('agent:status', () => agent.status())
  ipcMain.handle('agent:setEnabled', (_e, enabled: unknown) => agent.setEnabled(enabled === true))
  ipcMain.handle('agent:setPort', (_e, port: unknown) => agent.setPort(Number(port)))
  ipcMain.handle('agent:restart', () => agent.restart())
  ipcMain.handle('agent:token', () => agent.getToken())
  ipcMain.handle('agent:regenerateToken', () => agent.regenerateToken())
  ipcMain.handle('agent:activity:list', () => agent.activity.list())
  ipcMain.handle('agent:approvals:list', () => agent.approvals.list())
  ipcMain.handle('agent:approvals:resolve', (_e, id: unknown, approve: unknown, reason?: unknown) =>
    agent.approvals.resolve(String(id), approve === true, typeof reason === 'string' ? reason : undefined)
  )
}
