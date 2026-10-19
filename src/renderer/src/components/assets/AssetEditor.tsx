import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { Asset } from '@shared/types'
import { ASSET_COPY, ASSET_FOLDER, assetAudio, audioCountLabel } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { FILE_MANAGER } from '../../lib/platform'
import OpenFolderButton from '../library/OpenFolderButton'
import AssetAvatar from './AssetAvatar'
import AssetImages from './AssetImages'
import AssetSounds, { type SoundFocus } from './AssetSounds'
import DefaultOutfitPicker from './DefaultOutfitPicker'
import { deleteAssetFilesNote, deleteAssetQuestion, deleteOutfitNote } from './deleteText'
import PromptField from '../prompt/PromptField'
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
  onDelete: () => Promise<void>
  onError: (message: string) => void
}

const createdFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Name, description, actions and reference images of one character, environment, product, outfit or pose (plus a
 * character's default outfit and voice, an environment's sound, which characters wear an outfit by default and how
 * a pose or a product is used). Mount with key={asset.id}.
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

  const remove = async () => {
    // A pending autosave must not race the delete.
    draft.suspend()
    try {
      await onDelete()
    } catch (e) {
      draft.resume()
      onError(ipcErrorMessage(e))
    }
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

      <div className="flex-1 overflow-y-auto">
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
              <p className="mt-0.5 text-muted">
                {imageCountLabel(imageCount)}
                {audioLabel && audioCount > 0 && ` · ${audioLabel}`} · Created {createdFormat.format(asset.createdAt)}
              </p>
            </div>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setGenerateWaiting(true)}
              disabled={!imageCount || generateWaiting}
              title={generateTitle}
              className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {generateWaiting ? 'Saving…' : `Generate ${copy.generatePhrase}`}
            </button>
            <button
              onClick={copyDescription}
              disabled={!draft.description.trim()}
              className="rounded-md border border-line px-4 py-2 hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {copied ? 'Copied ✓' : 'Copy description'}
            </button>
            <OpenFolderButton
              target={ASSET_FOLDER[asset.kind]}
              id={asset.id}
              title={`Show ${copy.possessive} folder with the images and the description in ${FILE_MANAGER}`}
              onError={onError}
              className="rounded-md border border-line px-4 py-2 hover:bg-raised disabled:opacity-40"
            />
            <div className="ml-auto">
              <DeleteControl
                question={deleteAssetQuestion(asset, draft.name.trim() || asset.name)}
                filesNote={deleteAssetFilesNote(asset)}
                note={deleteOutfitNote(wearers.map((c) => c.name))}
                onConfirm={remove}
              />
            </div>
          </div>

          <section className="mt-8">
            <label className="block">
              <span className="mb-1.5 flex items-baseline justify-between gap-4">
                <span className="font-medium">Description</span>
                <span className="text-[11px] text-muted">{copy.descriptionHint}</span>
              </span>
              <PromptField
                value={draft.description}
                onChange={draft.setDescription}
                onBlur={draft.onBlur}
                minRows={4}
                maxRows={14}
                showCount
                title="Description"
                focusHint={copy.descriptionHint}
                placeholder={copy.descriptionPlaceholder}
              />
            </label>
          </section>

          {isCharacter && (
            <section className="mt-8">
              <div className="mb-1.5 flex items-baseline justify-between gap-4">
                <h2 className="font-medium">Default outfit</h2>
                <span className="text-[11px] text-muted">
                  Comes along when you add the character to a generation
                </span>
              </div>
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

          {copy.usage && (
            <section className="mt-6 rounded-lg border border-line bg-panel px-4 py-3">
              <h2 className="mb-1 font-medium">How {copy.definite} is used</h2>
              <p className="text-[12px] leading-relaxed text-muted">{copy.usage}</p>
            </section>
          )}

          {asset.kind === 'outfit' && (
            <Wearers
              wearers={wearers}
              onOpen={(id) => navigate('characters', { type: 'open-asset', assetId: id })}
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
function Wearers({ wearers, onOpen }: { wearers: Asset[]; onOpen: (characterId: string) => void }) {
  return (
    <section className="mt-8">
      <h2 className="mb-1.5 font-medium">Default outfit for</h2>
      {wearers.length ? (
        <div className="flex flex-wrap gap-2">
          {wearers.map((c) => (
            <button
              key={c.id}
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
          No character yet. Pick the outfit as a character's default outfit under Characters, and it comes along
          with the character when you generate.
        </p>
      )}
    </section>
  )
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state.kind === 'saving') return <span className="text-[11px] text-muted">Saving…</span>
  if (state.kind === 'saved') return <span className="text-[11px] text-muted">Saved</span>
  if (state.kind === 'error') {
    return (
      <span className="no-drag max-w-md truncate text-[11px] text-accent select-text" title={state.message}>
        Couldn't save: {state.message}
      </span>
    )
  }
  return null
}

/** Inline two-step confirm; falls back to the plain button after a few seconds. The wording is the list's too. */
function DeleteControl({
  question,
  filesNote,
  note,
  onConfirm
}: {
  /** "Delete “Anna” and 3 images?" */
  question: string
  /** Where the files go, on hover. */
  filesNote: string
  /** A consequence worth knowing before confirming, shown under the question. */
  note?: string
  onConfirm: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!confirming || busy) return
    const t = setTimeout(() => setConfirming(false), note ? 9000 : 6000)
    return () => clearTimeout(t)
  }, [confirming, busy, note])

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="rounded-md px-3 py-2 text-muted hover:bg-raised hover:text-accent"
      >
        Delete
      </button>
    )
  }

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`text-muted ${note ? 'max-w-xs' : ''}`} title={filesNote}>
        {question}
        {note && <span className="mt-0.5 block text-[11px] leading-snug">{note}</span>}
      </span>
      <button
        onClick={confirm}
        disabled={busy}
        className="rounded-md bg-accent px-3 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
      >
        {busy ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="rounded-md border border-line px-3 py-2 hover:bg-raised disabled:opacity-40"
      >
        Cancel
      </button>
    </div>
  )
}
