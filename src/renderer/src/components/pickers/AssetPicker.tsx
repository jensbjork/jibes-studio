import { useMemo, useState, type KeyboardEvent } from 'react'
import { ASSET_KINDS, type Asset, type AssetKind } from '@shared/types'
import { ASSET_COPY, englishList } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import { KIND_TONE, PICKER_COPY } from './assetKinds'
import { defaultOutfitOf } from './assetRefs'
import { bringsVoice } from './audioRefs'
import { imageCount, matchesQuery } from './text'

interface Props {
  /** The whole library, all kinds. */
  assets: Asset[]
  /** The tab shown when the picker opens. */
  initialKind: AssetKind
  title: string
  /** Shown under the title, e.g. how many reference slots are left. */
  hint?: string
  /** Image paths already in use; they get a marker. */
  selectedPaths?: string[]
  /**
   * Clicking an asset's row (reference mode: all its photos). When omitted, a row click picks the asset's
   * cover image.
   */
  onPickAsset?: (asset: Asset) => void
  onPickImage: (path: string, asset: Asset) => void
  /** Free reference slots; with onPickAsset, rows warn when an asset's photos won't fit. */
  freeSlots?: number
  /** With onPickAsset: a character's first voice clip comes along (the model takes reference audio). */
  withVoice?: boolean
  /** Opens the library view of a kind; used by the empty state and the footer link. */
  onManage?: (kind: AssetKind) => void
}

/**
 * Popover content: the library's characters, environments, products, outfits and poses under one tab each. Pick a
 * whole asset or a single photo.
 */
export default function AssetPicker({
  assets,
  initialKind,
  title,
  hint,
  selectedPaths = [],
  onPickAsset,
  onPickImage,
  freeSlots,
  withVoice = false,
  onManage
}: Props) {
  const [kind, setKind] = useState(initialKind)
  const [query, setQuery] = useState('')
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  const counts = useMemo(() => {
    const n: Record<AssetKind, number> = { character: 0, environment: 0, product: 0, outfit: 0, pose: 0 }
    for (const a of assets) if (a.kind in n) n[a.kind] += 1
    return n
  }, [assets])

  const copy = PICKER_COPY[kind]
  const ofKind = assets.filter((a) => a.kind === kind)
  const visible = ofKind.filter((a) => matchesQuery(`${a.name} ${a.description}`, query))
  const selected = new Set(selectedPaths)

  const showTab = (k: AssetKind) => {
    setKind(k)
    setQuery('')
  }

  const onTabKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.key === 'ArrowRight' ? 1 : -1
    const next = ASSET_KINDS[(ASSET_KINDS.indexOf(kind) + step + ASSET_KINDS.length) % ASSET_KINDS.length]
    showTab(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus()
  }

  const pickRow = (a: Asset) => {
    if (!a.images.length) return
    if (onPickAsset) onPickAsset(a)
    else onPickImage(a.images[0].path, a)
  }

  // Outfit id → the characters that wear it by default, shown on outfit rows.
  const defaultFor = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of assets) {
      const outfit = defaultOutfitOf(c, byId)
      if (outfit) map.set(outfit.id, [...(map.get(outfit.id) ?? []), c.name])
    }
    return map
  }, [assets, byId])

  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
        {/* Five kinds share the popover's width: icon and count above, the name below, so no name is cut (the
            longest, Environments, gets a wider column). */}
        <div
          role="tablist"
          onKeyDown={onTabKeyDown}
          className="mt-2 grid grid-cols-[1fr_1.25fr_1fr_1fr_1fr] gap-0.5 rounded-md bg-raised p-0.5"
        >
          {ASSET_KINDS.map((k) => (
            <button
              key={k}
              role="tab"
              data-kind={k}
              aria-selected={k === kind}
              tabIndex={k === kind ? 0 : -1}
              onClick={() => showTab(k)}
              title={counts[k] ? `${ASSET_COPY[k].plural} (${counts[k]})` : ASSET_COPY[k].plural}
              className={`flex min-w-0 flex-col items-center gap-0.5 rounded px-0.5 pb-1 pt-1.5 text-[10px] ${
                k === kind ? 'bg-line text-text' : 'text-muted hover:text-text'
              } leading-none transition`}
            >
              <span className="flex items-center gap-1">
                <span className={`flex text-[13px] ${KIND_TONE[k].text}`}>
                  <AssetIcon kind={k} />
                </span>
                {counts[k] > 0 && <span className="text-[10px] tabular-nums text-muted">{counts[k]}</span>}
              </span>
              <span className="max-w-full truncate">{ASSET_COPY[k].plural}</span>
            </button>
          ))}
        </div>
        {ofKind.length > 6 && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={copy.search}
            className="mt-2 w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
          />
        )}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {ofKind.length === 0 ? (
          <div className="px-3 py-6 text-center text-muted">
            <p>{copy.emptyTitle}</p>
            <p className="mt-1 text-[11px]">{copy.emptyText}</p>
            {onManage && (
              <button
                onClick={() => onManage(kind)}
                className="mt-3 rounded-md border border-line px-3 py-1.5 text-text hover:bg-raised"
              >
                {copy.create}
              </button>
            )}
          </div>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted">
            {copy.noMatch} “{query}”.
          </p>
        ) : (
          visible.map((a) => (
            <AssetRow
              key={a.id}
              asset={a}
              selected={selected}
              reference={!!onPickAsset}
              freeSlots={freeSlots}
              outfit={onPickAsset ? defaultOutfitOf(a, byId) : undefined}
              voice={onPickAsset && withVoice && bringsVoice(a)}
              wornBy={defaultFor.get(a.id)}
              onPickRow={() => pickRow(a)}
              onPickImage={(path) => onPickImage(path, a)}
            />
          ))
        )}
      </div>

      {onManage && ofKind.length > 0 && (
        <button
          onClick={() => onManage(kind)}
          className="border-t border-line px-3 py-2 text-left text-[11px] text-muted hover:bg-raised hover:text-text"
        >
          {copy.manage}
        </button>
      )}
    </>
  )
}

