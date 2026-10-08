import { useRef, useState, type DragEvent } from 'react'
import type { EditSummary } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { carriesFiles, droppedVideoPaths, ImportCardView, useImportCards } from '../feed/ownClips'
import { FilmIcon } from '../sequences/icons'
import { secondaryButton } from '../storyboards/ui'
import { formatPrice, originLabel, summaryLine } from './editorUtils'
import { CameraIcon, ScissorsIcon } from './icons'

// Redigeringar: every edit as a card (poster, name, where it came from, versions, length, spent), and the ways to
// start one: an own film (file dialog, or dropped on the list), a clip from the feed, an exported film.

interface Props {
  edits?: EditSummary[]
  error?: string
  /** Paths of own films this view is importing (their progress cards show here). */
  importing: ReadonlySet<string>
  busy?: string
  onOpen: (editId: string) => void
  onOwnFilm: () => void
  onDropFiles: (paths: string[], hadOther: boolean) => void
  onFromFeed: () => void
  onFromExport: () => void
}

export default function EditList({
  edits,
  error,
  importing,
  busy,
  onOpen,
  onOwnFilm,
  onDropFiles,
  onFromFeed,
  onFromExport
}: Props) {
  const cards = useImportCards().filter((c) => importing.has(c.path))
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const onDragEnter = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current += 1
    setOver(true)
  }
  const onDragLeave = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setOver(false)
  }
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const { paths, other } = droppedVideoPaths(e)
    onDropFiles(paths, other)
  }

  const empty = edits?.length === 0 && cards.length === 0
  const actions = (
    <>
      <button type="button" onClick={onOwnFilm} disabled={!!busy} className={secondaryButton}>
        <CameraIcon size={13} />
        Öppna en egen film…
      </button>
      <button type="button" onClick={onFromFeed} disabled={!!busy} className={secondaryButton}>
        Från klippflödet…
      </button>
      <button type="button" onClick={onFromExport} disabled={!!busy} className={secondaryButton}>
        Från en export…
      </button>
    </>
  )

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line pl-5 pr-3">
        <h1 className="font-medium">Redigeringar</h1>
        {busy && <span className="ml-2 text-[12px] text-muted">{busy}</span>}
        {!empty && <div className="no-drag ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {error && <p className="mx-5 mt-3 text-[12px] text-accent select-text">{error}</p>}

      {empty ? (
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
          <div className="max-w-md text-center">
            <ScissorsIcon size={30} className="mx-auto mb-4 text-muted" />
            <h2 className="mb-2 text-base font-semibold">Redigera en film</h2>
            <p className="leading-relaxed text-muted">
              Öppna ett klipp från Generera, en exporterad film eller en egen film för att ändra den med AI. Originalet
              lämnas orört — varje ändring blir en ny version.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>
            <p className="mt-4 text-[11px] text-muted">Du kan också släppa en filmfil här.</p>
          </div>
        </div>
      ) : !edits ? (
        <div className="flex flex-1 items-center justify-center text-muted">Hämtar redigeringar…</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
            {cards.map((card) => (
              <div key={card.path} className="overflow-hidden rounded-lg border border-line bg-panel">
                <div className="aspect-video bg-black/40">
                  <ImportCardView card={card} compact />
                </div>
                <div className="px-3 py-2.5 text-[11px] text-muted">Egen film · importeras</div>
              </div>
            ))}
            {edits.map((e) => (
              <EditCard key={e.id} edit={e} onOpen={() => onOpen(e.id)} />
            ))}
          </div>
        </div>
      )}

      {over && (
        <div className="pointer-events-none absolute inset-3 top-14 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-bg/80">
          <p className="text-base">Släpp för att öppna som egen film</p>
        </div>
      )}
    </div>
  )
}

function EditCard({ edit, onOpen }: { edit: EditSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group overflow-hidden rounded-lg border border-line bg-panel text-left outline-none transition hover:border-muted/60 focus-visible:ring-1 focus-visible:ring-muted"
    >
      <div className="relative flex aspect-video items-center justify-center bg-black">
        {edit.posterPath ? (
          <img src={mediaUrl(edit.posterPath)} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <FilmIcon size={22} className="text-muted/50" />
        )}
        {edit.running && (
          <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Pågår…
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <p className="truncate font-medium">{edit.name}</p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted">
          {edit.origin.kind === 'import' && <CameraIcon size={11} className="shrink-0" />}
          <span className="truncate">
            {originLabel(edit.origin)}
            {edit.origin.missing && ' (borta)'}
          </span>
        </p>
        <p className="mt-0.5 text-[11px] tabular-nums text-muted">{summaryLine(edit)}</p>
      </div>
    </button>
  )
}
