import { useCallback, useEffect, useState } from 'react'
import { rememberModelKinds } from '@shared/models'
import type {
  Asset,
  AssetKind,
  AudioCatalog,
  GenerationParams,
  SavedPrompt,
  SeparationStatus,
  VideoModel
} from '@shared/types'

// The model list rarely changes; share one request across all views (and the agent bridge). Venice does add and
// retire models, and a window can stay open for days, so the copy is dropped after as long as main keeps its own.
const MODELS_MAX_AGE_MS = 10 * 60_000
let modelsPromise: Promise<VideoModel[]> | undefined
let modelsFetchedAt = 0
let lastModels: VideoModel[] | undefined

/**
 * The model list, fetched again when the copy is ten minutes old. A failed fetch is forgotten so the next caller
 * tries again, and answers with the last list that arrived when there is one.
 */
export function loadModels(): Promise<VideoModel[]> {
  if (modelsPromise && Date.now() - modelsFetchedAt < MODELS_MAX_AGE_MS) return modelsPromise
  const request: Promise<VideoModel[]> = window.studio.listModels().then(
    (list) => {
      // Kinds are registered before anyone uses the list, so kindOfModelId agrees with main.
      rememberModelKinds(list)
      lastModels = list
      return list
    },
    (err: unknown) => {
      if (modelsPromise === request) modelsPromise = undefined
      if (lastModels) return lastModels
      throw err
    }
  )
  modelsPromise = request
  modelsFetchedAt = Date.now()
  return request
}

export function useModels(): { models: VideoModel[]; error?: string } {
  const [models, setModels] = useState<VideoModel[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    const load = () =>
      loadModels().then(
        (list) => {
          if (!active) return
          setModels(list)
          setError(undefined)
        },
        (e: unknown) => active && setError(ipcErrorMessage(e))
      )
    load()
    // Back in front after a long while: ask again (nothing is fetched until the copy is old; the same list keeps
    // the same array, so nothing re-renders).
    window.addEventListener('focus', load)
    return () => {
      active = false
      window.removeEventListener('focus', load)
    }
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

// ── Audio models and voice separation (Redigera, voice design) ─────────────

// Venice's audio models, shared like the video model list. Main caches the list for 10 minutes; the window asks again
// after that, so a voice changer Venice starts listing (or one the API key unlocks) shows up without a restart.
const AUDIO_CATALOG_MAX_AGE_MS = 10 * 60 * 1000
let audioCatalog: { promise: Promise<AudioCatalog>; at: number; forced: boolean } | undefined
const audioCatalogListeners = new Set<(catalog: AudioCatalog) => void>()

/**
 * The audio catalog. force: fetch it again past main's cache ("Kontrollera igen", a new API key); a forced fetch
 * already on its way is shared. A failed fetch is forgotten so the next caller tries again.
 */
export function loadAudioCatalog(force = false): Promise<AudioCatalog> {
  const stale = audioCatalog && Date.now() - audioCatalog.at > AUDIO_CATALOG_MAX_AGE_MS
  if (!audioCatalog || stale || (force && !audioCatalog.forced)) {
    const promise = window.studio.listAudioModels(force)
    const entry = { promise, at: Date.now(), forced: force }
    audioCatalog = entry
    promise.then(
      (catalog) => {
        // A forced fetch keeps that mark only while it runs; afterwards the next "Kontrollera igen" asks again.
        if (audioCatalog === entry) audioCatalog = { ...entry, forced: false }
        for (const listener of audioCatalogListeners) listener(catalog)
      },
      () => {
        if (audioCatalog === entry) audioCatalog = undefined
      }
    )
  }
  return audioCatalog.promise
}

/** The audio catalog, live: every mounted user sees a refetch (and a new API key fetches it again). */
export function useAudioCatalog(): {
  catalog?: AudioCatalog
  error?: string
  /** A fetch is on its way. */
  loading: boolean
  /** Fetches the list again from Venice ("Kontrollera igen"). */
  refresh: () => void
} {
  const [catalog, setCatalog] = useState<AudioCatalog>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  const load = useCallback((force: boolean) => {
    setLoading(true)
    loadAudioCatalog(force).then(
      (c) => {
        setCatalog(c)
        setError(undefined)
        setLoading(false)
      },
      (e: unknown) => {
        setError(ipcErrorMessage(e))
        setLoading(false)
      }
    )
  }, [])

  useEffect(() => {
    const listener = (c: AudioCatalog) => setCatalog(c)
    audioCatalogListeners.add(listener)
    load(false)
    // Some models are only listed to keyed accounts: a key saved (or removed) in Inställningar asks again.
    let keyed: boolean | undefined
    const offSettings = window.studio.onSettingsChange(() => {
      void window.studio.getSettings().then((s) => {
        if (keyed !== undefined && keyed !== s.hasApiKey) load(true)
        keyed = s.hasApiKey
      })
    })
    void window.studio.getSettings().then((s) => {
      keyed ??= s.hasApiKey
    })
    return () => {
      audioCatalogListeners.delete(listener)
      offSettings()
    }
  }, [load])

  return { catalog, error, loading, refresh: useCallback(() => load(true), [load]) }
}

let separationPromise: Promise<SeparationStatus> | undefined

/**
 * Whether this Mac can separate voice and background (Ta bort rösten, Bara rösten, keeping the background under a
 * new voice). Asked once per window; a failure or "not available" is asked again next time, since main only caches
 * success.
 */
export function useSeparationStatus(): SeparationStatus | undefined {
  const [status, setStatus] = useState<SeparationStatus>()
  useEffect(() => {
    let active = true
    if (!separationPromise) {
      const request = window.studio.separationStatus()
      separationPromise = request
      request.then(
        (s) => {
          if (!s.available && separationPromise === request) separationPromise = undefined
        },
        () => {
          if (separationPromise === request) separationPromise = undefined
        }
      )
    }
    separationPromise.then(
      (s) => active && setStatus(s),
      (e: unknown) => active && setStatus({ available: false, message: ipcErrorMessage(e) })
    )
    return () => {
      active = false
    }
  }, [])
  return status
}
