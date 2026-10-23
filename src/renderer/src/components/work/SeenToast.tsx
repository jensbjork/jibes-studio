import { useState } from 'react'
import { useAgentPillVisible } from '../../lib/agent'
import { dismissSeenToast, useSeenToast } from '../../lib/work'
import { CloseIcon } from '../sequences/icons'

/**
 * "7 marked as seen · Undo" after Mark all as seen, for ten seconds, at the bottom of the work area.
 * Lifted above the agent's presence pill while it shows, so the two never cover each other, and beside the panel
 * next to the sidebar while one is open (Activity's own Mark all starts it), so it never covers the panel's rows.
 */
export default function SeenToast({ besidePanel = false }: { besidePanel?: boolean }) {
  const toast = useSeenToast()
  const lifted = useAgentPillVisible()
  const [undoing, setUndoing] = useState(false)
  if (!toast) return null

  const undo = toast.undo
  return (
    <div
      className={`pointer-events-none fixed right-0 z-50 flex justify-center px-4 ${
        // The panel (SidePanel): 8 px in from the sidebar, 360 px wide.
        besidePanel ? 'left-[calc(var(--sidebar-w)+368px)]' : 'left-[var(--sidebar-w)]'
      } ${lifted ? 'bottom-20' : 'bottom-5'}`}
    >
      <div
        role="status"
        className="no-drag pointer-events-auto flex max-w-md items-center gap-3 rounded-full border border-line bg-panel/95 py-1.5 pl-4 pr-1.5 text-sm shadow-lg shadow-black/40 backdrop-blur"
      >
        <span className={`min-w-0 truncate ${toast.error ? 'text-danger' : ''}`}>{toast.text}</span>
        {undo && (
          <button
            disabled={undoing}
            onClick={() => {
              setUndoing(true)
              void undo().finally(() => setUndoing(false))
            }}
            className="rounded-full px-2.5 py-1 font-medium text-text transition hover:bg-raised disabled:opacity-60"
          >
            Undo
          </button>
        )}
        <button
          onClick={dismissSeenToast}
          title="Close"
          aria-label="Close"
          className="rounded-full p-1.5 text-muted transition hover:bg-raised hover:text-text"
        >
          <CloseIcon size={11} />
        </button>
      </div>
    </div>
  )
}
