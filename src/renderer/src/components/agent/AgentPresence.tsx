import { useEffect, useState } from 'react'
import type { AgentActivity } from '@shared/types'
import { useAgentWorking } from '../../lib/agent'
import { presenceText } from './agentText'

interface Props {
  /** The activity drawer is open: it shows the same thing, so the pill steps aside. */
  hidden: boolean
  onOpen: () => void
}

/**
 * A small pill at the bottom of the window while an agent works: a pulsing dot, "Agenten arbetar" and what it just
 * did, with the step before it fading above. It fades out a few seconds after the agent goes quiet; a click opens
 * the activity drawer.
 */
export default function AgentPresence({ hidden, onOpen }: Props) {
  const working = useAgentWorking()
  // Keep the last steps while fading out, so the pill doesn't go blank as it disappears.
  const [shown, setShown] = useState<AgentActivity[]>([])
  useEffect(() => {
    if (working.length) setShown(working.slice(0, 2))
  }, [working])

  const visible = working.length > 0 && !hidden
  const [latest, previous] = shown
  if (!latest) return null

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center transition-all duration-500 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
      aria-hidden={!visible}
    >
      <button
        onClick={onOpen}
        tabIndex={visible ? 0 : -1}
        title="Se allt agenten gjort"
        className={`flex max-w-md items-center gap-3 rounded-full border border-line bg-panel/95 py-2 pl-3.5 pr-4 text-left text-sm shadow-lg shadow-black/40 backdrop-blur ${
          visible ? 'pointer-events-auto' : ''
        }`}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
        <span className="min-w-0">
          {previous && <span className="block truncate text-xs text-muted/70">{presenceText(previous)}</span>}
          <span className="block truncate">
            <span className="font-medium text-text">Agenten arbetar</span>
            <span className="text-muted"> · {presenceText(latest)}</span>
          </span>
        </span>
      </button>
    </div>
  )
}
