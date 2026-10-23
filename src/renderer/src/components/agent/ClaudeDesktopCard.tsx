import { useCallback, useEffect, useState } from 'react'
import type { AgentStatus, ClaudeDesktopStatus } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { FILE_MANAGER, PATH_SEPARATOR, THIS_COMPUTER } from '../../lib/platform'
import { MoreAbout, StatusPill } from '../settings/SettingsLayout'
import { buttonClass } from '../ui/button'
import Segmented from '../ui/Segmented'

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

const link = 'text-text underline underline-offset-2 hover:text-white disabled:opacity-40'

// Settings → Agent connection, Studio as an extension (connector) in Claude Desktop: added in one click on this
// computer (ClaudeDesktopCard, under "Connect an agent"), or saved as a file for Claude Desktop on another computer in
// the tailnet (ClaudeDesktopFile, under Advanced). Main makes the file with the address and the current token
// (src/main/claude-desktop.ts); the token never passes through here. Both are shown only while the connection is on.

/** What the last click came to, shown where it was clicked. */
type Outcome =
  | { kind: 'opened' }
  | { kind: 'not-opened' }
  | { kind: 'saved'; path: string; local: boolean }
  | { kind: 'error'; message: string }

/** One click at a time; what it came to goes to `show`, an error included. */
function useAction(): {
  busy: boolean
  run: (show: (o: Outcome | undefined) => void, action: () => Promise<Outcome | undefined>) => void
} {
  const [busy, setBusy] = useState(false)
  const run = (show: (o: Outcome | undefined) => void, action: () => Promise<Outcome | undefined>): void => {
    setBusy(true)
    show(undefined)
    void action()
      .then(show, (e: unknown) => show({ kind: 'error', message: ipcErrorMessage(e) }))
      .finally(() => setBusy(false))
  }
  return { busy, run }
}

/** Saves the extension as a file for `host`; resolves with where it went (nothing when the dialog was cancelled). */
async function saveFile(host: string): Promise<Outcome | undefined> {
  const { savedTo } = await window.studio.addToClaudeDesktop({ address: host, save: true })
  return savedTo ? { kind: 'saved', path: savedTo, local: host === LOCAL_HOST } : undefined
}

/**
 * Claude Desktop on this computer: Add to Claude Desktop (it opens and asks to install Studio), or where to download
 * it when it isn't installed; "Connected" beside the button once Claude has connected.
 */
export default function ClaudeDesktopCard({ status }: { status: AgentStatus }) {
  const [claude, setClaude] = useState<ClaudeDesktopStatus>()
  const [added, setAdded] = useState<Outcome>()
  const { busy, run } = useAction()

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

  // What a click said no longer applies once Claude Desktop comes or goes.
  useEffect(() => setAdded(undefined), [claude?.installed])

  const connected = status.clients.some((c) => c.name === CLAUDE_AGENT_NAME)

  const add = () =>
    run(setAdded, async () => {
      const { opened } = await window.studio.addToClaudeDesktop()
      return { kind: opened ? 'opened' : 'not-opened' }
    })

  return (
    <div>
      <p className="mb-2.5 text-[12px] leading-relaxed text-muted">
        Claude then works in Studio like any other agent – paid steps and removals still wait for your OK here.
      </p>
      <div className="rounded-lg border border-line bg-raised/40 p-3">
        {claude === undefined ? (
          <p className="text-[12px] text-muted">Looking for Claude Desktop…</p>
        ) : claude.installed ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" onClick={add} disabled={busy} className={buttonClass('primary')}>
              Add to Claude Desktop
            </button>
            {connected && <StatusPill tone="ok">Connected</StatusPill>}
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
        {added?.kind === 'opened' && (
          <p role="status" className="mt-2 text-[12px] leading-relaxed text-success">
            Claude Desktop opened the extension – click Install there. Claude shows up under Connected agents once it
            connects.
          </p>
        )}
        {added?.kind === 'not-opened' && (
          <p className="mt-2 text-[12px] leading-relaxed text-warning">
            Claude Desktop didn’t open the file.{' '}
            <button
              type="button"
              onClick={() => run(setAdded, () => saveFile(LOCAL_HOST))}
              disabled={busy}
              className={link}
            >
              Save it
            </button>{' '}
            and install it in Claude Desktop under {INSTALL_BY_HAND}
          </p>
        )}
        {added && <OutcomeLine outcome={added} />}
      </div>
    </div>
  )
}

/**
 * "For Claude Desktop on another computer…": the extension saved as a file to open there, made with the address that
 * computer reaches Studio at (the Tailscale address first).
 */
export function ClaudeDesktopFile({ status, addresses }: { status: AgentStatus; addresses: ClaudeAddress[] }) {
  const [saved, setSaved] = useState<Outcome>()
  const [addressId, setAddressId] = useState<string>()
  const { busy, run } = useAction()
  // For another computer the Tailscale address comes first; this computer's own is there for a file kept for later.
  const address = addresses.find((a) => a.id === addressId) ?? addresses[0]

  return (
    <MoreAbout summary="For Claude Desktop on another computer…">
      <p>
        Save the extension as a file and open it on the other computer. That computer reaches Studio through your
        tailnet (Tailscale), so choose the Tailscale address.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {address && addresses.length > 1 && (
          <Segmented
            label="Address:"
            ariaLabel="Address"
            options={addresses.map((a) => ({ value: a.id, label: a.label, title: a.host }))}
            value={address.id}
            onChange={setAddressId}
          />
        )}
        <button
          type="button"
          onClick={() => address && run(setSaved, () => saveFile(address.host))}
          disabled={busy || !address}
          className={buttonClass('secondary', 'sm')}
        >
          Save…
        </button>
      </div>
      {!status.tailscaleAddress && (
        <p className="text-warning">
          Tailscale isn’t running on {THIS_COMPUTER}, so another computer can’t reach Studio yet.
        </p>
      )}
      {saved && <OutcomeLine outcome={saved} />}
      <p>The file holds Studio’s token, like the agents’ configurations: don’t share it with anyone.</p>
    </MoreAbout>
  )
}

/** A saved file (with Show in Finder and how to install it) or an error; nothing for the other outcomes. */
function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'error') {
    return (
      <p role="alert" className="mt-2 text-[12px] text-danger select-text">
        {outcome.message}
      </p>
    )
  }
  if (outcome.kind !== 'saved') return null
  const name = outcome.path.split(PATH_SEPARATOR).pop()
  return (
    <div className="mt-2 text-[12px] leading-relaxed">
      <p className="text-success">
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
