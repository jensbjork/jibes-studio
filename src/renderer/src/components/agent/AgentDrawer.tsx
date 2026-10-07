import { useEffect, useState } from 'react'
import type { AgentStatus, ApprovalRequest } from '@shared/types'
import { APPROVAL_TTL_MS, pendingApprovals, showApproval, useAgentState } from '../../lib/agent'
import { formatUsd } from '../../lib/media'
import type { Navigate } from '../../lib/navigation'
import { CloseIcon } from '../sequences/icons'
import {
  activityText,
  agentSummary,
  approvalTitle,
  approvalVerb,
  expiresText,
  formatTime,
  TONE_DOT
} from './agentText'

interface Props {
  open: boolean
  onClose: () => void
  navigate: Navigate
}

/**
 * What the connected agents have done, newest first, with requests waiting for the user's OK pinned on top.
 * Slides out next to the sidebar.
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

  const openSettings = () => {
    onClose()
    navigate('settings')
  }

  return (
    <>
      {/* Clicking anywhere outside closes the drawer. */}
      <div className="no-drag fixed inset-y-0 left-52 right-0 z-30" onMouseDown={onClose} />
      <aside
        aria-label="Agent"
        className="no-drag fixed inset-y-0 left-52 z-40 flex w-[340px] flex-col border-r border-line bg-panel shadow-2xl shadow-black/50"
      >
        <div className="drag flex h-12 shrink-0 items-center gap-2 px-4">
          <h2 className="font-semibold">Agent</h2>
          <button
            onClick={onClose}
            title="Stäng"
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
                Väntar på ditt OK
              </h3>
              <div className="space-y-2">
                {waiting.map((a) => (
                  <PendingCard key={a.id} approval={a} now={now} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Senaste händelser</h3>
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
                            Granska
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
                  ? 'Inget än. Slå på agentanslutningen så syns allt en agent gör här.'
                  : 'Inget än. När en agent ansluter syns allt den gör här – vad den läser, ändrar och vill generera.'}
              </p>
            )}
          </section>
        </div>

        <div className="border-t border-line px-4 py-3">
          <button onClick={openSettings} className="text-[12px] text-muted transition hover:text-text">
            Inställningar för agentanslutning →
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
                <li key={`${c.name}-${c.address}`} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {c.name}
                    {c.version ? <span className="text-muted"> {c.version}</span> : null}
                    <span className="text-muted"> · {c.address}</span>
                  </span>
                  <span className="shrink-0 text-muted" title="Senast aktiv">
                    {formatTime(c.lastSeen)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!status.tailscaleAddress && (
            <p className="mt-2 text-[12px] leading-relaxed text-amber-300">
              Tailscale är inte igång – bara agenter på den här Macen kan ansluta.
            </p>
          )}
        </>
      )}

      {!status?.enabled && (
        <button
          onClick={onOpenSettings}
          className="mt-2.5 rounded-md border border-line px-3 py-1.5 text-[12px] transition hover:bg-raised"
        >
          Slå på i Inställningar
        </button>
      )}
    </div>
  )
}

function PendingCard({ approval: a, now }: { approval: ApprovalRequest; now: number }) {
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
      <p className="text-[12px]">
        <span className="font-medium">{a.client}</span> {approvalVerb(a)} {lowerFirst(approvalTitle(a, a.sequenceName))}
      </p>
      <div className="mt-2 flex items-center gap-3 text-[12px]">
        <span className="font-medium tabular-nums">{a.priceUsd !== undefined ? formatUsd(a.priceUsd) : 'Okänt pris'}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{expiresText(a.createdAt + APPROVAL_TTL_MS, now)}</span>
        <button
          onClick={() => showApproval(a.id)}
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 font-medium text-white transition hover:bg-accent-hover"
        >
          Granska
        </button>
      </div>
    </div>
  )
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase('sv') + text.slice(1)
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
