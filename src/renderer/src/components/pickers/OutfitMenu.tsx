import { useState } from 'react'
import type { Asset } from '@shared/types'
import AssetAvatar from '../assets/AssetAvatar'
import { PICKER_COPY } from './assetKinds'
import { imageCount, matchesQuery } from './text'

interface Props {
  character: Asset
  /** Every outfit in the library. */
  outfits: Asset[]
  /** Ids of the outfits the character wears in the form now. */
  wearing: string[]
  /** The form's reference images, to tell which outfits fit. */
  refs: string[]
  max: number
  /** null takes the character's clothes off (removes the worn outfits' photos). */
  onPick: (outfit: Asset | null) => void
  /** Opens the outfits view. */
  onManage?: () => void
}

const copy = PICKER_COPY.outfit

/** Popover content for "Byt kläder" on a character chip: swap what the character wears for another outfit. */
export default function OutfitMenu({ character, outfits, wearing, refs, max, onPick, onManage }: Props) {
  const [query, setQuery] = useState('')
  const worn = new Set(wearing)
  const visible = outfits.filter((o) => matchesQuery(`${o.name} ${o.description}`, query))

  // Photos the character's current clothes take up; a new outfit replaces them.
  const wornPaths = new Set(outfits.filter((o) => worn.has(o.id)).flatMap((o) => o.images.map((img) => img.path)))

  /** How many of the outfit's photos would be left out, after taking off the others. */
  const shortfall = (o: Asset): number => {
    const own = new Set(o.images.map((img) => img.path))
    const kept = refs.filter((p) => !wornPaths.has(p) || own.has(p))
    const missing = o.images.filter((img) => !kept.includes(img.path)).length
    return Math.max(0, missing - Math.max(0, max - kept.length))
  }

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <p className="truncate font-medium">Kläder för {character.name}</p>
        <p className="mt-0.5 text-[11px] text-muted">
          {wearing.length
            ? `Byter ut det ${character.name} har på sig nu.`
            : 'Lägger till klädselns bilder bland referensbilderna.'}
        </p>
        {outfits.length > 8 && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={copy.search}
            className="mt-2 w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {outfits.length === 0 ? (
          <div className="px-3 py-6 text-center text-muted">
            <p>{copy.emptyTitle}</p>
            <p className="mt-1 text-[11px]">{copy.emptyText}</p>
            {onManage && (
              <button
                onClick={onManage}
                className="mt-3 rounded-md border border-line px-3 py-1.5 text-text hover:bg-raised"
              >
                {copy.create}
              </button>
            )}
          </div>
        ) : (
          <>
            {wearing.length > 0 && !query && (
              <button
                onClick={() => onPick(null)}
                className="flex w-full items-center gap-3 rounded-md p-1.5 text-left hover:bg-raised/60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-line text-muted">
                  –
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Ingen klädsel</span>
                  <span className="block text-[11px] text-muted">Tar bort klädernas bilder från referensbilderna</span>
                </span>
              </button>
            )}
            {visible.length === 0 ? (
              <p className="px-3 py-6 text-center text-muted">
                {copy.noMatch} ”{query}”.
              </p>
            ) : (
              visible.map((o) => {
                const short = shortfall(o)
                const isDefault = o.id === character.defaultOutfitId
                return (
                  <button
                    key={o.id}
                    onClick={() => onPick(o)}
                    disabled={!o.images.length}
                    title={!o.images.length ? copy.needsImages : worn.has(o.id) ? 'Har på sig den nu' : undefined}
                    className={`flex w-full items-center gap-3 rounded-md p-1.5 text-left hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-50 ${
                      worn.has(o.id) ? 'bg-raised/60' : ''
                    }`}
                  >
                    <AssetAvatar asset={o} className="h-9 w-9 rounded-md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{o.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {o.images.length ? imageCount(o.images.length) : 'Inga bilder än'}
                        {isDefault && ' · standard'}
                        {short > 0 && (
                          <span className="text-accent">
                            {' '}
                            · {short === o.images.length ? 'får inte plats' : `${short} får inte plats`}
                          </span>
                        )}
                      </span>
                    </span>
                    {worn.has(o.id) && <span className="pr-1 text-[11px] text-accent">✓</span>}
                  </button>
                )
              })
            )}
          </>
        )}
      </div>

      {onManage && outfits.length > 0 && (
        <button
          onClick={onManage}
          className="border-t border-line px-3 py-2 text-left text-[11px] text-muted hover:bg-raised hover:text-text"
        >
          {copy.manage}
        </button>
      )}
    </>
  )
}
