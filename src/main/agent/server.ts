import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { AgentClientInfo } from '@shared/types'
import { isAllowedPeer, normalizeAddress } from './network'

// The agent connection's HTTP side: MCP over Streamable HTTP at /mcp, one transport and MCP server per client
// session. Only this Mac and the tailnet get in, only with Studio's bearer token, and never a web page.

export const MCP_PATH = '/mcp'
/** Tool calls are small; anything bigger than this is refused unread. */
export const MAX_BODY_BYTES = 1024 * 1024
/** Clients that never close their session are dropped after this long without a request… */
const IDLE_SESSION_MS = 12 * 60 * 60 * 1000
/** …and the least recently seen one goes when there are more sessions than this. */
const MAX_SESSIONS = 24
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/** One client's MCP session. */
export class AgentSession {
  id: string | undefined
  lastSeen = Date.now()
  /**
   * Set once the session has ended (the client left, the token changed, the connection was switched off). A
   * tool call that was already running then finishes without asking the user for anything.
   */
  closed = false
  mcp: McpServer | undefined
  transport: StreamableHTTPServerTransport | undefined
  /**
   * The MCP protocol version the client speaks (from its initialize request, then the mcp-protocol-version
   * header it sends with every later request); undefined until known.
   */
  protocolVersion: string | undefined

  constructor(
    /** Where the client connects from. */
    readonly address: string,
    /** A name the client sent in the X-Studio-Agent-Name header, which wins over its clientInfo. */
    private readonly announcedName: string | undefined
  ) {}

  /** The client's name as the user sees it: the header, else the MCP clientInfo (title, then name). */
  get name(): string {
    const info = this.mcp?.server.getClientVersion()
    return this.announcedName || info?.title || info?.name || 'Agent'
  }

  get version(): string | undefined {
    return this.mcp?.server.getClientVersion()?.version
  }
}

export interface AgentServerOptions {
  port: number
  /** The current token; undefined refuses everyone. */
  token: () => string | undefined
  /** Builds the MCP server (with its tools) for a new session. */
  createMcpServer: (session: AgentSession) => McpServer
  /** A session opened, closed or was dropped. */
  onSessionsChanged: () => void
}

export interface ListenResult {
  /** Hosts it now listens on. */
  listening: string[]
  failures: { host: string; error: NodeJS.ErrnoException }[]
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

/** A short plain-text answer (401/403/404/413 …). */
function plain(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(text)
}

/** A JSON-RPC error without a request id, the way MCP transports answer requests they can't route. */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

class BodyTooLarge extends Error {}

/** Reads the request body, refusing more than MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge())
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body)
}

/** The protocol version an initialize request asks for. */
function requestedVersion(body: unknown): string | undefined {
  const message = (Array.isArray(body) ? body : [body]).find((m) => isInitializeRequest(m))
  const version = message && isInitializeRequest(message) ? message.params.protocolVersion : undefined
  return typeof version === 'string' && version ? version : undefined
}

export class AgentServer {
  private readonly servers = new Map<string, Server>()
  private readonly sessions = new Map<string, AgentSession>()
  private readonly sweeper: NodeJS.Timeout
  private closed = false

  constructor(private readonly opts: AgentServerOptions) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweeper.unref?.()
  }

  get port(): number {
    return this.opts.port
  }

  /** Hosts it listens on right now. */
  hosts(): string[] {
    return [...this.servers.keys()]
  }

