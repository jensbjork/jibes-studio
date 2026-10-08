import { pendingApprovals, useAgentState, useAgentWorking } from '../../lib/agent'
import { agentSummary, presenceText, TONE_DOT } from './agentText'

interface Props {
  /** The activity drawer is open. */
  active: boolean
  onClick: () => void
}

/**
 * Sidebar row: "Agent: av", "Agent: på – väntar" or "● Agent ansluten", with the number of requests waiting.
 * While the agent works it reads "Agenten arbetar…" with a pulsing dot and what it just did, so its presence is felt.
 */
export default function AgentIndicator({ active, onClick }: Props) {
  const agent = useAgentState()
  const summary = agentSummary(agent.status)
  const waiting = pendingApprovals(agent).length
  const working = useAgentWorking()
  const latest = working[0]

  return (
    <button
      onClick={onClick}
      aria-expanded={active}
      title={
        waiting
          ? `${waiting === 1 ? 'En begäran' : `${waiting} begäranden`} väntar på ditt OK. ${summary.detail}`
          : `${summary.detail} Klicka för att se vad agenten gjort.`
      }
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition ${
        active ? 'bg-raised text-text' : 'text-muted hover:bg-raised/60 hover:text-text'
      }`}
    >
      <span className="flex w-4 shrink-0 justify-center">
        {latest ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
        ) : (
          <span className={`h-2 w-2 rounded-full ${TONE_DOT[summary.tone]}`} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        {latest ? (
          <>
            <span className="block truncate text-text">Agenten arbetar…</span>
            <span className="block truncate text-xs text-muted" aria-live="polite">
              {presenceText(latest)}
            </span>
          </>
        ) : (
          <span className="block truncate">{summary.label}</span>
        )}
      </span>
      {waiting > 0 && (
        <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
          {waiting}
        </span>
      )}
    </button>
  )
}
