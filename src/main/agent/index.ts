// The agent connection: an MCP server through which the user's own agents (e.g. OpenClaw, Hermes Agent,
// Claude Desktop or Claude Code) work in Studio.
export { recordIpcHandlers } from './local-ipc'
export { registerAgentIpc } from './ipc'
export { AgentService } from './service'
