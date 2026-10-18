import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { AgentClientInfo } from '@shared/types'
import { isAllowedPeer, LOOPBACK, normalizeAddress } from './network'

// The agent connection's HTTP side: MCP over Streamable HTTP at /mcp, one transport and MCP server per client
// session, and PUT /uploads/<id> for the raw bytes of a file an agent announced with begin_upload. Only this Mac and
// the tailnet get in, only with Studio's bearer token, and never a web page.

export const MCP_PATH = '/mcp'
/** Tool calls are small; anything bigger than this is refused unread. */
export const MAX_BODY_BYTES = 1024 * 1024
/** An /mcp request body must have arrived within this long (the server itself has no overall limit: PUTs are long). */
const BODY_TIMEOUT_MS = 60_000
/** How long a connection answered mid-upload may still drain the client's bytes before it is closed for good. */
const LINGER_MS = 2000
/** Where an upload's bytes go: /uploads/<upload id>. */
export const UPLOAD_PATH = /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** What the server needs of the upload store for PUT /uploads/<id> (agent/uploads.ts). */
export interface UploadReceiver {
  /** Undefined when a PUT of `length` bytes from `peer` may start, else its status and reason. */
  checkPut(id: string, peer: string, length: number): Promise<{ status: number; error: string } | undefined>
  /** Reads the body into the upload and answers with the status and JSON body to send. */
  receive(id: string, req: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }>
}
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
  /**
   * "http://<host>:<port>" as the client reached Studio (the Host of its initialize request, when that names an
   * address Studio listens on or its MagicDNS name), for the put_url of its uploads; undefined when unknown.
   */
  baseUrl: string | undefined

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
  /** Takes the bytes of PUT /uploads/<id>; without it that path is unknown. */
  uploads?: UploadReceiver
  /** Names this Mac answers to besides its addresses (its MagicDNS name), for a session's base URL. */
  hostNames?: () => string[]
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
class BodyTimeout extends Error {}

/**
 * Reads the request body, refusing more than MAX_BODY_BYTES; a body that hasn't arrived within BODY_TIMEOUT_MS
 * ends the request (the socket is destroyed, there is no one left to answer).
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      reject(new BodyTimeout())
      req.destroy()
    }, BODY_TIMEOUT_MS)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer)
        reject(new BodyTooLarge())
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** A JSON answer (the upload route speaks JSON both ways). */
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers
  })
  res.end(text)
}

