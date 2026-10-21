import { useEffect, useMemo, useState, type DragEvent } from 'react'
import type { Asset } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { directorEntries, isPresetId } from '../../lib/directors'
import { ipcErrorMessage, useAssetsState, useModels } from '../../lib/hooks'
import { SELECTED_ASSET_KEYS } from '../../lib/library'
import type { Intent, Navigate } from '../../lib/navigation'
import AssetIcon from '../assets/AssetIcon'
import { isFileDrag } from '../assets/imageUtils'
import DirectorEditor from './DirectorEditor'
import DirectorList from './DirectorList'
import PresetView from './PresetView'

const SELECTED_KEY = SELECTED_ASSET_KEYS.director

function loadSelected(): string | undefined {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function saveSelected(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id)
    else localStorage.removeItem(SELECTED_KEY)
  } catch {
    // Remembering the selection is only a convenience.
  }
}

// How long a mutation result may stand in for a director the live list doesn't contain yet.
const OVERLAY_GRACE_MS = 3000

interface Overlaid {
  asset: Asset
  receivedAt: number
}

function uniqueNewName(assets: Asset[], base: string): string {
  const taken = new Set(assets.map((a) => a.name.toLocaleLowerCase('en')))
  if (!taken.has(base.toLocaleLowerCase('en'))) return base
  let n = 2
  while (taken.has(`${base} ${n}`.toLocaleLowerCase('en'))) n++
  return `${base} ${n}`
}

interface Notice {
  id: number
  tone: 'error' | 'info'
  text: string
}

interface Props {
  intent?: Intent
  onIntentHandled: () => void
  navigate: Navigate
}

/**
 * Directors: the user's own and the ready-made ones in the shared side list, and the open one – an editor for an own
 * director, a read-only page with "Use a copy" for a ready-made one.
 */
export default function DirectorsView({ intent, onIntentHandled, navigate }: Props) {
  const { assets: all, loaded } = useAssetsState()
  const { models } = useModels()
  const [overlay, setOverlay] = useState<Record<string, Overlaid>>({})
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | undefined>(loadSelected)
  const [createdId, setCreatedId] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [addingImages, setAddingImages] = useState<Record<string, number>>({})
  const [notice, setNotice] = useState<Notice>()

  // The live list lags a moment behind each change: what a change returned stands in until it has caught up.
  const own = useMemo(() => {
    const byId = new Map(all.filter((a) => a.kind === 'director').map((a) => [a.id, a]))
    for (const { asset } of Object.values(overlay)) {
      const current = byId.get(asset.id)
      if (!current || current.updatedAt < asset.updatedAt) byId.set(asset.id, asset)
    }
    return [...byId.values()].filter((a) => !removed.has(a.id))
  }, [all, overlay, removed])
  const entries = useMemo(() => directorEntries(own), [own])
  // The remembered one once the library has loaded (until then only the ready-made ones are known), else the first.
  const selected = entries.find((e) => e.id === selectedId) ?? (loaded ? entries[0] : undefined)

  useEffect(() => {
    const listed = new Map(all.map((a) => [a.id, a]))
    const now = Date.now()
    setOverlay((o) => {
      const next: Record<string, Overlaid> = {}
      for (const [id, entry] of Object.entries(o)) {
        const current = listed.get(id)
        if (current ? current.updatedAt < entry.asset.updatedAt : now - entry.receivedAt < OVERLAY_GRACE_MS) next[id] = entry
      }
      return Object.keys(next).length === Object.keys(o).length ? o : next
    })
  }, [all])

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])
  useEffect(() => saveSelected(selectedId), [selectedId])

  // ⌘K, a link from Generate or a sequence, an agent's open_in_studio: an own director or a ready-made one.
  useEffect(() => {
    if (intent?.type !== 'open-asset') return
    setSelectedId(intent.assetId)
    setCreatedId(undefined)
    onIntentHandled()
  }, [intent])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(undefined), notice.tone === 'error' ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [notice])

  const notify = (text: string, tone: Notice['tone'] = 'error') => setNotice({ id: Date.now(), tone, text })
  const updated = (a: Asset) => setOverlay((o) => ({ ...o, [a.id]: { asset: a, receivedAt: Date.now() } }))

  const select = (id: string) => {
    setSelectedId(id)
    setCreatedId(undefined)
  }

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const a = await window.studio.saveAsset({
        kind: 'director',
        name: uniqueNewName(own, ASSET_COPY.director.newName),
        description: ''
      })
      updated(a)
      setSelectedId(a.id)
      setCreatedId(a.id)
    } catch (e) {
      notify(ipcErrorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  const useCopy = async (presetId: string) => {
    try {
      const a = await window.studio.copyDirectorPreset(presetId)
      updated(a)
      setSelectedId(a.id)
      setCreatedId(undefined)
      notify(`“${a.name}” is yours to change – the ready-made one stays as it was.`, 'info')
    } catch (e) {
      notify(ipcErrorMessage(e))
    }
  }

  const remove = async (id: string, nextId?: string) => {
    if (isPresetId(id)) return
    const i = entries.findIndex((e) => e.id === id)
    const neighbor = nextId ?? (entries[i + 1] ?? entries[i - 1])?.id
    await window.studio.deleteAsset(id)
    setRemoved((s) => new Set(s).add(id))
    if (id === selected?.id) {
      setSelectedId(neighbor)
      setCreatedId(undefined)
    }
  }

  const addImages = async (assetId: string, paths: string[]) => {
    const bump = (d: number) =>
      setAddingImages((a) => {
        const n = (a[assetId] ?? 0) + d
        const next = { ...a }
        if (n > 0) next[assetId] = n
        else delete next[assetId]
        return next
      })
    bump(paths.length)
    try {
      updated(await window.studio.addAssetImages(assetId, paths))
    } catch (e) {
      notify(ipcErrorMessage(e))
    } finally {
      bump(-paths.length)
    }
  }

  // Dropping files outside a drop target would otherwise navigate the window to the file.
  const guardDrop = (e: DragEvent) => {
    if (e.nativeEvent.defaultPrevented || !isFileDrag(e)) return
    e.preventDefault()
    if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
  }

  return (
    <div className="relative flex h-full" onDragOver={guardDrop} onDrop={guardDrop}>
      <DirectorList
        entries={loaded || own.length ? entries : undefined}
        selectedId={selected?.id}
        onSelect={select}
        onCreate={create}
        creating={creating}
        onDelete={remove}
      />

      <section className="min-w-0 flex-1">
        {!loaded && !own.length ? (
          <div className="drag h-12" />
        ) : selected?.asset ? (
          <DirectorEditor
            key={selected.id}
            asset={selected.asset}
            models={models}
            autoFocusName={selected.id === createdId}
            addingImages={addingImages[selected.id] ?? 0}
            navigate={navigate}
            onUpdated={updated}
            onAddImages={(paths) => void addImages(selected.asset!.id, paths)}
            onDelete={() => remove(selected.id)}
            onError={notify}
          />
        ) : selected ? (
          <PresetView
            key={selected.id}
            entry={selected}
            models={models}
            navigate={navigate}
            onUseCopy={() => useCopy(selected.id)}
          />
        ) : (
          <EmptyState onCreate={create} creating={creating} />
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
            title="Close"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyState({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  const copy = ASSET_COPY.director
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-12 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center px-10 pb-12 text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-raised text-2xl text-muted">
          <AssetIcon kind="director" />
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
