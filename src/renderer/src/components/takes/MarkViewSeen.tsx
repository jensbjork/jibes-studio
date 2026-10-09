import { markAllSeen } from '../../lib/work'
import { CheckAllIcon } from '../sequences/icons'

const VIEW_NAMES = { sequences: 'Sekvenser', storyboards: 'Storyboards' } as const

/**
 * "Markera alla som sedda" for a whole view, under its list's heading while something there is new (Sekvenser and
 * Storyboards share it; one sequence or storyboard is marked from its ⋯ menu). The Ångra toast follows.
 */
export default function MarkViewSeen({ view }: { view: keyof typeof VIEW_NAMES }) {
  return (
    <button
      type="button"
      onClick={() => void markAllSeen({ view })}
      title={`Tar bort markeringen Ny från allt i ${VIEW_NAMES[view]}`}
      aria-label={`Markera alla som sedda i ${VIEW_NAMES[view]}`}
      className="no-drag mx-2 mb-1 flex shrink-0 items-center gap-1.5 self-start rounded-md px-2 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-text"
    >
      <CheckAllIcon size={12} />
      Markera alla som sedda
    </button>
  )
}
