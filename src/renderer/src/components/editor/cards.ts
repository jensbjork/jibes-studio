import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { EditRange } from '@shared/types'
import { useEditor } from './EditorContext'

// Which operation card of a tab is open: one at a time, so the tab stays calm. Shared by everything in the window
// (another tab's "Go to Transcribe" opens a card here) and kept while the window is open.

const openCards = new Map<string, string | undefined>()
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Opens a card of a tab (closing the one that was open there). */
export function openCard(tab: string, id: string | undefined): void {
  if (openCards.get(tab) === id) return
  openCards.set(tab, id)
  for (const cb of listeners) cb()
}

/**
 * Whether the tab is the one on screen. The tabs stay mounted (so what was typed in a card survives a look at another
 * tab), but a hidden tab's cards are closed: they plan nothing and draw nothing on the timeline.
 */
export const TabActiveContext = createContext(true)

export function useOpenCard(tab: string): [string | undefined, (id: string) => void] {
  const active = useContext(TabActiveContext)
  const stored = useSyncExternalStore(subscribe, () => openCards.get(tab))
  const open = active ? stored : undefined
  const toggle = (id: string) => openCard(tab, openCards.get(tab) === id ? undefined : id)
  return [open, toggle]
}

/** While the card is open, the part of the film it works on is drawn on the timeline. */
export function useReportRange(open: boolean, range: EditRange | undefined): void {
  const { setOpRange } = useEditor()
  const key = open && range ? `${range.start}:${range.end}` : ''
  useEffect(() => {
    if (!key) return
    setOpRange(range)
    return () => setOpRange(undefined)
  }, [key])
}
