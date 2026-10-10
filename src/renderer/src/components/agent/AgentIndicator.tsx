import type { AgentActivity } from '@shared/types'
import { pendingApprovals, useAgentState, useAgentWorking } from '../../lib/agent'
import StatusRow from '../work/StatusRow'
import { agentSummary, presenceText, TONE_DOT, workingLabel, type AgentSummary } from './agentText'

interface Props {
  /** The collapsed sidebar's icon rail: the dot alone, with the number of waiting requests on its corner. */
  collapsed: boolean
  /** The activity drawer is open. */
  active: boolean
  onClick: () => void
}

interface IndicatorState {
  summary: AgentSummary
  /** Requests waiting for the user's OK. */
  waiting: number
  /** The agent's latest call while it works; undefined when it is quiet. */
  latest?: AgentActivity
  /** In words: "Agent ansluten", "Agenten arbetar", "OpenClaw arbetar". */
  label: string
  /** In words: "2 begäranden väntar på ditt OK · Satte prompten"; '' when there is nothing to add. */
  status: string
}

/** "2 begäranden väntar på ditt OK", or nothing. */
function waitingText(waiting: number): string {
  if (!waiting) return ''
  return `${waiting === 1 ? 'En begäran väntar' : `${waiting} begäranden väntar`} på ditt OK`
}

function useIndicator(): IndicatorState {
  const agent = useAgentState()
  const summary = agentSummary(agent.status)
  const waiting = pendingApprovals(agent).length
  const latest = useAgentWorking()[0]
  return {
    summary,
    waiting,
    latest,
    // No "…": the pulsing dot says it goes on, and the name keeps its room beside the waiting count.
    label: latest ? workingLabel(latest) : summary.label,
    status: [waitingText(waiting), latest ? presenceText(latest) : ''].filter(Boolean).join(' · ')
  }
}

/** The connection's tone as a 8 px dot, or the emerald ping while the agent works. */
function Dot({ working, summary }: { working: boolean; summary: AgentSummary }) {
  return working ? (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
    </span>
  ) : (
    <span className={`h-2 w-2 rounded-full ${TONE_DOT[summary.tone]}`} />
  )
}

/**
 * The sidebar's status row of the agent connection: "Agent: av", "Agent: på – väntar" or "● Agent ansluten", with
 * the number of requests waiting for the user's OK as an accent pill. While the agent works it reads "Agenten
 * arbetar" (or the agent's own name) with a pulsing dot, and what it just did is in the tooltip (and in the
 * presence pill at the bottom of the window). In the rail it is the dot, with the count on its corner.
 */
export default function AgentIndicator({ collapsed, active, onClick }: Props) {
  const { summary, waiting, latest, label, status } = useIndicator()

  return (
    <StatusRow
      collapsed={collapsed}
      active={active}
      onClick={onClick}
      icon={<Dot working={!!latest} summary={summary} />}
      badge={
        waiting > 0 && (
          <span
            aria-hidden
            className="absolute -right-2.5 -top-1.5 min-w-3.5 rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-3.5 text-white tabular-nums ring-2 ring-[var(--row-bg,var(--color-panel))]"
          >
            {waiting}
          </span>
        )
      }
      label={label}
      lit={!!latest || waiting > 0}
      trailing={
        waiting > 0 && (
          <span
            aria-hidden
            className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums"
          >
            {waiting}
          </span>
        )
      }
      status={status || undefined}
      title={
        [waiting ? `${waitingText(waiting)}.` : '', latest ? `${presenceText(latest)}.` : '', summary.detail]
          .filter(Boolean)
          .join(' ') + (waiting ? '' : ' Klicka för att se vad agenten gjort.')
      }
      live={latest ? presenceText(latest) : ''}
    />
  )
}
