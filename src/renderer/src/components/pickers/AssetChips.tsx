import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ASSET_KINDS, type Asset, type PromptLanguage } from '@shared/types'
import { ASSET_COPY, englishList } from '../../lib/assets'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import { KIND_TONE } from './assetKinds'
import { outfitsWornBy, type AssetRef } from './assetRefs'
import { audioIndicesOf, clipsOf, type FormAudio } from './audioRefs'
import OutfitMenu from './OutfitMenu'
import Popover from './Popover'
import {
  assetReference,
  audioWord,
  characterReference,
  formatAudioRefs,
  formatImageRefs,
  poseReference,
  productReference
} from './text'

interface Props {
  /** The assets among the reference images (see assetRefsOf). */
  assetRefs: AssetRef[]
  /** Outfit id → id of the character wearing it (see resolvePairings). */
  pairings: ReadonlyMap<string, string>
  /** Every outfit in the library, for "Change outfit". */
  outfits: Asset[]
  /** All reference images in the form, including ones that aren't library photos. */
  refs: string[]
  max: number
  /** Prompt language: decides the words between a character and its voice and clothes ("voice" or the Swedish word…). */
  language: PromptLanguage
  /** The form's reference audio as @AudioN references (also clips that aren't sent). */
  audios: FormAudio[]
  /** The model takes reference audio: characters and environments with clips offer to bring theirs along. */
  audioSupported: boolean
  /** Whether the asset's first clip would fit among the reference audio, and why not. */
  audioFits: (asset: Asset) => { fits: boolean; reason?: string }
  /** "Include the voice": adds the asset's first clip, or removes all of its clips. */
  onToggleAudio: (asset: Asset, include: boolean) => void
  /** Pose id → the characters it applies to; undefined: every character in the form. */
  posePeople: Readonly<Record<string, string[] | undefined>>
  onPosePeople: (poseId: string, characterIds: string[] | undefined) => void
  /** Product id → the character holding it ("held by"); missing or null: nobody (the default). */
  productHolders: Readonly<Record<string, string | null | undefined>>
  onHolder: (productId: string, characterId: string | null) => void
  onInsert: (text: string) => void
  onRemove: (asset: Asset) => void
  /** "worn by": who wears an outfit (null = nobody). */
  onWear: (outfitId: string, characterId: string | null) => void
  /** "Change outfit": replace what a character wears (null = nothing). */
  onSwapOutfit: (character: Asset, outfit: Asset | null) => void
  onManageOutfits?: () => void
}

const chip = 'inline-flex max-w-full items-center rounded-full border text-[11px] transition'

/** The characters a pose applies to: the chosen ones still in the form, or all of them by default. */
export function posePeopleOf(
  poseId: string,
  characters: readonly AssetRef[],
  chosen: Readonly<Record<string, string[] | undefined>>
): AssetRef[] {
  const ids = chosen[poseId]
  return ids ? characters.filter((c) => ids.includes(c.asset.id)) : [...characters]
}

/**
 * The character holding a product in the form: the one chosen with "held by", while it is still among the
 * references. Nobody by default – a product is often just in the scene, and guessing a hand for it would put
 * words in the prompt the user didn't ask for.
 */
export function productHolderOf(
  productId: string,
  characters: readonly AssetRef[],
  chosen: Readonly<Record<string, string | null | undefined>>
): AssetRef | undefined {
  const id = chosen[productId]
  return id ? characters.find((c) => c.asset.id === id) : undefined
}

/**
 * The library assets among the reference images, grouped and coloured by kind, with their @Image (and @Audio)
 * tokens. Clicking a chip inserts its prompt text; below them the image budget.
 */
