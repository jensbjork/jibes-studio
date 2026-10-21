import { useMemo, useRef, useState, type ReactNode } from 'react'
import { castFollowAt, castIsEmpty, swapCastAsset } from '@shared/cast'
import { maxReferenceImages, supportsAudioInput } from '@shared/models'
import { resolveOutfitWearers } from '@shared/outfits'
import type { Asset, AssetKind, Sequence, SequenceCast, SequenceCastSwap } from '@shared/types'
import { ipcErrorMessage, useAssets } from '../../lib/hooks'
import { ASSET_COPY, isReferenceKind } from '../../lib/assets'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import AssetPicker from '../pickers/AssetPicker'
import { KIND_TONE } from '../pickers/assetKinds'
import { clipsOf } from '../pickers/audioRefs'
import Popover from '../pickers/Popover'
import { formatAudioRefs, formatImageRefs } from '../pickers/text'
import {
  addPhotoToCast,
  addToCast,
  castEntries,
  castModel,
  moveInCast,
  removeFromCast,
  setCastVoice,
  wearInCast,
  type CastChange,
  type CastEntry
} from './castEdits'
import { CloseIcon } from './icons'

/** A cast change as the sequence view saves it. */
export type CastPatch = { cast: SequenceCast } | { castSwap: SequenceCastSwap }

interface Props {
  sequence: Sequence
  /** Saves the change (the clip editor's edits are saved first); rejects with main's refusal. */
  onChange: (patch: CastPatch) => Promise<void>
  /** Opens the library view of a kind (the pickers' empty state and footer link). */
  onManage?: (kind: AssetKind) => void
}

/** "@Image1–2, @Image4" (runs of tokens shortened, so a row's tokens fit beside its buttons). */
function compactTokens(word: 'Image' | 'Audio', indices: readonly number[]): string {
  const runs: [number, number][] = []
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && i === last[1] + 1) last[1] = i
    else runs.push([i, i])
  }
  return runs.map(([a, b]) => (a === b ? `@${word}${a}` : `@${word}${a}–${b}`)).join(', ')
}

/** "1", "1 and 3", "1, 3 and 4". */
function numbers(list: readonly number[]): string {
  return list.length === 1 ? `${list[0]}` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** "Clips 1 and 3 follow the cast · clip 2 carries it · clip 4 has other references". */
export function castSummary(sequence: Sequence): string {
  const follows: number[] = []
  const carries: number[] = []
  const differs: number[] = []
  sequence.segments.forEach((_, i) => {
    const state = castFollowAt(sequence.segments, i, sequence.cast).state
    if (state === 'follows') follows.push(i + 1)
    else if (state === 'carries') carries.push(i + 1)
    else if (state === 'differs') differs.push(i + 1)
  })
  if (castIsEmpty(sequence.cast)) {
    return follows.length
      ? `${follows.length === 1 ? 'Clip' : 'Clips'} ${numbers(follows)} ${follows.length === 1 ? 'has' : 'have'} no references yet and will take the cast`
      : 'New clips will start with the cast'
  }
  const parts = [
    follows.length
      ? `${follows.length === 1 ? 'Clip' : 'Clips'} ${numbers(follows)} ${follows.length === 1 ? 'follows' : 'follow'} the cast`
      : 'No clip follows the cast yet',
    carries.length ? `${carries.length === 1 ? 'clip' : 'clips'} ${numbers(carries)} ${carries.length === 1 ? 'carries' : 'carry'} it` : '',
    differs.length
      ? `${differs.length === 1 ? 'clip' : 'clips'} ${numbers(differs)} ${differs.length === 1 ? 'has' : 'have'} other references`
      : ''
  ]
  return parts.filter(Boolean).join(' · ')
}

const iconButton =
  'flex h-6 min-w-6 items-center justify-center rounded px-1 text-[11px] text-muted transition hover:bg-line hover:text-text disabled:pointer-events-none disabled:opacity-30'

/**
 * "Cast" in the sequence header: the assets chosen once for the whole sequence, as small avatars, and the panel to
 * change them – add (at the end), remove, move, swap for another asset, a character's voice, who wears an outfit.
 */
export default function CastButton({ sequence, onChange, onManage }: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const assets = useAssets()
  const entries = useMemo(() => castEntries(sequence.cast, assets), [sequence.cast, assets])
  const shown = entries.flatMap((e) => (e.asset ? [e.asset] : [])).slice(0, 4)
  const empty = castIsEmpty(sequence.cast)

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          empty
            ? 'Choose the characters, outfits and places once for the whole sequence'
            : `The sequence's cast. ${castSummary(sequence)}.`
        }
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] transition hover:bg-raised"
      >
        {/* The avatars only when the main area is wide: the header's actions need the room. */}
        {shown.length > 0 && (
          <span className="hidden -space-x-1.5 @min-[75rem]/main:flex">
            {shown.map((a) => (
              <AssetAvatar key={a.id} asset={a} className="h-5 w-5 rounded-full ring-2 ring-bg" />
            ))}
          </span>
        )}
        <span className={empty ? 'text-muted' : ''}>{empty ? '+ Cast' : 'Cast'}</span>
        {entries.length > shown.length && (
          <span className="hidden text-[11px] tabular-nums text-muted @min-[75rem]/main:inline">
            +{entries.length - shown.length}
          </span>
        )}
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="end" width={400} maxHeight={560} label="Cast">
        <CastPanel sequence={sequence} assets={assets} entries={entries} onChange={onChange} onManage={onManage} />
      </Popover>
    </>
  )
}

