import { useMemo } from 'react'
import type { FinishedWork, RunningWork, SequenceSummary } from '@shared/types'
import { formatSeconds } from '../../lib/media'
import { useOwnerWork, useRunning, useUnseen, useViewWork } from '../../lib/work'
import SideList, { SideListRow, SideListThumb, type SideRowControl } from '../library/SideList'
import MarkViewSeen from '../takes/MarkViewSeen'
import { ownerStatusText } from '../takes/takeText'
import { StatusMark } from '../work/StatusMark'
import { FilmIcon } from './icons'

interface Props {
  sequences?: SequenceSummary[]
  selectedId?: string
  creating: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  /** After the row's question (with the row that takes its place); throws to show the error there. */
  onDelete: (id: string, nextId: string | undefined) => Promise<void>
}

// Module-level, so the store's selectors keep one identity (and re-render only on a real change).
const inSequences = (w: RunningWork | FinishedWork) => w.view === 'sequences'

/** What runs and what is new, per sequence, for the rows' tooltips (the counts come from useOwnerWork). */
function useSequencesWork(): { running: Map<string, RunningWork[]>; unseen: Map<string, FinishedWork[]> } {
  const running = useRunning(inSequences)
  const unseen = useUnseen(inSequences)
  return useMemo(() => {
    const group = <T extends { ownerId?: string }>(items: readonly T[]) => {
      const out = new Map<string, T[]>()
      for (const w of items) if (w.ownerId) out.set(w.ownerId, [...(out.get(w.ownerId) ?? []), w])
      return out
    }
    return { running: group(running), unseen: group(unseen) }
  }, [running, unseen])
}

/** The sequences, newest change first, in the shared side list. */
export default function SequenceList({ sequences, selectedId, creating, onSelect, onCreate, onDelete }: Props) {
  const work = useSequencesWork()
  const view = useViewWork('sequences')
  const newCount = view.unseen + view.failed

  return (
    <SideList
      title="Sekvenser"
      createLabel="Ny sekvens"
      createTitle="Skapa en ny sekvens"
      onCreate={onCreate}
      creating={creating}
      headerExtra={newCount > 0 && <MarkViewSeen view="sequences" />}
      items={sequences}
      selectedId={selectedId}
      onSelect={onSelect}
      searchPlaceholder="Sök sekvenser"
      emptyText="Inga sekvenser ännu. En sekvens sätter ihop flera klipp till en längre video."
      deleteNote={() =>
        'Tagningarna och exporterade filmer finns kvar; sekvensens bilder som inget annat använder flyttas till papperskorgen.'
      }
      onDelete={(s, next) => onDelete(s.id, next?.id)}
      renderRow={(s, control) => (
        <SequenceRow sequence={s} control={control} running={work.running.get(s.id)} unseen={work.unseen.get(s.id)} />
      )}
    />
  )
}

const NONE: never[] = []

/**
 * One sequence: its cover, name and length, and – for every sequence, not only the open one – what is being made
 * there and what is new (a spinner with a count, then a dot).
 */
function SequenceRow({
  sequence: s,
  control,
  running = NONE,
  unseen = NONE
}: {
  sequence: SequenceSummary
  control: SideRowControl
  running?: RunningWork[]
  unseen?: FinishedWork[]
}) {
  const counts = useOwnerWork(s.id)
  return (
    <SideListRow
      control={control}
      visual={<SideListThumb path={s.thumbPath} fallback={<FilmIcon size={16} className="text-muted/60" />} />}
      name={s.name}
      meta={`${s.segmentCount} klipp${s.totalDuration > 0 ? ` · ${formatSeconds(s.totalDuration * 1000)}` : ''}`}
      status={<StatusMark variant="inline" running={counts.running} fresh={counts.unseen} failed={counts.failed} />}
      title={ownerStatusText('sequence', running, unseen, counts)}
      deleteTitle="Radera sekvensen"
    />
  )
}
