import { useMemo, useState, type DragEvent } from 'react'
import type { FinishedWork, RunningWork, SequenceSummary } from '@shared/types'
import { useOwnerWork, useRunning, useUnseen, useViewWork } from '../../lib/work'
import { AUDIO_EXT, AUDIO_FORMATS } from '../assets/audioUtils'
import { carriesFiles } from '../feed/ownClips'
import SideList, { SideListRow, SideListThumb, type SideRowControl } from '../library/SideList'
import MarkViewSeen from '../takes/MarkViewSeen'
import { ownerStatusText } from '../takes/takeText'
import { menuRow, onMenuKeyDown } from '../ui/menu'
import { StatusMark } from '../work/StatusMark'
import { FilmIcon, NoteIcon } from './icons'
import { DELETE_SEQUENCE_TEXT } from './SequenceHeader'
import { formatLength } from './sequenceUtils'

interface Props {
  sequences?: SequenceSummary[]
  selectedId?: string
  creating: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  /** "From a song…" in the ＋ menu: pick an audio file, then the song's dialog. */
  onCreateFromSong: () => void
  /** An audio file dropped on the list: a new sequence from it (the song's dialog). */
  onDropSong: (path: string) => void
  /** Something dropped on the list that isn't a song. */
  onDropProblem: (message: string) => void
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

/**
 * The sequences, newest change first, in the shared side list. "＋ New sequence" offers an empty one or one from a
 * song, and a song dropped on the list starts one from it.
 */
export default function SequenceList({
  sequences,
  selectedId,
  creating,
  onSelect,
  onCreate,
  onCreateFromSong,
  onDropSong,
  onDropProblem,
  onDelete
}: Props) {
  const work = useSequencesWork()
  const view = useViewWork('sequences')
  const newCount = view.unseen + view.failed
  const [dropping, setDropping] = useState(false)

  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.studio.pathForFile(f))
      .filter((p) => !!p)
    const song = paths.find((p) => AUDIO_EXT.test(p))
    if (song) onDropSong(song)
    else if (paths.length) onDropProblem(`Drop a song (${AUDIO_FORMATS}) to make a sequence from it.`)
  }

  const list = (
    <SideList
      title="Sequences"
      createLabel="New sequence"
      createTitle="Create a new sequence, empty or from a song"
      onCreate={onCreate}
      onCreateRequest={onCreate}
      createPanel={{
        width: 260,
        popup: 'menu',
        render: (close) => (
          <div role="menu" aria-label="New sequence" onKeyDown={onMenuKeyDown} className="p-1">
            <button
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus
              onClick={() => {
                close()
                onCreate()
              }}
              className={`${menuRow} flex-col items-start gap-0.5`}
            >
              <span>Empty sequence</span>
              <span className="text-[11px] leading-snug text-muted">Add the clips one by one.</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => {
                close()
                onCreateFromSong()
              }}
              className={`${menuRow} flex-col items-start gap-0.5`}
            >
              <span className="flex items-center gap-1.5">
                <NoteIcon size={12} className="shrink-0 text-violet-300" />
                From a song…
              </span>
              <span className="text-[11px] leading-snug text-muted">
                A music video: the song is split into clips on the beat, and the film plays it.
              </span>
            </button>
          </div>
        )
      }}
      creating={creating}
      headerExtra={newCount > 0 && <MarkViewSeen view="sequences" />}
      items={sequences}
      selectedId={selectedId}
      onSelect={onSelect}
      // No empty text: the view beside the list says what a sequence is and how to start one.
      deleteNote={() => DELETE_SEQUENCE_TEXT}
      onDelete={(s, next) => onDelete(s.id, next?.id)}
      renderRow={(s, control) => (
        <SequenceRow sequence={s} control={control} running={work.running.get(s.id)} unseen={work.unseen.get(s.id)} />
      )}
    />
  )

  return (
    <div
      className="relative flex shrink-0"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={onDrop}
    >
      {list}
      {dropping && (
        <div className="pointer-events-none absolute inset-1 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-accent/70 bg-bg/90 px-4 text-center">
          <NoteIcon size={20} className="text-violet-300" />
          <span className="text-[12px]">Drop a song to make a sequence from it</span>
        </div>
      )}
    </div>
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
      meta={`${s.segmentCount} ${s.segmentCount === 1 ? 'clip' : 'clips'}${s.totalDuration > 0 ? ` · ${formatLength(s.totalDuration)}` : ''}`}
      status={<StatusMark variant="inline" running={counts.running} fresh={counts.unseen} failed={counts.failed} />}
      title={ownerStatusText('sequence', running, unseen, counts)}
      deleteTitle="Delete sequence"
    />
  )
}
