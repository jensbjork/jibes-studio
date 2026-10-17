import type { Asset } from '@shared/types'
import { assetAudio, audioCountLabel, swedishList } from '../../lib/assets'
import { imageCountLabel } from './imageUtils'

// What deleting an asset says, the same in its editor (Radera) and on its row in the list (✕).

/** " och 3 bilder", ", 3 bilder och 1 röstklipp", " och 1 röstklipp" or "": what goes with the asset. */
function deletedFiles(imageCount: number, audioLabel: string | undefined): string {
  const files = [imageCount ? imageCountLabel(imageCount) : undefined, audioLabel].filter(Boolean) as string[]
  if (!files.length) return ''
  return files.length === 1 ? ` och ${files[0]}` : `, ${swedishList(files)}`
}

/** "Radera ”Anna” och 3 bilder?" – `name` is the name being typed, in the editor. */
export function deleteAssetQuestion(asset: Asset, name = asset.name): string {
  const audio = assetAudio(asset).length
  return `Radera ”${name}”${deletedFiles(asset.images.length, audio ? audioCountLabel(asset.kind, audio) : undefined)}?`
}

/** Where its files go: to the Trash, except those generations or clips use. */
export function deleteAssetFilesNote(asset: Asset): string {
  const images = asset.images.length > 0
  const audio = assetAudio(asset).length > 0
  if (!images && !audio) return 'Mappen flyttas till papperskorgen.'
  const what = images && audio ? 'Bilderna och ljudklippen' : images ? 'Bilderna' : 'Ljudklippen'
  return `${what} flyttas till papperskorgen – utom de som genereringar eller klipp använder, de flyttas till Referensbilder.`
}

/** An outfit's wearers: "Anna och Bo har den som standardklädsel och blir utan." */
export function deleteOutfitNote(wearerNames: readonly string[]): string | undefined {
  return wearerNames.length ? `${swedishList([...wearerNames])} har den som standardklädsel och blir utan.` : undefined
}
