import { useRef, useState, type DragEvent } from 'react'
import type { Asset, AssetKind } from '@shared/types'
import { ASSET_COPY, assetAudio } from '../../lib/assets'
import AssetAvatar from './AssetAvatar'
import { droppedPaths, imageCountLabel, isFileDrag } from './imageUtils'

// Below this many entries a search field is just clutter.
const SEARCH_THRESHOLD = 6

interface Props {
  kind: AssetKind
  /** Every asset of the kind, sorted; filtering happens here. */
  assets: Asset[]
  /** Character id → the name of its default outfit, shown under the name. */
  outfitNames?: ReadonlyMap<string, string>
  selectedId?: string
  /** False until the first load has had a chance to arrive. */
  ready: boolean
  query: string
  onQuery: (query: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
  creating: boolean
  /** Photos being copied in, per asset id. */
  addingImages: Record<string, number>
  /** Sound clips being copied in, per asset id. */
  addingAudio: Record<string, number>
  /** Files from Finder dropped on a row: photos and (for kinds that have them) sound clips. */
  onDropFiles: (assetId: string, paths: string[]) => void
}

function matches(a: Asset, q: string): boolean {
  return a.name.toLocaleLowerCase('sv').includes(q) || a.description.toLocaleLowerCase('sv').includes(q)
}

export default function AssetList({
  kind,
  assets,
  outfitNames,
  selectedId,
  ready,
  query,
  onQuery,
  onSelect,
  onCreate,
  creating,
  addingImages,
  addingAudio,
  onDropFiles
}: Props) {
  const copy = ASSET_COPY[kind]
  const q = query.trim().toLocaleLowerCase('sv')
  const visible = q ? assets.filter((a) => matches(a, q)) : assets
  const showSearch = assets.length >= SEARCH_THRESHOLD || !!query

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line">
      <div className="drag flex h-12 shrink-0 items-center justify-between pl-5 pr-3">
        <span className="font-medium">{copy.plural}</span>
        <button
          onClick={onCreate}
          disabled={creating}
          className="no-drag rounded-md px-2.5 py-1 text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          title={copy.newName}
        >
          ＋ {copy.newName}
        </button>
      </div>

      {showSearch && (
        <div className="px-3 pb-2">
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('')
            }}
            placeholder="Sök namn eller beskrivning"
            className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {assets.length === 0 ? (
          ready && <p className="px-2 pt-2 text-[11px] leading-relaxed text-muted">{copy.listHint}</p>
        ) : visible.length === 0 ? (
          <p className="px-2 pt-2 text-muted">Inga träffar för ”{query.trim()}”.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((a) => (
              <li key={a.id}>
                <AssetListItem
                  asset={a}
                  outfitName={outfitNames?.get(a.id)}
                  active={a.id === selectedId}
                  addingImages={addingImages[a.id] ?? 0}
                  addingAudio={addingAudio[a.id] ?? 0}
                  onSelect={() => onSelect(a.id)}
                  onDropFiles={(paths) => onDropFiles(a.id, paths)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

interface ItemProps {
  asset: Asset
  outfitName?: string
  active: boolean
  addingImages: number
  addingAudio: number
  onSelect: () => void
  onDropFiles: (paths: string[]) => void
}

/** "3 bilder · röst · i Röd klänning": what the asset has, short enough for the list column. */
function summary(a: Asset, outfitName: string | undefined): string {
  const parts = [imageCountLabel(a.images.length)]
  const audio = ASSET_COPY[a.kind].audio
  if (audio && assetAudio(a).length) parts.push(audio.listLabel)
  if (outfitName) parts.push(`i ${outfitName}`)
  return parts.join(' · ')
}

/** One row; also a drop target that adds Finder images (and sound clips) to that asset. */
function AssetListItem({
  asset: a,
  outfitName,
  active,
  addingImages,
  addingAudio,
  onSelect,
  onDropFiles
}: ItemProps) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    depth.current += 1
    setOver(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }
  const onDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const paths = droppedPaths(e)
    if (paths.length) onDropFiles(paths)
  }

  return (
    <button
      onClick={onSelect}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex w-full items-center gap-3 rounded-md p-2 text-left transition ${
        over ? 'bg-accent/10 ring-1 ring-accent' : active ? 'bg-raised' : 'hover:bg-raised/60'
      }`}
    >
      <AssetAvatar asset={a} className="h-10 w-10 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className={`truncate ${active ? 'text-text' : 'text-text/90'}`}>{a.name}</div>
        <div className="truncate text-[11px] text-muted">
          {over
            ? 'Släpp för att lägga till'
            : addingImages
              ? 'Lägger till bilder…'
              : addingAudio
                ? 'Lägger till ljud…'
                : summary(a, outfitName)}
        </div>
      </div>
    </button>
  )
}
