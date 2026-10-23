import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { Asset } from '@shared/types'
import { ASSET_COPY, ASSET_FOLDER, assetAudio, audioCountLabel } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { FILE_MANAGER } from '../../lib/platform'
import FolderIcon from '../library/FolderIcon'
import SectionTitle from '../library/SectionTitle'
import PromptField from '../prompt/PromptField'
import { buttonClass } from '../ui/button'
import MoreMenu, { MenuDivider, MenuItem } from '../ui/MoreMenu'
import AssetAvatar from './AssetAvatar'
import AssetImages from './AssetImages'
import AssetSounds, { type SoundFocus } from './AssetSounds'
import DefaultOutfitPicker from './DefaultOutfitPicker'
import { deleteAssetFilesNote, deleteAssetQuestion, deleteOutfitNote } from './deleteText'
import { droppedPaths, fileDragKinds, imageCountLabel, isFileDrag, type FileDragKinds } from './imageUtils'
import { useAssetDraft, type SaveState } from './useAssetDraft'

interface Props {
  asset: Asset
  /** Every outfit, for a character's default outfit. */
  outfits: Asset[]
  outfitsLoaded: boolean
  /** The characters that have this outfit as their default (outfits only). */
  wearers: Asset[]
  /** Focus and select the name, e.g. right after creating the asset. */
  autoFocusName: boolean
  /** Images currently being copied into the library. */
  addingImages: number
  /** Sound clips currently being copied into the library. */
  addingAudio: number
  /** A sound clip (or a failed voice design) to bring into view and point out (see AssetSounds). */
  focusAudio?: SoundFocus
  navigate: Navigate
  onUpdated: (a: Asset) => void
  /** Files dropped or picked: photos, and sound clips for the kinds that have them. */
  onAddFiles: (paths: string[]) => void
  /** After the question in ⋯; a rejection is shown there. */
  onDelete: () => Promise<void>
  onError: (message: string) => void
}

const createdFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Name, description, actions and reference images of one character, environment, product, outfit or pose (plus a
 * character's default outfit and voice, an environment's sound and which characters wear an outfit by default), laid
 * out as every library editor is: the name, a meta line, one row of actions (Generate, then ⋯ with Open folder and
 * Delete…), then the sections. Mount with key={asset.id}.
 */
