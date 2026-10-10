import { useEffect, useId, useState } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import type { AgentStatus } from '@shared/types'
import { refreshAgentStatus, restartAgent, setAgentEnabled, setAgentPort, useAgentState } from '../../lib/agent'
import { ipcErrorMessage } from '../../lib/hooks'
import ConfirmButton from '../sequences/ConfirmButton'
import { MoreAbout, SettingsItem } from '../settings/SettingsLayout'
import Switch from '../settings/Switch'
import { clientDetail, formatTime } from './agentText'
import CopyButton from './CopyButton'

const MASK = '•'.repeat(28)
const TOKEN_PLACEHOLDER = '••••••••'
const MIN_PORT = 1024
const MAX_PORT = 65535

const secondary = 'shrink-0 rounded-md border border-line px-3 py-1.5 text-[12px] transition hover:bg-raised disabled:opacity-40'
const code = 'rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs select-text'

type EndpointId = 'tailscale' | 'dns' | 'local'

interface Endpoint {
  id: EndpointId
  label: string
  url: string
  hint: string
}

function endpointsOf(status: AgentStatus): Endpoint[] {
  const port = status.port
  const list: Endpoint[] = []
  if (status.tailscaleAddress) {
    list.push({
      id: 'tailscale',
      label: 'Tailscale-adress',
      url: `http://${status.tailscaleAddress}:${port}/mcp`,
      hint: 'För agenter på andra datorer i ditt tailnet, till exempel en server eller en annan Mac.'
    })
  }
  if (status.tailscaleDnsName) {
    list.push({
      id: 'dns',
      label: 'Tailscale-namn',
      url: `http://${status.tailscaleDnsName.replace(/\.$/, '')}:${port}/mcp`,
      hint: 'Samma sak, med datorns namn (MagicDNS) i stället för IP-adressen.'
    })
  }
  list.push({
    id: 'local',
    label: 'Den här Macen',
    url: `http://127.0.0.1:${port}/mcp`,
    hint: 'Bara för agenter som körs på den här datorn.'
  })
  return list
}

/**
 * The header Studio reads the agent's name from, for the activity log and the approval dialog; without it
 * Studio shows whatever name the agent's MCP client reports, which can be a generic one.
 */
const AGENT_NAME_HEADER = 'X-Studio-Agent-Name'

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

type SnippetId = 'openclaw' | 'hermes'

/**
 * Inställningar → Agentanslutning (the section's heading and one-line description are SettingsView's): the MCP
 * server the user's own agents (e.g. OpenClaw, Hermes Agent) connect to. Off by default; reachable only from this
 * Mac and the tailnet, and only with the token shown here.
 */
