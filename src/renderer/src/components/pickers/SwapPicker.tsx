import { useMemo, useState } from 'react'
import { ASSET_KINDS, type Asset, type AssetKind, type Still } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import { useStills } from '../images/imageModels'
import StillThumb from '../images/StillThumb'
import { KIND_TONE } from './assetKinds'
import { imageCount, matchesQuery } from './text'

// What a click on a reference thumbnail opens, anchored to it: another library asset for every place of the
// picture's asset (a library photo), or another photo, a saved picture or a file for just that place (a picture of
// its own, or "Pick a single image instead…"). The panel only picks; the form swaps (in place, so no @ImageN
// number changes).

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
/** Saved pictures shown before "Show more". */
const STILLS_PAGE = 24

/** Every kind in the app's order, `first` (the swapped picture's kind) first. */
function kindsFrom(first: AssetKind | undefined): AssetKind[] {
  return first ? [first, ...ASSET_KINDS.filter((k) => k !== first)] : [...ASSET_KINDS]
}

function PanelHeader({ title, hint, onClose }: { title: string; hint?: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</p>}
      </div>
      <button
        onClick={onClose}
        className="-mr-1 rounded px-1.5 py-0.5 text-muted transition hover:bg-raised hover:text-text"
        title="Close (Esc)"
        aria-label="Close the picker"
      >
        ✕
      </button>
    </div>
  )
}

/** The other way to swap, as a link under the list: "Pick a single image instead…". */
export interface SwapAlternative {
  label: string
  title?: string
  onClick: () => void
}

function AlternativeLink({ alternative }: { alternative?: SwapAlternative }) {
  if (!alternative) return null
  return (
    <div className="border-t border-line px-4 py-2">
      <button
        onClick={alternative.onClick}
        title={alternative.title}
        className="rounded text-[12px] text-muted underline decoration-line underline-offset-2 outline-none transition hover:text-text focus-visible:ring-2 focus-visible:ring-muted"
      >
        {alternative.label}
      </button>
    </div>
  )
}

function KindHeading({ kind }: { kind: AssetKind }) {
  return (
    <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted">
      <span className={`flex ${KIND_TONE[kind].text}`}>
        <AssetIcon kind={kind} />
      </span>
      {ASSET_COPY[kind].plural}
    </p>
  )
}

interface SearchProps {
  value: string
  onChange: (query: string) => void
  placeholder: string
}

function Search({ value, onChange, placeholder }: SearchProps) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
    />
  )
}

interface ImageProps {
  /** E.g. "Swap @Image2 for…". */
  title: string
  hint?: string
  library: readonly Asset[]
  /** The picture being swapped: marked, and not offered. */
  current: string
  /** Its kind, when it is a library photo: that kind's assets come first. */
  currentKind?: AssetKind
  /** Where a picture already is in the list ("@Image3"); it gets a marker. */
  placeOf?: (path: string) => string | undefined
  /** Saved pictures to offer; left out, the panel lists them itself (a sequence's, or all of them). */
  stills?: Still[]
  sequenceId?: string
  /** Their heading; default "The sequence's images" or "Saved images". */
  stillsLabel?: string
  /** E.g. "Swap all of Anna instead…", under the list. */
  alternative?: SwapAlternative
  onPick: (path: string) => void
  onClose: () => void
}

