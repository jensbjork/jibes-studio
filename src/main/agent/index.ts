// The agent connection: an MCP server through which the user's own agents (e.g. Claude Desktop, Claude Code,
// Hermes Agent or OpenClaw) work in Studio.
export { recordIpcHandlers } from './local-ipc'
export { registerAgentIpc } from './ipc'
export { AgentService } from './service'
export type { ExecutingApproval } from './approvals'
