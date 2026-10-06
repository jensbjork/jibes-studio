import { pendingApprovals, useAgentState } from '../../lib/agent'
import { agentSummary, TONE_DOT } from './agentText'

interface Props {
  /** The activity drawer is open. */
  active: boolean
  onClick: () => void
}

/** Sidebar row: "Agent: av", "Agent: på – väntar" or "● OpenClaw ansluten", with the number of requests waiting. */
export default function AgentIndicator({ active, onClick }: Props) {
  const agent = useAgentState()
  const summary = agentSummary(agent.status)
  const waiting = pendingApprovals(agent).length

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
        <span className={`h-2 w-2 rounded-full ${TONE_DOT[summary.tone]}`} />
      </span>
      <span className="min-w-0 flex-1 truncate">{summary.label}</span>
      {waiting > 0 && (
        <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
          {waiting}
        </span>
      )}
    </button>
  )
}
