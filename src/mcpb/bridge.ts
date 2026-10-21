// Studio's extension for Claude Desktop (.mcpb, see src/main/claude-desktop.ts): Claude Desktop starts this small stdio
// MCP server with `node server/index.js`, and it forwards every message to Studio's agent connection over Streamable
// HTTP – the address and the token come from the environment (STUDIO_URL, STUDIO_TOKEN: the extension's settings,
// filled in by Studio when it made the file). Bundled into one file by scripts/build-mcpb.mjs; it runs on Claude
// Desktop's own Node.js, on whichever computer Claude Desktop is on.
//
// It is a forwarder, not a second server: Studio's own initialize result (its instructions and capabilities), its
// tools, prompts and resources pass through unchanged. What it adds is what a long-lived stdio server needs when the
// HTTP server behind it comes and goes:
// - Studio not running when Claude Desktop starts: initialize is still answered (Claude Desktop would otherwise give
//   up on the extension until it restarts), the tool list holds only `studio_status`, which says why, and the bridge
//   keeps trying; once Studio answers, Claude Desktop is told that the lists changed.
// - Studio restarted (its sessions are gone): the next request opens a new session and is sent once more; nothing
//   is sent twice that Studio may already have run.
// - A request whose answer never comes because Studio closed mid-call is answered with an error at once.
// - Every failure is an MCP error that says what to do: Studio not running or the connection switched off, a token
//   Studio refuses (it was changed in Studio), an address that isn't Studio's.
// Nothing but MCP messages goes to stdout; the log (stderr) never holds the token.

import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type RequestId
} from '@modelcontextprotocol/sdk/types.js'

/** Studio's version, put in by the build (scripts/build-mcpb.mjs). */
declare const __STUDIO_VERSION__: string
const VERSION = typeof __STUDIO_VERSION__ === 'string' ? __STUDIO_VERSION__ : '0.0.0'

/** The name Studio shows in its activity log and approval dialog (Studio reads the X-Studio-Agent-Name header). */
const AGENT_NAME = 'Claude'
/** How long initialize waits for Studio before it is answered without it (the session is still opened later). */
const INITIALIZE_WAIT_MS = 8_000
/** How long the bridge's own requests to Studio (its initialize) may take. */
const INTERNAL_REQUEST_MS = 20_000
/** While Claude Desktop has no tools from Studio: the first retry, and the longest wait between retries. */
const RETRY_FIRST_MS = 2_000
const RETRY_MAX_MS = 30_000
/** A POST's event stream that ended without its answer: how long to wait for an answer still on its way. */
const ANSWER_GRACE_MS = 250
/** JSON-RPC error code for "Studio can't be reached or refused us" (implementation-defined server error range). */
const UNAVAILABLE = -32000

/** The one tool offered while Studio can't be reached: Claude can call it to learn why. */
const STATUS_TOOL = {
  name: 'studio_status',
  title: 'Studio connection',
  description:
    "Studio's tools aren't available right now because Studio can't be reached. Call this to find out why and what " +
    'the user can do; once Studio answers, its tools appear in place of this one.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false }
}

const log = (message: string): void => {
  process.stderr.write(`[studio] ${message}\n`)
}
/** STUDIO_BRIDGE_DEBUG=1 also logs every retry (they are quiet otherwise: Claude Desktop keeps the log for long). */
const debug = (message: string): void => {
  if (process.env.STUDIO_BRIDGE_DEBUG === '1') log(message)
}

const THIS_COMPUTER =
  process.platform === 'darwin' ? 'this Mac' : process.platform === 'win32' ? 'this PC' : 'this computer'

// ── Configuration ────────────────────────────────────────────────────────────

export interface BridgeConfig {
  url: URL
  token: string
}

/** A value Claude Desktop left unfilled ("${user_config.x}" stays as it is when the setting has no value). */
const unset = (value: string | undefined): boolean => !value || !value.trim() || value.includes('${')

