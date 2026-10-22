import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { app, BrowserWindow } from 'electron'
import type { AgentStatus, ApprovalRequest } from '@shared/types'
import { IS_WINDOWS } from '../platform'
import {
  getAgentSettings,
  getAgentToken,
  getPromptLanguage,
  regenerateAgentToken,
  setAgentEnabledSetting,
  setAgentPortSetting
} from '../settings'
import { flashTaskbar } from '../taskbar'
import { ActivityLog } from './activity'
import { ApprovalStore } from './approvals'
import { FormBridge } from './bridge'
import { serverInstructions } from './guide'
import { LOOPBACK, magicDnsName, tailscaleAddresses } from './network'
import { AgentServer, type AgentSession, type ListenResult } from './server'
import { registerAgentTools } from './tools'
import { UploadStore } from './uploads'

// The agent connection as a whole: switched on and off from Settings, listening on this Mac and the tailnet,
// with the activity log, the approval requests and the bridge to the window.

/** How often the Tailscale address is checked while the server runs (Tailscale may start or reconnect later). */
const TAILSCALE_CHECK_MS = 30_000
/** Status updates caused only by clients being active are sent at most this often. */
const ACTIVITY_STATUS_MS = 15_000
/** A MagicDNS name that couldn't be found is looked up again after this long. */
const DNS_RETRY_MS = 60_000
/** The MCP protocol version that introduced audio content in tool results. */
const AUDIO_CONTENT_SINCE = '2025-03-26'

export interface AgentServiceOptions {
  /** Sends an event to every window. */
  broadcast: (channel: string, payload: unknown) => void
  /** Overrides the hosts to listen on (tests); normally 127.0.0.1 plus the Tailscale addresses. */
  hosts?: () => string[]
  /**
   * Work that Activity shows started, moved on or ended without any other broadcast: an upload coming in, an
   * approved request being carried out ('progress': only an upload's bytes moved).
   */
  workChanged?: (kind: 'structure' | 'progress') => void
}

function listenError(port: number, failure: ListenResult['failures'][number] | undefined): string | undefined {
  if (!failure) return undefined
  const { host, error } = failure
  if (host !== LOOPBACK) {
    return `Studio couldn't listen on the Tailscale address ${host} (${error.code ?? error.message}). Agents on other computers can't reach Studio right now.`
  }
  if (error.code === 'EADDRINUSE') return `Port ${port} is already used by another program. Choose another port.`
  if (error.code === 'EACCES') return `Studio wasn't allowed to open port ${port}. Choose another port.`
  return `The agent connection couldn't be started: ${error.message}`
}

