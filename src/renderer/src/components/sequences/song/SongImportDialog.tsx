import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { DEFAULT_SONG_TARGET_SECONDS } from '@shared/song-window'
import type { SongImportOptions } from '@shared/types'
import { NO_SEPARATION, ipcErrorMessage, useSeparationStatus } from '../../../lib/hooks'
import { formatUsd, mediaUrl } from '../../../lib/media'
import { THIS_COMPUTER, isMac } from '../../../lib/platform'
import { pauseOthers } from '../../feed/playback'
import Modal from '../../pickers/Modal'
import { buttonClass } from '../../ui/button'
import Disclosure from '../../ui/Disclosure'
import Segmented from '../../ui/Segmented'
import { PauseIcon, PlayIcon } from '../icons'
import { fileName, formatFrameTime } from '../sequenceUtils'
import { LyricsOptions, lyricsPrice, useLyricsModels } from './lyricsModels'
import { useMediaPlaying, useMediaTime } from './useMediaTime'

/** The clip lengths "Clips of about" offers. */
const CLIP_LENGTHS = [4, 6, 8, 10, 12] as const

/**
 * What the dialog is for: a new sequence from the song ("New sequence from a song…"), another song for a sequence
 * that has one ("Replace the song…"), or a first song for a sequence without one ("Add a song…").
 */
export type SongImportMode = { kind: 'create' } | { kind: 'replace' | 'add'; sequenceName: string; clipCount: number }

interface Props {
  /** The audio file picked or dropped. */
  path: string
  mode: SongImportMode
  onCancel: () => void
  /**
   * Imports with the choices (the budget question included); resolves true when it is done, false when nothing was
   * done (the budget question answered no) – the dialog then stays. A refusal is thrown and shown in the dialog.
   */
  onSubmit: (opts: SongImportOptions) => Promise<boolean>
}

/** The file's name without its extension: the new sequence's name unless another is typed. */
function baseName(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, '')
}

/**
 * "New sequence from a song…": the song's name and length (to listen to), then what Studio does with it – separate the
 * vocals (free, on this Mac), transcribe the lyrics (paid, the price shown), split it into clips of about N seconds –
 * and the sequence's name. The same dialog replaces or adds a song on an open sequence.
 */
