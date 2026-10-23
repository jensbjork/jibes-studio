import { useEffect, useState } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import type { AgentStatus } from '@shared/types'
import { refreshAgentStatus, restartAgent, setAgentEnabled, setAgentPort, useAgentState } from '../../lib/agent'
import { ipcErrorMessage } from '../../lib/hooks'
import { COMPUTER, THIS_COMPUTER } from '../../lib/platform'
import { MoreAbout, SaveActions, SettingsItem } from '../settings/SettingsLayout'
import { SwitchRow } from '../settings/Switch'
import { buttonClass } from '../ui/button'
import ConfirmButton from '../ui/ConfirmButton'
import Segmented from '../ui/Segmented'
import { clientDetail, formatTime } from './agentText'
import ClaudeDesktopCard, { ClaudeDesktopFile } from './ClaudeDesktopCard'
import CopyButton from './CopyButton'

const MASK = '•'.repeat(28)
const TOKEN_PLACEHOLDER = '••••••••'
const MIN_PORT = 1024
const MAX_PORT = 65535

const code = 'rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] select-text'

type EndpointId = 'tailscale' | 'dns' | 'local'

interface Endpoint {
  id: EndpointId
  label: string
  /** What an agent connects to: an address or the MagicDNS name (the Claude Desktop extension is made with it). */
  host: string
  url: string
  hint: string
}