export class AgentService {
  readonly activity: ActivityLog
  readonly approvals: ApprovalStore
  readonly bridge: FormBridge
  /** Files agents send (URL, PUT or base64), shared by every session. */
  readonly uploads: UploadStore
  private server: AgentServer | undefined
  private token: string | undefined
  private error: string | undefined
  private dnsName: { address: string; name?: string; checkedAt: number } | undefined
  /** The address whose MagicDNS name is being looked up right now. */
  private dnsLookup: string | undefined
  private tailscaleTimer: NodeJS.Timeout | undefined
  private statusTimer: NodeJS.Timeout | undefined
  private lastActivityStatus = 0
  /** Starts and stops run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: AgentServiceOptions) {
    this.activity = new ActivityLog((entry) => opts.broadcast('agent:activity', entry))
    // An approved request being carried out shows in Activity, which hears of it through workChanged.
    this.approvals = new ApprovalStore(
      (request, created) => this.onApproval(request, created),
      () => opts.workChanged?.('structure')
    )
    this.bridge = new FormBridge()
    this.uploads = new UploadStore({
      notify: (kind) => opts.workChanged?.(kind),
      userAgent: `Studio/${app.getVersion()}`,
      // A fetch or a PUT ends after its tool call answered: the log says how, naming the host (never the URL).
      onSettled: (entry) => {
        const what = entry.kind === 'image' ? 'an image' : entry.kind === 'audio' ? 'a sound' : 'a video'
        const name = `“${entry.fileName}”`
        const summary =
          entry.status === 'ready'
            ? entry.host
              ? `fetched ${what} from ${entry.host} (${name})`
              : `uploaded ${name}`
            : `${entry.host ? `couldn't fetch ${name} from ${entry.host}` : `couldn't receive ${name}`} – ${entry.error ?? 'unknown error'}`
        this.activity.record({ client: entry.client, tool: 'begin_upload', summary, ok: entry.status === 'ready' })
      }
    })
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  status(): AgentStatus {
    const { enabled, port } = getAgentSettings()
    const tailscale = tailscaleAddresses()[0]
    const server = this.server
    const name = this.dnsName && this.dnsName.address === tailscale ? this.dnsName.name : undefined
    // Found in the background; the status is sent again once it is known.
    if (tailscale) void this.lookUpDnsName()
    return {
      enabled,
      running: !!server && server.hosts().length > 0,
      port: server?.port ?? port,
      addresses: server ? server.hosts().map((h) => `${h}:${server.port}`) : [],
      tailscaleAddress: tailscale,
      tailscaleDnsName: name,
      clients: server?.clients() ?? [],
      error: this.error
    }
  }

  /** Sends the status to the windows shortly (several changes at once give one update). */
  private pushStatus(): void {
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined
      this.opts.broadcast('agent:status', this.status())
    }, 200)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** At app start: starts the server if the user switched it on. */
  startIfEnabled(): Promise<void> {
    if (!getAgentSettings().enabled) return Promise.resolve()
    return this.serialized(() => this.start())
  }

  async setEnabled(enabled: boolean): Promise<AgentStatus> {
    setAgentEnabledSetting(enabled)
    await this.serialized(async () => {
      if (!enabled) {
        await this.stop('The agent connection was turned off.')
        this.error = undefined
      } else if (!this.server) {
        this.error = undefined
        await this.start()
      }
    })
    return this.status()
  }

  async setPort(port: number): Promise<AgentStatus> {
    setAgentPortSetting(port)
    await this.serialized(async () => {
      if (!getAgentSettings().enabled) return
      // Clients reconnect on the new port; their pending requests stay.
      await this.stop()
      this.error = undefined
      await this.start()
    })
    this.pushStatus()
    return this.status()
  }

  /**
   * "Search again" / "Try again" in Settings: looks for Tailscale again, or starts a server that couldn't start.
   * Unlike switching the connection off and on, pending requests stay (as when the port changes).
   */
  async restart(): Promise<AgentStatus> {
    await this.serialized(async () => {
      if (!getAgentSettings().enabled) return
      if (this.server) return this.followTailscale()
      this.error = undefined
      await this.start()
    })
    this.pushStatus()
    return this.status()
  }

  getToken(): string {
    this.token = getAgentToken()
    return this.token
  }

  /**
   * A new token: every connected agent is disconnected and needs the new one. What they asked for lapses too:
   * the user may be changing the token because they no longer trust whoever holds the old one.
   */
  async regenerateToken(): Promise<string> {
    this.token = regenerateAgentToken()
    this.approvals.expireAll('The token was changed, so the request no longer applies.')
    this.uploads.expireAll('the token was changed')
    await this.server?.closeSessions()
    this.pushStatus()
    return this.token
  }

  /** A library was opened (at start or after a switch): requests made for the previous one no longer apply. */
  libraryOpened(): void {
    this.approvals.expireAll('The library was switched, so the request no longer applies.')
    // Their files were in the old library's scratch, which opening clears anyway.
    this.uploads.expireAll('the library was switched')
  }

  /**
   * The library is about to be switched or moved: uploads still coming in are stopped and their files removed
   * before the folder goes (a PUT or a fetch writing into a folder being moved would leave a half file behind).
   */
  libraryClosing(): void {
    this.uploads.expireAll('the library was switched or moved')
  }

  /** On quit. */
  shutdown(): void {
    clearInterval(this.tailscaleTimer)
    clearTimeout(this.statusTimer)
    this.bridge.cancelAll()
    this.approvals.dispose()
    this.uploads.dispose()
    void this.server?.close()
    this.server = undefined
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  private hosts(): string[] {
    return this.opts.hosts?.() ?? [LOOPBACK, ...tailscaleAddresses()]
  }

  private async start(): Promise<void> {
    if (this.server) return
    const { port } = getAgentSettings()
    this.token = getAgentToken()
    const server = new AgentServer({
      port,
      token: () => this.token,
      createMcpServer: (session) => this.createMcpServer(session),
      onSessionsChanged: () => this.pushStatus(),
      uploads: this.uploads,
      // An agent that reached Studio by its MagicDNS name gets its upload URLs by that name too.
      hostNames: () => (this.dnsName?.name ? [this.dnsName.name] : [])
    })
    const result = await server.listenOn(this.hosts())
    if (!result.listening.includes(LOOPBACK)) {
      await server.close()
      this.error = listenError(port, result.failures.find((f) => f.host === LOOPBACK) ?? result.failures[0])
      this.pushStatus()
      return
    }
    this.server = server
    this.error = listenError(port, result.failures[0])
    this.tailscaleTimer = setInterval(() => void this.serialized(() => this.followTailscale()), TAILSCALE_CHECK_MS)
    this.tailscaleTimer.unref?.()
    void this.lookUpDnsName()
    this.pushStatus()
  }

  /** Stops listening. With a reason, pending approval requests lapse with it. */
  private async stop(reason?: string): Promise<void> {
    clearInterval(this.tailscaleTimer)
    this.tailscaleTimer = undefined
    const server = this.server
    this.server = undefined
    this.bridge.cancelAll()
    if (reason) {
      this.approvals.expireAll(reason)
      this.uploads.expireAll(reason.replace(/\.$/, '').toLowerCase())
    }
    await server?.close()
    this.pushStatus()
  }

  /** Listens on the Tailscale address it has now (it can appear, change or go away while Studio runs). */
  private async followTailscale(): Promise<void> {
    const server = this.server
    if (!server) return
    const wanted = this.hosts()
    const now = server.hosts()
    if (wanted.length === now.length && wanted.every((h) => now.includes(h))) return
    const result = await server.listenOn(wanted)
    this.error = listenError(server.port, result.failures[0])
    void this.lookUpDnsName()
    this.pushStatus()
  }

  /** This Mac's MagicDNS name for the endpoint URLs; a failed lookup is retried after a minute. */
  private async lookUpDnsName(): Promise<void> {
    const address = tailscaleAddresses()[0]
    if (!address || this.dnsLookup === address) return
    const known = this.dnsName
    if (known?.address === address && (known.name || Date.now() - known.checkedAt < DNS_RETRY_MS)) return
    this.dnsLookup = address
    try {
      const name = await magicDnsName(address).catch(() => undefined)
      this.dnsName = { address, name, checkedAt: Date.now() }
    } finally {
      this.dnsLookup = undefined
    }
    if (this.dnsName.name !== known?.name || address !== known?.address) this.pushStatus()
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private createMcpServer(session: AgentSession): McpServer {
    const mcp = new McpServer(
      { name: 'studio', title: 'JIBES Studio', version: app.getVersion() },
      { instructions: serverInstructions(getPromptLanguage()) }
    )
    registerAgentTools(mcp, {
      bridge: this.bridge,
      approvals: this.approvals,
      uploads: this.uploads,
      promptLanguage: getPromptLanguage,
      clientName: () => session.name,
      peer: () => session.address,
      baseUrl: () => session.baseUrl,
      agentPort: () => this.server?.port ?? getAgentSettings().port,
      // Audio content came with protocol 2025-03-26; older clients would reject a result that has it.
      audioContent: () => !session.protocolVersion || session.protocolVersion >= AUDIO_CONTENT_SINCE,
      // A session that ended (or a server that was stopped) asks the user for nothing more.
      connected: () => !session.closed && !!this.server,
      record: ({ readOnly, ...entry }) => {
        session.lastSeen = Date.now()
        this.activity.record({ client: session.name, ...entry }, readOnly)
        if (Date.now() - this.lastActivityStatus > ACTIVITY_STATUS_MS) {
          this.lastActivityStatus = Date.now()
          this.pushStatus()
        }
      }
    })
    // Sent by the client once it has its answer to initialize; its name is known from then on.
    mcp.server.oninitialized = () => {
      this.activity.record({ client: session.name, tool: 'connect', summary: 'connected to Studio', ok: true })
      this.pushStatus()
    }
    return mcp
  }

  private onApproval(request: ApprovalRequest, created: boolean): void {
    this.opts.broadcast('agent:approval', request)
    // A new request while the user is in another app: the Dock icon bounces once, on Windows the taskbar button
    // flashes until Studio is in front (the window shows the dialog).
    if (created && !BrowserWindow.getFocusedWindow()) {
      try {
        if (IS_WINDOWS) flashTaskbar()
        else app.dock?.bounce('informational')
      } catch {
        // Only a nudge.
      }
    }
  }
}
