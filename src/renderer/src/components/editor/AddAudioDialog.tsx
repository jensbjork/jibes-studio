import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditMedia, EditOperation } from '@shared/types'
import { ipcErrorMessage, useAssets } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import Modal from '../pickers/Modal'
import { PauseIcon, PlayIcon } from '../sequences/icons'
import { useCardRun, useEditor } from './EditorContext'
import { fileName, formatClock, formatLength } from './editorUtils'
import { Check, GainSlider, PlanNotes, TimeAt } from './ui'

// "Add sound…" / "Replace the original…": a sound from the library (a character's voice, a place's
// soundscape), from this edit's earlier sounds (paid results are reused for free), or from a file (copied into the
// edit's Ljud/ folder), laid on the film as a layer. Free.

type SourceTab = 'library' | 'edit'

interface Source {
  key: string
  ref: { assetAudioId: string } | { mediaId: string }
  path: string
  label: string
  detail?: string
  duration?: number
}

const MEDIA_KIND: Record<EditMedia['kind'], string> = {
  voice: 'New voice',
  speech: 'Line',
  music: 'Music',
  effect: 'Sound effect',
  audio: 'Sound',
  bake: 'Mixed sound'
}

export default function AddAudioDialog({ replace, onClose }: { replace?: boolean; onClose: () => void }) {
  const { edit, selection, player, duration } = useEditor()
  const assets = useAssets()
  const [tab, setTab] = useState<SourceTab>(edit.media.some((m) => m.kind !== 'bake') ? 'edit' : 'library')
  const [chosen, setChosen] = useState<string>()
  const [at, setAt] = useState(() => (replace ? 0 : Math.round((selection?.start ?? player.getTime()) * 100) / 100))
  const [gain, setGain] = useState(0)
  const [duck, setDuck] = useState(false)
  const [loop, setLoop] = useState(false)
  const [fades, setFades] = useState(true)
  const [adding, setAdding] = useState(false)
  const [fileError, setFileError] = useState<string>()
  const card = useCardRun()

  const library = useMemo<Source[]>(
    () =>
      assets.flatMap((a) =>
        a.audio.map((clip) => ({
          key: `a:${clip.id}`,
          ref: { assetAudioId: clip.id },
          path: clip.path,
          label: a.name,
          detail: fileName(clip.path),
          duration: clip.duration
        }))
      ),
    [assets]
  )
  const own = useMemo<Source[]>(
    () =>
      edit.media
        .filter((m) => m.kind !== 'bake')
        .map((m) => ({
          key: `m:${m.id}`,
          ref: { mediaId: m.id },
          path: m.path,
          label: m.label || MEDIA_KIND[m.kind],
          detail: MEDIA_KIND[m.kind],
          duration: m.durationSeconds
        })),
    [edit.media]
  )
  const list = tab === 'library' ? library : own
  const source = [...library, ...own].find((s) => s.key === chosen)

  const fromFile = async () => {
    setFileError(undefined)
    try {
      const paths = await window.studio.pickAudio(true)
      if (!paths.length) return
      setAdding(true)
      const added = await window.studio.addEditAudio(edit.id, paths)
      setTab('edit')
      if (added[0]) setChosen(`m:${added[0].id}`)
    } catch (e) {
      setFileError(ipcErrorMessage(e))
    } finally {
      setAdding(false)
    }
  }

  const op: EditOperation | undefined = source && {
    op: 'add-audio',
    source: source.ref,
    at: replace ? 0 : at,
    gainDb: gain,
    duck: replace ? false : duck,
    loop,
    length: loop ? Math.max(0.1, duration - (replace ? 0 : at)) : undefined,
    fadeInSeconds: fades ? 1 : undefined,
    fadeOutSeconds: fades ? 1 : undefined,
    replaceBed: replace || undefined
  }

  const submit = async () => {
    if (!op) return
    const outcome = await card.run({ op, label: replace ? 'Replace the original sound' : 'Add sound' })
    if (outcome.ok) onClose()
  }

  return (
    <Modal
      title={replace ? 'Replace the original sound' : 'Add sound'}
      subtitle={
        replace
          ? 'The film’s own sound is muted and what you choose plays from the start instead.'
          : 'The sound is laid as a layer on the timeline. Free – it becomes a new version.'
      }
      onClose={onClose}
      maxWidth={520}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 hover:bg-raised">
            Cancel
          </button>
          <button
            type="button"
            disabled={!op || card.running}
            onClick={() => void submit()}
            className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {card.running ? 'Creating version…' : replace ? 'Replace the sound' : 'Add'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-1 border-b border-line">
          {(
            [
              ['library', 'From the library'],
              ['edit', 'From the edit']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-2.5 py-1.5 transition ${
                tab === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void fromFile()}
            disabled={adding}
            className="ml-auto rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40"
          >
            {adding ? 'Copying…' : 'From file…'}
          </button>
        </div>

        <SourceList
          sources={list}
          chosen={chosen}
          onChoose={setChosen}
          empty={
            tab === 'library'
              ? 'No voices or soundscapes in the library yet. Add them under Characters and Environments.'
              : 'No sound in this edit yet. Music, lines and files you add end up here and can be used again for free.'
          }
        />
        {fileError && <p className="text-[12px] text-accent select-text">{fileError}</p>}

        {source && (
          <div className="space-y-3 border-t border-line pt-4">
            {!replace && <TimeAt label="Starts at" value={at} onChange={setAt} player={player} />}
            <GainSlider value={gain} onChange={setGain} />
            {!replace && (
              <Check checked={duck} onChange={setDuck} hint="The sound is lowered automatically when someone speaks.">
                Lower under speech
              </Check>
            )}
            <Check checked={loop} onChange={setLoop} hint={`Repeats until the film ends (${formatLength(duration)}).`}>
              Loop
            </Check>
            <Check checked={fades} onChange={setFades}>
              Fade in and out (1 s)
            </Check>
          </div>
        )}
        <PlanNotes error={card.error} />
      </div>
    </Modal>
  )
}

/** The sounds to choose from, each with a play button. */
function SourceList({
  sources,
  chosen,
  onChoose,
  empty
}: {
  sources: Source[]
  chosen?: string
  onChoose: (key: string) => void
  empty: string
}) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState<string>()
  useEffect(() => () => audio.current?.pause(), [])

  const toggle = (s: Source) => {
    const el = audio.current
    if (!el) return
    if (playing === s.key) {
      el.pause()
      setPlaying(undefined)
      return
    }
    el.src = mediaUrl(s.path)
    void el.play().then(
      () => setPlaying(s.key),
      () => setPlaying(undefined)
    )
  }

  if (!sources.length) return <p className="py-3 text-[12px] leading-relaxed text-muted">{empty}</p>
  return (
    <ul className="max-h-56 space-y-0.5 overflow-y-auto">
      <audio ref={audio} onEnded={() => setPlaying(undefined)} onPause={() => setPlaying(undefined)} hidden />
      {sources.map((s) => (
        <li key={s.key}>
          <div
            role="radio"
            aria-checked={chosen === s.key}
            tabIndex={0}
            onClick={() => onChoose(s.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onChoose(s.key)
              }
            }}
            className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
              chosen === s.key ? 'bg-raised' : 'hover:bg-raised/60'
            }`}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                toggle(s)
              }}
              aria-label={playing === s.key ? 'Stop' : `Listen to ${s.label}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-text transition hover:bg-line"
            >
              {playing === s.key ? <PauseIcon size={10} /> : <PlayIcon size={10} className="translate-x-px" />}
            </button>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{s.label}</span>
              {s.detail && <span className="block truncate text-[11px] text-muted">{s.detail}</span>}
            </span>
            {s.duration !== undefined && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatClock(s.duration)}</span>
            )}
            <span
              className={`h-3.5 w-3.5 shrink-0 rounded-full border ${
                chosen === s.key ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--color-raised)]' : 'border-line'
              }`}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