export default function AgentSettingsSection() {
  const { status, statusError } = useAgentState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [token, setToken] = useState<string>()
  const [revealed, setRevealed] = useState(false)
  const [tokenNotice, setTokenNotice] = useState<string>()
  const [endpointId, setEndpointId] = useState<EndpointId>()
  const [snippet, setSnippet] = useState<SnippetId>('openclaw')
  const switchLabel = useId()

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
      setTokenNotice('Ny token skapad. Agenter med den gamla kommer inte längre in – ge dem den nya konfigurationen.')
    })

  // Detects Tailscale again (or retries starting) without switching the connection off, which would let every
  // request waiting for the user lapse.
  const restart = () => void run(restartAgent)

  const endpoints = status ? endpointsOf(status) : []
  const endpoint = endpoints.find((e) => e.id === endpointId) ?? endpoints[0]
  const shownToken = revealed && token ? token : TOKEN_PLACEHOLDER
  const withToken = (build: (url: string, token: string) => string) => async () =>
    build(endpoint!.url, await loadToken())

  if (!status) {
    return <p className={statusError ? 'text-accent' : 'text-muted'}>{statusError ?? 'Läser av anslutningen…'}</p>
  }

  return (
    <>
      <div>
        <div className="rounded-lg border border-line bg-raised/40 p-3">
          <div className="flex items-start gap-3">
            <Switch
              on={status.enabled}
              disabled={busy}
              onChange={(on) => void run(() => setAgentEnabled(on))}
              labelledBy={switchLabel}
            />
            <span className="min-w-0">
              <span id={switchLabel} className="block">
                Tillåt agenter att ansluta
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted">
                Av som standard. När den är på nås Studio bara från den här Macen och från datorer i ditt tailnet
                (Tailscale) – och bara med token nedan.
              </span>
            </span>
          </div>
          {status.enabled && <StatusLines status={status} busy={busy} onRestart={restart} />}
        </div>
        {error && <p className="mt-2 text-[12px] text-accent select-text">{error}</p>}
        <div className="mt-3">
          <MoreAbout summary="Mer om vad agenter kan göra">
            <p>
              En ansluten agent kan göra nästan allt du kan: skapa karaktärer, produkter och andra tillgångar, lägga
              till bilder och ljud, skriva prompter och bygga sekvenser och storyboards.
            </p>
            <p>
              Det som kostar pengar och allt som tar bort något gör den aldrig på egen hand: varje sådan begäran
              väntar på ditt OK här i Studio.
            </p>
            <p>
              MCP är sättet agenten ansluter på. Studio visar agentens namn i loggen och när den ber om lov – eller
              ”Agenten” när klienten bara kallar sig något allmänt, som ”mcp”.
            </p>
          </MoreAbout>
        </div>
      </div>

      <SettingsItem title="Token" help="Agenten skickar den som ”Authorization: Bearer …”. Dela den inte med någon annan.">
        <div className="flex items-center gap-2">
          <code className={`min-w-0 flex-1 truncate ${code}`}>{revealed && token ? token : MASK}</code>
          <button onClick={toggleReveal} disabled={busy} className={secondary}>
            {revealed ? 'Dölj' : 'Visa'}
          </button>
          <CopyButton text={loadToken} title="Kopiera token" className={secondary} />
        </div>
        <div className="mt-1.5">
          <ConfirmButton
            question="Byta token? Anslutna agenter behöver den nya."
            confirmLabel="Byt"
            onConfirm={regenerate}
            disabled={busy}
            className="text-[11px] text-muted underline-offset-2 hover:text-text hover:underline disabled:opacity-40"
          >
            Byt token…
          </ConfirmButton>
        </div>
        {tokenNotice && <p className="mt-1.5 text-[12px] text-amber-300">{tokenNotice}</p>}
      </SettingsItem>

      <SettingsItem title="Adresser" help="Där agenten når Studio. Välj den som passar var agenten körs.">
        <ul className="space-y-2.5">
          {endpoints.map((e) => (
            <li key={e.id}>
              <div className="flex items-center gap-2">
                <code className={`min-w-0 flex-1 truncate ${code}`} title={e.url}>
                  {e.url}
                </code>
                <CopyButton text={e.url} className={secondary} />
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                <span className="text-text">{e.label}</span> – {e.hint}
              </p>
            </li>
          ))}
        </ul>
        {!status.tailscaleAddress &&
          (status.enabled && status.running ? (
            <p className="mt-2 text-[12px] leading-relaxed text-amber-300">
              Tailscale är inte igång på den här Macen, så agenter på andra datorer kan inte nå Studio. Starta
              Tailscale och tryck på Sök igen ovan.
            </p>
          ) : (
            !status.enabled && (
              <p className="mt-2 text-[11px] text-muted">
                Tailscale-adressen, som agenter på andra datorer behöver, visas när anslutningen är på.
              </p>
            )
          ))}
      </SettingsItem>

      {endpoint && (
        <SettingsItem
          title="Konfiguration för agenten"
          help="Klistra in i agentens inställningar. Kopiera tar med den riktiga token."
        >
          <div className="mb-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
            <Segmented
              label="Agent"
              options={[
                { id: 'openclaw', label: 'OpenClaw' },
                { id: 'hermes', label: 'Hermes' }
              ]}
              value={snippet}
              onChange={setSnippet}
            />
            {endpoints.length > 1 && (
              <Segmented
                label="Adress"
                options={endpoints.map((e) => ({ id: e.id, label: e.label }))}
                value={endpoint.id}
                onChange={setEndpointId}
              />
            )}
          </div>

          {snippet === 'openclaw' ? (
            <Snippet
              hint="Läggs i OpenClaws konfiguration under mcp.servers. Namnet i X-Studio-Agent-Name är det Studio visar i loggen och när agenten ber om lov."
              text={openClawConfig(endpoint.url, shownToken)}
              copy={withToken(openClawConfig)}
            />
          ) : (
            <Snippet
              hint={
                'Hermes Agent ansluter också över HTTP. Var MCP-servrar anges kan skilja mellan versioner – se Hermes ' +
                'dokumentation.'
              }
              text={hermesConfig(endpoint.url, shownToken)}
              copy={withToken(hermesConfig)}
            />
          )}
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            Be sedan agenten börja med verktyget <span className="font-mono text-text">get_studio_guide</span> – där
            står hur Studio fungerar och hur bra videoprompter skrivs.
          </p>
        </SettingsItem>
      )}

      <SettingsItem title="Port">
        <PortField port={status.port} disabled={busy} onSave={(port) => run(() => setAgentPort(port))} />
      </SettingsItem>
    </>
  )
}

