import { useMemo } from 'react'
import type { FinishedWork, RunningWork, StoryboardSummary } from '@shared/types'
import { useOwnerWork, useRunning, useUnseen, useViewWork } from '../../lib/work'
import SideList, { SideListRow, SideListThumb, type SideRowControl } from '../library/SideList'
import MarkViewSeen from '../takes/MarkViewSeen'
import { ownerStatusText } from '../takes/takeText'
import { StatusMark } from '../work/StatusMark'
import CreateStoryboardForm from './CreateStoryboardForm'
import { StoryboardIcon } from './icons'
import { boardCountLabel, clipProgressShort, DELETE_STORYBOARD_TEXT } from './storyboardUtils'

interface Props {
  storyboards?: StoryboardSummary[]
  selectedId?: string
  creating: boolean
  onSelect: (id: string) => void
  /** "New storyboard": only the format is asked; the name is given in the header afterwards. */
  onCreate: (aspectRatio: string) => Promise<boolean>
  /** After the row's question (with the row that takes its place); throws to show the error there. */
  onDelete: (id: string, nextId: string | undefined) => Promise<void>
}

// Module-level, so the store's selectors keep one identity (and re-render only on a real change).
const inStoryboards = (w: RunningWork | FinishedWork) => w.view === 'storyboards'

/** What runs and what is new, per storyboard, for the rows' tooltips (the counts come from useOwnerWork). */
function useStoryboardsWork(): { running: Map<string, RunningWork[]>; unseen: Map<string, FinishedWork[]> } {
  const running = useRunning(inStoryboards)
  const unseen = useUnseen(inStoryboards)
  return useMemo(() => {
    const group = <T extends { ownerId?: string }>(items: readonly T[]) => {
      const out = new Map<string, T[]>()
      for (const w of items) if (w.ownerId) out.set(w.ownerId, [...(out.get(w.ownerId) ?? []), w])
      return out
    }
    return { running: group(running), unseen: group(unseen) }
  }, [running, unseen])
}

/**
 * The storyboards, newest change first, in the shared side list, with "New storyboard" (the format; the name follows
 * in the header). Every row shows what is being made there and what is new, not only the open storyboard's.
 */
export default function StoryboardList({ storyboards, selectedId, creating, onSelect, onCreate, onDelete }: Props) {
  const work = useStoryboardsWork()
  const view = useViewWork('storyboards')
  const newCount = view.unseen + view.failed

  return (
    <SideList
      title="Storyboards"
      createLabel="New storyboard"
      createTitle="Create a new storyboard"
      creating={creating}
      createPanel={{
        width: 300,
        render: (close) => (
          <div className="p-4">
            <CreateStoryboardForm
              creating={creating}
              autoFocus
              onCreate={(aspect) =>
                void onCreate(aspect).then((ok) => {
                  if (ok) close()
                })
              }
            />
          </div>
        )
      }}
      headerExtra={newCount > 0 && <MarkViewSeen view="storyboards" />}
      items={storyboards}
      selectedId={selectedId}
      onSelect={onSelect}
      // No empty text: the view beside the list says what a storyboard is and how to start one.
      deleteNote={() => DELETE_STORYBOARD_TEXT}
      onDelete={(s, next) => onDelete(s.id, next?.id)}
      renderRow={(s, control) => (
        <StoryboardRow storyboard={s} control={control} running={work.running.get(s.id)} unseen={work.unseen.get(s.id)} />
      )}
    />
  )
}

const NONE: never[] = []

/** One storyboard: its cover, name and progress, what is being made there and what is new. */
function StoryboardRow({
  storyboard: s,
  control,
  running = NONE,
  unseen = NONE
}: {
  storyboard: StoryboardSummary
  control: SideRowControl
  running?: RunningWork[]
  unseen?: FinishedWork[]
}) {
  const counts = useOwnerWork(s.id)
  return (
    <SideListRow
      control={control}
      visual={<SideListThumb path={s.coverPath} fallback={<StoryboardIcon className="text-[16px] text-muted/60" />} />}
      name={s.name}
      // One number, to fit the row: the clips once there are any (one fewer than the boards), else the boards.
      meta={s.transitionCount ? clipProgressShort(s.doneCount, s.transitionCount) : boardCountLabel(s.boardCount)}
      status={<StatusMark variant="inline" running={counts.running} fresh={counts.unseen} failed={counts.failed} />}
      title={ownerStatusText('storyboard', running, unseen, counts)}
      deleteTitle="Delete storyboard"
    />
  )
}