/**
 * Reads STUDIO_URL and STUDIO_TOKEN. Lenient with what a person may paste into the extension's settings: an address
 * without "http://" or without "/mcp", a token with "Bearer " in front. Gives the problem instead when one is missing.
 */
export function readConfig(env: NodeJS.ProcessEnv): { config?: BridgeConfig; problem?: string } {
  const where = "Add Studio to Claude Desktop again from Studio's Settings → Agent connection"
  const rawUrl = env.STUDIO_URL
  if (unset(rawUrl)) {
    return { problem: `The extension has no address for Studio. ${where}, or enter the address shown there in this extension's settings in Claude Desktop.` }
  }
  let text = rawUrl!.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { problem: `“${rawUrl!.trim()}” isn't an address Studio can be reached at. ${where}, or correct it in this extension's settings.` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: `Studio is reached over http, not ${url.protocol.replace(/:$/, '')}. ${where}.` }
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp'
  const rawToken = env.STUDIO_TOKEN
  if (unset(rawToken)) {
    return { problem: `The extension has no token for Studio. ${where}, or paste the token from there into this extension's settings in Claude Desktop.` }
  }
  const token = rawToken!.trim().replace(/^Bearer\s+/i, '')
  return { config: { url, token } }
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Connection errors where the request never reached Studio (so sending it again can't run it twice). */
const NEVER_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT'
])

/** The system error code behind a failed fetch ("fetch failed" → cause.code, or the first of an AggregateError). */
export function networkCode(err: unknown): string | undefined {
  let e: unknown = err
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const o = e as { code?: unknown; cause?: unknown; errors?: unknown[] }
    if (typeof o.code === 'string') return o.code
    e = o.cause ?? (Array.isArray(o.errors) ? o.errors[0] : undefined)
  }
  return undefined
}

const httpStatus = (err: unknown): number | undefined =>
  err instanceof StreamableHTTPError && typeof err.code === 'number' && err.code > 0 ? err.code : undefined

/** Problems only the user can fix (a token or an address that is wrong): retrying won't help. */
const isFatal = (err: unknown): boolean => [401, 403, 404, 405, 406].includes(httpStatus(err) ?? 0)

/** What went wrong, for the user: what Claude shows when a request fails. */
export function describe(err: unknown, url: URL): string {
  if (err instanceof StudioStopped) return err.message
  const host = url.host
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const status = httpStatus(err)
  if (status === 401) {
    return (
      'Studio refused the token (401 Unauthorized) – it was probably changed in Studio. Add Studio to Claude Desktop ' +
      "again from Studio's Settings → Agent connection, or paste the current token into this extension's settings " +
      'in Claude Desktop.'
    )
  }
  if (status === 403) {
    return (
      `Studio at ${host} refused the connection (403 Forbidden). Studio only accepts agents on its own computer and ` +
      "on computers in your tailnet: check the address against Studio's Settings → Agent connection → Addresses."
    )
  }
  if (status === 404 || status === 405 || status === 406) {
    return `Nothing at ${url.href} answers as Studio (${status}). Check the address against Studio's Settings → Agent connection → Addresses; it ends in /mcp.`
  }
  const code = networkCode(err)
  if (code && (NEVER_SENT.has(code) || code === 'ECONNRESET' || code.startsWith('UND_ERR'))) {
    const toggle = 'Settings → Agent connection → Allow agents to connect is on'
    const check = local
      ? `Make sure Studio is running on ${THIS_COMPUTER} and that ${toggle}.`
      : `Make sure Studio is running on the computer at ${url.hostname}, that ${toggle} there, and that ` +
        `${THIS_COMPUTER} is connected to your tailnet (Tailscale).`
    return `Studio isn't reachable at ${host}. ${check} Claude can use Studio again as soon as it answers.`
  }
  const message = err instanceof Error ? err.message : String(err)
  return `Studio couldn't be reached at ${host}: ${message}`
}

class StudioStopped extends Error {
  constructor() {
    super('Studio stopped answering before the request was finished – it may have been closed. Try again once Studio is running.')
  }
}