export default function AssetEditor({
  asset,
  outfits,
  outfitsLoaded,
  wearers,
  autoFocusName,
  addingImages,
  addingAudio,
  focusAudio,
  navigate,
  onUpdated,
  onAddFiles,
  onDelete,
  onError
}: Props) {
  const copy = ASSET_COPY[asset.kind]
  const draft = useAssetDraft(asset, onUpdated)
  const nameRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [fileOver, setFileOver] = useState<FileDragKinds>()
  const [copied, setCopied] = useState(false)
  const [audioBusy, setAudioBusy] = useState(false)
  const imageCount = asset.images.length
  const audioCount = assetAudio(asset).length
  const audioLabel = audioCountLabel(asset.kind, audioCount)
  const isCharacter = asset.kind === 'character'
  const outfit = isCharacter && draft.defaultOutfitId ? outfits.find((o) => o.id === draft.defaultOutfitId) : undefined

  useEffect(() => {
    if (!autoFocusName) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [autoFocusName])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copyDescription = async () => {
    try {
      await navigator.clipboard.writeText(draft.description.trim())
      setCopied(true)
    } catch {
      onError("Couldn't copy to the clipboard.")
    }
  }

  // A pending autosave must not race the delete; a refusal goes back to ⋯'s question, which shows it.
  const remove = async () => {
    draft.suspend()
    try {
      await onDelete()
    } catch (e) {
      draft.resume()
      throw e
    }
  }

  const openFolder = () => {
    window.studio.revealLibraryFolder(ASSET_FOLDER[asset.kind], asset.id).catch((e) => onError(ipcErrorMessage(e)))
  }

  // Files can be dropped anywhere in the editor; photos go to the images and sound to the clips, and each
  // section lights up for what is being dragged.
  const onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current += 1
    if (dragDepth.current === 1) setFileOver(fileDragKinds(e))
  }
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setFileOver(undefined)
  }
  const onDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setFileOver(undefined)
    const paths = droppedPaths(e)
    if (paths.length) onAddFiles(paths)
  }

  // Generate reads the asset from the library, so photos and clips still being copied, a just-picked outfit
  // (or name) and a just-moved voice window still being saved must land first, or the form would get the
  // asset as it was. A click meanwhile is kept and carried out once they have.
  const [generateWaiting, setGenerateWaiting] = useState(false)
  const settling = addingImages > 0 || addingAudio > 0 || audioBusy || draft.state.kind === 'saving'
  useEffect(() => {
    if (!generateWaiting || settling) return
    setGenerateWaiting(false)
    navigate('generate', { type: 'use-asset', assetId: asset.id })
  }, [generateWaiting, settling])

  const generateTitle = !imageCount
    ? 'Add at least one image first'
    : `Opens Generate in reference mode with ${copy.possessive} images${outfit ? ` and ${outfit.name}` : ''}` +
      (isCharacter && audioCount ? ' – and the voice, if the model takes audio' : '')
  const folderTitle =
    `Open ${copy.possessive} folder in ${FILE_MANAGER}: the images` +
    `${copy.audio ? `, the ${copy.audio.clips}` : ''} and the description`

  return (
    <div
      className="flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="drag flex h-12 shrink-0 items-center justify-end px-6">
        <SaveIndicator state={draft.state} />
      </div>

      {/* The gutter stays whether or not the page scrolls, so the column doesn't shift between kinds. */}
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-4xl px-8 pb-16">
          <header className="flex items-center gap-4">
            <AssetAvatar asset={asset} className="h-14 w-14 rounded-xl text-xl" />
            <div className="min-w-0 flex-1">
              <input
                ref={nameRef}
                value={draft.name}
                onChange={(e) => draft.setName(e.target.value)}
                onBlur={draft.onBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                placeholder="Name"
                aria-label="Name"
                spellCheck={false}
                className="-ml-2 w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold outline-none hover:border-line focus:border-muted focus:bg-raised"
              />
              <p className="mt-0.5 text-[11px] text-muted">
                {imageCountLabel(imageCount)}
                {audioLabel && audioCount > 0 && ` · ${audioLabel}`} · Created {createdFormat.format(asset.createdAt)}
              </p>
            </div>
          </header>

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGenerateWaiting(true)}
              disabled={!imageCount || generateWaiting}
              title={generateTitle}
              className={buttonClass('primary')}
            >
              {generateWaiting ? 'Saving…' : `Generate ${copy.generatePhrase}`}
            </button>
            <div className="ml-auto">
              <MoreMenu>
                {(menu) => (
                  <>
                    <MenuItem icon={<FolderIcon size={13} />} title={folderTitle} onSelect={openFolder}>
                      Open folder
                    </MenuItem>
                    <MenuDivider />
                    <MenuItem
                      danger
                      onSelect={() =>
                        menu.confirm({
                          question: deleteAssetQuestion(asset, draft.name.trim() || asset.name),
                          note: [deleteOutfitNote(wearers.map((c) => c.name)), deleteAssetFilesNote(asset)]
                            .filter(Boolean)
                            .join(' '),
                          onConfirm: remove
                        })
                      }
                    >
                      Delete…
                    </MenuItem>
                  </>
                )}
              </MoreMenu>
            </div>
          </div>

          <section className="mt-8">
            <SectionTitle
              title="Description"
              htmlFor="asset-description"
              hint={copy.descriptionHint}
              actions={
                <button
                  type="button"
                  onClick={copyDescription}
                  disabled={!draft.description.trim()}
                  title="Copy the description, e.g. for a start-image or text prompt"
                  className={buttonClass('ghost', 'inline')}
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
              }
            />
            <PromptField
              id="asset-description"
              value={draft.description}
              onChange={draft.setDescription}
              onBlur={draft.onBlur}
              minRows={4}
              maxRows={14}
              title="Description"
              focusHint={copy.descriptionHint}
              placeholder={copy.descriptionPlaceholder}
            />
          </section>

          {isCharacter && (
            <section className="mt-8">
              <SectionTitle title="Default outfit" hint="Comes along when you add the character to a generation" />
              <DefaultOutfitPicker
                outfits={outfits}
                loaded={outfitsLoaded}
                value={draft.defaultOutfitId}
                onChange={draft.setDefaultOutfit}
                onOpen={(id) => navigate('outfits', { type: 'open-asset', assetId: id })}
                onManage={() => navigate('outfits')}
              />
            </section>
          )}

          {asset.kind === 'outfit' && (
            <Wearers
              wearers={wearers}
              onOpen={(id) => navigate('characters', { type: 'open-asset', assetId: id })}
              onManage={() => navigate('characters')}
            />
          )}

          <section className="mt-8">
            <AssetImages
              asset={asset}
              adding={addingImages}
              fileOver={!!fileOver?.image}
              onAdd={onAddFiles}
              onUpdated={onUpdated}
              onError={onError}
            />
          </section>

          {copy.audio && (
            <section className="mt-10">
              <AssetSounds
                asset={asset}
                adding={addingAudio}
                fileOver={!!fileOver?.audio}
                onAdd={onAddFiles}
                onUpdated={onUpdated}
                onError={onError}
                onBusyChange={setAudioBusy}
                focus={focusAudio}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/** "Default outfit for Anna, Kalle": the characters that wear this outfit unless told otherwise. */
function Wearers({
  wearers,
  onOpen,
  onManage
}: {
  wearers: Asset[]
  onOpen: (characterId: string) => void
  /** Goes to Characters, where a character's default outfit is chosen. */
  onManage: () => void
}) {
  return (
    <section className="mt-8">
      <SectionTitle
        title="Default outfit for"
        hint={wearers.length ? 'Comes along when you add one of them to a generation' : undefined}
      />
      {wearers.length ? (
        <div className="flex flex-wrap gap-2">
          {wearers.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpen(c.id)}
              title={`Show ${c.name} under Characters`}
              className="flex max-w-60 items-center gap-2 rounded-full border border-line bg-raised py-1 pl-1 pr-3 transition hover:border-muted"
            >
              <AssetAvatar asset={c} className="h-6 w-6 rounded-full text-[10px]" />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-muted">
          No character yet – choose it as a character's default outfit under{' '}
          <button type="button" onClick={onManage} className="text-text underline-offset-2 hover:underline">
            Characters
          </button>
          .
        </p>
      )}
    </section>
  )
}

/** How the autosave is doing, alone at the right of the editor's top bar (Directors' too). */
export function SaveIndicator({ state }: { state: SaveState }) {
  if (state.kind === 'saving') return <span className="text-[11px] text-muted">Saving…</span>
  if (state.kind === 'saved') return <span className="text-[11px] text-muted">Saved</span>
  if (state.kind === 'error') {
    return (
      <span className="no-drag max-w-md truncate text-[11px] text-danger select-text" title={state.message}>
        Couldn't save: {state.message}
      </span>
    )
  }
  return null
}
