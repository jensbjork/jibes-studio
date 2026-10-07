import { useEffect, useSyncExternalStore } from 'react'
import type { PromptLanguage } from '@shared/types'

// The "Promptspråk" setting decides the words inserted between references ("wearing" or "i"). It is read
// from main and shared by every editor; read again whenever an editor mounts or gets focus and when the
// window comes back to the front, so a change in Settings reaches a form that stayed open.

let current: PromptLanguage = 'en'
const listeners = new Set<() => void>()
let latest = 0

/** Reads the setting from main; editors update when it changed. */
export function refreshPromptLanguage(): void {
  const n = ++latest
  window.studio.getSettings().then(
    (s) => {
      const lang: PromptLanguage = s.promptLanguage === 'sv' ? 'sv' : 'en'
      if (n !== latest || lang === current) return
      current = lang
      for (const l of listeners) l()
    },
    () => {
      // Keep the last known language; inserting English connectives is the safe default.
    }
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePromptLanguage(): PromptLanguage {
  const language = useSyncExternalStore(subscribe, () => current, () => current)
  useEffect(() => {
    refreshPromptLanguage()
    window.addEventListener('focus', refreshPromptLanguage)
    return () => window.removeEventListener('focus', refreshPromptLanguage)
  }, [])
  return language
}
