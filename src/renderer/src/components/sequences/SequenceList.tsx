import { useEffect, useState } from 'react'
import type { SequenceSummary } from '@shared/types'
import { formatSeconds, mediaUrl } from '../../lib/media'
import { CloseIcon, FilmIcon, PlusIcon } from './icons'

interface Props {
  sequences?: SequenceSummary[]
  selectedId?: string
  /** The open sequence is running "Generera saknade". */
  runningId?: string
  creating: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

export default function SequenceList({
  sequences,
  selectedId,
  runningId,
  creating,
  onSelect,
  onCreate,
  onDelete
}: Props) {
  const [confirming, setConfirming] = useState<string>()

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
          className="no-drag flex items-center gap-1 rounded-md px-2 py-1 text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          title="Skapa en ny sekvens"
        >
          <PlusIcon size={12} />
          Ny sekvens
        </button>
      </div>

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
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(s.id)
                }
              }}
              className={`group mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-md p-1.5 outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
                active ? 'bg-raised' : 'hover:bg-raised/60'
              }`}
            >
              <div className="relative flex h-10 w-[71px] shrink-0 items-center justify-center overflow-hidden rounded bg-black">
                {s.thumbPath ? (
                  <img src={mediaUrl(s.thumbPath)} draggable={false} className="h-full w-full object-cover" />
                ) : (
                  <FilmIcon size={16} className="text-muted/60" />
                )}
                {s.id === runningId && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`truncate ${active ? 'text-text' : ''}`}>{s.name}</p>
                <p className="text-[11px] text-muted">
                  {s.segmentCount} klipp
                  {s.totalDuration > 0 && ` · ${formatSeconds(s.totalDuration * 1000)}`}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirming(s.id)
                }}
                title="Radera sekvensen"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-line hover:text-accent focus:opacity-100 group-hover:opacity-100"
              >
                <CloseIcon size={11} />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