type View = { mode: 'list' } | { mode: 'add' } | { mode: 'swap'; entry: CastEntry & { asset: Asset } }

function CastPanel({
  sequence,
  assets,
  entries,
  onChange,
  onManage
}: Props & { assets: Asset[]; entries: CastEntry[] }) {
  const [view, setView] = useState<View>({ mode: 'list' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const cast = sequence.cast
  const model = castModel(sequence)
  const max = maxReferenceImages(model)

  const save = async (patch: CastPatch, said?: string) => {
    setBusy(true)
    setError(undefined)
    setNote(said)
    try {
      await onChange(patch)
      setView({ mode: 'list' })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = (change: CastChange) => void save({ cast: change.cast }, change.note)
  /** One asset swapped for another; the notes say what the swap left as it was (a voice the new one lacks, say). */
  const swapFor = (from: Asset, to: Asset) => {
    let notes: string[] = []
    try {
      notes = swapCastAsset(cast, { from, to }, assets).notes
    } catch {
      // Main says what is wrong.
    }
    void save({ castSwap: { fromAssetId: from.id, toAssetId: to.id } }, notes.join(' ') || undefined)
  }

  if (view.mode !== 'list') {
    const swap = view.mode === 'swap' ? view.entry.asset : undefined
    const free = Math.max(0, max - cast.referenceImages.length)
    return (
      <>
        <button
          type="button"
          onClick={() => setView({ mode: 'list' })}
          className="border-b border-line px-3 py-1.5 text-left text-[11px] text-muted transition hover:bg-raised hover:text-text"
        >
          ← Cast
        </button>
        {error && <p className="px-3 pt-2 text-[11px] text-accent select-text">{error}</p>}
        <AssetPicker
          assets={assets}
          initialKind={swap && isReferenceKind(swap.kind) ? swap.kind : 'character'}
          title={swap ? `Swap ${swap.name} for…` : 'Add to the cast'}
          hint={
            swap
              ? 'The new one takes its places, so no @Image number changes in the clips that follow the cast.'
              : `${free} of ${max} image places free. New assets go last, so the numbers in the prompts stay.`
          }
          selectedPaths={cast.referenceImages}
          freeSlots={swap ? undefined : free}
          withVoice={!swap && supportsAudioInput(model)}
          onPickAsset={(a) => (swap ? swapFor(swap, a) : apply(addToCast(cast, a, assets, model)))}
          onPickImage={(path, a) => (swap ? swapFor(swap, a) : apply(addPhotoToCast(cast, path, model)))}
          onManage={onManage}
        />
      </>
    )
  }

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <p className="font-medium">Cast</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          The characters, outfits and places of the whole sequence. New clips start with them, and the clips that
          follow the cast change with it – their prompts keep pointing at the same pictures.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {entries.length === 0 ? (
          <p className="px-2 py-5 text-center text-[12px] leading-relaxed text-muted">
            No cast yet. Add the characters (their outfits and voices come along), the places and anything else every
            clip should have.
          </p>
        ) : (
          entries.map((entry, i) => (
            <CastRow
              key={entry.key}
              entry={entry}
              entries={entries}
              cast={cast}
              busy={busy}
              first={i === 0}
              last={i === entries.length - 1}
              audioSupported={supportsAudioInput(model)}
              onMove={(step) => apply({ cast: moveInCast(cast, entries, i, step) })}
              onRemove={() => apply({ cast: removeFromCast(cast, entry) })}
              onSwap={() => entry.asset && setView({ mode: 'swap', entry: { ...entry, asset: entry.asset } })}
              onVoice={(on) => entry.asset && apply(setCastVoice(cast, entry.asset, on, assets, model))}
              onWear={(wearer) => entry.asset && apply({ cast: wearInCast(cast, entry.asset.id, wearer) })}
            />
          ))
        )}
      </div>
      {(error || note) && (
        <p className={`border-t border-line px-3 py-2 text-[11px] leading-snug select-text ${error ? 'text-accent' : 'text-amber-300'}`}>
          {error ?? note}
        </p>
      )}
      <div className="flex items-center gap-3 border-t border-line px-3 py-2">
        <button
          type="button"
          onClick={() => {
            setError(undefined)
            setView({ mode: 'add' })
          }}
          disabled={busy || cast.referenceImages.length >= max}
          title={cast.referenceImages.length >= max ? `The cast has all ${max} image places filled` : 'Add an asset at the end'}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] transition hover:bg-raised disabled:opacity-40"
        >
          + Add
        </button>
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
          {sequence.segments.length ? castSummary(sequence) : 'The first clip will start with the cast.'}
        </span>
      </div>
    </>
  )
}

function CastRow({
  entry,
  entries,
  cast,
  busy,
  first,
  last,
  audioSupported,
  onMove,
  onRemove,
  onSwap,
  onVoice,
  onWear
}: {
  entry: CastEntry
  entries: CastEntry[]
  cast: SequenceCast
  busy: boolean
  first: boolean
  last: boolean
  audioSupported: boolean
  onMove: (step: -1 | 1) => void
  onRemove: () => void
  onSwap: () => void
  onVoice: (on: boolean) => void
  onWear: (wearer: string | null | undefined) => void
}) {
  const a = entry.asset
  const tokens = [
    entry.images.length ? compactTokens('Image', entry.images) : '',
    entry.audios.length ? `${a?.kind === 'character' ? 'voice' : 'sound'} ${compactTokens('Audio', entry.audios)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const fullTokens = [
    entry.images.length ? formatImageRefs(entry.images) : '',
    entry.audios.length ? formatAudioRefs(entry.audios) : ''
  ]
    .filter(Boolean)
    .join(', ')
  const hasClips = !!a && clipsOf(a).length > 0 && (a.kind === 'character' || a.kind === 'environment')
  const voiceOn = entry.audios.length > 0
  let extra: ReactNode = null
  if (a?.kind === 'outfit') extra = <WornBy outfit={a} entries={entries} cast={cast} busy={busy} onWear={onWear} />
  return (
    <div className="group flex items-start gap-2.5 rounded-md p-1.5 hover:bg-raised/60">
      {a ? (
        <AssetAvatar asset={a} className="h-9 w-9 rounded-md" />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-raised text-muted">?</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {a && (
            <span className={`flex text-[12px] ${KIND_TONE[a.kind].text}`} title={ASSET_COPY[a.kind].singular}>
              <AssetIcon kind={a.kind} />
            </span>
          )}
          <span className="truncate font-medium">{a ? a.name : 'Missing picture'}</span>
        </div>
        <p
          className="truncate text-[11px] tabular-nums text-muted"
          title={a ? fullTokens : 'No asset has this picture any more. Remove it from the cast.'}
        >
          {tokens}
        </p>
        {extra}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pt-0.5 opacity-70 transition group-hover:opacity-100">
        {hasClips && (audioSupported || voiceOn) && (
          <button
            type="button"
            onClick={() => onVoice(!voiceOn)}
            disabled={busy}
            aria-pressed={voiceOn}
            title={voiceOn ? 'Leave the voice out' : 'Bring the voice along'}
            className={`${iconButton} ${voiceOn ? 'text-text' : ''}`}
          >
            {a?.kind === 'character' ? 'Voice' : 'Sound'}
            <span className={`ml-1 h-1.5 w-1.5 rounded-full ${voiceOn ? 'bg-emerald-400' : 'bg-line'}`} />
          </button>
        )}
        <button type="button" onClick={() => onMove(-1)} disabled={busy || first} title="Move up" aria-label="Move up" className={iconButton}>
          ↑
        </button>
        <button type="button" onClick={() => onMove(1)} disabled={busy || last} title="Move down" aria-label="Move down" className={iconButton}>
          ↓
        </button>
        {a && entry.images.length > 0 && (
          <button
            type="button"
            onClick={onSwap}
            disabled={busy}
            title={`Swap ${a.name} for another – no number changes`}
            className={iconButton}
          >
            Swap
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          title="Remove from the cast (its tokens leave the prompts of the clips that follow it)"
          aria-label="Remove"
          className={`${iconButton} hover:text-accent`}
        >
          <CloseIcon size={9} />
        </button>
      </div>
    </div>
  )
}

/** "Worn by" for an outfit in the cast: the default (the character whose outfit it is, or the only one), a character, nobody. */
function WornBy({
  outfit,
  entries,
  cast,
  busy,
  onWear
}: {
  outfit: Asset
  entries: CastEntry[]
  cast: SequenceCast
  busy: boolean
  onWear: (wearer: string | null | undefined) => void
}) {
  const characters = entries.flatMap((e) => (e.asset?.kind === 'character' && e.images.length ? [e.asset] : []))
  const present = entries.flatMap((e) =>
    e.asset && e.images.length
      ? [{ id: e.asset.id, kind: e.asset.kind, ...(e.asset.defaultOutfitId ? { defaultOutfitId: e.asset.defaultOutfitId } : {}) }]
      : []
  )
  const fallback = resolveOutfitWearers(present, undefined).get(outfit.id)
  const chosen = cast.outfitWearers?.[outfit.id]
  const value = chosen === null ? 'nobody' : (chosen ?? '')
  const fallbackName = characters.find((c) => c.id === fallback)?.name
  if (!characters.length) return null
  return (
    <label className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
      Worn by
      <select
        value={value}
        disabled={busy}
        onChange={(e) => onWear(e.target.value === '' ? undefined : e.target.value === 'nobody' ? null : e.target.value)}
        className="min-w-0 rounded border border-line bg-raised px-1 py-0.5 text-[11px] text-text outline-none focus:border-muted"
      >
        <option value="">{fallbackName ? `${fallbackName} (default)` : 'Nobody (default)'}</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value="nobody">Nobody</option>
      </select>
    </label>
  )
}