  /** Clients with an open session, one entry per name and address, most recently seen first. */
  clients(): AgentClientInfo[] {
    const byClient = new Map<string, AgentClientInfo>()
    for (const s of this.sessions.values()) {
      const key = `${s.name}\u0000${s.address}`
      const known = byClient.get(key)
      if (!known || known.lastSeen < s.lastSeen) {
        byClient.set(key, { name: s.name, version: s.version, address: s.address, lastSeen: s.lastSeen })
      }
    }
    return [...byClient.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * Listens on exactly these hosts: new ones are opened, ones no longer listed are closed (e.g. after
   * Tailscale changed address). Never 0.0.0.0: every address is named.
   */
  async listenOn(hosts: string[]): Promise<ListenResult> {
    const wanted = new Set(hosts)
    for (const [host, server] of this.servers) {
      if (wanted.has(host)) continue
      this.servers.delete(host)
      server.close()
      server.closeAllConnections()
    }
    const failures: ListenResult['failures'] = []
    for (const host of wanted) {
      if (this.servers.has(host) || this.closed) continue
      try {
        this.servers.set(host, await this.open(host))
      } catch (err) {
        failures.push({ host, error: err as NodeJS.ErrnoException })
      }
    }
    return { listening: this.hosts(), failures }
  }

  /** Ends every session (e.g. when the token changed); clients have to connect again. */
  async closeSessions(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.drop(id)))
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.sweeper)
    await this.closeSessions()
    for (const server of this.servers.values()) {
      server.close()
      server.closeAllConnections()
    }
    this.servers.clear()
  }

  private open(host: string): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          console.error('Agent request failed:', err)
          if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
          else res.end()
        })
      })
      // Generous for a body of at most 1 MB; the time a streamed response takes is not limited by this.
      server.requestTimeout = 60_000
      server.headersTimeout = 20_000
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen({ port: this.opts.port, host, exclusive: true }, () => {
        server.off('error', onError)
        server.on('error', (err) => console.warn(`Agent server on ${host} failed:`, err))
        resolve(server)
      })
    })
  }

  private authorized(header: string | undefined): boolean {
    const token = this.opts.token()
    const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null
    if (!token || !match) return false
    // Hashing first gives equal lengths, so the comparison takes the same time whatever was sent.
    return timingSafeEqual(sha256(match[1]), sha256(token))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const peer = req.socket.remoteAddress
    if (!isAllowedPeer(peer, req.socket.localAddress)) return plain(res, 403, 'Forbidden')
    const path = (req.url ?? '/').split('?')[0]
    if (path !== MCP_PATH) return plain(res, 404, 'Not found')
    // Browsers always say where a request comes from; agents don't. No web page gets to talk to Studio.
    const origin = req.headers.origin
    if (origin !== undefined && origin !== 'null') return plain(res, 403, 'Browser access is not allowed')
    if (!this.authorized(req.headers.authorization)) {
      return plain(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="Studio"' })
    }

    let body: unknown
    if (req.method === 'POST') {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return plain(res, 413, 'Request too large')
      let text: string
      try {
        text = await readBody(req)
      } catch (err) {
        if (err instanceof BodyTooLarge) return plain(res, 413, 'Request too large', { Connection: 'close' })
        throw err
      }
      try {
        body = JSON.parse(text)
      } catch {
        return rpcError(res, 400, -32700, 'Parse error')
      }
    } else if (req.method !== 'GET' && req.method !== 'DELETE') {
      return plain(res, 405, 'Method not allowed', { Allow: 'GET, POST, DELETE' })
    }

    const header = req.headers['mcp-session-id']
    const sessionId = Array.isArray(header) ? header[0] : header
    let session: AgentSession | undefined
    if (sessionId) {
      session = this.sessions.get(sessionId)
      // MCP clients start a new session when theirs is unknown (e.g. after Studio restarted).
      if (!session) return rpcError(res, 404, -32001, 'Session not found')
    } else if (req.method === 'POST' && isInitialize(body)) {
      const name = req.headers['x-studio-agent-name']
      session = await this.start(normalizeAddress(peer), typeof name === 'string' ? name.trim().slice(0, 60) : undefined)
      session.protocolVersion = requestedVersion(body)
    } else {
      return rpcError(res, 400, -32000, 'Bad Request: No valid session ID provided')
    }

    session.lastSeen = Date.now()
    const version = req.headers['mcp-protocol-version']
    if (typeof version === 'string' && version) session.protocolVersion = version
    await session.transport!.handleRequest(req, res, body)
    if (!sessionId && !session.id) {
      // The initialize was refused; nothing refers to this session.
      await session.mcp?.close().catch(() => {})
    }
  }

  /** A new session for a client's initialize request. */
  private async start(address: string, name: string | undefined): Promise<AgentSession> {
    const session = new AgentSession(address, name)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: MAX_BODY_BYTES,
      onsessioninitialized: (id) => {
        session.id = id
        this.sessions.set(id, session)
        this.evictOverflow()
        this.opts.onSessionsChanged()
      },
      // The client ended its session (HTTP DELETE).
      onsessionclosed: (id) => void this.drop(id)
    })
    transport.onclose = () => {
      if (session.id) void this.drop(session.id)
    }
    session.transport = transport
    session.mcp = this.opts.createMcpServer(session)
    await session.mcp.connect(transport)
    return session
  }

  private async drop(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    session.closed = true
    this.sessions.delete(id)
    this.opts.onSessionsChanged()
    await session.mcp?.close().catch((err: unknown) => console.warn('Closing an agent session failed:', err))
  }

  private evictOverflow(): void {
    const overflow = this.sessions.size - MAX_SESSIONS
    if (overflow <= 0) return
    const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, overflow)
    for (const s of oldest) if (s.id) void this.drop(s.id)
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_SESSION_MS
    for (const [id, s] of this.sessions) if (s.lastSeen < cutoff) void this.drop(id)
  }
}
