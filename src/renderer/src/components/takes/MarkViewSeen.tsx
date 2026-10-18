import { markAllSeen } from '../../lib/work'
import { CheckAllIcon } from '../sequences/icons'

const VIEW_NAMES = { sequences: 'Sequences', storyboards: 'Storyboards', editor: 'the Editor' } as const

/**
 * "Mark all as seen" for a whole view, under its list's heading while something there is new (Sequences,
 * Storyboards and the Editor share it; one sequence or storyboard is marked from its ⋯ menu). The Undo toast follows.
 */
export default function MarkViewSeen({ view }: { view: keyof typeof VIEW_NAMES }) {
  return (
    <button
      type="button"
      onClick={() => void markAllSeen({ view })}
      title={`Removes the New mark from everything in ${VIEW_NAMES[view]}`}
      aria-label={`Mark all as seen in ${VIEW_NAMES[view]}`}
      className="no-drag mx-2 mb-1 flex shrink-0 items-center gap-1.5 self-start rounded-md px-2 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-text"
    >
      <CheckAllIcon size={12} />
      Mark all as seen
    </button>
  )
}
