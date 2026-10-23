import { useEffect, useMemo, useState, type DragEvent } from 'react'
import type { Asset } from '@shared/types'
import { ASSET_COPY, uniqueNewName } from '../../lib/assets'
import { directorEntries, isPresetId } from '../../lib/directors'
import { ipcErrorMessage, useAssetsState, useModels } from '../../lib/hooks'
import { SELECTED_ASSET_KEYS } from '../../lib/library'
import type { Intent, Navigate } from '../../lib/navigation'
import { isFileDrag } from '../assets/imageUtils'
import { FloatingBanner } from '../ui/Banner'
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
 * director, a read-only page with "Copy to edit" for a ready-made one. The ready-made ones are always there, so the
 * view has no empty state: a ready-made page says what a director is.
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
      // Its name ready to retype, as a new one's is: "Noir (copy)" would otherwise head every prompt it directs.
      setCreatedId(a.id)
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
          // Never for long: the ready-made ones are always there once the library has loaded.
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
