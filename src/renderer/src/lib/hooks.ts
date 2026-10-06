import { useEffect, useState } from 'react'
import { rememberModelKinds } from '@shared/models'
import type { Asset, AssetKind, GenerationParams, SavedPrompt, VideoModel } from '@shared/types'

// The model list rarely changes; share one request across all views (and the agent bridge).
let modelsPromise: Promise<VideoModel[]> | undefined

/** The model list, fetched once; a failed fetch is forgotten so the next caller tries again. */
export function loadModels(): Promise<VideoModel[]> {
  if (!modelsPromise) {
    // Kinds are registered before anyone uses the list, so kindOfModelId agrees with main.
    const request = window.studio.listModels().then((list) => {
      rememberModelKinds(list)
      return list
    })
    modelsPromise = request
    request.catch(() => {
      if (modelsPromise === request) modelsPromise = undefined
    })
  }
  return modelsPromise
}

export function useModels(): { models: VideoModel[]; error?: string } {
  const [models, setModels] = useState<VideoModel[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    loadModels().then(setModels, (e: unknown) => setError(ipcErrorMessage(e)))
  }, [])
  return { models, error }
}

interface LibraryList<T> {
  items: T[]
  /** False until the first load has answered, so views can tell "loading" from "empty". */
  loaded: boolean
}

const NOT_LOADED: LibraryList<never> = { items: [], loaded: false }

/**
 * Live list that refetches whenever main reports an asset/prompt change. `key` names what `load` fetches;
 * a new key starts over, so one list's items never show up as another's.
 */
function useLibraryList<T>(key: string, load: () => Promise<T[]>): LibraryList<T> {
  const [list, setList] = useState<LibraryList<T> & { key: string }>({ key, ...NOT_LOADED })
  useEffect(() => {
    let active = true
    let latest = 0
    const refresh = () => {
      // Only the newest request may land, so a slow older reply can't bring back stale items.
      const n = ++latest
      const current = () => active && n === latest
      load().then(
        (items) => {
          if (current()) setList({ key, items, loaded: true })
        },
        () => {
          // Keep what we had; a failed first load still counts as answered so views don't wait forever.
          if (!current()) return
          setList((l) => {
            if (l.key !== key) return { key, items: [], loaded: true }
            return l.loaded ? l : { ...l, loaded: true }
          })
        }
      )
    }
    refresh()
    const off = window.studio.onLibraryChange(refresh)
    return () => {
      active = false
      off()
    }
  }, [key])
  return list.key === key ? list : NOT_LOADED
}

/** Characters, environments and outfits (one kind, or all of them), sorted by name. */
export function useAssetsState(kind?: AssetKind): { assets: Asset[]; loaded: boolean } {
  const { items, loaded } = useLibraryList(`assets:${kind ?? 'all'}`, () => window.studio.listAssets(kind))
  return { assets: items, loaded }
}

export function useAssets(kind?: AssetKind): Asset[] {
  return useAssetsState(kind).assets
}

export function usePromptsState(): { prompts: SavedPrompt[]; loaded: boolean } {
  const { items, loaded } = useLibraryList('prompts', () => window.studio.listPrompts())
  return { prompts: items, loaded }
}

export function usePrompts(): SavedPrompt[] {
  return usePromptsState().prompts
}

/** Strips Electron's "Error invoking remote method '…': Error: " prefix from IPC errors. */
export function ipcErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Live USD price for the params; debounced so flipping through options doesn't spam the API. */
export function useQuote(params: GenerationParams, model: VideoModel | undefined): number | undefined {
  const [quote, setQuote] = useState<number>()
  useEffect(() => {
    setQuote(undefined)
    if (!model) return
    let cancelled = false
    const t = setTimeout(() => {
      window.studio.quote(params).then(
        (q) => !cancelled && setQuote(q),
        () => !cancelled && setQuote(undefined)
      )
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [model?.id, params.duration, params.resolution, params.aspectRatio, params.audio])
  return quote
}
