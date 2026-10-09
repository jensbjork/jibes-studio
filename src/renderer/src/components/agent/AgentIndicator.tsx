import type { AgentActivity } from '@shared/types'
import { pendingApprovals, useAgentState, useAgentWorking } from '../../lib/agent'
import { agentSummary, presenceText, TONE_DOT, type AgentSummary } from './agentText'

interface Props {
  /** The activity drawer is open. */
  active: boolean
  onClick: () => void
  /**
   * The collapsed sidebar's icon rail: only the dot (or the emerald ping while the agent works) in a 40×36 button,
   * with the number of waiting requests on its top-right corner; the words go into its accessible name (and the
   * tooltip). The working text stays with AgentPresence at the bottom of the window.
   */
  compact?: boolean
  /** compact: also give the button a native tooltip (leave off when the rail shows its own tooltip around it). */
  nativeTooltip?: boolean
}

interface IndicatorState {
  summary: AgentSummary
  /** Requests waiting for the user's OK. */
  waiting: number
  /** The agent's latest call while it works; undefined when it is quiet. */
  latest?: AgentActivity
  /** In words: "Agent ansluten", "Agenten arbetar". */
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
    label: latest ? 'Agenten arbetar' : summary.label,
    status: [waitingText(waiting), latest ? presenceText(latest) : ''].filter(Boolean).join(' · ')
  }
}

/**
 * What the indicator says in words, for the rail's tooltip: its label ("Agent ansluten", "Agenten arbetar") and a
 * status line ("2 begäranden väntar på ditt OK", what it just did), '' when there is nothing to add.
 */
export function useAgentIndicatorText(): { label: string; status: string } {
  const { label, status } = useIndicator()
  return { label, status }
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
 * Sidebar row: "Agent: av", "Agent: på – väntar" or "● Agent ansluten", with the number of requests waiting.
 * While the agent works it reads "Agenten arbetar…" with a pulsing dot and what it just did, so its presence is felt.
 * In the collapsed rail (`compact`) it is the dot alone, with the count as a badge.
 */
export default function AgentIndicator({ active, onClick, compact = false, nativeTooltip = true }: Props) {
  const { summary, waiting, latest, label, status } = useIndicator()

  if (compact) {
    const name = status ? `${label} · ${status}` : label
    return (
      <button
        type="button"
        onClick={onClick}
        aria-expanded={active}
        aria-label={name}
        title={nativeTooltip ? name : undefined}
        className={`relative flex h-9 w-10 shrink-0 items-center justify-center rounded-md transition ${
          active ? 'bg-raised text-text' : 'text-muted hover:bg-raised/60 hover:text-text'
        }`}
      >
        <Dot working={!!latest} summary={summary} />
        {waiting > 0 && (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-white tabular-nums ring-2 ring-panel"
          >
            {waiting}
          </span>
        )}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      title={
        waiting ? `${waitingText(waiting)}. ${summary.detail}` : `${summary.detail} Klicka för att se vad agenten gjort.`
      }
      className={`flex w-full items-center gap-3 rounded-md py-2 pl-4 pr-3 text-left transition ${
        active ? 'bg-raised text-text' : 'text-muted hover:bg-raised/60 hover:text-text'
      }`}
    >
      <span className="flex w-4 shrink-0 justify-center">
        <Dot working={!!latest} summary={summary} />
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
