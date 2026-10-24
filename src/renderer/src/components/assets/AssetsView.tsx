import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { MAX_AUDIO_CLIP_SECONDS, MIN_AUDIO_CLIP_SECONDS } from '@shared/models'
import type { Asset, AssetAudio, AssetKind } from '@shared/types'
import { ASSET_COPY, assetAudio, hasAudio, uniqueNewName } from '../../lib/assets'
import { ipcErrorMessage, useAssetsState } from '../../lib/hooks'
import { SELECTED_ASSET_KEYS } from '../../lib/library'
import type { Intent, Navigate } from '../../lib/navigation'
import { FloatingBanner } from '../ui/Banner'
import EmptyState from '../ui/EmptyState'
import AssetEditor from './AssetEditor'
import AssetIcon from './AssetIcon'
import AssetList from './AssetList'
import type { SoundFocus } from './AssetSounds'
import { LONG_AUDIO_SECONDS, clipFileName, formatDuration } from './audioUtils'
import { isFileDrag, sortFiles, sortedFilesNotice } from './imageUtils'

interface Notice {
  id: number
  tone: 'error' | 'info'
  text: string
}

function loadSelected(kind: AssetKind): string | undefined {
  try {
    return localStorage.getItem(SELECTED_ASSET_KEYS[kind]) ?? undefined
  } catch {
    return undefined
  }
}

function saveSelected(kind: AssetKind, id: string | undefined): void {
  try {
    if (id) localStorage.setItem(SELECTED_ASSET_KEYS[kind], id)
    else localStorage.removeItem(SELECTED_ASSET_KEYS[kind])
  } catch {
    // Remembering the selection is only a convenience.
  }
}

// How long a mutation result may stand in for an asset the live list doesn't contain yet.
const OVERLAY_GRACE_MS = 3000

interface Overlaid {
  asset: Asset
  receivedAt: number
}

const byName = (a: Asset, b: Asset) => a.name.localeCompare(b.name, 'en')

/**
 * The live list lags a moment behind each mutation, so assets returned by mutations are overlaid until the
 * list has caught up (same or newer updatedAt). Deleted ones are hidden right away.
 */
function mergeAssets(listed: Asset[], overlay: Record<string, Overlaid>, removed: ReadonlySet<string>): Asset[] {
  const byId = new Map(listed.map((a) => [a.id, a]))
  for (const { asset } of Object.values(overlay)) {
    const current = byId.get(asset.id)
    if (!current || current.updatedAt < asset.updatedAt) byId.set(asset.id, asset)
  }
  return [...byId.values()].filter((a) => !removed.has(a.id)).sort(byName)
}

/** Drops overlay entries the list has caught up with, and stale ones for assets it no longer has. */
function pruneOverlay(overlay: Record<string, Overlaid>, listed: Asset[]): Record<string, Overlaid> {
  const byId = new Map(listed.map((a) => [a.id, a]))
  const now = Date.now()
  const next: Record<string, Overlaid> = {}
  for (const [id, entry] of Object.entries(overlay)) {
    const current = byId.get(id)
    const keep = current ? current.updatedAt < entry.asset.updatedAt : now - entry.receivedAt < OVERLAY_GRACE_MS
    if (keep) next[id] = entry
  }
  return Object.keys(next).length === Object.keys(overlay).length ? overlay : next
}

/** Files being copied into the library, per asset id. */
type Adding = Record<string, number>

function bumpAdding(adding: Adding, assetId: string, delta: number): Adding {
  const n = (adding[assetId] ?? 0) + delta
  const next = { ...adding }
  if (n > 0) next[assetId] = n
  else delete next[assetId]
  return next
}

/** Advice for clips much longer than what is sent, so the user knows to pick the part that counts. */
function longClipsNotice(clips: AssetAudio[], section: string): string | undefined {
  if (!clips.length) return undefined
  const what =
    clips.length === 1
      ? `“${clipFileName(clips[0].path)}” is ${formatDuration(clips[0].duration)} long`
      : `${clips.length} of the audio files are longer than ${formatDuration(LONG_AUDIO_SECONDS)}`
  return (
    `${what}. Only an excerpt of ${MIN_AUDIO_CLIP_SECONDS}–${MAX_AUDIO_CLIP_SECONDS} s is sent with a generation – pick ` +
    `the best part under ${section}.`
  )
}

