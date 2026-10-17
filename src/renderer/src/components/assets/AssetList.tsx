import { useRef, useState, type DragEvent } from 'react'
import type { Asset, AssetKind, WorkCounts } from '@shared/types'
import { ASSET_COPY, assetAudio } from '../../lib/assets'
import { useOwnerWork } from '../../lib/work'
import SideList, { SideListRow, type SideRowControl } from '../library/SideList'
import { StatusMark } from '../work/StatusMark'
import { failedText } from '../work/workText'
import AssetAvatar from './AssetAvatar'
import { deleteAssetFilesNote, deleteAssetQuestion, deleteOutfitNote } from './deleteText'
import { droppedPaths, imageCountLabel, isFileDrag } from './imageUtils'

interface Props {
  kind: AssetKind
  /** Every asset of the kind, sorted; the search filters them. */
  assets: Asset[]
  /** Character id → the name of its default outfit, shown under the name. */
  outfitNames?: ReadonlyMap<string, string>
  /** Outfit id → the characters that wear it by default, for the question before it is deleted. */
  wearerNames?: ReadonlyMap<string, string[]>
  selectedId?: string
  /** False until the first load has had a chance to arrive. */
  ready: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  creating: boolean
  /** Photos being copied in, per asset id. */
  addingImages: Record<string, number>
  /** Sound clips being copied in, per asset id. */
  addingAudio: Record<string, number>
  /** Files from Finder dropped on a row: photos and (for kinds that have them) sound clips. */
  onDropFiles: (assetId: string, paths: string[]) => void
  /** After the row's question (with the row that takes its place); throws to show the error there. */
  onDelete: (assetId: string, nextId: string | undefined) => Promise<void>
}

/** Karaktärer, Miljöer, Produkter, Kläder or Poser: the shared side list, with drops of Finder files on a row. */
export default function AssetList({
  kind,
  assets,
  outfitNames,
  wearerNames,
  selectedId,
  ready,
  onSelect,
  onCreate,
  creating,
  addingImages,
  addingAudio,
  onDropFiles,
  onDelete
}: Props) {
  const copy = ASSET_COPY[kind]
  return (
    <SideList
      title={copy.plural}
      createLabel={copy.newName}
      createTitle={copy.newName}
      onCreate={onCreate}
      creating={creating}
      items={ready ? assets : undefined}
      selectedId={selectedId}
      onSelect={onSelect}
      searchPlaceholder="Sök namn eller beskrivning"
      searchText={(a) => a.description}
      emptyText={copy.listHint}
      deleteQuestion={(a) => deleteAssetQuestion(a)}
      deleteNote={(a) =>
        [deleteOutfitNote(wearerNames?.get(a.id) ?? []), deleteAssetFilesNote(a)].filter(Boolean).join(' ')
      }
      onDelete={(a, next) => onDelete(a.id, next?.id)}
      renderRow={(a, control) => (
        <AssetListItem
          asset={a}
          control={control}
          outfitName={outfitNames?.get(a.id)}
          addingImages={addingImages[a.id] ?? 0}
          addingAudio={addingAudio[a.id] ?? 0}
          onDropFiles={(paths) => onDropFiles(a.id, paths)}
        />
      )}
    />
  )
}

interface ItemProps {
  asset: Asset
  control: SideRowControl
  outfitName?: string
  addingImages: number
  addingAudio: number
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

/**
 * What Pågår och klart says about an asset (only characters have work of their own so far: a voice made with AI):
 * "Skapar en röst…", "1 ny röst", "… · 1 misslyckades".
 */
function workTitle(c: WorkCounts): string | undefined {
  const parts: string[] = []
  if (c.running > 0) parts.push(c.running === 1 ? 'Skapar en röst…' : `Skapar ${c.running} röster…`)
  if (c.unseen > 0) parts.push(c.unseen === 1 ? '1 ny röst' : `${c.unseen} nya röster`)
  if (c.failed > 0) parts.push(failedText(c.failed))
  return parts.length ? parts.join(' · ') : undefined
}

/** One row; also a drop target that adds Finder images (and sound clips) to that asset. */
function AssetListItem({ asset: a, control, outfitName, addingImages, addingAudio, onDropFiles }: ItemProps) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const work = useOwnerWork(a.id)
  const title = workTitle(work)

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
    <SideListRow
      control={control}
      visual={<AssetAvatar asset={a} className="h-10 w-10 rounded-md" />}
      name={a.name}
      meta={
        over
          ? 'Släpp för att lägga till'
          : addingImages
            ? 'Lägger till bilder…'
            : addingAudio
              ? 'Lägger till ljud…'
              : summary(a, outfitName)
      }
      status={<StatusMark running={work.running} fresh={work.unseen} failed={work.failed} variant="inline" />}
      title={title}
      deleteTitle={`Radera ${ASSET_COPY[a.kind].definite}`}
      highlight={over}
      dropHandlers={{ onDragEnter, onDragOver, onDragLeave, onDrop }}
    />
  )
}
