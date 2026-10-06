import { useCallback, useRef, useState } from 'react'
import type { FolderInspection, LibraryMode, LibraryStatus } from '@shared/types'
import { freezeGenerateParams } from '../../lib/generateStore'
import { ipcErrorMessage } from '../../lib/hooks'
import {
  assetImageMap,
  needsImageLookup,
  readRememberedParams,
  rememberAfterSwitch,
  type SwitchMemory
} from '../../lib/library'

/** Picking a folder (dialog or a given path) and asking main what is in it. */
export function useFolderChoice() {
  const [inspection, setInspection] = useState<FolderInspection>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  // Only the newest pick may land, so a slow inspection can't replace a newer choice.
  const latest = useRef(0)

  const inspect = useCallback(async (path: string) => {
    const n = ++latest.current
    setChecking(true)
    setError(undefined)
    try {
      const result = await window.studio.inspectLibraryFolder(path)
      if (n === latest.current) setInspection(result)
    } catch (e) {
      if (n === latest.current) setError(ipcErrorMessage(e))
    } finally {
      if (n === latest.current) setChecking(false)
    }
  }, [])

  /** Opens the folder dialog; resolves with whether a folder was chosen. */
  const choose = useCallback(async () => {
    setError(undefined)
    try {
      const path = await window.studio.chooseLibraryFolder()
      if (!path) return false
      await inspect(path)
      return true
    } catch (e) {
      setError(ipcErrorMessage(e))
      return false
    }
  }, [inspect])

  const reset = useCallback(() => {
    latest.current++
    setInspection(undefined)
    setChecking(false)
    setError(undefined)
  }, [])

  return { inspection, checking, error, inspect, choose, reset }
}

export type SwitchPhase =
  | { kind: 'idle' }
  | { kind: 'working'; mode: LibraryMode }
  /** Main has switched and reloads the window in a moment. */
  | { kind: 'reloading' }
  /** A switch started before this window was (re)loaded is still running; main reloads it when done. */
  | { kind: 'waiting' }

// Main reloads every window shortly after the switch; this only catches a reload that never comes.
const RELOAD_FALLBACK_MS = 5000

/** Switches the library and keeps what the renderer remembers (localStorage) pointing at the right files. */
export function useLibrarySwitch(status: LibraryStatus) {
  const [phase, setPhase] = useState<SwitchPhase>({ kind: 'idle' })
  const [error, setError] = useState<string>()
  const running = useRef(false)

  const start = async (path: string, mode: LibraryMode) => {
    if (running.current) return
    running.current = true
    setError(undefined)

    const unconfigured = status.state === 'unconfigured'
    const memory: SwitchMemory = {
      mode,
      oldRoot: unconfigured ? status.legacy?.path : status.root,
      // Only an earlier version's layout is reorganized; a library found there in the new layout keeps its paths.
      oldIsLegacy: unconfigured && !!status.legacy?.oldLayout,
      newRoot: path
    }
    // Taken before the call: paths in it still refer to the old location.
    const snapshot = readRememberedParams()

    setPhase({ kind: 'working', mode })
    try {
      await window.studio.setLibraryRoot(path, mode)
    } catch (e) {
      running.current = false
      setPhase({ kind: 'idle' })
      setError(ipcErrorMessage(e))
      return
    }

    setPhase({ kind: 'reloading' })
    // From here on the form in memory belongs to the library that was left; it must not be saved over what
    // rememberAfterSwitch writes (an agent's set_form could otherwise do that before the reload).
    freezeGenerateParams()
    // Written right away so it is in place even if the reload comes before the lookup below answers.
    rememberAfterSwitch(memory, snapshot)
    if (needsImageLookup(snapshot, memory)) {
      try {
        rememberAfterSwitch(memory, snapshot, assetImageMap(await window.studio.listAssets()))
      } catch {
        // The images are dropped instead; they were only remembered form values.
      }
    }
    window.setTimeout(() => window.location.reload(), RELOAD_FALLBACK_MS)
  }

  return { phase, error, start, clearError: () => setError(undefined) }
}
