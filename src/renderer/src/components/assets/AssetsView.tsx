import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { MAX_AUDIO_CLIP_SECONDS, MIN_AUDIO_CLIP_SECONDS } from '@shared/models'
import type { Asset, AssetAudio, AssetKind } from '@shared/types'
import { ASSET_COPY, assetAudio, hasAudio } from '../../lib/assets'
import { ipcErrorMessage, useAssetsState } from '../../lib/hooks'
import { SELECTED_ASSET_KEYS } from '../../lib/library'
import type { Intent, Navigate } from '../../lib/navigation'
import AssetEditor from './AssetEditor'
import AssetIcon from './AssetIcon'
import AssetList from './AssetList'
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

const byName = (a: Asset, b: Asset) => a.name.localeCompare(b.name, 'sv')

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
      ? `”${clipFileName(clips[0].path)}” är ${formatDuration(clips[0].duration)} lång`
      : `${clips.length} av ljudfilerna är längre än ${formatDuration(LONG_AUDIO_SECONDS)}`
  return (
    `${what}. Bara ett utdrag på ${MIN_AUDIO_CLIP_SECONDS}–${MAX_AUDIO_CLIP_SECONDS} s skickas till Venice – välj ` +
    `den bästa delen under ${section}.`
  )
}

function uniqueNewName(assets: Asset[], base: string): string {
  const taken = new Set(assets.map((a) => a.name.toLocaleLowerCase('sv')))
  if (!taken.has(base.toLocaleLowerCase('sv'))) return base
  let n = 2
  while (taken.has(`${base} ${n}`.toLocaleLowerCase('sv'))) n++
  return `${base} ${n}`
}

interface Props {
  kind: AssetKind
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

/** Karaktärer, Miljöer, Kläder or Poser: the list of one kind of asset and an editor for the selected one. */
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
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice>()

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

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  useEffect(() => setOverlay((o) => pruneOverlay(o, listed)), [listed])

  useEffect(() => saveSelected(kind, selectedId), [kind, selectedId])

  // "Visa klädseln" and similar links from the other library views.
  useEffect(() => {
    if (intent?.type !== 'open-asset') return
    setSelectedId(intent.assetId)
    setCreatedId(undefined)
    setQuery('')
    onIntentHandled()
  }, [intent])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(undefined), notice.tone === 'error' ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [notice])

  // Advice never pushes an error off the screen before it has been read; it times out on its own.
  const notify = (text: string, tone: Notice['tone'] = 'error') =>
    setNotice((current) => (current?.tone === 'error' && tone === 'info' ? current : { id: Date.now(), tone, text }))

  const updated = (a: Asset) => setOverlay((o) => ({ ...o, [a.id]: { asset: a, receivedAt: Date.now() } }))

  const select = (id: string) => {
    setSelectedId(id)
    setCreatedId(undefined)
  }

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const a = await window.studio.saveAsset({ kind, name: uniqueNewName(assets, copy.newName), description: '' })
      updated(a)
      setQuery('')
      setSelectedId(a.id)
      setCreatedId(a.id)
    } catch (e) {
      notify(ipcErrorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  /** Throws so the editor can show the error and resume autosaving. */
  const remove = async (id: string) => {
    const i = assets.findIndex((a) => a.id === id)
    const neighbor = assets[i + 1] ?? assets[i - 1]
    await window.studio.deleteAsset(id)
    setRemoved((s) => new Set(s).add(id))
    setSelectedId(neighbor?.id)
    setCreatedId(undefined)
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
      const advice = longClipsNotice(long, copy.audio?.title ?? 'ljudet')
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
        selectedId={selected?.id}
        ready={loaded || assets.length > 0}
        query={query}
        onQuery={setQuery}
        onSelect={select}
        onCreate={create}
        creating={creating}
        addingImages={addingImages}
        addingAudio={addingAudio}
        onDropFiles={(id, paths) => {
          select(id)
          addFiles(id, paths)
        }}
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
            navigate={navigate}
            onUpdated={updated}
            onAddFiles={(paths) => addFiles(selected.id, paths)}
            onDelete={() => remove(selected.id)}
            onError={notify}
          />
        ) : loaded ? (
          <EmptyState kind={kind} onCreate={create} creating={creating} />
        ) : (
          <div className="drag h-12" />
        )}
      </section>

      {notice && (
        <div
          key={notice.id}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className="absolute bottom-5 left-1/2 z-40 flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-lg border border-line bg-raised px-4 py-2.5 shadow-2xl"
        >
          <span className={`select-text ${notice.tone === 'error' ? 'text-accent' : 'text-text'}`}>{notice.text}</span>
          <button
            onClick={() => setNotice(undefined)}
            className="-mr-1 shrink-0 rounded px-1 text-muted hover:text-text"
            title="Stäng"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyState({ kind, onCreate, creating }: { kind: AssetKind; onCreate: () => void; creating: boolean }) {
  const copy = ASSET_COPY[kind]
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-12 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center px-10 pb-12 text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-raised text-2xl text-muted">
          <AssetIcon kind={kind} />
        </div>
        <h2 className="text-base font-semibold">{copy.emptyTitle}</h2>
        <p className="mt-2 max-w-md leading-relaxed text-muted">{copy.emptyText}</p>
        <button
          onClick={onCreate}
          disabled={creating}
          className="mt-6 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {copy.newName}
        </button>
      </div>
    </div>
  )
}
