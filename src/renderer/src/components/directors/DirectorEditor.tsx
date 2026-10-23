import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { Asset, VideoModel } from '@shared/types'
import { ASSET_FOLDER } from '../../lib/assets'
import { directorMediaCounts, type DirectorEntry } from '../../lib/directors'
import { ipcErrorMessage } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { FILE_MANAGER, TRASH } from '../../lib/platform'
import { SaveIndicator } from '../assets/AssetEditor'
import AssetImages from '../assets/AssetImages'
import { droppedPaths, isFileDrag } from '../assets/imageUtils'
import FolderIcon from '../library/FolderIcon'
import SectionTitle from '../library/SectionTitle'
import { isVideoFile } from '../pickers/ReferenceVideos'
import { buttonClass } from '../ui/button'
import MoreMenu, { MenuDivider, MenuItem } from '../ui/MoreMenu'
import DirectionFields from './DirectionFields'
import DirectionPreview from './DirectionPreview'
import DirectorAvatar from './DirectorAvatar'
import { DefaultSettings, DirectorSettingsSection, ShotSettings } from './DirectorSettings'
import StyleVideos from './StyleVideos'
import { useDirectorDraft } from './useDirectorDraft'

interface Props {
  asset: Asset
  models: VideoModel[]
  /** Focus and select the name, e.g. right after creating it. */
  autoFocusName: boolean
  /** Style frames being copied into the library. */
  addingImages: number
  navigate: Navigate
  onUpdated: (a: Asset) => void
  /** Pictures dropped or picked for the style frames. */
  onAddImages: (paths: string[]) => void
  /** After the question in ⋯; a rejection is shown there. */
  onDelete: () => Promise<void>
  onError: (message: string) => void
}

const createdFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** What deleting a director does, under its question (in its editor and on its row). */
export const DELETE_DIRECTOR_NOTE = 'Sequences, storyboards and clips it directs are left without a director.'

/** Where its files go, also under the question. */
export const DELETE_DIRECTOR_FILES = `The folder is moved to ${TRASH} – style frames and videos that takes were made with are kept.`

/**
 * One of the user's own directors, laid out as every library editor is: its name, line and a meta line, one row of
 * actions (Generate, then ⋯ with Open folder and Delete…), then a field per part of the direction with building blocks
 * and, folded under them, the Direction section as a clip would be sent it; the style frames (its photos) and style
 * videos; and last, folded into one row, the shot length, what happens between shots and the defaults it sets.
 * Autosaved. Mount with key={asset.id}.
 */