/** A row of choices with a quiet label in front: "Agent: [OpenClaw] Hermes". */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span aria-hidden className="mr-1 text-muted">
        {label}:
      </span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={o.id === value}
          className={`rounded-md px-2 py-1 transition ${
            o.id === value ? 'bg-line text-text' : 'text-muted hover:bg-raised hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function StatusLines({ status, busy, onRestart }: { status: AgentStatus; busy: boolean; onRestart: () => void }) {
  const restartButton = (label: string) => (
    <button onClick={onRestart} disabled={busy} className={`ml-auto ${secondary}`}>
      {label}
    </button>
  )
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3 text-[12px]">
      {status.running ? (
        <p className="flex items-start gap-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          <span className="min-w-0">
            Igång – lyssnar på{' '}
            <span className="font-mono text-[11px] text-muted select-text">{status.addresses.join(', ') || '–'}</span>
          </span>
        </p>
      ) : (
        <div className="flex items-start gap-2">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${status.error ? 'bg-accent' : 'bg-amber-400'}`} />
          <span className={`min-w-0 select-text ${status.error ? 'text-accent' : ''}`}>
            {status.error ? `Kunde inte starta: ${status.error}` : 'Startar…'}
          </span>
          {status.error && restartButton('Försök igen')}
        </div>
      )}
      {status.running && status.error && <p className="text-amber-300 select-text">{status.error}</p>}

      {status.running && !status.tailscaleAddress && (
        <div className="flex items-start gap-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
          <span className="min-w-0 text-amber-300">Tailscale är inte igång – bara den här Macen kan ansluta.</span>
          {restartButton('Sök igen')}
        </div>
      )}

      {status.running && (
        <div>
          <p className="text-muted">{status.clients.length ? 'Anslutna agenter:' : 'Ingen agent är ansluten än.'}</p>
          {status.clients.length > 0 && (
            <ul className="mt-1 space-y-1">
              {status.clients.map((c) => (
                <li key={`${c.name}-${c.address}`} className="flex items-baseline gap-2">
                  {/* The agent as the user knows it; how it connects (MCP, the client's own name) in small print. */}
                  <span className="min-w-0 flex-1 truncate">
                    {agentDisplayName(c.name)}
                    <span className="text-[11px] text-muted select-text"> · {clientDetail(c)}</span>
                  </span>
                  <span className="shrink-0 text-muted">senast {formatTime(c.lastSeen)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function PortField({
  port,
  disabled,
  onSave
}: {
  port: number
  disabled: boolean
  onSave: (port: number) => Promise<void>
}) {
  const [value, setValue] = useState(String(port))
  useEffect(() => setValue(String(port)), [port])

  const n = Number(value.trim())
  const valid = /^\d+$/.test(value.trim()) && n >= MIN_PORT && n <= MAX_PORT
  const changed = valid && n !== port
  const save = () => {
    if (changed) void onSave(n)
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') setValue(String(port))
          }}
          disabled={disabled}
          aria-label="Port"
          className="w-28 rounded-md border border-line bg-raised px-3 py-1.5 tabular-nums outline-none focus:border-muted disabled:opacity-60"
        />
        {changed && (
          <>
            <button onClick={save} disabled={disabled} className={secondary}>
              Spara
            </button>
            <button onClick={() => setValue(String(port))} disabled={disabled} className="text-[12px] text-muted hover:text-text">
              Ångra
            </button>
          </>
        )}
      </div>
      <p className={`mt-1 text-[11px] ${valid ? 'text-muted' : 'text-accent'}`}>
        {valid
          ? 'Byter du port behöver agenterna den nya adressen.'
          : `Ange ett nummer mellan ${MIN_PORT} och ${MAX_PORT}.`}
      </p>
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
          title="Kopiera konfigurationen med token"
          className={`absolute right-2 top-2 bg-panel ${secondary}`}
        />
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{hint}</p>
    </div>
  )
}
