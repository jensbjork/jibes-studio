import { useCallback, useEffect, useState } from 'react'
import type { AgentStatus, ClaudeDesktopStatus } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { FILE_MANAGER, PATH_SEPARATOR, THIS_COMPUTER } from '../../lib/platform'
import { SettingsItem, StatusPill } from '../settings/SettingsLayout'

/** An address Claude Desktop can reach Studio at: the host main puts into the extension, and how it's named here. */
export interface ClaudeAddress {
  id: string
  label: string
  host: string
}

/** The name the extension sends in X-Studio-Agent-Name (src/mcpb/bridge.ts). */
const CLAUDE_AGENT_NAME = 'Claude'
const DOWNLOAD_URL = 'https://claude.ai/download'
const INSTALL_BY_HAND = 'Settings → Extensions → Advanced settings → Install Extension…'
const LOCAL_HOST = '127.0.0.1'

const primary =
  'shrink-0 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40'
const secondary = 'shrink-0 rounded-md border border-line px-3 py-1.5 text-[12px] transition hover:bg-raised disabled:opacity-40'
const link = 'text-text underline underline-offset-2 hover:text-white disabled:opacity-40'

/** What the last click came to, shown where it was clicked. */
type Outcome =
  | { kind: 'opened' }
  | { kind: 'not-opened' }
  | { kind: 'saved'; path: string; local: boolean }
  | { kind: 'error'; message: string }

/**
 * Settings → Agent connection → Claude Desktop: Studio as an extension (connector) in Claude Desktop, added in one
 * click on this computer, or saved as a file for Claude Desktop on another computer in the tailnet. Main makes the
 * file with the address and the current token (src/main/claude-desktop.ts); the token never passes through here.
 */