function endpointsOf(status: AgentStatus): Endpoint[] {
  const port = status.port
  const list: Endpoint[] = []
  if (status.tailscaleAddress) {
    list.push({
      id: 'tailscale',
      label: 'Tailscale address',
      host: status.tailscaleAddress,
      url: `http://${status.tailscaleAddress}:${port}/mcp`,
      hint: `For agents on other computers in your tailnet, such as a server or another ${COMPUTER}.`
    })
  }
  if (status.tailscaleDnsName) {
    const name = status.tailscaleDnsName.replace(/\.$/, '')
    list.push({
      id: 'dns',
      label: 'Tailscale name',
      host: name,
      url: `http://${name}:${port}/mcp`,
      hint: 'The same, with the computer’s name (MagicDNS) instead of the IP address.'
    })
  }
  list.push({
    id: 'local',
    label: `This ${COMPUTER}`,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${port}/mcp`,
    hint: 'Only for agents running on this computer.'
  })
  return list
}

/**
 * The header Studio reads the agent's name from, for the activity log and the approval dialog; without it
 * Studio shows whatever name the agent's MCP client reports, which can be a generic one.
 */
const AGENT_NAME_HEADER = 'X-Studio-Agent-Name'

/** One line, so it runs in any terminal (macOS' and Windows' continue lines differently). */
function claudeCodeCommand(url: string, token: string): string {
  return (
    `claude mcp add --transport http studio ${url} ` +
    `--header "Authorization: Bearer ${token}" --header "${AGENT_NAME_HEADER}: Claude Code"`
  )
}

function openClawConfig(url: string, token: string): string {
  const server = {
    url,
    transport: 'streamable-http',
    headers: { Authorization: `Bearer ${token}`, [AGENT_NAME_HEADER]: 'OpenClaw' }
  }
  return JSON.stringify({ mcp: { servers: { studio: server } } }, null, 2)
}

function hermesConfig(url: string, token: string): string {
  return [
    'mcp_servers:',
    '  studio:',
    `    url: "${url}"`,
    '    headers:',
    `      Authorization: "Bearer ${token}"`,
    `      ${AGENT_NAME_HEADER}: "Hermes"`
  ].join('\n')
}

/** Who is being connected: Claude Desktop in one click, the others with a configuration to paste. */
type ClientId = 'claude-desktop' | 'claude-code' | 'hermes' | 'openclaw'

const CLIENTS: { value: ClientId; label: string }[] = [
  { value: 'claude-desktop', label: 'Claude Desktop' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'openclaw', label: 'OpenClaw' }
]

/**
 * Settings → Agent connection (the pane's heading and one-line description are SettingsView's): the MCP server the
 * user's own agents (e.g. Claude Desktop, Claude Code, Hermes Agent, OpenClaw) connect to. Off by default; reachable
 * only from this Mac and the tailnet, and only with the token. Off, the pane is the switch and what agents can do;
 * on, how it runs, how to connect an agent, and – folded away under Advanced – the token, the addresses and the port
 * (open by itself when the server couldn't start, since the fix is usually another port).
 */
export default function AgentSettingsSection() {
  const { status, statusError } = useAgentState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [token, setToken] = useState<string>()
  const [revealed, setRevealed] = useState(false)
  const [tokenNotice, setTokenNotice] = useState<string>()
  const [endpointId, setEndpointId] = useState<EndpointId>()
  const [client, setClient] = useState<ClientId>('claude-desktop')
  const failed = !!status?.enabled && !status.running && !!status.error
  const [advancedOpen, setAdvancedOpen] = useState(failed)
  useEffect(() => {
    if (failed) setAdvancedOpen(true)
  }, [failed])

  // Fresh status when Settings opens: Tailscale may have been started or stopped since.
  useEffect(() => {
    void refreshAgentStatus()
  }, [])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /** The token, read from main the first time it is needed (it stays out of the page until then). */
  const loadToken = async (): Promise<string> => {
    if (token) return token
    const t = await window.studio.getAgentToken()
    setToken(t)
    return t
  }

  const toggleReveal = () => {
    if (revealed) return setRevealed(false)
    void run(async () => {
      await loadToken()
      setRevealed(true)
    })
  }

  const regenerate = () =>
    void run(async () => {
      const t = await window.studio.regenerateAgentToken()
      setToken(t)
      setRevealed(true)
      setTokenNotice(
        'New token created. Agents with the old one can no longer get in – give them the new configuration and add ' +
          'Studio to Claude Desktop again.'
      )
    })

  // Detects Tailscale again (or retries starting) without switching the connection off, which would let every
  // request waiting for the user lapse.
  const restart = () => void run(restartAgent)

  /** The port's own save: its outcome shows beside the field (PortField), so it isn't caught here. */
  const savePort = async (port: number): Promise<AgentStatus> => {
    setBusy(true)
    setError(undefined)
    try {
      return await setAgentPort(port)
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return statusError ? (
      <p role="alert" className="text-danger">
        {statusError}
      </p>
    ) : (
      <p className="text-muted">Checking the connection…</p>
    )
  }

  const endpoints = endpointsOf(status)
  const endpoint = endpoints.find((e) => e.id === endpointId) ?? endpoints[0]
  const shownToken = revealed && token ? token : TOKEN_PLACEHOLDER
  const withToken = (build: (url: string, token: string) => string) => async () =>
    build(endpoint.url, await loadToken())

  const switchBox = (
    <div>
      <div className="rounded-lg border border-line bg-raised/40 p-3">
        <SwitchRow
          on={status.enabled}
          disabled={busy}
          onChange={(on) => void run(() => setAgentEnabled(on))}
          label="Allow agents to connect"
          description={`Only from ${THIS_COMPUTER} and your tailnet (Tailscale), with Studio’s token.`}
        />
        {status.enabled && <StatusLines status={status} busy={busy} onRestart={restart} />}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger select-text">
          {error}
        </p>
      )}
      <div className="mt-3">
        <MoreAbout summary="More about what agents can do">
          <p>
            A connected agent can do almost everything you can: create characters, products and other assets, add
            images and sound, write prompts and build sequences and storyboards.
          </p>
          <p>
            Anything that costs money and anything that deletes something it never does on its own: every such
            request waits for your OK here in Studio.
          </p>
          <p>
            MCP is how the agent connects. Studio shows the agent’s name in the log and when it asks for permission –
            or “The agent” when the client only calls itself something generic, like “mcp”.
          </p>
          <p>Other MCP clients send the token as “Authorization: Bearer &lt;token&gt;”.</p>
        </MoreAbout>
      </div>
    </div>
  )

  // Off: nothing to connect to, so nothing about connecting.
  if (!status.enabled) return switchBox

  return (
    <>
      {switchBox}

      <SettingsItem title="Connect an agent">
        <Segmented role="tablist" ariaLabel="Agent" options={CLIENTS} value={client} onChange={setClient} />
        <div className="mt-3">
          {client === 'claude-desktop' ? (
            <ClaudeDesktopCard status={status} />
          ) : (
            <>
              {endpoints.length > 1 && (
                <Segmented
                  label="Address:"
                  ariaLabel="Address"
                  options={endpoints.map((e) => ({ value: e.id, label: e.label, title: e.hint }))}
                  value={endpoint.id}
                  onChange={setEndpointId}
                  className="mb-2.5 text-[12px]"
                />
              )}
              {client === 'claude-code' ? (
                <Snippet
                  hint="Run it in a terminal."
                  text={claudeCodeCommand(endpoint.url, shownToken)}
                  copy={withToken(claudeCodeCommand)}
                />
              ) : client === 'hermes' ? (
                <Snippet
                  hint="Goes in Hermes’ configuration under mcp_servers."
                  text={hermesConfig(endpoint.url, shownToken)}
                  copy={withToken(hermesConfig)}
                />
              ) : (
                <Snippet
                  hint="Goes in OpenClaw’s configuration under mcp.servers."
                  text={openClawConfig(endpoint.url, shownToken)}
                  copy={withToken(openClawConfig)}
                />
              )}
              <p className="mt-3 text-[12px] leading-relaxed text-muted">
                Then ask the agent to start with <span className="font-mono text-text">get_studio_guide</span>.
              </p>
            </>
          )}
        </div>
      </SettingsItem>

      <MoreAbout summary="Advanced: token, addresses, port" plain open={advancedOpen} onToggle={setAdvancedOpen}>
        <div className="space-y-8 pt-3">
          <SettingsItem title="Token" help="Agents need it to connect. Keep it to yourself.">
            <div className="flex items-center gap-2">
              <code className={`min-w-0 flex-1 truncate ${code}`}>{revealed && token ? token : MASK}</code>
              <button type="button" onClick={toggleReveal} disabled={busy} className={buttonClass('secondary', 'sm')}>
                {revealed ? 'Hide' : 'Show'}
              </button>
              <CopyButton text={loadToken} title="Copy the token" />
            </div>
            <div className="mt-1.5">
              <ConfirmButton
                question="Change the token? Connected agents, Claude Desktop included, will need the new one."
                confirmLabel="Change"
                onConfirm={regenerate}
                disabled={busy}
                className="text-[12px] text-muted underline-offset-2 hover:text-text hover:underline disabled:opacity-40"
                armedClassName="inline-flex flex-wrap items-center gap-1.5"
              >
                Change token…
              </ConfirmButton>
            </div>
            {tokenNotice && (
              <p role="status" className="mt-1.5 text-[12px] text-warning">
                {tokenNotice}
              </p>
            )}
          </SettingsItem>

          <SettingsItem title="Addresses" help="Where an agent reaches Studio. Pick the one that fits where it runs.">
            <ul className="space-y-2.5">
              {endpoints.map((e) => (
                <li key={e.id}>
                  <div className="flex items-center gap-2">
                    <code className={`min-w-0 flex-1 truncate ${code}`} title={e.url}>
                      {e.url}
                    </code>
                    <CopyButton text={e.url} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted">
                    <span className="text-text">{e.label}</span> – {e.hint}
                  </p>
                </li>
              ))}
            </ul>
          </SettingsItem>

          <ClaudeDesktopFile
            status={status}
            addresses={endpoints.map(({ id, label, host }) => ({ id, label, host }))}
          />

          <SettingsItem title="Port">
            <PortField port={status.port} disabled={busy} onSave={savePort} />
          </SettingsItem>
        </div>
      </MoreAbout>
    </>
  )
}

function StatusLines({ status, busy, onRestart }: { status: AgentStatus; busy: boolean; onRestart: () => void }) {
  const restartButton = (label: string) => (
    <button
      type="button"
      onClick={onRestart}
      disabled={busy}
      className={`ml-auto shrink-0 ${buttonClass('secondary', 'sm')}`}
    >
      {label}
    </button>
  )
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3 text-[12px]">
      {status.running ? (
        <p className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          Running
        </p>
      ) : (
        <div className="flex items-start gap-2">
          <span
            aria-hidden
            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${status.error ? 'bg-accent' : 'bg-amber-400'}`}
          />
          <span
            role={status.error ? 'alert' : undefined}
            className={`min-w-0 select-text ${status.error ? 'text-danger' : ''}`}
          >
            {status.error ? `Couldn’t start: ${status.error}` : 'Starting…'}
          </span>
          {status.error && restartButton('Try again')}
        </div>
      )}
      {status.running && status.error && <p className="text-warning select-text">{status.error}</p>}

      {status.running && !status.tailscaleAddress && (
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
          <span className="min-w-0 text-warning">Tailscale isn’t running – only {THIS_COMPUTER} can connect.</span>
          {restartButton('Check again')}
        </div>
      )}

      {status.running && (
        <div>
          <p className="text-muted">{status.clients.length ? 'Connected agents:' : 'No agent is connected yet.'}</p>
          {status.clients.length > 0 && (
            <ul className="mt-1 space-y-1">
              {status.clients.map((c) => (
                <li key={`${c.name}-${c.address}`} className="flex items-baseline gap-2">
                  {/* The agent as the user knows it; how it connects (MCP, the client's own name) in small print. */}
                  <span className="min-w-0 flex-1 truncate">
                    {agentDisplayName(c.name)}
                    <span className="text-[11px] text-muted select-text"> · {clientDetail(c)}</span>
                  </span>
                  <span className="shrink-0 text-muted">last seen {formatTime(c.lastSeen)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The port, saved like every typed setting (SaveActions: Enter saves, Esc puts it back). What came of it shows beside
 * the field – "Saved", or why the port couldn't be used (the server tried it at once).
 */
function PortField({
  port,
  disabled,
  onSave
}: {
  port: number
  disabled: boolean
  onSave: (port: number) => Promise<AgentStatus>
}) {
  const [value, setValue] = useState(String(port))
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<'saved' | string>()
  useEffect(() => setValue(String(port)), [port])

  const n = Number(value.trim())
  const valid = /^\d+$/.test(value.trim()) && n >= MIN_PORT && n <= MAX_PORT
  const dirty = value !== String(port)
  const revert = () => setValue(String(port))
  const save = async () => {
    if (!valid || saving) return
    if (n === port) return revert()
    setSaving(true)
    setOutcome(undefined)
    try {
      const next = await onSave(n)
      setOutcome(next.enabled && !next.running && next.error ? `Couldn’t use port ${n}: ${next.error}` : 'saved')
    } catch (e) {
      setOutcome(`Couldn’t use port ${n}: ${ipcErrorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setOutcome(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape' && dirty) {
              e.preventDefault()
              revert()
            }
          }}
          disabled={disabled || saving}
          aria-label="Port"
          className="h-8 w-28 rounded-md border border-line bg-raised px-3 tabular-nums outline-none focus:border-muted disabled:opacity-60"
        />
        <SaveActions
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onRevert={revert}
          status={valid ? outcome : `Enter a number between ${MIN_PORT} and ${MAX_PORT}.`}
        />
      </div>
      <p className="mt-1 text-[11px] text-muted">If you change the port, the agents need the new address.</p>
    </>
  )
}

function Snippet({ hint, text, copy }: { hint: string; text: string; copy: () => Promise<string> }) {
  return (
    <div>
      <div className="relative">
        <pre className={`overflow-x-auto whitespace-pre pr-24 leading-relaxed ${code}`}>{text}</pre>
        <CopyButton
          text={copy}
          title="Copy the configuration with the token"
          className={`absolute right-2 top-2 bg-panel ${buttonClass('secondary', 'sm')}`}
        />
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{hint}</p>
    </div>
  )
}
