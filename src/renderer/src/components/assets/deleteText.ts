import type { Asset } from '@shared/types'
import { assetAudio, audioCountLabel, englishList } from '../../lib/assets'
import { TRASH } from '../../lib/platform'
import { imageCountLabel } from './imageUtils'

// What deleting an asset says, the same in its editor (Delete) and on its row in the list (✕).

/** " and 3 images", ", 3 images and 1 voice clip", " and 1 voice clip" or "": what goes with the asset. */
function deletedFiles(imageCount: number, audioLabel: string | undefined): string {
  const files = [imageCount ? imageCountLabel(imageCount) : undefined, audioLabel].filter(Boolean) as string[]
  if (!files.length) return ''
  return files.length === 1 ? ` and ${files[0]}` : `, ${englishList(files)}`
}

/** "Delete “Anna” and 3 images?" – `name` is the name being typed, in the editor. */
export function deleteAssetQuestion(asset: Asset, name = asset.name): string {
  const audio = assetAudio(asset).length
  return `Delete “${name}”${deletedFiles(asset.images.length, audio ? audioCountLabel(asset.kind, audio) : undefined)}?`
}

/** Where its files go: to the Trash, except those generations or clips use. */
export function deleteAssetFilesNote(asset: Asset): string {
  const images = asset.images.length > 0
  const audio = assetAudio(asset).length > 0
  if (!images && !audio) return `The folder is moved to ${TRASH}.`
  const what = images && audio ? 'The images and sound clips' : images ? 'The images' : 'The sound clips'
  return `${what} are moved to ${TRASH} – except those generations or clips use, which go to “Referensbilder”.`
}

/** An outfit's wearers: "Anna and Bo have it as their default outfit and will be left without one." */
export function deleteOutfitNote(wearerNames: readonly string[]): string | undefined {
  if (!wearerNames.length) return undefined
  const verb = wearerNames.length === 1 ? 'has' : 'have'
  return `${englishList(wearerNames)} ${verb} it as their default outfit and will be left without one.`
}
