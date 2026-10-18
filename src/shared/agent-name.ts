// What Studio calls a connected agent in UI text. MCP clients often report a technical name ("mcp",
// "mcp-remote", "mcp-client") that says how the agent connects, not who it is: those read "The agent". A real name
// (an X-Studio-Agent-Name header, or a client that names itself, like "OpenClaw") is kept.

const GENERIC = /^(?:mcp|mcp[-_ ]?(?:client|remote|server|agent)|client|agent|unknown|unknown agent|okänd agent|node|python|curl)$/i

/** True when the name only says how the agent connects (or nothing at all). */
export function isGenericAgentName(name: string | undefined): boolean {
  const n = (name ?? '').trim()
  return !n || GENERIC.test(n)
}

/** "The agent" for a generic or missing name, else the name itself; for the start of a sentence ("The agent set …"). */
export function agentDisplayName(name: string | undefined): string {
  return isGenericAgentName(name) ? 'The agent' : (name ?? '').trim()
}

/** The same inside a sentence: "the agent" for a generic or missing name ("The review by the agent"), else the name. */
export function agentInSentence(name: string | undefined): string {
  return isGenericAgentName(name) ? 'the agent' : (name ?? '').trim()
}
