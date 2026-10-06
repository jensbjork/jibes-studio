import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ASSET_KINDS, type Asset, type PromptLanguage } from '@shared/types'
import { ASSET_COPY, swedishList } from '../../lib/assets'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import { KIND_TONE } from './assetKinds'
import { outfitsWornBy, type AssetRef } from './assetRefs'
import OutfitMenu from './OutfitMenu'
import Popover from './Popover'
import { assetReference, characterReference, formatImageRefs } from './text'

interface Props {
  /** The assets among the reference images (see assetRefsOf). */
  assetRefs: AssetRef[]
  /** Outfit id → id of the character wearing it (see resolvePairings). */
  pairings: ReadonlyMap<string, string>
  /** Every outfit in the library, for "Byt kläder". */
  outfits: Asset[]
  /** All reference images in the form, including ones that aren't library photos. */
  refs: string[]
  max: number
  /** Prompt language: decides the word between a character and its clothes ("wearing" / "i"). */
  language: PromptLanguage
  onInsert: (text: string) => void
  onRemove: (asset: Asset) => void
  /** "bärs av": who wears an outfit (null = nobody). */
  onWear: (outfitId: string, characterId: string | null) => void
  /** "Byt kläder": replace what a character wears (null = nothing). */
  onSwapOutfit: (character: Asset, outfit: Asset | null) => void
  onManageOutfits?: () => void
}

const chip = 'inline-flex max-w-full items-center rounded-full border text-[11px] transition'

/**
 * The library assets among the reference images, grouped and coloured by kind, with their @Image tokens.
 * Clicking a chip inserts its prompt text; below them the image budget.
 */
export default function AssetChips({
  assetRefs,
  pairings,
  outfits,
  refs,
  max,
  language,
  onInsert,
  onRemove,
  onWear,
  onSwapOutfit,
  onManageOutfits
}: Props) {
  const sorted = ASSET_KINDS.flatMap((k) => assetRefs.filter((r) => r.asset.kind === k))
  const characters = assetRefs.filter((r) => r.asset.kind === 'character').map((r) => r.asset)
  const over = refs.length > max

  return (
    <div className="mt-2">
      {sorted.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sorted.map((entry) => {
            const a = entry.asset
            if (a.kind === 'character') {
              return (
                <CharacterChip
                  key={a.id}
                  entry={entry}
                  wearing={outfitsWornBy(a.id, assetRefs, pairings)}
                  outfits={outfits}
                  refs={refs}
                  max={max}
                  language={language}
                  onInsert={onInsert}
                  onRemove={() => onRemove(a)}
                  onSwapOutfit={(o) => onSwapOutfit(a, o)}
                  onManageOutfits={onManageOutfits}
                />
              )
            }
            const wearer = a.kind === 'outfit' ? pairings.get(a.id) : undefined
            return (
              <AssetChip
                key={a.id}
                entry={entry}
                text={assetReference(a.name, entry.indices)}
                onInsert={onInsert}
                onRemove={() => onRemove(a)}
              >
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
            ? 'Klicka på ett namn för att infoga det i prompten – eller skriv @ i prompten.'
            : 'Hänvisa till bilderna i prompten, t.ex. ”@Image1 går längs stranden” – skriv @ för att välja.'}
        </span>
        <span
          className={`shrink-0 tabular-nums ${over ? 'text-accent' : ''}`}
          title={
            over
              ? `${refs.length - max} av bilderna skickas inte – modellen tar max ${max}.`
              : `Modellen tar max ${max} referensbilder.`
          }
        >
          {refs.length}/{max} bilder
        </span>
      </div>
    </div>
  )
}

interface ChipProps {
  entry: AssetRef
  /** What a click inserts into the prompt. */
  text: string
  onInsert: (text: string) => void
  onRemove: () => void
  /** Extra info after the tokens, inside the insert button. */
  detail?: ReactNode
  /** Controls between the insert button and ✕. */
  children?: ReactNode
}

/** "● Strandpromenaden @Image4 ✕": click inserts the reference, ✕ removes the asset's photos. */
function AssetChip({ entry, text, onInsert, onRemove, detail, children }: ChipProps) {
  const { asset: a, indices } = entry
  const tone = KIND_TONE[a.kind]
  return (
    <span className={`${chip} ${tone.chip}`}>
      <button
        onClick={() => onInsert(text)}
        title={`Infoga ”${text}” i prompten`}
        className="flex min-w-0 items-center gap-1.5 py-0.5 pl-0.5 pr-1.5"
      >
        <AssetAvatar asset={a} className={`h-5 w-5 rounded-full ring-1 ${tone.ring}`} />
        <span className="min-w-0 truncate font-medium">{a.name}</span>
        <span className="shrink-0 text-muted">{formatImageRefs(indices)}</span>
        {detail}
      </button>
      {children}
      <button
        onClick={onRemove}
        title={`Ta bort ${ASSET_COPY[a.kind].possessive} bilder från referensbilderna`}
        className="mr-1 shrink-0 rounded-full px-1 text-muted hover:text-text"
      >
        ✕
      </button>
    </span>
  )
}

interface CharacterChipProps {
  entry: AssetRef
  /** The outfits paired with this character. */
  wearing: AssetRef[]
  outfits: Asset[]
  refs: string[]
  max: number
  language: PromptLanguage
  onInsert: (text: string) => void
  onRemove: () => void
  onSwapOutfit: (outfit: Asset | null) => void
  onManageOutfits?: () => void
}

/** A character chip shows what the character wears, inserts both together, and can swap the clothes. */
function CharacterChip({
  entry,
  wearing,
  outfits,
  refs,
  max,
  language,
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
    language
  )

  return (
    <AssetChip
      entry={entry}
      text={text}
      onInsert={onInsert}
      onRemove={onRemove}
      detail={
        wearing.length > 0 && (
          <span className="min-w-0 truncate text-muted">i {swedishList(wearing.map((w) => w.asset.name))}</span>
        )
      }
    >
      <button
        ref={button}
        onClick={() => setOpen((o) => !o)}
        title={wearing.length ? 'Byt kläder' : 'Välj kläder'}
        aria-label={wearing.length ? 'Byt kläder' : 'Välj kläder'}
        className={`flex shrink-0 items-center rounded-full p-0.5 transition hover:text-text ${
          open ? 'text-text' : 'text-muted'
        }`}
      >
        <AssetIcon kind="outfit" />
      </button>
      <Popover anchorRef={button} open={open} onClose={close} width={300} maxHeight={420} label="Byt kläder">
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

/** "bärs av Anna ▾" on an outfit chip. Only shapes the text inserted for the character. */
function WearerSelect({ outfit, wearer, characters, onChange }: WearerSelectProps) {
  const name = characters.find((c) => c.id === wearer)?.name
  return (
    <label
      className="relative flex shrink-0 items-center gap-1 pr-1 text-muted"
      title={`Vem har på sig ${outfit.name}? Styr texten som infogas för karaktären.`}
    >
      <span>bärs av</span>
      <span className={`max-w-20 truncate ${name ? 'text-text' : ''}`}>{name ?? 'ingen'}</span>
      <span aria-hidden>▾</span>
      {/* The native select sits invisibly on top, so the chip keeps its own look but gets the system menu. */}
      <select
        value={wearer ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={`Vem bär ${outfit.name}`}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Ingen</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  )
}