export default function SongImportDialog({ path, mode, onCancel, onSubmit }: Props) {
  const create = mode.kind === 'create'
  // A song put on clips that exist keeps them (their places follow the song); only an empty sequence is split.
  const splits = create || mode.clipCount === 0
  const [name, setName] = useState(() => baseName(path))
  const [duration, setDuration] = useState<number | null>()
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
  const separation = useSeparationStatus()
  const [separateChoice, setSeparateChoice] = useState<boolean>()
  const lyrics = useLyricsModels()
  const [transcribe, setTranscribe] = useState(true)
  const [modelChoice, setModelChoice] = useState<string>()
  const [language, setLanguage] = useState('')
  const [target, setTarget] = useState<number>(DEFAULT_SONG_TARGET_SECONDS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const nameId = useId()

  const separable = !!separation?.available
  const separate = separable && (separateChoice ?? true)
  const model = lyrics.models.find((m) => m.id === (modelChoice ?? lyrics.defaultId))
  const canTranscribe = !!model
  const transcribing = transcribe && canTranscribe
  const price = lyricsPrice(model, duration ?? undefined)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const opts: SongImportOptions = {
        separateVocals: separate,
        lyrics: transcribing ? { model: model?.id, ...(language ? { language } : {}) } : false,
        ...(splits ? { targetSeconds: target } : {}),
        ...(create && name.trim() ? { name: name.trim() } : {})
      }
      await onSubmit(opts)
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const action = create ? 'Create' : mode.kind === 'replace' ? 'Replace the song' : 'Add the song'
  // The length can be unknown here (a format Chromium can't read): then the price per minute.
  const priceText =
    price !== undefined ? formatUsd(price) : model ? `${formatUsd(model.usdPerSecond * 60)} a minute` : ''

  return (
    <Modal
      title={create ? 'New sequence from a song' : mode.kind === 'replace' ? 'Replace the song' : 'Add a song'}
      subtitle={create ? undefined : `In “${mode.sequenceName}”`}
      onClose={() => !busy && onCancel()}
      maxWidth={480}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass('ghost')}>
            Cancel
          </button>
          <button type="submit" form={`${nameId}-form`} disabled={busy} className={buttonClass('primary')}>
            {busy ? 'Starting…' : action}
            {transcribing && priceText && (
              <span className="tabular-nums text-white/80 group-disabled:text-muted">· {priceText}</span>
            )}
          </button>
        </>
      }
    >
      <form id={`${nameId}-form`} onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="rounded-lg border border-line bg-raised/40 p-3">
          <div className="flex items-center gap-2.5">
            <Listen audio={audio} disabled={!duration} />
            <span className="min-w-0 flex-1 truncate font-medium" title={path}>
              {fileName(path)}
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-muted">
              {duration ? formatFrameTime(duration) : duration === null ? 'Length unknown' : 'Reading…'}
            </span>
          </div>
          {duration ? <ListenProgress audio={audio} duration={duration} /> : null}
          {/* The length from the file's own header; main measures it again when it copies the song in. */}
          <audio
            ref={setAudio}
            src={mediaUrl(path)}
            preload="metadata"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration
              setDuration(Number.isFinite(d) ? d : null)
            }}
            onPlay={(e) => pauseOthers(e.currentTarget)}
            onError={() => setDuration(null)}
            className="hidden"
          />
        </div>

        <Option
          checked={separate}
          disabled={!separable || busy}
          onChange={setSeparateChoice}
          label="Separate the vocals"
          note="Free"
          hint={
            separation === undefined
              ? `Checking whether ${THIS_COMPUTER} can…`
              : separable
                ? `On ${THIS_COMPUTER}. Singing shots then hear only the voice, which keeps the lips in time.`
                : (separation.message ?? (isMac ? "This Mac can't separate voices." : NO_SEPARATION))
          }
        />

        <Option
          checked={transcribing}
          disabled={!canTranscribe || busy}
          onChange={setTranscribe}
          label="Transcribe the lyrics"
          note={canTranscribe ? priceText : undefined}
          hint={
            canTranscribe
              ? 'Venice writes down the words with their times. Each clip then knows what is sung in it; you can correct the lines by hand for free.'
              : (lyrics.problem ?? 'Loading the transcription models…')
          }
        >
          {canTranscribe && (
            <Disclosure summary="More" plain className="mt-2 text-[12px]">
              <LyricsOptions
                lyrics={lyrics}
                model={model?.id}
                language={language}
                disabled={!transcribe || busy}
                onModel={setModelChoice}
                onLanguage={setLanguage}
              />
            </Disclosure>
          )}
        </Option>

        {splits ? (
          <fieldset>
            <legend className="mb-1.5 text-muted">Clips of about</legend>
            <Segmented
              value={target}
              onChange={setTarget}
              options={CLIP_LENGTHS.map((s) => ({ value: s, label: `${s} s`, disabled: busy }))}
              ariaLabel="Clips of about"
              fill
              className="w-full tabular-nums"
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              The song is split at its lines and phrases, on the beat. Move the boundaries in the song strip afterwards.
            </p>
          </fieldset>
        ) : (
          <p className="rounded-md border border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            {mode.kind === 'replace'
              ? 'The clips keep their places in the new song (shortened where it is shorter) and everything else.'
              : `The ${mode.clipCount === 1 ? 'clip gets' : `${mode.clipCount} clips get`} places spread evenly over the song, and keep everything else. Move the boundaries in the song strip afterwards.`}
          </p>
        )}

        {create && (
          <label className="block" htmlFor={nameId}>
            <span className="mb-1.5 block text-muted">Name</span>
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              spellCheck={false}
              placeholder={baseName(path)}
              className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
            />
          </label>
        )}

        {error && (
          <p role="alert" className="select-text text-[12px] leading-relaxed text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}

/** Play / pause the picked file, to hear that it is the right one. */
function Listen({ audio, disabled }: { audio: HTMLAudioElement | null; disabled: boolean }) {
  const playing = useMediaPlaying(audio)
  return (
    <button
      type="button"
      onClick={() => (audio?.paused ? void audio.play().catch(() => undefined) : audio?.pause())}
      disabled={disabled || !audio}
      aria-label={playing ? 'Pause the song' : 'Listen to the song'}
      title={playing ? 'Pause' : 'Listen'}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-line text-text transition hover:bg-muted/40 disabled:opacity-40"
    >
      {playing ? <PauseIcon size={11} /> : <PlayIcon size={11} />}
    </button>
  )
}

/** How far the song has been listened to; a press moves there. */
function ListenProgress({ audio, duration }: { audio: HTMLAudioElement | null; duration: number }) {
  const t = useMediaTime(audio)
  return (
    <div
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        if (audio && r.width) audio.currentTime = ((e.clientX - r.left) / r.width) * duration
      }}
      className="mt-2.5 h-1.5 cursor-pointer overflow-hidden rounded-full bg-bg/80"
      aria-hidden
    >
      <div className="h-full bg-sky-300/70" style={{ width: `${Math.min(100, (t / duration) * 100)}%` }} />
    </div>
  )
}

function Option({
  checked,
  disabled,
  onChange,
  label,
  note,
  hint,
  children
}: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  label: string
  /** After the label, quieter: "Free", the price. */
  note?: string
  hint: ReactNode
  children?: ReactNode
}) {
  return (
    <div>
      <label className={`flex items-start gap-2.5 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span className="min-w-0">
          <span className={disabled ? 'text-muted' : ''}>
            {label}
            {note && <span className="text-muted"> · {note}</span>}
          </span>
          <span className="block text-[11px] leading-snug text-muted">{hint}</span>
        </span>
      </label>
      {children && <div className="pl-6">{children}</div>}
    </div>
  )
}
