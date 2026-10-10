// What Studio calls a connected agent in Swedish UI text. MCP clients often report a technical name ("mcp",
// "mcp-remote", "mcp-client") that says how the agent connects, not who it is: those read "Agenten". A real name
// (an X-Studio-Agent-Name header, or a client that names itself, like "OpenClaw") is kept.

const GENERIC = /^(?:mcp|mcp[-_ ]?(?:client|remote|server|agent)|client|agent|unknown|okänd agent|node|python|curl)$/i

/** True when the name only says how the agent connects (or nothing at all). */
export function isGenericAgentName(name: string | undefined): boolean {
  const n = (name ?? '').trim()
  return !n || GENERIC.test(n)
}

/** "Agenten" for a generic or missing name, else the name itself; for the start of a sentence ("Agenten satte …"). */
export function agentDisplayName(name: string | undefined): string {
  return isGenericAgentName(name) ? 'Agenten' : (name ?? '').trim()
}

/** The same inside a sentence: "agenten" for a generic or missing name ("Omdömet av agenten"), else the name. */
export function agentInSentence(name: string | undefined): string {
  return isGenericAgentName(name) ? 'agenten' : (name ?? '').trim()
}