/** "host" and "port" of a Host header ("127.0.0.1:8787", "[fd7a::1]:8787", "<your-mac>.<tailnet>.ts.net:8787"). */
function splitHost(header: string | undefined): { host: string; port?: number } | undefined {
  if (!header) return undefined
  const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(header.trim())
  if (!m) return undefined
  return { host: (m[1] ?? m[2]).toLowerCase(), ...(m[3] ? { port: Number(m[3]) } : {}) }
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
      const serve = (req: IncomingMessage, res: ServerResponse, expectContinue: boolean): void => {
        this.handle(req, res, expectContinue).catch((err: unknown) => {
          console.error('Agent request failed:', err)
          if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error')
          else res.end()
        })
      }
      const server = createServer((req, res) => serve(req, res, false))
      // With a listener, Node hands requests that send "Expect: 100-continue" (curl -T of a larger file) here instead
      // of answering "100 Continue" on its own: the client only starts sending once every check has passed.
      server.on('checkContinue', (req, res) => serve(req, res, true))
      // No overall limit: an upload of a large video takes long. /mcp bodies have their own 60 s (readBody), a PUT
      // its idle and total timeouts (uploads.ts); headers must still arrive within 20 s.
      server.requestTimeout = 0
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

  private async handle(req: IncomingMessage, res: ServerResponse, expectContinue = false): Promise<void> {
    const peer = req.socket.remoteAddress
    const path = (req.url ?? '/').split('?')[0]
    const upload = UPLOAD_PATH.exec(path)
    // A refused upload (or a request still waiting for "100 Continue") must never be read: the connection is closed
    // once the answer is out, so a refused 4 GB body isn't taken in just to be thrown away.
    const closing = !!upload || req.method === 'PUT' || expectContinue
    const refuse = (status: number, text: string, headers: Record<string, string> = {}): void => {
      if (closing) this.closeAfter(req, res)
      plain(res, status, text, closing ? { ...headers, Connection: 'close' } : headers)
    }
    if (!isAllowedPeer(peer, req.socket.localAddress)) return refuse(403, 'Forbidden')
    if (path !== MCP_PATH && !upload) return refuse(404, 'Not found')
    // Browsers always say where a request comes from; agents don't. No web page gets to talk to Studio.
    const origin = req.headers.origin
    if (origin !== undefined && origin !== 'null') return refuse(403, 'Browser access is not allowed')
    if (!this.authorized(req.headers.authorization)) {
      return refuse(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="Studio"' })
    }
    if (upload) return this.handleUpload(req, res, upload[1], normalizeAddress(peer), expectContinue)

    let body: unknown
    if (req.method === 'POST') {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuse(413, 'Request too large')
      // Every check this request can fail before its body has passed: the client may send it now.
      if (expectContinue) res.writeContinue()
      let text: string
      try {
        text = await readBody(req)
      } catch (err) {
        if (err instanceof BodyTooLarge) return plain(res, 413, 'Request too large', { Connection: 'close' })
        // The socket is gone already: nobody to answer.
        if (err instanceof BodyTimeout) return
        throw err
      }
      try {
        body = JSON.parse(text)
      } catch {
        return rpcError(res, 400, -32700, 'Parse error')
      }
    } else if (req.method !== 'GET' && req.method !== 'DELETE') {
      return refuse(405, 'Method not allowed', { Allow: 'GET, POST, DELETE' })
    } else if (expectContinue) {
      res.writeContinue()
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
      session.baseUrl = this.baseUrlFor(req.headers.host)
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

  /**
   * PUT /uploads/<id>: same peer, Origin and token checks as /mcp (done by handle), then PUT only, a declared length
   * that matches what begin_upload said (no chunked bodies), and an upload that is waiting for its bytes from this
   * very machine. Only then is "100 Continue" sent and the body read.
   */
  private async handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    peer: string,
    expectContinue: boolean
  ): Promise<void> {
    const refuse = (status: number, error: string, headers: Record<string, string> = {}): void => {
      this.closeAfter(req, res)
      json(res, status, { error }, { ...headers, Connection: 'close' })
    }
    if (req.method !== 'PUT') return refuse(405, 'Only PUT is accepted here.', { Allow: 'PUT' })
    const uploads = this.opts.uploads
    if (!uploads) return refuse(404, 'Unknown upload.')
    if (req.headers['transfer-encoding'] !== undefined) {
      return refuse(411, 'Send the file with Content-Length (not chunked), as curl -T does.')
    }
    const header = req.headers['content-length']
    if (header === undefined) return refuse(411, 'Content-Length is missing.')
    const length = Number(header)
    if (!/^\d+$/.test(header) || !Number.isSafeInteger(length)) return refuse(400, "Content-Length can't be read.")
    const problem = await uploads.checkPut(id, peer, length)
    if (problem) return refuse(problem.status, problem.error)
    // Nothing may wait between the check and receive(), which marks the upload as sending.
    if (expectContinue) res.writeContinue()
    const answer = await uploads.receive(id, req)
    if (answer.status >= 400) {
      // The client may still be sending (a transfer Studio stopped): the answer goes out first, and the connection
      // closes once it has been read rather than resetting under it.
      this.lingerClose(req, res)
      return json(res, answer.status, answer.body, { Connection: 'close' })
    }
    json(res, answer.status, answer.body)
  }

  /**
   * Ends the connection after an answer sent while the request body may still be arriving: our side is closed once
   * the answer is out and what still comes in is discarded unread, so the client reads the answer instead of a reset;
   * the socket goes when the client closes, or after LINGER_MS.
   */
  private lingerClose(req: IncomingMessage, res: ServerResponse): void {
    const socket = req.socket
    const destroy = (): void => {
      clearTimeout(timer)
      socket.destroy()
    }
    let timer: NodeJS.Timeout | undefined
    res.once('finish', () => {
      req.resume()
      socket.end()
      timer = setTimeout(destroy, LINGER_MS)
      timer.unref?.()
      socket.once('close', () => clearTimeout(timer))
    })
    res.once('close', () => {
      if (!res.writableFinished) destroy()
    })
  }

  /** Destroys the connection once the answer has gone out (or at once, if it never can). */
  private closeAfter(req: IncomingMessage, res: ServerResponse): void {
    const destroy = (): void => {
      req.socket.destroy()
    }
    res.once('finish', destroy)
    res.once('close', destroy)
  }

  /**
   * "http://<host>:<port>" for a session, from the Host its initialize request named: an address Studio listens on,
   * "localhost" (as 127.0.0.1, which Studio listens on) or one of its names, on Studio's own port. Anything else is
   * not trusted to lead back here (a proxy, a made-up name), and the agent gets only put_path then.
   */
  private baseUrlFor(header: string | undefined): string | undefined {
    const parsed = splitHost(header)
    if (!parsed || parsed.port !== this.port) return undefined
    const listening = this.hosts()
    let host = parsed.host
    if (host === 'localhost' && listening.includes(LOOPBACK)) host = LOOPBACK
    const names = (this.opts.hostNames?.() ?? []).map((n) => n.toLowerCase())
    if (!listening.includes(host) && !names.includes(host)) return undefined
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.port}`
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