export default function AssetChips({
  assetRefs,
  pairings,
  outfits,
  refs,
  max,
  language,
  audios,
  audioSupported,
  audioFits,
  onToggleAudio,
  posePeople,
  onPosePeople,
  productHolders,
  onHolder,
  onInsert,
  onRemove,
  onWear,
  onSwapOutfit,
  onManageOutfits
}: Props) {
  const sorted = ASSET_KINDS.flatMap((k) => assetRefs.filter((r) => r.asset.kind === k))
  // Only clips that are sent get written into the prompt; a clip this model won't take would be a wrong token.
  const sentAudios = audios.filter((a) => a.sent)
  const characterRefs = assetRefs.filter((r) => r.asset.kind === 'character')
  const characters = characterRefs.map((r) => r.asset)
  const over = refs.length > max

  /** The toggle that brings a character's voice (or an environment's sound) along, when it has any. */
  const audioToggle = (a: Asset): ReactNode => {
    const included = audioIndicesOf(audios, a.id)
    if (!clipsOf(a).length || (!audioSupported && !included.length)) return null
    return (
      <AudioToggle
        asset={a}
        included={included}
        supported={audioSupported}
        fits={audioFits(a)}
        onToggle={(on) => onToggleAudio(a, on)}
      />
    )
  }

  return (
    <div className="mt-2">
      {sorted.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sorted.map((entry) => {
            const a = entry.asset
            const own = audioIndicesOf(sentAudios, a.id)
            if (a.kind === 'character') {
              return (
                <CharacterChip
                  key={a.id}
                  entry={entry}
                  voices={own}
                  wearing={outfitsWornBy(a.id, assetRefs, pairings)}
                  outfits={outfits}
                  refs={refs}
                  max={max}
                  language={language}
                  audioToggle={audioToggle(a)}
                  onInsert={onInsert}
                  onRemove={() => onRemove(a)}
                  onSwapOutfit={(o) => onSwapOutfit(a, o)}
                  onManageOutfits={onManageOutfits}
                />
              )
            }
            if (a.kind === 'pose') {
              const people = posePeopleOf(a.id, characterRefs, posePeople)
              return (
                <AssetChip
                  key={a.id}
                  entry={entry}
                  text={poseReference(
                    { name: a.name, indices: entry.indices },
                    people.map((p) => ({ name: p.asset.name, indices: p.indices })),
                    language
                  )}
                  onInsert={onInsert}
                  onRemove={() => onRemove(a)}
                >
                  <PosePeopleSelect
                    pose={a}
                    characters={characters}
                    chosen={posePeople[a.id]}
                    onChange={(ids) => onPosePeople(a.id, ids)}
                  />
                </AssetChip>
              )
            }
            if (a.kind === 'product') {
              const holder = productHolderOf(a.id, characterRefs, productHolders)
              return (
                <AssetChip
                  key={a.id}
                  entry={entry}
                  text={productReference(
                    { name: a.name, indices: entry.indices },
                    holder && { name: holder.asset.name, indices: holder.indices },
                    language
                  )}
                  onInsert={onInsert}
                  onRemove={() => onRemove(a)}
                >
                  {characters.length > 0 && (
                    <HolderSelect
                      product={a}
                      holder={holder?.asset.id}
                      characters={characters}
                      onChange={(id) => onHolder(a.id, id)}
                    />
                  )}
                </AssetChip>
              )
            }
            const wearer = a.kind === 'outfit' ? pairings.get(a.id) : undefined
            return (
              <AssetChip
                key={a.id}
                entry={entry}
                audios={own}
                text={assetReference(a.name, entry.indices, own, audioWord(a.kind, language))}
                onInsert={onInsert}
                onRemove={() => onRemove(a)}
              >
                {audioToggle(a)}
                {a.kind === 'outfit' && characters.length > 0 && (
                  <WearerSelect
                    outfit={a}
                    wearer={wearer}
                    characters={characters}
                    onChange={(id) => onWear(a.id, id)}
                  />
                )}
              </AssetChip>
            )
          })}
        </div>
      )}
      <div className="mt-1.5 flex items-start gap-3 text-[11px] text-muted">
        <span className="min-w-0 flex-1">
          {sorted.length
            ? 'Click a name to insert it in the prompt – or type @ in the prompt.'
            : 'Refer to the images in the prompt, e.g. “@Image1 walks along the beach” – type @ to choose.'}
        </span>
        <span
          className={`shrink-0 tabular-nums ${over ? 'text-accent' : ''}`}
          title={
            over
              ? `${refs.length - max} of the images ${refs.length - max === 1 ? 'isn’t' : 'aren’t'} sent – the model takes at most ${max}.`
              : `The model takes at most ${max} reference images.`
          }
        >
          {refs.length}/{max} images
        </span>
      </div>
    </div>
  )
}