/** A request Studio answered with an error (e.g. initialize refused): passed on as it is. */
class RpcError extends Error {
  constructor(readonly error: { code: number; message: string; data?: unknown }) {
    super(error.message)
  }
}

// ── Messages ─────────────────────────────────────────────────────────────────

type Message = JSONRPCMessage & { id?: RequestId; method?: string; params?: Record<string, unknown> }
type Request = Message & { id: RequestId; method: string }

const isRequest = (m: Message): m is Request => typeof m.method === 'string' && m.id !== undefined
const isNotification = (m: Message): boolean => typeof m.method === 'string' && m.id === undefined
const isResponse = (m: Message): boolean => m.method === undefined && m.id !== undefined

/** The id of the JSON-RPC request in a POST body, when it is one. */
function requestIdOf(body: unknown): RequestId | undefined {
  if (typeof body !== 'string') return undefined
  try {
    const m = JSON.parse(body) as Message
    return m && typeof m === 'object' && isRequest(m) ? m.id : undefined
  } catch {
    return undefined
  }
}

/** Calls `onEnd` once the stream has ended, normally or not; its bytes pass through untouched. */
function watchStream(body: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    onEnd()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          controller.close()
          end()
        } else controller.enqueue(value)
      } catch (err) {
        controller.error(err)
        end()
      }
    },
    cancel(reason) {
      end()
      return reader.cancel(reason)
    }
  })
}

// ── The bridge ───────────────────────────────────────────────────────────────

interface Session {
  transport: StreamableHTTPClientTransport
  /** Studio's answer to the session's initialize. */
  init: Record<string, unknown>
}

interface InitParams {
  protocolVersion: string
  capabilities: Record<string, unknown>
  clientInfo: { name: string; version: string; [k: string]: unknown }
}

export interface BridgeOptions {
  /** Where messages from Claude Desktop come in and answers go out (stdio unless a test gives its own). */
  client?: { start(): Promise<void>; send(m: JSONRPCMessage): Promise<void>; onmessage?: (m: JSONRPCMessage) => void; onerror?: (e: Error) => void; onclose?: () => void; close(): Promise<void> }
}

export class Bridge {
  private readonly client: NonNullable<BridgeOptions['client']>
  private session: Session | undefined
  private connecting: Promise<Session> | undefined
  /** Sessions opened so far: a new one after the first means Claude Desktop's lists may be out of date. */
  private sessionsOpened = 0
  /** What Claude Desktop asked for in its initialize (sent to Studio again for every new session). */
  private initParams: InitParams | undefined
  /** Claude Desktop got an answer without Studio (the status tool, empty lists): tell it when Studio is back. */
  private listsStale = false
  /** Requests from Claude Desktop sent to Studio and not answered yet, with the transport they went on. */
  private readonly pending = new Map<RequestId, StreamableHTTPClientTransport>()
  /** Studio's requests to Claude Desktop (rare), by id, so the answer goes back on the same session. */
  private readonly fromStudio = new Map<RequestId, StreamableHTTPClientTransport>()
  /** The bridge's own requests to Studio (each session's initialize). */
  private readonly internal = new Map<RequestId, { resolve: (r: Record<string, unknown>) => void; reject: (e: unknown) => void }>()
  private internalId = 0
  private retryTimer: NodeJS.Timeout | undefined
  private retryDelay = RETRY_FIRST_MS
  private closing = false

  constructor(
    private readonly config: BridgeConfig | undefined,
    /** Why there is no config (STUDIO_URL or STUDIO_TOKEN missing): every request says so. */
    private readonly problem: string | undefined,
    options: BridgeOptions = {}
  ) {
    this.client = options.client ?? new StdioServerTransport()
  }

