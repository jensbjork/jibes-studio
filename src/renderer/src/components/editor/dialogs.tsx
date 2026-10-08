import { useEffect, useState } from 'react'
import type { EditSummary, ExportSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Modal from '../pickers/Modal'
import { FilmIcon } from '../sequences/icons'
import { fileName, formatLength, formatPrice, summaryLine } from './editorUtils'

// Redigera's two small dialogs: picking an exported film ("Från en export…"), and choosing between the edits that
// already exist for a film and a new one.

const dateFormat = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "Från en export…": the films exported from sequences and storyboards that are still on disk, newest first. */
export function ExportPickerDialog({ onClose, onPicked }: { onClose: () => void; onPicked: (e: ExportSummary) => void }) {
  const [exports, setExports] = useState<ExportSummary[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    window.studio.listExports().then(
      (list) => setExports(list.filter((e) => e.exists).sort((a, b) => b.createdAt - a.createdAt)),
      (e: unknown) => {
        setExports([])
        setError(ipcErrorMessage(e))
      }
    )
  }, [])

  return (
    <Modal
      title="Redigera en exporterad film"
      subtitle="Filmen kopieras in i redigeringen som original; exporten lämnas orörd."
      onClose={onClose}
      maxWidth={520}
    >
      {error && <p className="mb-3 text-[12px] text-accent select-text">{error}</p>}
      {!exports ? (
        <p className="py-4 text-center text-muted">Hämtar exporter…</p>
      ) : exports.length === 0 ? (
        <p className="py-4 leading-relaxed text-muted">
          Inga exporterade filmer än. Exportera en sekvens eller en storyboard först – sedan kan du redigera filmen här.
        </p>
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {exports.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onPicked(e)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition hover:bg-raised"
              >
                <FilmIcon size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{e.sequenceName ?? fileName(e.path)}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {dateFormat.format(e.createdAt)}
                    {e.duration !== undefined && ` · ${formatLength(e.duration)}`}
                    {e.cuts?.length ? ` · ${e.cuts.length + 1} klipp` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/** A film that already has edits: open one of them, or start a new one. */
export function OpenChoiceDialog({
  edits,
  onOpen,
  onNew,
  onClose
}: {
  edits: EditSummary[]
  onOpen: (editId: string) => void
  onNew: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title="Filmen redigeras redan"
      subtitle="Fortsätt där du var, eller börja om från originalet i en ny redigering."
      onClose={onClose}
      maxWidth={480}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Avbryt
          </button>
          <button
            type="button"
            onClick={onNew}
            className="rounded-md border border-line px-4 py-2 transition hover:bg-raised"
          >
            Ny redigering
          </button>
        </>
      }
    >
      <ul className="-mx-2 space-y-1">
        {edits.map((e, i) => (
          <li key={e.id}>
            <button
              type="button"
              autoFocus={i === 0}
              onClick={() => onOpen(e.id)}
              className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition hover:bg-raised"
            >
              <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-black">
                {e.posterPath ? (
                  <img src={mediaUrl(e.posterPath)} alt="" className="h-full w-full object-contain" />
                ) : (
                  <FilmIcon size={14} className="text-muted" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">Öppna redigeringen ”{e.name}”</span>
                <span className="block truncate text-[11px] text-muted">{summaryLine(e)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