/** Another picture for one place: every library asset's photos (the swapped one's kind first), saved pictures, a file. */
export function SwapImagePicker({
  title,
  hint,
  library,
  current,
  currentKind,
  placeOf,
  stills,
  sequenceId,
  stillsLabel,
  alternative,
  onPick,
  onClose
}: ImageProps) {
  const [query, setQuery] = useState('')
  const sections = useMemo(
    () =>
      kindsFrom(currentKind)
        .map((kind) => ({
          kind,
          assets: library.filter(
            (a) => a.kind === kind && a.images.length > 0 && matchesQuery(`${a.name} ${a.description}`, query)
          )
        }))
        .filter((s) => s.assets.length),
    [library, currentKind, query]
  )

  const pickFile = async () => {
    const [path] = await window.studio.pickImages(false)
    if (path && IMAGE_EXT.test(path)) onPick(path)
  }

  return (
    <>
      <PanelHeader title={title} hint={hint} onClose={onClose} />
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <Search value={query} onChange={setQuery} placeholder="Search the library…" />
        </div>
        <button
          onClick={() => void pickFile()}
          className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[12px] transition hover:bg-raised"
          title="Choose an image file on this Mac"
        >
          From file…
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sections.length === 0 && (
          <p className="px-1 py-4 text-center text-[12px] text-muted">
            {query ? `Nothing in the library matches “${query}”.` : 'The library has no images yet.'}
          </p>
        )}
        {sections.map(({ kind, assets }) => (
          <section key={kind} aria-label={ASSET_COPY[kind].plural} className="mb-4">
            <KindHeading kind={kind} />
            {/* One tile per photo, named like the strip's thumbnails: a big library still fits a screen or two. */}
            <div className="grid grid-cols-4 gap-1.5">
              {assets.flatMap((a) =>
                a.images.map((img, k) => {
                  const isCurrent = img.path === current
                  const at = isCurrent ? undefined : placeOf?.(img.path)
                  const of = a.images.length > 1 ? `${k + 1}/${a.images.length}` : undefined
                  const photo = of ? `photo ${k + 1} of ${a.images.length}` : 'photo'
                  const state = isCurrent ? ' (the one being swapped)' : at ? ` (already there as ${at})` : ''
                  return (
                    <PhotoButton
                      key={img.id}
                      path={img.path}
                      name={a.name}
                      of={of}
                      tone={KIND_TONE[kind].caption}
                      label={`${a.name}, ${photo}${state}`}
                      current={isCurrent}
                      badge={isCurrent ? 'now' : at}
                      onPick={() => onPick(img.path)}
                    />
                  )
                })
              )}
            </div>
          </section>
        ))}
        <LooseStills
          stills={stills}
          sequenceId={sequenceId}
          label={stillsLabel ?? (sequenceId ? 'The sequence’s images' : 'Saved images')}
          current={current}
          placeOf={placeOf}
          onPick={onPick}
        />
      </div>
      <AlternativeLink alternative={alternative} />
    </>
  )
}

function PhotoButton({
  path,
  name,
  of,
  tone,
  label,
  current,
  badge,
  onPick
}: {
  path: string
  /** The asset's name, on a strip in its kind's colour. */
  name: string
  /** "2/3" for one of several photos. */
  of?: string
  tone: string
  label: string
  current: boolean
  badge?: string
  onPick: () => void
}) {
  return (
    <button
      onClick={onPick}
      disabled={current}
      title={label}
      aria-label={label}
      className={`relative aspect-square w-full overflow-hidden rounded bg-raised outline-none ring-offset-2 ring-offset-panel transition focus-visible:ring-2 focus-visible:ring-muted ${
        current ? 'cursor-default ring-2 ring-text' : 'hover:brightness-110 hover:ring-1 hover:ring-muted'
      }`}
    >
      <img src={mediaUrl(path)} alt="" draggable={false} decoding="async" loading="lazy" className="h-full w-full object-cover" />
      <span className={`absolute inset-x-0 bottom-0 flex gap-1 px-1 text-[10px] leading-[15px] text-white ${tone}`}>
        <span className="min-w-0 flex-1 truncate text-center">{name}</span>
        {of && <span className="shrink-0 tabular-nums opacity-80">{of}</span>}
      </span>
      {badge && (
        <span className="absolute left-0.5 top-0.5 rounded bg-black/75 px-0.5 text-[9px] leading-[13px] text-white">
          {badge}
        </span>
      )}
    </button>
  )
}

interface LooseProps {
  stills?: Still[]
  sequenceId?: string
  label: string
  current: string
  placeOf?: (path: string) => string | undefined
  onPick: (path: string) => void
}

/** The saved pictures (stills), given or loaded here – only while the panel is open. */
function LooseStills(props: LooseProps) {
  return props.stills ? <StillGrid {...props} stills={props.stills} /> : <LoadedStills {...props} />
}

