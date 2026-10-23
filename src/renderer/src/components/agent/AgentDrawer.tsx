import { useEffect, useState } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import type { AgentStatus, ApprovalRequest } from '@shared/types'
import { APPROVAL_TTL_MS, pendingApprovals, showApproval, useAgentState } from '../../lib/agent'
import { formatUsd } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { THIS_COMPUTER } from '../../lib/platform'
import { SETTINGS_SECTION, showSettingsSection } from '../settings/SettingsLayout'
import SidePanel from '../SidePanel'
import { buttonClass } from '../ui/button'
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
 * The Agent panel: what the connected agents have done, newest first, with requests waiting for the user's OK pinned
 * on top. A SidePanel beside the sidebar, like Activity. While the connection is off it shows the status card (with
 * its one way to Settings) and only the events from before it was switched off.
 */
export default function AgentDrawer({ open, onClose, navigate }: Props) {
  if (!open) return null
  return <Panel onClose={onClose} navigate={navigate} />
}

function Panel({ onClose, navigate }: Omit<Props, 'open'>) {
  const agent = useAgentState()
  const waiting = pendingApprovals(agent)
  const now = useNow(15_000)
  const enabled = !!agent.status?.enabled

  // Straight to Agent connection, not the top of Settings.
  const openSettings = () => {
    onClose()
    showSettingsSection(SETTINGS_SECTION.agent)
    navigate('settings')
  }

  return (
    <SidePanel
      label="Agent"
      title="Agent"
      onClose={onClose}
      // While the connection is off, the status card's "Turn on in Settings" is the way there.
      footer={
        enabled && (
          <button type="button" onClick={openSettings} className="text-[12px] text-muted transition hover:text-text">
            Agent connection settings →
          </button>
        )
      }
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <StatusCard status={agent.status} error={agent.statusError} onOpenSettings={openSettings} />

        {waiting.length > 0 && (
          <section>
            <h3 className="section-label mb-2">Waiting for your OK</h3>
            <div className="space-y-2">
              {waiting.map((a) => (
                <PendingCard key={a.id} approval={a} now={now} />
              ))}
            </div>
          </section>
        )}

        {(enabled || agent.activity.length > 0) && (
          <section>
            <h3 className="section-label mb-2">Latest events</h3>
            {agent.activity.length ? (
              <ol className="space-y-px">
                {agent.activity.map((a) => {
                  const request = a.approvalId ? waiting.find((x) => x.id === a.approvalId) : undefined
                  return (
                    <li key={a.id} className="flex gap-2.5 rounded px-1.5 py-1 text-[12px] leading-snug hover:bg-raised/50">
                      <span className="w-11 shrink-0 text-muted tabular-nums">{formatTime(a.at)}</span>
                      <span className={`min-w-0 flex-1 break-words ${a.ok ? '' : 'text-danger'}`} title={a.tool}>
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
                Nothing yet. When an agent connects, everything it does shows up here – what it reads and changes, and
                what it wants to generate or delete.
              </p>
            )}
          </section>
        )}
      </div>
    </SidePanel>
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
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}

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
            <p className="mt-2 text-[12px] leading-relaxed text-warning">
              Tailscale isn’t running – only agents on {THIS_COMPUTER} can connect.
            </p>
          )}
        </>
      )}

      {/* Not before the status is known: it would flash in while the connection may well be on. */}
      {status && !status.enabled && (
        <button type="button" onClick={onOpenSettings} className={`mt-2.5 ${buttonClass('secondary', 'sm')}`}>
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
          className="shrink-0 rounded-md bg-accent-fill px-2.5 py-1 font-medium text-white transition hover:bg-accent-hover"
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