export default function DirectorEditor({
  asset,
  models,
  autoFocusName,
  addingImages,
  navigate,
  onUpdated,
  onAddImages,
  onDelete,
  onError
}: Props) {
  const draft = useDirectorDraft(asset, onUpdated, onError)
  const nameRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [fileOver, setFileOver] = useState(false)
  // "3 style frames · Created 23 Oct 2026": the counts it has none of left out.
  const meta = [
    ...directorMediaCounts(asset.images.length, draft.videos.length),
    `Created ${createdFormat.format(asset.createdAt)}`
  ].join(' · ')

  useEffect(() => {
    if (!autoFocusName) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [autoFocusName])

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
    window.studio.revealLibraryFolder(ASSET_FOLDER.director, asset.id).catch((e) => onError(ipcErrorMessage(e)))
  }

  // Generate reads the director from the library, so an edit still being saved must land first; a click meanwhile
  // is kept and carried out once it has.
  const [generateWaiting, setGenerateWaiting] = useState(false)
  const settling = draft.settling || addingImages > 0
  useEffect(() => {
    if (!generateWaiting || settling) return
    setGenerateWaiting(false)
    navigate('generate', { type: 'use-director', directorId: asset.id })
  }, [generateWaiting, settling])

  // Pictures dropped anywhere become style frames, videos style videos.
  const onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current += 1
    if (dragDepth.current === 1) setFileOver(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e) || e.defaultPrevented) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setFileOver(false)
  }
  const onDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current = 0
    setFileOver(false)
    if (e.defaultPrevented) return
    e.preventDefault()
    const paths = droppedPaths(e)
    const clips = paths.filter(isVideoFile)
    const pictures = paths.filter((p) => !isVideoFile(p))
    if (pictures.length) onAddImages(pictures)
    if (clips.length) void draft.addVideos(clips)
  }

  const entry: DirectorEntry = {
    id: asset.id,
    name: draft.name,
    description: draft.description,
    direction: { ...draft.direction, videos: draft.videos },
    preset: false,
    asset
  }

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

      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-4xl px-8 pb-16">
          <header className="flex items-center gap-4">
            <DirectorAvatar entry={entry} className="h-14 w-14 rounded-xl text-xl" />
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
              <input
                value={draft.description}
                onChange={(e) => draft.setDescription(e.target.value)}
                onBlur={draft.onBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                placeholder="What it is good for, in one line…"
                aria-label="Description"
                spellCheck={false}
                className="-ml-2 mt-0.5 w-full rounded-md border border-transparent bg-transparent px-2 py-0.5 text-muted outline-none placeholder:text-muted/60 hover:border-line focus:border-muted focus:bg-raised focus:text-text"
              />
              <p className="mt-0.5 text-[11px] text-muted">{meta}</p>
            </div>
          </header>

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                draft.flush()
                setGenerateWaiting(true)
              }}
              disabled={generateWaiting}
              title="Opens Generate directed by it, with its defaults"
              className={buttonClass('primary')}
            >
              {generateWaiting ? 'Saving…' : 'Generate with the director'}
            </button>
            <div className="ml-auto">
              <MoreMenu>
                {(menu) => (
                  <>
                    <MenuItem
                      icon={<FolderIcon size={13} />}
                      title={`Open the director's folder in ${FILE_MANAGER}: its style frames and videos`}
                      onSelect={openFolder}
                    >
                      Open folder
                    </MenuItem>
                    <MenuDivider />
                    <MenuItem
                      danger
                      onSelect={() =>
                        menu.confirm({
                          question: `Delete “${draft.name.trim() || asset.name}”?`,
                          note: `${DELETE_DIRECTOR_NOTE} ${DELETE_DIRECTOR_FILES}`,
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

          <div className="@container/fields mt-8 space-y-9">
            <section>
              <SectionTitle title="Direction" hint="Written into every prompt it directs, after the references" />
              <DirectionFields
                direction={draft.direction}
                onChange={(field, text) => draft.setPart(field, text)}
                onBlur={draft.onBlur}
              />
              <div className="mt-4">
                <DirectionPreview entry={entry} />
              </div>
            </section>

            <section>
              <AssetImages
                asset={asset}
                adding={addingImages}
                fileOver={fileOver}
                onAdd={onAddImages}
                onUpdated={onUpdated}
                onError={onError}
              />
            </section>

            <section>
              <StyleVideos
                videos={draft.videos}
                onAdd={(paths) => void draft.addVideos(paths)}
                onChange={draft.setVideos}
              />
            </section>

            <DirectorSettingsSection direction={entry.direction} models={models}>
              <section>
                <SectionTitle title="In a sequence" hint="For new clips only – existing clips aren’t changed" />
                <ShotSettings
                  shotSeconds={draft.direction.shotSeconds}
                  continuity={draft.direction.continuity}
                  onShotSeconds={(seconds, now) => draft.setPart('shotSeconds', seconds, now)}
                  onContinuity={(c) => draft.setPart('continuity', c, true)}
                />
              </section>
              <section>
                <SectionTitle title="Defaults" hint="Set when you choose the director, where the model offers them" />
                <DefaultSettings
                  value={draft.direction.defaults}
                  models={models}
                  onChange={(defaults) => draft.setPart('defaults', defaults, true)}
                />
              </section>
            </DirectorSettingsSection>
          </div>
        </div>
      </div>
    </div>
  )
}