function LoadedStills(props: LooseProps) {
  const { stills } = useStills(props.sequenceId)
  return <StillGrid {...props} stills={stills} />
}

function StillGrid({ stills, label, current, placeOf, onPick }: LooseProps & { stills: Still[] }) {
  const [shown, setShown] = useState(STILLS_PAGE)
  if (!stills.length) return null
  return (
    <section aria-label={label} className="mb-4">
      <p className="mb-1.5 px-1 text-[11px] font-medium text-muted">{label}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {stills.slice(0, shown).map((s) => {
          const isCurrent = s.path === current
          const at = isCurrent ? undefined : placeOf?.(s.path)
          return (
            <StillThumb
              key={s.id}
              still={s}
              selected={isCurrent}
              onOpen={isCurrent ? undefined : () => onPick(s.path)}
              className="aspect-video w-full"
            >
              {at && <span className="rounded bg-black/75 px-0.5 text-[9px] leading-[13px] text-white">{at}</span>}
            </StillThumb>
          )
        })}
      </div>
      {stills.length > shown && (
        <button
          onClick={() => setShown((n) => n + STILLS_PAGE)}
          className="mt-2 w-full rounded-md px-2 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-text"
        >
          Show more ({stills.length - shown} more)
        </button>
      )}
    </section>
  )
}

interface AssetProps {
  /** E.g. "Swap Anna for…". */
  title: string
  hint?: string
  library: readonly Asset[]
  /** The asset whose places are swapped: marked, and not offered. */
  from: Asset
  /** Ids of the assets already among the references; they get a marker. */
  present?: ReadonlySet<string>
  /** E.g. "Pick a single image instead…", under the list. */
  alternative?: SwapAlternative
  onPick: (asset: Asset) => void
  onClose: () => void
}

/** Another asset for every place of `from`: the library's assets with photos, `from`'s kind first. */
export function SwapAssetPicker({ title, hint, library, from, present, alternative, onPick, onClose }: AssetProps) {
  const [query, setQuery] = useState('')
  const sections = useMemo(
    () =>
      kindsFrom(from.kind)
        .map((kind) => ({
          kind,
          assets: library.filter((a) => a.kind === kind && matchesQuery(`${a.name} ${a.description}`, query))
        }))
        .filter((s) => s.assets.length),
    [library, from.kind, query]
  )
  return (
    <>
      <PanelHeader title={title} hint={hint} onClose={onClose} />
      <div className="border-b border-line px-4 py-2.5">
        <Search value={query} onChange={setQuery} placeholder="Search the library…" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sections.length === 0 && (
          <p className="px-1 py-4 text-center text-[12px] text-muted">Nothing in the library matches “{query}”.</p>
        )}
        {sections.map(({ kind, assets }) => (
          <section key={kind} aria-label={ASSET_COPY[kind].plural} className="mb-4">
            <KindHeading kind={kind} />
            {assets.map((a) => {
              const isFrom = a.id === from.id
              const sound = a.audio.length ? (a.kind === 'character' ? 'with voice' : 'with sound') : undefined
              const facts = [a.images.length ? imageCount(a.images.length) : 'No images yet', sound]
                .filter(Boolean)
                .join(' · ')
              // The swapped asset itself is shown (dimmed) so the list reads as the library; one already among the
              // references can still be picked – its photos then take these places too.
              const note = isFrom ? 'the one being swapped' : present?.has(a.id) ? 'already included' : undefined
              return (
                <button
                  key={a.id}
                  onClick={() => onPick(a)}
                  disabled={isFrom || !a.images.length}
                  title={!a.images.length ? 'Has no images to swap to' : undefined}
                  className="flex w-full items-center gap-3 rounded-md p-1.5 text-left transition hover:bg-raised/60 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <AssetAvatar asset={a} className="h-10 w-10 rounded-md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {facts}
                      {note && <span className={isFrom ? '' : 'text-accent'}> · {note}</span>}
                    </span>
                  </span>
                </button>
              )
            })}
          </section>
        ))}
      </div>
      <AlternativeLink alternative={alternative} />
    </>
  )
}
