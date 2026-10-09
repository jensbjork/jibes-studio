import { useEffect, useMemo, useState } from 'react'
import type { FinishedWork, RunningWork, SequenceSummary } from '@shared/types'
import { formatSeconds, mediaUrl } from '../../lib/media'
import { useOwnerWork, useRunning, useUnseen, useViewWork } from '../../lib/work'
import MarkViewSeen from '../takes/MarkViewSeen'
import { ownerStatusText } from '../takes/takeText'
import { StatusMark } from '../work/StatusMark'
import { CloseIcon, FilmIcon, PlusIcon } from './icons'

interface Props {
  sequences?: SequenceSummary[]
  selectedId?: string
  creating: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
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

export default function SequenceList({ sequences, selectedId, creating, onSelect, onCreate, onDelete }: Props) {
  const [confirming, setConfirming] = useState<string>()
  const work = useSequencesWork()
  const view = useViewWork('sequences')
  const newCount = view.unseen + view.failed

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(undefined), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line">
      <div className="drag flex h-12 shrink-0 items-center justify-between pl-4 pr-2.5">
        <span className="font-medium">Sekvenser</span>
        <button
          onClick={onCreate}
          disabled={creating}
          className="no-drag flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          title="Skapa en ny sekvens"
        >
          <PlusIcon size={12} />
          Ny sekvens
        </button>
      </div>
      {newCount > 0 && <MarkViewSeen view="sequences" />}

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {sequences?.length === 0 && (
          <p className="px-2 py-2 text-[12px] leading-relaxed text-muted">
            Inga sekvenser ännu. En sekvens sätter ihop flera klipp till en längre video.
          </p>
        )}
        {sequences?.map((s) => {
          const active = s.id === selectedId
          if (confirming === s.id) {
            return (
              <div key={s.id} className="mb-0.5 rounded-md border border-accent/40 bg-raised p-2">
                <p className="mb-2 truncate text-[12px]">Radera ”{s.name}”?</p>
                <p className="mb-2 text-[11px] leading-snug text-muted">
                  Klippen försvinner, men videorna finns kvar under Generera.
                </p>
                <div className="flex gap-1.5">
                  <button
                    autoFocus
                    onClick={() => {
                      setConfirming(undefined)
                      onDelete(s.id)
                    }}
                    className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-accent-hover"
                  >
                    Radera
                  </button>
                  <button
                    onClick={() => setConfirming(undefined)}
                    className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-line hover:text-text"
                  >
                    Avbryt
                  </button>
                </div>
              </div>
            )
          }
          return (
            <SequenceRow
              key={s.id}
              sequence={s}
              active={active}
              running={work.running.get(s.id)}
              unseen={work.unseen.get(s.id)}
              onSelect={() => onSelect(s.id)}
              onDelete={() => setConfirming(s.id)}
            />
          )
        })}
      </div>
    </aside>
  )
}

const NONE: never[] = []

/**
 * One sequence: its cover, name and length, and – for every sequence, not only the open one – what is being made
 * there and what is new (a spinner with a count, then a dot). On hover the ✕ that deletes it takes that place.
 */
function SequenceRow({
  sequence: s,
  active,
  running = NONE,
  unseen = NONE,
  onSelect,
  onDelete
}: {
  sequence: SequenceSummary
  active: boolean
  running?: RunningWork[]
  unseen?: FinishedWork[]
  onSelect: () => void
  onDelete: () => void
}) {
  const counts = useOwnerWork(s.id)
  const status = ownerStatusText('sequence', running, unseen, counts)
  const marked = counts.running + counts.unseen + counts.failed > 0
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      title={status}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`group mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-md p-1.5 outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
        active ? 'bg-raised' : 'hover:bg-raised/60'
      }`}
    >
      <div className="relative flex h-10 w-[71px] shrink-0 items-center justify-center overflow-hidden rounded bg-black">
        {s.thumbPath ? (
          <img src={mediaUrl(s.thumbPath)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <FilmIcon size={16} className="text-muted/60" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate ${active ? 'text-text' : ''}`}>{s.name}</p>
        <p className="text-[11px] text-muted">
          {s.segmentCount} klipp
          {s.totalDuration > 0 && ` · ${formatSeconds(s.totalDuration * 1000)}`}
        </p>
      </div>
      <span className="relative flex h-6 min-w-6 shrink-0 items-center justify-end">
        {marked && (
          // Steps aside only where the ✕ takes its place (hover, or the ✕ itself focused) – never just because the
          // row has the focus after a click, which would leave the slot empty.
          <span className="flex items-center transition-opacity group-hover:opacity-0 group-has-[button:focus]:opacity-0">
            <StatusMark
              variant="inline"
              running={counts.running}
              fresh={counts.unseen}
              failed={counts.failed}
              title={status}
            />
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Radera sekvensen"
          aria-label={`Radera ${s.name}`}
          className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition hover:bg-line hover:text-accent focus:opacity-100 group-hover:opacity-100"
        >
          <CloseIcon size={11} />
        </button>
      </span>
    </div>
  )
}
