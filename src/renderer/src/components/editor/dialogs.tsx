import { useEffect, useState } from 'react'
import type { EditSummary, ExportSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Modal from '../pickers/Modal'
import { FilmIcon } from '../sequences/icons'
import { fileName, formatLength, formatPrice, summaryLine } from './editorUtils'

// The Editor's two small dialogs: picking an exported film ("From an export…"), and choosing between the edits that
// already exist for a film and a new one.

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "From an export…": the films exported from sequences and storyboards that are still on disk, newest first. */
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
      title="Edit an exported film"
      subtitle="The film is copied into the edit as its original; the export is left untouched."
      onClose={onClose}
      maxWidth={520}
    >
      {error && <p className="mb-3 text-[12px] text-accent select-text">{error}</p>}
      {!exports ? (
        <p className="py-4 text-center text-muted">Loading exports…</p>
      ) : exports.length === 0 ? (
        <p className="py-4 leading-relaxed text-muted">
          No exported films yet. Export a sequence or a storyboard first – then you can edit the film here.
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
                    {e.cuts?.length ? ` · ${e.cuts.length + 1} clips` : ''}
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
      title="This film is already being edited"
      subtitle="Continue where you left off, or start over from the original in a new edit."
      onClose={onClose}
      maxWidth={480}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Cancel
          </button>
          <button
            type="button"
            onClick={onNew}
            className="rounded-md border border-line px-4 py-2 transition hover:bg-raised"
          >
            New edit
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
                <span className="block truncate">Open the edit “{e.name}”</span>
                <span className="block truncate text-[11px] text-muted">{summaryLine(e)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