interface ChipProps {
  entry: AssetRef
  /** The asset's @AudioN numbers in the form, shown after its image tokens. */
  audios?: number[]
  /** What a click inserts into the prompt. */
  text: string
  onInsert: (text: string) => void
  onRemove: () => void
  /** Extra info after the tokens, inside the insert button. */
  detail?: ReactNode
  /** Controls between the insert button and ✕. */
  children?: ReactNode
}

/** "● Strandpromenaden @Image4 ✕": click inserts the reference, ✕ removes the asset's photos (and audio). */
function AssetChip({ entry, audios = [], text, onInsert, onRemove, detail, children }: ChipProps) {
  const { asset: a, indices } = entry
  const tone = KIND_TONE[a.kind]
  const copy = ASSET_COPY[a.kind]
  return (
    <span className={`${chip} ${tone.chip}`}>
      <button
        onClick={() => onInsert(text)}
        title={`Insert “${text}” in the prompt`}
        className="flex min-w-0 items-center gap-1.5 py-0.5 pl-0.5 pr-1.5"
      >
        <AssetAvatar asset={a} className={`h-5 w-5 rounded-full ring-1 ${tone.ring}`} />
        <span className="min-w-0 truncate font-medium">{a.name}</span>
        <span className="shrink-0 text-muted">
          {formatImageRefs(indices)}
          {audios.length > 0 && <span className={tone.text}> · {formatAudioRefs(audios)}</span>}
        </span>
        {detail}
      </button>
      {children}
      <button
        onClick={onRemove}
        title={
          audios.length
            ? `Remove ${copy.possessive} images and sound from the references`
            : `Remove ${copy.possessive} images from the reference images`
        }
        className="mr-1 shrink-0 rounded-full px-1 text-muted hover:text-text"
      >
        ✕
      </button>
    </span>
  )
}

interface AudioToggleProps {
  asset: Asset
  /** The asset's @AudioN numbers in the form; empty while its audio isn't included. */
  included: number[]
  /** The model takes reference audio. */
  supported: boolean
  fits: { fits: boolean; reason?: string }
  onToggle: (include: boolean) => void
}

/**
 * "Include the voice" on a character chip (or "Include the soundscape" on an environment's): a microphone that is lit while
 * the clip is among the reference audio. Off removes every clip of the asset from it.
 */
function AudioToggle({ asset, included, supported, fits, onToggle }: AudioToggleProps) {
  const on = included.length > 0
  const voice = asset.kind === 'character'
  const label = voice ? 'Include the voice' : 'Include the soundscape'
  const what = voice ? 'The voice' : 'The soundscape'
  const disabled = !on && !fits.fits
  const title = on
    ? supported
      ? `${what} is sent as ${formatAudioRefs(included)} – click to remove it`
      : `${what} (${formatAudioRefs(included)}) isn’t sent – the model doesn’t take sound. Click to remove it.`
    : disabled
      ? `${what} can’t be included: ${fits.reason ?? 'no room left'}`
      : `${label} (${voice ? 'the first voice clip' : 'the first sound clip'})`
  return (
    <button
      onClick={() => onToggle(!on)}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={title}
      className={`flex shrink-0 items-center rounded-full p-0.5 transition disabled:opacity-40 ${
        on ? (supported ? KIND_TONE[asset.kind].text : 'text-accent') : 'text-muted hover:text-text'
      }`}
    >
      <MicIcon crossed={!on} />
    </button>
  )
}

function MicIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <rect x="4" y="1" width="4" height="6.2" rx="2" fill="currentColor" />
      <path
        d="M2.4 5.6a3.6 3.6 0 0 0 7.2 0M6 9.2v1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {crossed && <path d="M1.5 1.5l9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />}
    </svg>
  )
}