interface Props {
  kind: AssetKind
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

/**
 * Characters, Environments, Products, Outfits or Poses: the list of one kind of asset and an editor for the selected one.
 */
export default function AssetsView({ kind, intent, onIntentHandled, navigate }: Props) {
  const copy = ASSET_COPY[kind]
  // Every kind in one request: characters need the outfits, and outfits show who wears them.
  const { assets: all, loaded } = useAssetsState()
  const listed = useMemo(() => all.filter((a) => a.kind === kind), [all, kind])
  const outfits = useMemo(() => all.filter((a) => a.kind === 'outfit'), [all])
  const [overlay, setOverlay] = useState<Record<string, Overlaid>>({})
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | undefined>(() => loadSelected(kind))
  const [createdId, setCreatedId] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [addingImages, setAddingImages] = useState<Adding>({})
  const [addingAudio, setAddingAudio] = useState<Adding>({})
  const [notice, setNotice] = useState<Notice>()
  // A clip to point out in Voice (a new voice opened from Activity); a new object each time it is asked for.
  const [focusAudio, setFocusAudio] = useState<SoundFocus>()

  const assets = useMemo(() => mergeAssets(listed, overlay, removed), [listed, overlay, removed])
  // The remembered selection if it still exists, otherwise the first one.
  const selected = assets.find((a) => a.id === selectedId) ?? assets[0]

  const outfitNames = useMemo(() => {
    if (kind !== 'character') return undefined
    const names = new Map(outfits.map((o) => [o.id, o.name]))
    const map = new Map<string, string>()
    for (const a of assets) {
      const name = a.defaultOutfitId ? names.get(a.defaultOutfitId) : undefined
      if (name) map.set(a.id, name)
    }
    return map
  }, [kind, assets, outfits])

  const wearers = useMemo(
    () =>
      selected?.kind === 'outfit'
        ? all.filter((a) => a.kind === 'character' && a.defaultOutfitId === selected.id && !removed.has(a.id))
        : [],
    [all, selected, removed]
  )

  // Outfit id → who wears it by default, for the list's question before an outfit is deleted.
  const wearerNames = useMemo(() => {
    if (kind !== 'outfit') return undefined
    const map = new Map<string, string[]>()
    for (const c of all) {
      if (c.kind !== 'character' || !c.defaultOutfitId || removed.has(c.id)) continue
      map.set(c.defaultOutfitId, [...(map.get(c.defaultOutfitId) ?? []), c.name])
    }
    return map
  }, [kind, all, removed])

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  useEffect(() => setOverlay((o) => pruneOverlay(o, listed)), [listed])

  useEffect(() => saveSelected(kind, selectedId), [kind, selectedId])

  // "Show outfit" and similar links from the other library views, Activity's "Go there" (with the new voice's
  // clip) and an agent's open_in_studio. Opening an asset marks nothing seen, whoever asked: a new voice counts as
  // heard only once it has been played, so an agent's open (source 'agent') needs no different handling here.
  useEffect(() => {
    if (intent?.type !== 'open-asset') return
    setSelectedId(intent.assetId)
    setCreatedId(undefined)
    setFocusAudio(
      intent.audioId || intent.jobId ? { audioId: intent.audioId, jobId: intent.jobId } : undefined
    )
    onIntentHandled()
  }, [intent])

  // Advice never pushes an error off the screen before it has been read (the banner keeps an error until it is
  // closed; advice goes by itself).
  const notify = (text: string, tone: Notice['tone'] = 'error') =>
    setNotice((current) => (current?.tone === 'error' && tone === 'info' ? current : { id: Date.now(), tone, text }))

  const updated = (a: Asset) => setOverlay((o) => ({ ...o, [a.id]: { asset: a, receivedAt: Date.now() } }))

  const select = (id: string) => {
    setSelectedId(id)
    setCreatedId(undefined)
    setFocusAudio(undefined)
  }

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const a = await window.studio.saveAsset({ kind, name: uniqueNewName(assets, copy.newName), description: '' })
      updated(a)
      setSelectedId(a.id)
      setCreatedId(a.id)
    } catch (e) {
      notify(ipcErrorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  /**
   * From the editor's Delete or a row's ✕ in the list; the open one gives way to its neighbour (from the list: the row
   * that took its place among those the search shows). Throws so the editor (which then resumes autosaving) or the
   * row can show the error.
   */
  const remove = async (id: string, nextId?: string) => {
    const i = assets.findIndex((a) => a.id === id)
    const neighbor = nextId ?? (assets[i + 1] ?? assets[i - 1])?.id
    await window.studio.deleteAsset(id)
    setRemoved((s) => new Set(s).add(id))
    if (id === selected?.id) {
      setSelectedId(neighbor)
      setCreatedId(undefined)
    }
  }

  const addImages = async (assetId: string, images: string[]) => {
    setAddingImages((a) => bumpAdding(a, assetId, images.length))
    try {
      updated(await window.studio.addAssetImages(assetId, images))
    } catch (e) {
      notify(ipcErrorMessage(e))
    } finally {
      setAddingImages((a) => bumpAdding(a, assetId, -images.length))
    }
  }

  const addAudio = async (assetId: string, paths: string[]) => {
    const before = new Set(assetAudio(assets.find((a) => a.id === assetId) ?? { audio: [] }).map((c) => c.id))
    setAddingAudio((a) => bumpAdding(a, assetId, paths.length))
    try {
      const asset = await window.studio.addAssetAudio(assetId, paths)
      updated(asset)
      const long = assetAudio(asset).filter((c) => !before.has(c.id) && c.duration > LONG_AUDIO_SECONDS)
      const advice = longClipsNotice(long, copy.audio?.title ?? 'the sound')
      if (advice) notify(advice, 'info')
    } catch (e) {
      notify(ipcErrorMessage(e))
    } finally {
      setAddingAudio((a) => bumpAdding(a, assetId, -paths.length))
    }
  }

  /** Files dropped or picked for an asset: photos to its images, sound to its clips (kinds that have them). */
  const addFiles = (assetId: string, paths: string[]) => {
    const withAudio = hasAudio(kind)
    const files = sortFiles(paths, withAudio)
    const taken = files.images.length + files.audio.length
    const notice = sortedFilesNotice(files, withAudio)
    if (notice) notify(notice, taken ? 'info' : 'error')
    if (files.images.length) void addImages(assetId, files.images)
    if (files.audio.length) void addAudio(assetId, files.audio)
  }

  // Dropping files outside a drop target would otherwise navigate the window to the file.
  const guardDrop = (e: DragEvent) => {
    if (e.nativeEvent.defaultPrevented || !isFileDrag(e)) return
    e.preventDefault()
    if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
  }

  return (
    <div className="relative flex h-full" onDragOver={guardDrop} onDrop={guardDrop}>
      <AssetList
        kind={kind}
        assets={assets}
        outfitNames={outfitNames}
        wearerNames={wearerNames}
        selectedId={selected?.id}
        ready={loaded || assets.length > 0}
        onSelect={select}
        onCreate={create}
        creating={creating}
        addingImages={addingImages}
        addingAudio={addingAudio}
        onDropFiles={(id, paths) => {
          select(id)
          addFiles(id, paths)
        }}
        onDelete={remove}
      />

      <section className="min-w-0 flex-1">
        {selected ? (
          <AssetEditor
            key={selected.id}
            asset={selected}
            outfits={outfits}
            outfitsLoaded={loaded}
            wearers={wearers}
            autoFocusName={selected.id === createdId}
            addingImages={addingImages[selected.id] ?? 0}
            addingAudio={addingAudio[selected.id] ?? 0}
            focusAudio={focusAudio}
            navigate={navigate}
            onUpdated={updated}
            onAddFiles={(paths) => addFiles(selected.id, paths)}
            onDelete={() => remove(selected.id)}
            onError={notify}
          />
        ) : loaded ? (
          <div className="flex h-full flex-col">
            <div className="drag h-12 shrink-0" />
            <EmptyState
              icon={<AssetIcon kind={kind} />}
              title={copy.emptyTitle}
              text={copy.emptyText}
              action={{ label: copy.newName, onClick: () => void create(), disabled: creating }}
            />
          </div>
        ) : (
          <div className="drag h-12" />
        )}
      </section>

      {notice && (
        <FloatingBanner key={notice.id} tone={notice.tone} onDismiss={() => setNotice(undefined)}>
          {notice.text}
        </FloatingBanner>
      )}
    </div>
  )
}
