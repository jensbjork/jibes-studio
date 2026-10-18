import { useEffect, useRef, useState } from 'react'
import { generationTitle } from '@shared/generation-label'
import type { Generation, Sequence, SequenceSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { formatDuration, titleFromPrompt } from './text'

export interface AddedToSequence {
  sequence: Sequence
  /** 1-based position of the new clip. */
  clipNumber: number
  segmentId: string
}

interface Props {
  generation: Generation
  onAdded: (result: AddedToSequence) => void
}

/** Popover content: add a generation as a new clip at the end of an existing or new sequence. */
export default function SequencePicker({ generation, onAdded }: Props) {
  const [sequences, setSequences] = useState<SequenceSummary[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [creating, setCreating] = useState(false)
  // Prefilled from the prompt (an own film's or a version's title) so Enter alone gives a sensible name; selected on
  // focus to type over.
  const [name, setName] = useState(() =>
    generation.title?.trim() ? generationTitle(generation, 32) : titleFromPrompt(generation.prompt, 4, 32)
  )

  useEffect(() => {
    window.studio.listSequences().then(
      (list) => {
        setSequences(list)
        if (!list.length) setCreating(true)
      },
      (e) => {
        setSequences([])
        setError(ipcErrorMessage(e))
      }
    )
  }, [])

  const add = async (sequenceId: string) => {
    const sequence = await window.studio.addSegment(sequenceId, { fromGenerationId: generation.id })
    // The new clip is the last one using this generation (it may already be in the sequence once).
    const target =
      sequence.segments.filter((s) => s.selectedGenerationId === generation.id).at(-1) ?? sequence.segments.at(-1)
    if (!target) throw new Error('The clip couldn’t be added.')
    onAdded({ sequence, clipNumber: target.position + 1, segmentId: target.id })
  }

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(ipcErrorMessage(e))
      setBusy(undefined)
    }
  }

  // If adding fails after the sequence was created, a retry reuses it instead of making another one.
  const created = useRef<string>(undefined)
  const create = () =>
    run('new', async () => {
      created.current ??= (await window.studio.createSequence(name.trim())).id
      await add(created.current)
    })

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <p className="font-medium">Add to sequence</p>
        <p className="mt-0.5 text-[11px] text-muted">The video becomes a new clip at the end of the sequence.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!sequences ? (
          <p className="px-3 py-4 text-center text-muted">Loading sequences…</p>
        ) : sequences.length === 0 ? (
          <p className="px-3 py-4 text-center text-muted">No sequences yet – create one below.</p>
        ) : (
          sequences.map((s) => (
            <button
              key={s.id}
              onClick={() => run(s.id, () => add(s.id))}
              disabled={!!busy}
              className="flex w-full items-center gap-3 rounded-md p-1.5 text-left hover:bg-raised disabled:opacity-60"
            >
              <span className="flex aspect-video w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-raised text-muted">
                {s.thumbPath ? <img src={mediaUrl(s.thumbPath)} className="h-full w-full object-cover" /> : '▤'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.name}</span>
                <span className="block text-[11px] text-muted">
                  {busy === s.id
                    ? 'Adding…'
                    : `${s.segmentCount} ${s.segmentCount === 1 ? 'clip' : 'clips'} · ${formatDuration(s.totalDuration)}`}
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      {error && <p className="border-t border-line px-3 py-2 text-[12px] text-accent select-text">{error}</p>}

      <div className="border-t border-line p-2">
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
            className="flex gap-1.5"
          >
            <input
              autoFocus
              value={name}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name of the sequence"
              className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
            />
            <button
              type="submit"
              disabled={!!busy}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {busy === 'new' ? 'Creating…' : 'Create'}
            </button>
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            disabled={!!busy}
            className="w-full rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          >
            ＋ New sequence…
          </button>
        )}
      </div>
    </>
  )
}