interface CharacterChipProps {
  entry: AssetRef
  /** The character's @AudioN numbers in the form (its voice). */
  voices: number[]
  /** The outfits paired with this character. */
  wearing: AssetRef[]
  outfits: Asset[]
  refs: string[]
  max: number
  language: PromptLanguage
  audioToggle: ReactNode
  onInsert: (text: string) => void
  onRemove: () => void
  onSwapOutfit: (outfit: Asset | null) => void
  onManageOutfits?: () => void
}

/** A character chip shows its voice and what it wears, inserts them together, and can swap the clothes. */
function CharacterChip({
  entry,
  voices,
  wearing,
  outfits,
  refs,
  max,
  language,
  audioToggle,
  onInsert,
  onRemove,
  onSwapOutfit,
  onManageOutfits
}: CharacterChipProps) {
  const { asset: c, indices } = entry
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const text = characterReference(
    c.name,
    indices,
    wearing.map((w) => ({ name: w.asset.name, indices: w.indices })),
    language,
    voices
  )

  return (
    <AssetChip
      entry={entry}
      audios={voices}
      text={text}
      onInsert={onInsert}
      onRemove={onRemove}
      detail={
        wearing.length > 0 && (
          <span className="min-w-0 truncate text-muted">wearing {englishList(wearing.map((w) => w.asset.name))}</span>
        )
      }
    >
      {audioToggle}
      <button
        ref={button}
        onClick={() => setOpen((o) => !o)}
        title={wearing.length ? 'Change outfit' : 'Choose an outfit'}
        aria-label={wearing.length ? 'Change outfit' : 'Choose an outfit'}
        className={`flex shrink-0 items-center rounded-full p-0.5 transition hover:text-text ${
          open ? 'text-text' : 'text-muted'
        }`}
      >
        <AssetIcon kind="outfit" />
      </button>
      <Popover anchorRef={button} open={open} onClose={close} width={300} maxHeight={420} label="Change outfit">
        <OutfitMenu
          character={c}
          outfits={outfits}
          wearing={wearing.map((w) => w.asset.id)}
          refs={refs}
          max={max}
          onPick={(o) => {
            close()
            onSwapOutfit(o)
          }}
          onManage={
            onManageOutfits &&
            (() => {
              close()
              onManageOutfits()
            })
          }
        />
      </Popover>
    </AssetChip>
  )
}

interface WearerSelectProps {
  outfit: Asset
  wearer?: string
  /** The characters in the form. */
  characters: Asset[]
  onChange: (characterId: string | null) => void
}

/**
 * "worn by Anna ▾" on an outfit chip: who wears the outfit (GenerationParams.outfitWearers). The References legend
 * says it when the prompt is sent ("worn by Anna (@Image1)"), and it shapes the text inserted for the character.
 */