export default function ClaudeDesktopCard({ status, addresses }: { status: AgentStatus; addresses: ClaudeAddress[] }) {
  const [claude, setClaude] = useState<ClaudeDesktopStatus>()
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<Outcome>()
  const [saved, setSaved] = useState<Outcome>()
  const [addressId, setAddressId] = useState<string>()
  const [othersOpen, setOthersOpen] = useState(false)

  // Looked for when Settings opens and whenever Studio comes back to the front (Claude Desktop may just have been
  // installed).
  const lookForClaude = useCallback(() => {
    window.studio
      .claudeDesktopStatus()
      .then(setClaude)
      .catch(() => setClaude({ installed: false }))
  }, [])
  useEffect(() => {
    lookForClaude()
    window.addEventListener('focus', lookForClaude)
    return () => window.removeEventListener('focus', lookForClaude)
  }, [lookForClaude])

  // What a click said no longer applies once Claude Desktop comes or goes, or the connection is switched.
  useEffect(() => setAdded(undefined), [claude?.installed, status.enabled])

  const connected = status.clients.some((c) => c.name === CLAUDE_AGENT_NAME)
  // For another computer the Tailscale address comes first; this computer's own is there for a file kept for later.
  const address = addresses.find((a) => a.id === addressId) ?? addresses[0]

  const run = async (show: (o: Outcome | undefined) => void, action: () => Promise<Outcome | undefined>) => {
    setBusy(true)
    show(undefined)
    try {
      show(await action())
    } catch (e) {
      show({ kind: 'error', message: ipcErrorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    void run(setAdded, async () => {
      const { opened } = await window.studio.addToClaudeDesktop()
      return { kind: opened ? 'opened' : 'not-opened' }
    })

  /** Saves the file for `host`; the outcome shows under the button that was clicked. */
  const save = (host: string, show: (o: Outcome | undefined) => void) =>
    void run(show, async () => {
      const { savedTo } = await window.studio.addToClaudeDesktop({ address: host, save: true })
      return savedTo ? { kind: 'saved', path: savedTo, local: host === LOCAL_HOST } : undefined
    })

  return (
    <SettingsItem
      title="Claude Desktop"
      status={connected ? <StatusPill tone="ok">Connected</StatusPill> : undefined}
      help="Add Studio to Claude Desktop as an extension. Claude then works in Studio like any other agent – paid steps and removals still wait for your OK here."
    >
      <div className="rounded-lg border border-line bg-raised/40 p-3">
        {claude === undefined ? (
          <p className="text-[12px] text-muted">Looking for Claude Desktop…</p>
        ) : claude.installed ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" onClick={add} disabled={busy || !status.enabled} className={primary}>
              Add to Claude Desktop
            </button>
            <span className="min-w-0 text-[12px] text-muted" title={claude.appPath}>
              Claude Desktop opens and asks you to install Studio.
            </span>
          </div>
        ) : (
          <p className="text-[12px] leading-relaxed">
            Claude Desktop isn’t installed on {THIS_COMPUTER}.{' '}
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className={link}>
              Download Claude Desktop
            </a>
            , install it and come back here – then Studio is one click away.
          </p>
        )}
        {!status.enabled && (
          <p className="mt-2 text-[12px] text-amber-300">Switch on “Allow agents to connect” above first: Claude connects through it.</p>
        )}
        {added?.kind === 'opened' && (
          <p className="mt-2 text-[12px] leading-relaxed text-emerald-300">
            Claude Desktop opened the extension – click Install there. Claude shows up under Connected agents once it
            connects.
          </p>
        )}
        {added?.kind === 'not-opened' && (
          <p className="mt-2 text-[12px] leading-relaxed text-amber-300">
            Claude Desktop didn’t open the file.{' '}
            <button type="button" onClick={() => save(LOCAL_HOST, setAdded)} disabled={busy} className={link}>
              Save it
            </button>{' '}
            and install it in Claude Desktop under {INSTALL_BY_HAND}
          </p>
        )}
        {added && <OutcomeLine outcome={added} />}
      </div>

      <details
        open={othersOpen}
        onToggle={(e) => setOthersOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="group mt-3 text-[12px]"
      >
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-muted transition hover:text-text [&::-webkit-details-marker]:hidden">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
            <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          For Claude Desktop on another computer…
        </summary>
        <div className="mt-2 space-y-2.5 border-l border-line pl-3.5 leading-relaxed text-muted">
          <p>
            Save the extension as a file and open it on the other computer. That computer reaches Studio through your
            tailnet (Tailscale), so choose the Tailscale address.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="group" aria-label="Address" className="flex flex-wrap items-center gap-1">
              <span aria-hidden className="mr-1">
                Address:
              </span>
              {addresses.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAddressId(a.id)}
                  aria-pressed={a.id === address?.id}
                  title={a.host}
                  className={`rounded-md px-2 py-1 transition ${
                    a.id === address?.id ? 'bg-line text-text' : 'hover:bg-raised hover:text-text'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => address && save(address.host, setSaved)}
              disabled={busy || !status.enabled || !address}
              className={secondary}
            >
              Save…
            </button>
          </div>
          {!status.tailscaleAddress && status.enabled && (
            <p className="text-amber-300">Tailscale isn’t running on {THIS_COMPUTER}, so another computer can’t reach Studio yet.</p>
          )}
          {saved && <OutcomeLine outcome={saved} />}
          <p>The file holds Studio’s token, like the configuration below: don’t share it with anyone.</p>
        </div>
      </details>

      <p className="mt-2.5 text-[11px] text-muted">
        If you change the token, add Studio to Claude Desktop again: the extension keeps the token it was made with.
      </p>
    </SettingsItem>
  )
}

/** A saved file (with Show in Finder and how to install it) or an error; nothing for the other outcomes. */
function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'error') return <p className="mt-2 text-[12px] text-accent select-text">{outcome.message}</p>
  if (outcome.kind !== 'saved') return null
  const name = outcome.path.split(PATH_SEPARATOR).pop()
  return (
    <div className="mt-2 text-[12px] leading-relaxed">
      <p className="text-emerald-300">
        Saved as “{name}”.{' '}
        <button type="button" onClick={() => void window.studio.revealFile(outcome.path)} className={link}>
          Show in {FILE_MANAGER}
        </button>
      </p>
      <p className="text-muted">
        {outcome.local ? 'Double-click it' : 'On the other computer, double-click it'}, or install it in Claude Desktop
        under {INSTALL_BY_HAND}
      </p>
    </div>
  )
}
