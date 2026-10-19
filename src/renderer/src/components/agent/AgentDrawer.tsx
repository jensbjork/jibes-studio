import { useEffect, useState } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import type { AgentStatus, ApprovalRequest } from '@shared/types'
import { APPROVAL_TTL_MS, pendingApprovals, showApproval, useAgentState } from '../../lib/agent'
import { formatUsd } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { THIS_COMPUTER } from '../../lib/platform'
import { CloseIcon } from '../sequences/icons'
import { SETTINGS_SECTION, showSettingsSection } from '../settings/SettingsLayout'
import {
  activityText,
  agentSummary,
  approvalPriceText,
  approvalTitle,
  approvalVerb,
  clientDetail,
  expiresText,
  formatTime,
  thingsText,
  TONE_DOT
} from './agentText'

interface Props {
  open: boolean
  onClose: () => void
  navigate: Navigate
}

/**
 * What the connected agents have done, newest first, with requests waiting for the user's OK pinned on top.
 * Slides out next to the sidebar (at --sidebar-w, so it follows the sidebar when it is collapsed to its icon rail).
 */
export default function AgentDrawer({ open, onClose, navigate }: Props) {
  const agent = useAgentState()
  const summary = agentSummary(agent.status)
  const waiting = pendingApprovals(agent)
  const now = useNow(open ? 15_000 : 0)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape belongs to a dialog shown over the drawer (e.g. an approval), not to the drawer.
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  // Straight to Agent connection, not the top of Settings.
  const openSettings = () => {
    onClose()
    showSettingsSection(SETTINGS_SECTION.agent)
    navigate('settings')
  }

  return (
    <>
      {/* Clicking anywhere outside closes the drawer. It opens next to the sidebar, expanded or collapsed. */}
      <div className="no-drag fixed inset-y-0 left-[var(--sidebar-w,208px)] right-0 z-30" onMouseDown={onClose} />
      <aside
        aria-label="Agent"
        className="no-drag fixed inset-y-0 left-[var(--sidebar-w,208px)] z-40 flex w-[340px] flex-col border-r border-line bg-panel shadow-2xl shadow-black/50 transition-[left] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
      >
        <div className="drag flex h-12 shrink-0 items-center gap-2 px-4">
          <h2 className="font-semibold">Agent</h2>
          <button
            onClick={onClose}
            title="Close"
            className="no-drag ml-auto rounded p-1 text-muted transition hover:bg-raised hover:text-text"
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          <StatusCard status={agent.status} error={agent.statusError} onOpenSettings={openSettings} />

          {waiting.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                Waiting for your OK
              </h3>
              <div className="space-y-2">
                {waiting.map((a) => (
                  <PendingCard key={a.id} approval={a} now={now} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Latest events</h3>
            {agent.activity.length ? (
              <ol className="space-y-px">
                {agent.activity.map((a) => {
                  const request = a.approvalId ? waiting.find((x) => x.id === a.approvalId) : undefined
                  return (
                    <li key={a.id} className="flex gap-2.5 rounded px-1.5 py-1 text-[12px] leading-snug hover:bg-raised/50">
                      <span className="w-11 shrink-0 text-muted tabular-nums">{formatTime(a.at)}</span>
                      <span className={`min-w-0 flex-1 break-words ${a.ok ? '' : 'text-[#ffb3b5]'}`} title={a.tool}>
                        {!a.ok && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />}
                        {activityText(a)}
                        {request && (
                          <button
                            onClick={() => showApproval(request.id)}
                            className="ml-1.5 text-text underline-offset-2 hover:underline"
                          >
                            Review
                          </button>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <p className="text-[12px] leading-relaxed text-muted">
                {summary.tone === 'off'
                  ? 'Nothing yet. Turn on the agent connection and everything an agent does shows up here.'
                  : 'Nothing yet. When an agent connects, everything it does shows up here – what it reads and changes, and what it wants to generate or delete.'}
              </p>
            )}
          </section>
        </div>

        <div className="border-t border-line px-4 py-3">
          <button onClick={openSettings} className="text-[12px] text-muted transition hover:text-text">
            Agent connection settings →
          </button>
        </div>
      </aside>
    </>
  )
}

function StatusCard({
  status,
  error,
  onOpenSettings
}: {
  status?: AgentStatus
  error?: string
  onOpenSettings: () => void
}) {
  const summary = agentSummary(status)
  return (
    <div className="rounded-lg border border-line bg-raised/40 p-3">
      <p className="flex items-center gap-2 font-medium">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[summary.tone]}`} />
        {summary.label}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{summary.detail}</p>
      {error && <p className="mt-1 text-[12px] text-accent">{error}</p>}

      {status?.enabled && status.running && (
        <>
          {status.clients.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12px]">
              {status.clients.map((c) => (
                <li key={`${c.name}-${c.address}`} className="flex items-baseline gap-2">
                  {/* The agent as the user knows it; how it connects (MCP, the client's own name) in small print. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{agentDisplayName(c.name)}</span>
                    <span className="block truncate text-[11px] text-muted select-text">{clientDetail(c)}</span>
                  </span>
                  <span className="shrink-0 text-muted" title="Last active">
                    {formatTime(c.lastSeen)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!status.tailscaleAddress && (
            <p className="mt-2 text-[12px] leading-relaxed text-amber-300">
              Tailscale isn’t running – only agents on {THIS_COMPUTER} can connect.
            </p>
          )}
        </>
      )}

      {!status?.enabled && (
        <button
          onClick={onOpenSettings}
          className="mt-2.5 rounded-md border border-line px-3 py-1.5 text-[12px] transition hover:bg-raised"
        >
          Turn on in Settings
        </button>
      )}
    </div>
  )
}

function PendingCard({ approval: a, now }: { approval: ApprovalRequest; now: number }) {
  // A removal costs nothing: it says how many things go, and what, instead of a price.
  const removal = a.kind === 'delete'
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
      <p className="text-[12px]">
        <span className="font-medium">{agentDisplayName(a.client)}</span> {approvalVerb(a)}{' '}
        {removal ? thingsText(a.delete?.items.length ?? 0) : lowerFirst(approvalTitle(a, a.sequenceName))}
      </p>
      {removal && a.delete?.summary && (
        <p className="mt-0.5 truncate text-[12px] text-muted" title={a.delete.summary}>
          {a.delete.summary}
        </p>
      )}
      <div className="mt-2 flex items-center gap-3 text-[12px]">
        {!removal && (
          <span className="font-medium tabular-nums">
            {approvalPriceText(a, (usd) => (a.edit?.partialPrice ? `≈ ${formatUsd(usd)} +` : formatUsd(usd)))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-muted">{expiresText(a.createdAt + APPROVAL_TTL_MS, now)}</span>
        <button
          onClick={() => showApproval(a.id)}
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 font-medium text-white transition hover:bg-accent-hover"
        >
          Review
        </button>
      </div>
    </div>
  )
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase('en') + text.slice(1)
}

/** The current time, refreshed every `intervalMs` (0: not refreshed). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!intervalMs) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
