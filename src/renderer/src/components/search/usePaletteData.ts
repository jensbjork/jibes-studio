import { useEffect, useState } from 'react'
import type { PaletteData } from './entries'

// The lists ⌘K searches, loaded each time it opens (through the same list calls the views use) and kept, unchanged,
// while it is open. Each list shows up as soon as it has arrived; one that fails is searched as empty.

/** How many of the newest sequences and storyboards are loaded in full, for their clips', boards' and transitions' text. */
const DETAIL_LIMIT = 100

type ListKey = Exclude<keyof PaletteData, 'sequenceDetails' | 'storyboardDetails'>
const LISTS: readonly (keyof PaletteData)[] = [
  'assets',
  'prompts',
  'sequences',
  'sequenceDetails',
  'storyboards',
  'storyboardDetails',
  'edits',
  'generations',
  'stills',
  'exports'
]

const EMPTY: PaletteData = {}

const newest = <T extends { id: string; updatedAt: number }>(list: T[]): string[] =>
  [...list]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DETAIL_LIMIT)
    .map((item) => item.id)

/** Settled results that arrived, in order; the ones that failed (deleted meanwhile) left out. */
async function all<T>(requests: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(requests)
  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
}

export function usePaletteData(open: boolean): { data: PaletteData; loading: boolean } {
  const [data, setData] = useState<PaletteData>(EMPTY)

  useEffect(() => {
    if (!open) {
      setData(EMPTY)
      return
    }
    let active = true
    const put = <K extends keyof PaletteData>(key: K, value: NonNullable<PaletteData[K]>): void => {
      if (active) setData((d) => ({ ...d, [key]: value }))
    }
    function load<K extends ListKey>(key: K, request: () => Promise<NonNullable<PaletteData[K]>>) {
      return request().then(
        (value) => {
          put(key, value)
          return value
        },
        () => {
          const none = [] as unknown as NonNullable<PaletteData[K]>
          put(key, none)
          return none
        }
      )
    }

    const studio = window.studio
    void load('assets', () => studio.listAssets())
    void load('prompts', () => studio.listPrompts())
    void load('edits', () => studio.listEdits())
    void load('generations', () => studio.listGenerations())
    void load('stills', () => studio.listStills())
    void load('exports', () => studio.listExports())
    void load('sequences', () => studio.listSequences()).then((list) =>
      all(newest(list).map((id) => studio.getSequence(id))).then((full) => put('sequenceDetails', full))
    )
    void load('storyboards', () => studio.listStoryboards()).then((list) =>
      all(newest(list).map((id) => studio.getStoryboard(id))).then((full) => put('storyboardDetails', full))
    )
    return () => {
      active = false
    }
  }, [open])

  return { data, loading: open && LISTS.some((key) => data[key] === undefined) }
}
