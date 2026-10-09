import { useEffect, useMemo, useRef, useState } from 'react'
import type { FinishedWork, RunningWork, StoryboardSummary } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { useOwnerWork, useRunning, useUnseen, useViewWork } from '../../lib/work'
import Popover from '../pickers/Popover'
import { CloseIcon, PlusIcon } from '../sequences/icons'
import MarkViewSeen from '../takes/MarkViewSeen'
import { ownerStatusText } from '../takes/takeText'
import { StatusMark } from '../work/StatusMark'
import CreateStoryboardForm from './CreateStoryboardForm'
import { StoryboardIcon } from './icons'
import { boardCountLabel } from './storyboardUtils'

interface Props {
  storyboards?: StoryboardSummary[]
  selectedId?: string
  creating: boolean
  onSelect: (id: string) => void
  onCreate: (name: string, aspectRatio: string) => Promise<boolean>
  onDelete: (id: string) => void
}

/** "2 av 3 klipp klara", "3 klipp", or nothing while there are no transitions. */
function progressLabel(s: StoryboardSummary): string | undefined {
  if (!s.transitionCount) return undefined
  return s.doneCount === s.transitionCount
    ? `${s.transitionCount} klipp`
    : `${s.doneCount} av ${s.transitionCount} klipp klara`
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
 * The storyboards, newest change first, with "Ny storyboard" (name and format) and deleting (asked twice). Every row
 * shows what is being made there and what is new, not only the open storyboard's.
 */
export default function StoryboardList({ storyboards, selectedId, creating, onSelect, onCreate, onDelete }: Props) {
  const [confirming, setConfirming] = useState<string>()
  const [createOpen, setCreateOpen] = useState(false)
  const createButton = useRef<HTMLButtonElement>(null)
  const work = useStoryboardsWork()
  const view = useViewWork('storyboards')
  const newCount = view.unseen + view.failed

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(undefined), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line">
      <div className="drag flex h-12 shrink-0 items-center justify-between pl-4 pr-2.5">
        <span className="font-medium">Storyboards</span>
        <button
          ref={createButton}
          onClick={() => setCreateOpen((open) => !open)}
          disabled={creating}
          aria-haspopup="dialog"
          aria-expanded={createOpen}
          className="no-drag flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          title="Skapa en ny storyboard"
        >
          <PlusIcon size={12} />
          Ny storyboard
        </button>
      </div>
      {newCount > 0 && <MarkViewSeen view="storyboards" />}
      <Popover
        anchorRef={createButton}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        width={300}
        label="Ny storyboard"
      >
        <div className="p-4">
          <CreateStoryboardForm
            creating={creating}
            autoFocus
            onCreate={(name, aspect) =>
              void onCreate(name, aspect).then((ok) => {
                if (ok) setCreateOpen(false)
              })
            }
          />
        </div>
      </Popover>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {storyboards?.length === 0 && (
          <p className="px-2 py-2 text-[12px] leading-relaxed text-muted">
            Inga storyboards ännu. Lägg upp filmens viktiga ögonblick som bilder och generera klippen mellan dem.
          </p>
        )}
        {storyboards?.map((s) => {
          const active = s.id === selectedId
          if (confirming === s.id) {
            return (
              <div key={s.id} className="mb-0.5 rounded-md border border-accent/40 bg-raised p-2">
                <p className="mb-2 truncate text-[12px]">Radera ”{s.name}”?</p>
                <p className="mb-2 text-[11px] leading-snug text-muted">
                  Rutorna försvinner, men klippen finns kvar under Generera. Bilder som inget annat använder flyttas
                  till papperskorgen.
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
            <StoryboardRow
              key={s.id}
              storyboard={s}
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

/** One storyboard: its cover, name and progress, what is being made there and what is new; ✕ on hover deletes it. */
function StoryboardRow({
  storyboard: s,
  active,
  running = NONE,
  unseen = NONE,
  onSelect,
  onDelete
}: {
  storyboard: StoryboardSummary
  active: boolean
  running?: RunningWork[]
  unseen?: FinishedWork[]
  onSelect: () => void
  onDelete: () => void
}) {
  const counts = useOwnerWork(s.id)
  const status = ownerStatusText('storyboard', running, unseen, counts)
  const marked = counts.running + counts.unseen + counts.failed > 0
  const progress = progressLabel(s)
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
        {s.coverPath ? (
          <img src={mediaUrl(s.coverPath)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <StoryboardIcon className="text-[16px] text-muted/60" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate ${active ? 'text-text' : ''}`}>{s.name}</p>
        <p className="truncate text-[11px] text-muted">
          {boardCountLabel(s.boardCount)}
          {progress && ` · ${progress}`}
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
          title="Radera storyboarden"
          aria-label={`Radera ${s.name}`}
          className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition hover:bg-line hover:text-accent focus:opacity-100 group-hover:opacity-100"
        >
          <CloseIcon size={11} />
        </button>
      </span>
    </div>
  )
}
