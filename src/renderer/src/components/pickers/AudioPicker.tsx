import { useMemo, useState } from 'react'
import { MAX_REFERENCE_AUDIO_SECONDS } from '@shared/models'
import type { Asset, AssetAudio, AssetKind, ReferenceAudio } from '@shared/types'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import AudioPlayButton from './AudioPlayButton'
import { KIND_TONE } from './assetKinds'
import {
  audioRole,
  clipsOf,
  fitsAudio,
  possessive,
  referenceAudioOf,
  totalSeconds,
  windowLabel,
  type AudioSource
} from './audioRefs'
import { formatClipSeconds, matchesQuery } from './text'

interface Props {
  /** The whole library. */
  assets: Asset[]
  /** The form's reference audio. */
  audios: ReferenceAudio[]
  byPath: ReadonlyMap<string, AudioSource>
  /** How many clips the model takes. */
  max: number
  onPick: (audio: AssetAudio, asset: Asset) => void
  /** Opens a library view, e.g. to give a character a voice. */
  onManage?: (kind: AssetKind) => void
}

/** The kinds that have audio, in the order they are listed, with what their clips are called. */
const SECTIONS: { kind: AssetKind; title: string }[] = [
  { kind: 'character', title: 'Röster' },
  { kind: 'environment', title: 'Ljudmiljöer' }
]

/**
 * Popover content for "＋ Ljud": the characters' voices and the environments' sounds, each clip with a play
 * button for the part that is sent. Clicking a clip adds it as the next @AudioN.
 */
export default function AudioPicker({ assets, audios, byPath, max, onPick, onManage }: Props) {
  const [query, setQuery] = useState('')
  const withAudio = useMemo(() => assets.filter((a) => clipsOf(a).length > 0), [assets])
  const visible = withAudio.filter((a) => matchesQuery(`${a.name} ${a.description}`, query))
  const total = totalSeconds(audios, byPath)
  const left = Math.max(0, MAX_REFERENCE_AUDIO_SECONDS - total)
  const full = audios.length >= max

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <p className="font-medium">Lägg till ljud</p>
        <p className="mt-0.5 text-[11px] text-muted">
          {full
            ? `Alla ${max} platser är upptagna – ta bort ett ljudklipp först.`
            : `Röster och ljudmiljöer från biblioteket. ${max - audios.length} av ${max} platser och ` +
              `${formatClipSeconds(left)} av ${MAX_REFERENCE_AUDIO_SECONDS} s kvar.`}
        </p>
        {withAudio.length > 6 && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sök karaktär eller miljö…"
            className="mt-2 w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {withAudio.length === 0 ? (
          <div className="px-3 py-6 text-center text-muted">
            <p>Inga röster eller ljud än.</p>
            <p className="mt-1 text-[11px]">
              Lägg till ett röstklipp på en karaktär eller ett ljudklipp på en miljö, så kan du skicka med hur de
              låter.
            </p>
            {onManage && (
              <div className="mt-3 flex justify-center gap-2">
                <button
                  onClick={() => onManage('character')}
                  className="rounded-md border border-line px-3 py-1.5 text-text hover:bg-raised"
                >
                  Karaktärer
                </button>
                <button
                  onClick={() => onManage('environment')}
                  className="rounded-md border border-line px-3 py-1.5 text-text hover:bg-raised"
                >
                  Miljöer
                </button>
              </div>
            )}
          </div>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted">Inget matchar ”{query}”.</p>
        ) : (
          SECTIONS.map(({ kind, title }) => {
            const rows = visible.filter((a) => a.kind === kind)
            if (!rows.length) return null
            return (
              <div key={kind} role="group" aria-label={title}>
                <p className="flex items-center gap-1.5 px-1.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                  <span className={`flex ${KIND_TONE[kind].text}`}>
                    <AssetIcon kind={kind} />
                  </span>
                  {title}
                </p>
                {rows.map((a) => (
                  <AssetClips key={a.id} asset={a} audios={audios} byPath={byPath} max={max} onPick={onPick} />
                ))}
              </div>
            )
          })
        )}
      </div>
    </>
  )
}

interface AssetClipsProps {
  asset: Asset
  audios: ReferenceAudio[]
  byPath: ReadonlyMap<string, AudioSource>
  max: number
  onPick: (audio: AssetAudio, asset: Asset) => void
}

function AssetClips({ asset, audios, byPath, max, onPick }: AssetClipsProps) {
  const clips = clipsOf(asset)
  return (
    <div className="rounded-md p-1.5">
      <div className="flex items-center gap-2.5">
        <AssetAvatar asset={asset} className={`h-7 w-7 rounded-full ring-1 ${KIND_TONE[asset.kind].ring}`} />
        <span className="min-w-0 flex-1 truncate font-medium">{asset.name}</span>
      </div>
      <ul className="mt-1 space-y-0.5 pl-[38px]">
        {clips.map((clip, i) => {
          const ref = referenceAudioOf(clip)
          const fit = fitsAudio(audios, ref, byPath, max)
          const added = audios.some((x) => x.path === clip.path)
          const name = `${audioRole(asset.kind)}${clips.length > 1 ? ` ${i + 1}` : ''}`
          const window = windowLabel({ start: ref.start ?? 0, length: ref.length ?? 0 })
          return (
            <li key={clip.id} className="flex items-center gap-1.5">
              <AudioPlayButton
                path={clip.path}
                start={ref.start ?? 0}
                length={ref.length ?? 0}
                label={`${asset.name} · ${name}`}
              />
              <button
                onClick={() => fit.fits && onPick(clip, asset)}
                disabled={!fit.fits}
                title={
                  added
                    ? 'Redan tillagt'
                    : fit.fits
                      ? `Lägg till ${possessive(asset.name, 'sv')} ${name} (${window})`
                      : `Kan inte läggas till: ${fit.reason}`
                }
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-raised/60 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <span className="shrink-0 capitalize">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{window}</span>
                {added ? (
                  <span className="shrink-0 text-[11px] text-accent">✓</span>
                ) : !fit.fits ? (
                  <span className="shrink-0 text-[11px] text-accent">{fit.reason}</span>
                ) : (
                  <span className="shrink-0 text-muted">＋</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
