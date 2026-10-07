import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { app, BrowserWindow } from 'electron'
import type { AgentStatus, ApprovalRequest } from '@shared/types'
import {
  getAgentSettings,
  getAgentToken,
  getPromptLanguage,
  regenerateAgentToken,
  setAgentEnabledSetting,
  setAgentPortSetting
} from '../settings'
import { ActivityLog } from './activity'
import { ApprovalStore } from './approvals'
import { FormBridge } from './bridge'
import { serverInstructions } from './guide'
import { LOOPBACK, magicDnsName, tailscaleAddresses } from './network'
import { AgentServer, type AgentSession, type ListenResult } from './server'
import { registerAgentTools } from './tools'

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
}

function listenError(port: number, failure: ListenResult['failures'][number] | undefined): string | undefined {
  if (!failure) return undefined
  const { host, error } = failure
  if (host !== LOOPBACK) {
    return `Studio kunde inte lyssna på Tailscale-adressen ${host} (${error.code ?? error.message}). Agenter på andra datorer når inte Studio just nu.`
  }
  if (error.code === 'EADDRINUSE') return `Port ${port} används redan av ett annat program. Välj en annan port.`
  if (error.code === 'EACCES') return `Studio fick inte öppna port ${port}. Välj en annan port.`
  return `Agentanslutningen kunde inte startas: ${error.message}`
}

export class AgentService {
  readonly activity: ActivityLog
  readonly approvals: ApprovalStore
  readonly bridge: FormBridge
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
    this.approvals = new ApprovalStore((request, created) => this.onApproval(request, created))
    this.bridge = new FormBridge()
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
        await this.stop('Agentanslutningen stängdes av.')
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
   * "Sök igen" / "Försök igen" in Settings: looks for Tailscale again, or starts a server that couldn't start.
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
    this.approvals.expireAll('Token byttes, så förfrågan gäller inte längre.')
    await this.server?.closeSessions()
    this.pushStatus()
    return this.token
  }

  /** A library was opened (at start or after a switch): requests made for the previous one no longer apply. */
  libraryOpened(): void {
    this.approvals.expireAll('Biblioteket byttes, så förfrågan gäller inte längre.')
  }

  /** On quit. */
  shutdown(): void {
    clearInterval(this.tailscaleTimer)
    clearTimeout(this.statusTimer)
    this.bridge.cancelAll()
    this.approvals.dispose()
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
      onSessionsChanged: () => this.pushStatus()
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
    if (reason) this.approvals.expireAll(reason)
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
      { name: 'studio', title: 'Studio', version: app.getVersion() },
      { instructions: serverInstructions(getPromptLanguage()) }
    )
    registerAgentTools(mcp, {
      bridge: this.bridge,
      approvals: this.approvals,
      promptLanguage: getPromptLanguage,
      clientName: () => session.name,
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
      this.activity.record({ client: session.name, tool: 'connect', summary: 'anslöt till Studio', ok: true })
      this.pushStatus()
    }
    return mcp
  }

  private onApproval(request: ApprovalRequest, created: boolean): void {
    this.opts.broadcast('agent:approval', request)
    // A new request while the user is in another app: the Dock icon bounces once (the window shows the dialog).
    if (created && !BrowserWindow.getFocusedWindow()) {
      try {
        app.dock?.bounce('informational')
      } catch {
        // Only a nudge.
      }
    }
  }
}
