import { useRef, useState } from 'react'
import type { Sequence } from '@shared/types'
import { ipcErrorMessage, useSeparationStatus } from '../../../lib/hooks'
import { formatUsd } from '../../../lib/media'
import { THIS_COMPUTER } from '../../../lib/platform'
import Popover from '../../pickers/Popover'
import { buttonClass } from '../../ui/button'
import { NoteIcon } from '../icons'
import { formatFrameTime } from '../sequenceUtils'
import { placedClips, workText } from './songText'
import { TranscribePanel, type TranscribeOptions } from './TranscribeLyrics'
import { useSongOverview } from './useSongOverview'

interface Props {
  /** A sequence with a song. */
  sequence: Sequence
  /** "Replace the song…": pick another file (the import dialog follows). */
  onReplace: () => void
  /** "Remove the song", after its question; rejects with main's refusal, shown in the panel. */
  onRemove: () => Promise<void>
  /** "Separate the vocals" (free); rejects with main's refusal. */
  onSeparate: () => Promise<unknown>
  /** "Transcribe the lyrics…" / "Transcribe again…" (paid, through the budget question). */
  onTranscribe: (opts: TranscribeOptions) => Promise<unknown>
  /** A failure once the panel has closed. */
  onError: (message: string) => void
}

type View = 'facts' | 'transcribe' | 'remove'

const rowButton =
  'shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-text transition hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * "Song" in the sequence header, beside Cast: what the song is (its name, length, tempo), whether the vocals are
 * separated and the lyrics transcribed (with those steps, again if need be), and replacing or removing it.
 */
export default function SongChip({ sequence, onReplace, onRemove, onSeparate, onTranscribe, onError }: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('facts')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { overview } = useSongOverview(sequence)
  const separation = useSeparationStatus()
  const song = sequence.song
  if (!song) return null
  const lyrics = song.lyrics
  const placed = placedClips(sequence).length

  const close = () => {
    setOpen(false)
    setView('facts')
    setError(undefined)
  }
  const working = !!sequence.songWork

  const separate = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onSeparate()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onRemove()
      close()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const facts = [
    formatFrameTime(song.duration),
    overview?.bpm !== undefined ? `${Math.round(overview.bpm)} BPM` : undefined,
    `${placed} ${placed === 1 ? 'clip' : 'clips'}`
  ].filter(Boolean)

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Song"
        title={`The sequence is cut to “${song.name}”`}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] transition hover:bg-raised"
      >
        <NoteIcon size={13} className="shrink-0 text-violet-300" />
        {/* The word only when the main area is wide: the header's actions need the room. */}
        <span className="hidden @min-[67rem]/main:inline">Song</span>
      </button>
      <Popover anchorRef={anchor} open={open} onClose={close} align="end" width={320} label="Song">
        <div className="border-b border-line px-3 py-2.5">
          <p className="font-medium">Song</p>
          <p className="mt-0.5 truncate text-[12px]" title={song.path}>
            {song.name}
          </p>
          <p className="text-[11px] tabular-nums text-muted">{facts.join(' · ')}</p>
        </div>
        {view === 'transcribe' ? (
          <>
            <button
              type="button"
              onClick={() => setView('facts')}
              className="w-full border-b border-line px-3 py-1.5 text-left text-[11px] text-muted transition hover:bg-raised hover:text-text"
            >
              ← Song
            </button>
            <TranscribePanel sequence={sequence} onTranscribe={onTranscribe} onDone={close} onError={onError} />
          </>
        ) : (
          <dl className="space-y-2.5 px-3 py-2.5 text-[12px]">
            <div>
              <div className="flex min-h-6 items-center justify-between gap-2">
                <dt className="text-muted">Vocals</dt>
                {!song.vocalsPath && (
                  <button
                    type="button"
                    onClick={() => void separate()}
                    disabled={busy || working || !separation?.available}
                    title={separation?.available ? `Free, on ${THIS_COMPUTER}` : separation?.message}
                    className={rowButton}
                  >
                    Separate the vocals
                  </button>
                )}
              </div>
              <dd className="leading-snug">
                {song.vocalsPath ? 'Separated – singing shots hear only the voice.' : 'Not separated.'}
              </dd>
            </div>
            <div>
              <div className="flex min-h-6 items-center justify-between gap-2">
                <dt className="text-muted">Lyrics</dt>
                <button
                  type="button"
                  onClick={() => setView('transcribe')}
                  disabled={working}
                  title="Paid; the price is shown first"
                  className={rowButton}
                >
                  {lyrics ? 'Transcribe again…' : 'Transcribe the lyrics…'}
                </button>
              </div>
              <dd className="leading-snug">
                {lyrics
                  ? `${lyrics.lines.length} ${lyrics.lines.length === 1 ? 'line' : 'lines'}${
                      lyrics.costUsd !== undefined ? ` · ${formatUsd(lyrics.costUsd)}` : ''
                    }. Click a line in the song strip to correct it.`
                  : 'Not transcribed.'}
              </dd>
            </div>
            {sequence.songWork && (
              <p className="text-[11px] text-muted" role="status">
                {workText(sequence.songWork)}
              </p>
            )}
            {error && view === 'facts' && <p className="select-text text-[11px] text-danger">{error}</p>}
          </dl>
        )}
        {view === 'transcribe' ? null : view === 'remove' ? (
          <div className="border-t border-line p-3">
            <p className="mb-1">Remove the song?</p>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              The clips keep their prompts and takes and become ordinary clips; the preview and the export play their
              own sound again. The song's files stay in the sequence's folder.
            </p>
            {error && <p className="mb-2 select-text text-[11px] text-danger">{error}</p>}
            {/* Cancel has the focus, as in every question before throwing work away. */}
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                autoFocus
                onClick={() => setView('facts')}
                disabled={busy}
                className={buttonClass('ghost', 'sm')}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void remove()} disabled={busy} className={buttonClass('danger', 'sm')}>
                {busy ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={() => {
                close()
                onReplace()
              }}
              disabled={!!sequence.songWork}
              title={sequence.songWork ? 'Wait until the song is ready' : 'Cut the clips to another file'}
              className="rounded-md border border-line px-2.5 py-1 text-[12px] transition hover:bg-raised disabled:opacity-40"
            >
              Replace the song…
            </button>
            <button
              type="button"
              onClick={() => {
                setError(undefined)
                setView('remove')
              }}
              disabled={!!sequence.songWork}
              className="ml-auto rounded-md px-2.5 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-danger disabled:opacity-40"
            >
              Remove the song…
            </button>
          </div>
        )}
      </Popover>
    </>
  )
}
