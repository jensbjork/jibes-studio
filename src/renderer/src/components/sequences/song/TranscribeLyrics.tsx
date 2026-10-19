import { useEffect, useRef, useState } from 'react'
import type { Sequence } from '@shared/types'
import { withBudgetConfirm } from '../../../lib/budget'
import { ipcErrorMessage } from '../../../lib/hooks'
import { formatUsd } from '../../../lib/media'
import { isMac } from '../../../lib/platform'
import Popover from '../../pickers/Popover'
import { LyricsOptions, useLyricsModels } from './lyricsModels'

export type TranscribeOptions = { model?: string; language?: string; confirmOverBudget?: boolean }

interface PanelProps {
  sequence: Sequence
  /** Runs the transcription (the sequence view's store applies the answer); rejects with main's refusal. */
  onTranscribe: (opts: TranscribeOptions) => Promise<unknown>
  /** Main has it in hand (or the panel is to close). */
  onDone: () => void
  /** A failure after the panel has gone (main started the work and it failed later). */
  onError: (message: string) => void
}

/**
 * Transcribing the song's lyrics: the model, the language and the price main quotes for this song, and the paid
 * button – asked past the budget like every paid step. In a popover by the song strip's button, or as a view of the
 * header's Song panel ("Transcribe again…").
 */
export function TranscribePanel({ sequence, onTranscribe, onDone, onError }: PanelProps) {
  const lyrics = useLyricsModels()
  const [modelChoice, setModelChoice] = useState<string>()
  const [language, setLanguage] = useState('')
  const [quote, setQuote] = useState<number>()
  const [quoteError, setQuoteError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  const model = modelChoice ?? lyrics.defaultId
  const again = !!sequence.song?.lyrics
  const edited = sequence.song?.lyrics?.lines.filter((l) => l.edited).length ?? 0

  // The price as main works it out for this song and model (free); asked again for another model.
  useEffect(() => {
    if (!model) return
    let current = true
    setQuote(undefined)
    setQuoteError(undefined)
    window.studio.quoteSongLyrics(sequence.id, model).then(
      (q) => current && setQuote(q),
      (e: unknown) => current && setQuoteError(ipcErrorMessage(e))
    )
    return () => {
      current = false
    }
  }, [model, sequence.id, sequence.song?.duration])

  // Once main is at it (the song strip shows the progress), the panel has done its part.
  const working = sequence.songWork?.stage === 'transcribing'
  useEffect(() => {
    if (busy && working) onDone()
  }, [busy, working])

  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const done = await withBudgetConfirm((confirmed) =>
        onTranscribe({
          ...(model ? { model } : {}),
          ...(language ? { language } : {}),
          ...(confirmed ? { confirmOverBudget: true } : {})
        }).then(() => true)
      )
      // Undefined: past the budget and the user said no – nothing was sent; the panel stays.
      if (done) onDone()
    } catch (e) {
      if (mounted.current) setError(ipcErrorMessage(e))
      else onError(ipcErrorMessage(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="font-medium">{again ? 'Transcribe the lyrics again' : 'Transcribe the lyrics'}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          {sequence.song?.vocalsPath
            ? 'From the separated vocals, which keeps the words clean.'
            : isMac
              ? 'From the whole song – separating the vocals first gives cleaner words.'
              : 'From the whole song.'}{' '}
          Each clip then knows what is sung in it.
        </p>
      </div>
      {lyrics.problem ? (
        <p className="text-[11px] leading-snug text-amber-300">{lyrics.problem}</p>
      ) : (
        <LyricsOptions
          lyrics={lyrics}
          model={model}
          language={language}
          disabled={busy}
          onModel={setModelChoice}
          onLanguage={setLanguage}
        />
      )}
      {again && (
        <p className="text-[11px] leading-snug text-amber-300">
          The new lyrics replace the ones there are
          {edited ? `, with your ${edited === 1 ? 'correction' : `${edited} corrections`}` : ''}.
        </p>
      )}
      {(error || quoteError) && (
        <p className="select-text text-[11px] leading-snug text-accent">{error ?? quoteError}</p>
      )}
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || !model || !!lyrics.problem}
        className="flex w-full items-center justify-between gap-3 rounded-md bg-accent px-3 py-1.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
      >
        <span>{busy ? 'Starting…' : again ? 'Transcribe again' : 'Transcribe'}</span>
        <span className="text-white/80">{quote !== undefined ? formatUsd(quote) : quoteError ? '' : '…'}</span>
      </button>
    </div>
  )
}

interface Props extends Omit<PanelProps, 'onDone'> {
  disabled?: boolean
  /** Why it is disabled. */
  disabledTitle?: string
  className: string
}

/** "Transcribe the lyrics…" in the song strip: the panel in a popover under the button. */
export default function TranscribeLyrics({ disabled, disabledTitle, className, ...panel }: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabled ? disabledTitle : 'Venice writes down the words with their times (paid; the price is shown first)'}
        className={className}
      >
        {panel.sequence.song?.lyrics ? 'Transcribe again…' : 'Transcribe the lyrics…'}
      </button>
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        width={320}
        label="Transcribe the lyrics"
      >
        {open && <TranscribePanel {...panel} onDone={() => setOpen(false)} />}
      </Popover>
    </>
  )
}