  async start(): Promise<void> {
    this.client.onmessage = (m) => void this.fromClient(m as Message).catch((err) => log(`Handling a message failed: ${String(err)}`))
    this.client.onerror = (err) => log(`Claude Desktop's side: ${err.message}`)
    await this.client.start()
    log(this.config ? `forwarding to Studio at ${this.config.url.href}` : `not configured: ${this.problem}`)
  }

  /** Ends the session with Studio (so its agent indicator updates at once) and stops. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    clearTimeout(this.retryTimer)
    const session = this.session
    this.session = undefined
    if (session) {
      await Promise.race([session.transport.terminateSession().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
      await session.transport.close().catch(() => {})
    }
    await this.client.close().catch(() => {})
  }

  // ── From Claude Desktop ──

  private async fromClient(m: Message): Promise<void> {
    if (isRequest(m)) {
      if (m.method === 'initialize') return this.initialize(m)
      // Claude Desktop asks whether the extension is alive: it is, whether or not Studio is.
      if (m.method === 'ping') return this.reply(m.id, {})
      if (m.method === 'tools/call' && (m.params as { name?: unknown } | undefined)?.name === STATUS_TOOL.name) {
        return this.statusToolCall(m)
      }
      return this.forward(m)
    }
    if (isNotification(m)) {
      // Each Studio session got its own "initialized" when it was opened.
      if (m.method === 'notifications/initialized') return
      if (m.method === 'notifications/cancelled') {
        const id = (m.params as { requestId?: RequestId } | undefined)?.requestId
        const transport = id !== undefined ? this.pending.get(id) : this.session?.transport
        if (id !== undefined) this.pending.delete(id)
        if (transport) await transport.send(m).catch(() => {})
        return
      }
      if (this.session) await this.session.transport.send(m).catch((err) => log(`Couldn't pass on ${m.method}: ${String(err)}`))
      return
    }
    if (isResponse(m)) {
      // Claude Desktop's answer to a request from Studio.
      const transport = this.fromStudio.get(m.id!)
      this.fromStudio.delete(m.id!)
      if (transport) await transport.send(m).catch((err) => log(`Couldn't pass on an answer to Studio: ${String(err)}`))
    }
  }

  private async initialize(m: Request): Promise<void> {
    const params = (m.params ?? {}) as Partial<InitParams>
    this.initParams = {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
      capabilities: params.capabilities ?? {},
      clientInfo: params.clientInfo ?? { name: 'claude-desktop', version: '0' }
    }
    const opening = this.ensureSession()
    try {
      const session = await Promise.race([
        opening,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), INITIALIZE_WAIT_MS).unref())
      ])
      return this.reply(m.id, session.init)
    } catch (err) {
      // Answered without Studio: Claude Desktop keeps the extension, and hears when Studio's tools are there.
      log(`Studio isn't available yet: ${this.reason(err)}`)
      this.listsStale = true
      this.retryLater(err)
      return this.reply(m.id, this.initResultWithoutStudio())
    }
  }

  /** The initialize answer while Studio can't be reached: the capabilities Studio has, and a word on why. */
  private initResultWithoutStudio(): Record<string, unknown> {
    const requested = this.initParams?.protocolVersion ?? LATEST_PROTOCOL_VERSION
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true }
      },
      serverInfo: { name: 'studio', title: 'Studio', version: VERSION },
      instructions:
        "Studio is the user's desktop video studio. It can't be reached right now, so its tools aren't available yet; " +
        'the studio_status tool says why. Once Studio answers, its tools appear: call get_studio_guide once before ' +
        'you start working in it.'
    }
  }

  private async statusToolCall(m: Request): Promise<void> {
    try {
      const session = await this.ensureSession()
      const info = session.init.serverInfo as { version?: string } | undefined
      return this.reply(m.id, {
        content: [
          {
            type: 'text',
            text: `Studio${info?.version ? ` ${info.version}` : ''} is connected at ${this.config!.url.host}; its tools are available now.`
          }
        ]
      })
    } catch (err) {
      return this.reply(m.id, { content: [{ type: 'text', text: this.reason(err) }], isError: true })
    }
  }

  /**
   * Sends a request to Studio; its answer comes back through onmessage. A session Studio no longer knows (it was
   * restarted) or a connection refused before anything was sent gets one more try on a new session.
   */
  private async forward(m: Request): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let session: Session
      try {
        session = await this.ensureSession()
      } catch (err) {
        return this.answerWithoutStudio(m, err)
      }
      const transport = session.transport
      this.pending.set(m.id, transport)
      try {
        await transport.send(m)
        return
      } catch (err) {
        this.pending.delete(m.id)
        const sessionGone = httpStatus(err) === 404 && !!transport.sessionId
        const neverSent = NEVER_SENT.has(networkCode(err) ?? '')
        if (sessionGone || neverSent || httpStatus(err) === 401) this.dropSession(transport)
        if (attempt === 0 && (sessionGone || neverSent)) continue
        return this.replyError(m.id, this.reason(err))
      }
    }
  }

  /** A request that couldn't reach Studio: the lists say what there is (only the status tool), the rest is an error. */
  private answerWithoutStudio(m: Request, err: unknown): Promise<void> {
    const lists: Record<string, Record<string, unknown>> = {
      'tools/list': { tools: [STATUS_TOOL] },
      'prompts/list': { prompts: [] },
      'resources/list': { resources: [] },
      'resources/templates/list': { resourceTemplates: [] }
    }
    const list = lists[m.method]
    if (list) {
      this.listsStale = true
      this.retryLater(err)
      return this.reply(m.id, list)
    }
    return this.replyError(m.id, this.reason(err))
  }

  // ── Studio's side ──

  /** The session with Studio, opening one when there is none (one attempt at a time). */
  private ensureSession(): Promise<Session> {
    if (this.session) return Promise.resolve(this.session)
    if (!this.config) return Promise.reject(new Error(this.problem))
    this.connecting ??= this.openSession(this.config).finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private async openSession(config: BridgeConfig): Promise<Session> {
    const transport = new StreamableHTTPClientTransport(config.url, {
      requestInit: { headers: { Authorization: `Bearer ${config.token}`, 'X-Studio-Agent-Name': AGENT_NAME } },
      fetch: (url, init) => this.fetchWatched(url, init)
    })
    transport.onmessage = (m) => this.fromStudioMessage(transport, m as Message)
    transport.onerror = (err) => {
      // Studio going away shows up here first (its event stream breaks); the next request finds out for sure.
      if (transport === this.session?.transport) log(`Studio's connection: ${err.message}`)
    }
    await transport.start()
    try {
      const params = this.initParams ?? {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'claude-desktop', version: '0' }
      }
      const init = await this.internalRequest(transport, 'initialize', params)
      if (typeof init.protocolVersion === 'string') transport.setProtocolVersion(init.protocolVersion)
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const session: Session = { transport, init }
      this.session = session
      this.sessionsOpened++
      this.retryDelay = RETRY_FIRST_MS
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      log(`connected to Studio ${(init.serverInfo as { version?: string } | undefined)?.version ?? ''} at ${config.url.host}`)
      // Claude Desktop's lists came from no Studio, or from an earlier session (Studio may have been updated since).
      if (this.initParams && (this.listsStale || this.sessionsOpened > 1)) {
        this.listsStale = false
        for (const kind of ['tools', 'prompts', 'resources']) {
          await this.client.send({ jsonrpc: '2.0', method: `notifications/${kind}/list_changed` }).catch(() => {})
        }
      }
      return session
    } catch (err) {
      await transport.close().catch(() => {})
      throw err
    }
  }

  private dropSession(transport: StreamableHTTPClientTransport): void {
    if (this.session?.transport !== transport) return
    this.session = undefined
    void transport.close().catch(() => {})
  }

  /** The bridge's own request to Studio on a session being opened. */
  private internalRequest(
    transport: StreamableHTTPClientTransport,
    method: string,
    params: unknown
  ): Promise<Record<string, unknown>> {
    const id = `studio-bridge-${++this.internalId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internal.delete(id)
        reject(new Error(`Studio didn't answer ${method} within ${INTERNAL_REQUEST_MS / 1000} s.`))
      }, INTERNAL_REQUEST_MS)
      timer.unref()
      const settle = <T>(fn: (v: T) => void) => (v: T): void => {
        clearTimeout(timer)
        this.internal.delete(id)
        fn(v)
      }
      this.internal.set(id, { resolve: settle(resolve), reject: settle(reject) })
      transport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage).catch((err) => this.internal.get(id)?.reject(err))
    })
  }

  private fromStudioMessage(transport: StreamableHTTPClientTransport, m: Message): void {
    if (isResponse(m)) {
      const own = this.internal.get(m.id!)
      if (own) {
        const error = (m as { error?: { code: number; message: string } }).error
        return error ? own.reject(new RpcError(error)) : own.resolve((m as { result: Record<string, unknown> }).result)
      }
      // Only answers Claude Desktop still waits for (not one already answered with an error).
      if (!this.pending.has(m.id!)) return
      this.pending.delete(m.id!)
      void this.client.send(m)
      return
    }
    // Requests and notifications only from the current session.
    if (transport !== this.session?.transport) return
    if (isRequest(m)) this.fromStudio.set(m.id, transport)
    void this.client.send(m)
  }

  /**
   * fetch for the transport: a POST's event stream that ends without the answer to its request (Studio closed in
   * the middle of a call) has that request answered with an error, rather than leaving Claude Desktop waiting.
   */
  private async fetchWatched(url: string | URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init)
    const id = init?.method === 'POST' ? requestIdOf(init.body) : undefined
    const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    if (id === undefined || !response.ok || !response.body || !sse) return response
    const body = watchStream(response.body, () => {
      setTimeout(() => this.streamEnded(id), ANSWER_GRACE_MS).unref()
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  private streamEnded(id: RequestId): void {
    const own = this.internal.get(id)
    if (own) return own.reject(new StudioStopped())
    const transport = this.pending.get(id)
    if (!transport) return
    this.pending.delete(id)
    this.dropSession(transport)
    void this.replyError(id, new StudioStopped().message)
  }

  /** While Claude Desktop has no tools from Studio: keep trying, less often over time, until Studio answers. */
  private retryLater(err: unknown): void {
    if (this.retryTimer || this.closing || !this.config || isFatal(err)) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.session || !this.listsStale) return
      debug('retrying')
      this.ensureSession().catch((e: unknown) => {
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
        debug(`still not available (${this.reason(e).slice(0, 60)}…); next try in ${this.retryDelay / 1000} s`)
        this.retryLater(e)
      })
    }, this.retryDelay)
  }

  // ── Answers to Claude Desktop ──

  private reason(err: unknown): string {
    if (!this.config) return this.problem ?? 'The extension is not configured.'
    if (err instanceof RpcError) return `Studio refused: ${err.message}`
    return describe(err, this.config.url)
  }

  private reply(id: RequestId, result: Record<string, unknown>): Promise<void> {
    return this.client.send({ jsonrpc: '2.0', id, result } as JSONRPCMessage)
  }

  private replyError(id: RequestId, message: string): Promise<void> {
    return this.client.send({ jsonrpc: '2.0', id, error: { code: UNAVAILABLE, message } } as JSONRPCMessage)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const { config, problem } = readConfig(process.env)
  const bridge = new Bridge(config, problem)
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void bridge.close().finally(() => process.exit(0))
  }
  // Claude Desktop closes stdin (or sends a signal) when it quits or the extension is switched off.
  process.stdin.on('end', stop)
  process.stdin.on('close', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  bridge.start().catch((err: unknown) => {
    log(`Couldn't start: ${String(err)}`)
    process.exit(1)
  })
}

// Run when Claude Desktop starts the bundle; a test importing the module only gets the exports.
if (typeof require !== 'undefined' && require.main === module) main()
