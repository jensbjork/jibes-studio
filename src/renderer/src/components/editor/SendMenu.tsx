import { useEffect, useState } from 'react'
import type { EditOrigin, SequenceSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { FilmIcon, PlusIcon } from '../sequences/icons'
import { menuRow, onMenuKeyDown, SubView } from '../storyboards/ui'

// "Send to": a version into Sequences — as a new take of the clip the film came from (when it was a take), or as
// a new clip at the end of any sequence (or a new one). The version is used where it is; nothing is copied.

export interface SentTo {
  sequenceId: string
  segmentId: string
  /** "“Beach scene” (clip 4)": for the notice. */
  where: string
}

export default function SendMenu({
  versionId,
  origin,
  onSent,
  onError
}: {
  versionId: string
  origin: EditOrigin
  onSent: (sent: SentTo) => void
  onError: (message: string) => void
}) {
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const asTake = origin.kind === 'take' && origin.segmentId && !origin.missing

  const send = async (target: { segmentId: string } | { sequenceId: string }, name: string) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.studio.sendEditToSequence(versionId, target)
      const sequence = await window.studio.getSequence(result.sequenceId).catch(() => undefined)
      const index = sequence?.segments.findIndex((s) => s.id === result.segmentId) ?? -1
      onSent({ ...result, where: `“${sequence?.name ?? name}”${index >= 0 ? ` (clip ${index + 1})` : ''}` })
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (picking) {
    return (
      <SubView title="As a new clip at the end of…" onBack={() => setPicking(false)}>
        <SequenceChoice busy={busy} onPick={(id, name) => void send({ sequenceId: id }, name)} onError={onError} />
      </SubView>
    )
  }

  return (
    <div role="menu" aria-label="Send to" onKeyDown={onMenuKeyDown} className="p-1">
      {asTake && (
        <button
          type="button"
          role="menuitem"
          data-menu-item
          autoFocus
          disabled={busy}
          onClick={() => void send({ segmentId: origin.segmentId! }, origin.sequenceName ?? '')}
          className={`${menuRow} flex-col items-start gap-0.5`}
        >
          <span>
            As a new take of clip {origin.clipNumber ?? ''} in “{origin.sequenceName ?? 'the sequence'}”
          </span>
          <span className="text-[11px] leading-snug text-muted">It’s selected in the clip; the old take is kept.</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-menu-item
        autoFocus={!asTake}
        onClick={() => setPicking(true)}
        className={`${menuRow} flex-col items-start gap-0.5`}
      >
        <span>As a new clip in a sequence…</span>
        <span className="text-[11px] leading-snug text-muted">Added at the end; the next AI clip can continue from it.</span>
      </button>
    </div>
  )
}

function SequenceChoice({
  busy,
  onPick,
  onError
}: {
  busy: boolean
  onPick: (sequenceId: string, name: string) => void
  onError: (message: string) => void
}) {
  const [sequences, setSequences] = useState<SequenceSummary[]>()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    window.studio.listSequences().then(setSequences, (e: unknown) => {
      setSequences([])
      onError(ipcErrorMessage(e))
    })
  }, [])

  const create = async () => {
    if (creating || busy) return
    setCreating(true)
    try {
      const sequence = await window.studio.createSequence(name.trim())
      onPick(sequence.id, sequence.name)
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="max-h-64 min-h-0 overflow-y-auto p-1">
        {!sequences ? (
          <p className="px-3 py-3 text-center text-muted">Loading sequences…</p>
        ) : sequences.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-muted">No sequences yet – create one below.</p>
        ) : (
          sequences.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => onPick(s.id, s.name)}
              className={menuRow}
            >
              <span className="flex h-6 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-black">
                {s.thumbPath ? (
                  <img src={mediaUrl(s.thumbPath)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <FilmIcon size={12} className="text-muted" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-[11px] text-muted">{s.segmentCount} {s.segmentCount === 1 ? 'clip' : 'clips'}</span>
            </button>
          ))
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
        className="flex items-center gap-1.5 border-t border-line p-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New sequence"
          aria-label="Name of the new sequence"
          className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2 py-1 text-[12px] outline-none focus:border-muted"
        />
        <button
          type="submit"
          disabled={creating || busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
        >
          <PlusIcon size={11} />
          Create
        </button>
      </form>
    </div>
  )
}