interface RowProps {
  asset: Asset
  selected: ReadonlySet<string>
  /** Reference mode: the row adds every photo, so it reports how many are in and whether the rest fit. */
  reference: boolean
  freeSlots?: number
  /** A character's default outfit, added along with it. */
  outfit?: Asset
  /** A character's first voice clip comes along with it. */
  voice?: boolean
  /** Names of the characters that wear this outfit by default. */
  wornBy?: string[]
  onPickRow: () => void
  onPickImage: (path: string) => void
}

function AssetRow({
  asset: a,
  selected,
  reference,
  freeSlots,
  outfit,
  voice = false,
  wornBy,
  onPickRow,
  onPickImage
}: RowProps) {
  const total = a.images.length
  const used = a.images.filter((img) => selected.has(img.path)).length
  const pending = total - used
  const all = total > 0 && used === total

  const status = !total
    ? 'No images yet'
    : !reference || !used
      ? imageCount(total)
      : all
        ? total === 1
          ? 'The image is added'
          : `All ${total} images added`
        : `${used} of ${total} images added`
  const extra = [
    voice ? 'with voice' : undefined,
    outfit ? `wears ${outfit.name}` : wornBy?.length ? `default for ${englishList(wornBy)}` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
  // The default outfit only comes along when all of its photos fit after the character's own.
  const outfitPending = outfit?.images.filter((img) => !selected.has(img.path)).length ?? 0
  const warning =
    !reference || freeSlots === undefined
      ? undefined
      : pending > freeSlots
        ? freeSlots
          ? `only ${freeSlots} ${freeSlots === 1 ? 'fits' : 'fit'}`
          : 'doesn’t fit'
        : outfitPending > freeSlots - pending
          ? 'the outfit doesn’t fit'
          : undefined

  return (
    <div className="rounded-md p-1.5 hover:bg-raised/60">
      <button
        onClick={onPickRow}
        disabled={!total}
        title={
          !total
            ? PICKER_COPY[a.kind].needsImages
            : reference
              ? `Add all images${voice ? (outfit ? ', the voice' : ' and the voice') : ''}` +
                (outfit ? ` and the default outfit “${outfit.name}”` : '')
              : 'Use the cover image'
        }
        className="flex w-full items-center gap-3 rounded-md text-left disabled:cursor-not-allowed disabled:opacity-50"
      >
        <AssetAvatar asset={a} className="h-10 w-10 rounded-md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{a.name}</span>
          <span className="block truncate text-[11px] text-muted">
            {status}
            {extra && ` · ${extra}`}
            {warning && <span className="text-accent"> · {warning}</span>}
          </span>
        </span>
        {all && <span className="pr-1 text-[11px] text-accent">✓</span>}
      </button>
      {total > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[52px]">
          {a.images.map((img, i) => (
            <button
              key={img.id}
              onClick={() => onPickImage(img.path)}
              title={selected.has(img.path) ? 'Already chosen' : `Image ${i + 1}`}
              className={`h-8 w-8 overflow-hidden rounded border transition ${
                selected.has(img.path) ? 'border-accent' : 'border-transparent hover:border-muted'
              }`}
            >
              <img src={mediaUrl(img.path)} draggable={false} decoding="async" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
