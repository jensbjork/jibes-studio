import { useSyncExternalStore } from 'react'
import { isMediaTab, type MediaTab } from '@shared/session'

// The Mediabank tab on screen (Videor, Bilder, Filmer), remembered across restarts, so the view opens where it was
// and an agent's get_workspace can say which tab the user looks at.

const KEY = 'studio.media.tab'
const listeners = new Set<() => void>()

function read(): MediaTab {
  try {
    const v = localStorage.getItem(KEY)
    return isMediaTab(v) ? v : 'videos'
  } catch {
    return 'videos'
  }
}

let current: MediaTab = read()

export function getMediaTab(): MediaTab {
  return current
}

export function setMediaTab(tab: MediaTab): void {
  if (tab === current) return
  current = tab
  try {
    localStorage.setItem(KEY, tab)
  } catch {
    // Remembered for this run only.
  }
  for (const l of listeners) l()
}

export function useMediaTab(): [MediaTab, (tab: MediaTab) => void] {
  const tab = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => current
  )
  return [tab, setMediaTab]
}