function WearerSelect({ outfit, wearer, characters, onChange }: WearerSelectProps) {
  const name = characters.find((c) => c.id === wearer)?.name
  return (
    <label
      className="relative flex shrink-0 items-center gap-1 pr-1 text-muted"
      title={`Who wears ${outfit.name}? Written into the prompt when it is sent (Added to the prompt), and shapes the text inserted for the character.`}
    >
      <span>worn by</span>
      <span className={`max-w-20 truncate ${name ? 'text-text' : ''}`}>{name ?? 'nobody'}</span>
      <span aria-hidden>▾</span>
      {/* The native select sits invisibly on top, so the chip keeps its own look but gets the system menu. */}
      <select
        value={wearer ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={`Who wears ${outfit.name}`}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Nobody</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  )
}

interface HolderSelectProps {
  product: Asset
  /** The character holding it; undefined: nobody. */
  holder?: string
  /** The characters in the form. */
  characters: Asset[]
  onChange: (characterId: string | null) => void
}

/**
 * "held by Anna ▾" on a product chip: which of the form's characters holds the product. Only shapes the text the
 * chip inserts ("Anna (@Image1) holding Coffee tin (@Image4)"); nothing is stored.
 */
function HolderSelect({ product, holder, characters, onChange }: HolderSelectProps) {
  const name = characters.find((c) => c.id === holder)?.name
  return (
    <label
      className="relative flex shrink-0 items-center gap-1 pr-1 text-muted"
      title={`Who holds ${product.name}? Shapes the text that is inserted.`}
    >
      <span>held by</span>
      <span className={`max-w-20 truncate ${name ? 'text-text' : ''}`}>{name ?? 'nobody'}</span>
      <span aria-hidden>▾</span>
      {/* The native select sits invisibly on top, so the chip keeps its own look but gets the system menu. */}
      <select
        value={holder ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={`Who holds ${product.name}`}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Nobody</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  )
}

interface PosePeopleSelectProps {
  pose: Asset
  /** The characters in the form. */
  characters: Asset[]
  /** The ones chosen; undefined: all of them. */
  chosen: string[] | undefined
  /** undefined goes back to "all of them" (which follows characters added later). */
  onChange: (characterIds: string[] | undefined) => void
}

/**
 * "applies to Anna, Erik ▾" on a pose chip: which of the form's characters take the pose. Only shapes the text the
 * chip inserts ("Anna (@Image1) and Erik (@Image3) posed as in Hug (@Image5)"); nothing is stored.
 */
function PosePeopleSelect({ pose, characters, chosen, onChange }: PosePeopleSelectProps) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const selected = chosen ? characters.filter((c) => chosen.includes(c.id)) : characters
  const summary = !characters.length
    ? 'no characters'
    : !selected.length
      ? 'nobody'
      : !chosen || selected.length === characters.length
        ? characters.length === 1
          ? characters[0].name
          : 'everyone'
        : englishList(selected.map((c) => c.name))

  const toggle = (id: string): void => {
    const current = new Set(selected.map((c) => c.id))
    if (current.has(id)) current.delete(id)
    else current.add(id)
    const ids = characters.map((c) => c.id).filter((c) => current.has(c))
    // Everyone chosen again: back to the default, so characters added later are included too.
    onChange(ids.length === characters.length ? undefined : ids)
  }

  return (
    <>
      <button
        ref={button}
        onClick={() => setOpen((o) => !o)}
        disabled={!characters.length}
        title={
          characters.length
            ? `Which characters should stand as in ${pose.name}? Shapes the text that is inserted.`
            : 'Add characters to choose who takes the pose.'
        }
        aria-label={`Who the pose ${pose.name} applies to`}
        className={`flex shrink-0 items-center gap-1 pr-1 transition disabled:opacity-60 ${
          open ? 'text-text' : 'text-muted hover:text-text'
        }`}
      >
        <span>applies to</span>
        <span className={`max-w-24 truncate ${selected.length ? 'text-text' : ''}`}>{summary}</span>
        <span aria-hidden>▾</span>
      </button>
      <Popover anchorRef={button} open={open} onClose={close} width={240} maxHeight={320} label="Who the pose applies to">
        <div className="border-b border-line px-3 py-2">
          <p className="truncate font-medium">{pose.name} applies to</p>
          <p className="mt-0.5 text-[11px] text-muted">The characters who should stand like this – shapes the text that is inserted.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {characters.map((c) => {
            const checked = selected.some((s) => s.id === c.id)
            return (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md p-1.5 hover:bg-raised/60"
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} className="accent-accent" />
                <AssetAvatar asset={c} className={`h-6 w-6 rounded-full ring-1 ${KIND_TONE.character.ring}`} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </label>
            )
          })}
        </div>
        <div className="flex gap-1 border-t border-line p-1.5 text-[11px]">
          <button
            onClick={() => onChange(undefined)}
            className="flex-1 rounded px-2 py-1 text-muted hover:bg-raised hover:text-text"
          >
            Everyone
          </button>
          <button
            onClick={() => onChange([])}
            className="flex-1 rounded px-2 py-1 text-muted hover:bg-raised hover:text-text"
          >
            Nobody
          </button>
        </div>
      </Popover>
    </>
  )
}
