import { useCallback, useState } from 'react'
import { isVariantCount } from '@shared/variants'

// How many variants a Generate button sends (GenerateOptions.count; shared/variants.ts), remembered per place: the
// Generate form, a sequence clip's "Generate take" and a storyboard transition's. A new place starts at ×1.

export type VariantPlace = 'generate' | 'clip' | 'transition'

const KEYS: Record<VariantPlace, string> = {
  generate: 'variants:generate',
  clip: 'variants:clip',
  transition: 'variants:transition'
}

export function loadVariantCount(place: VariantPlace): number {
  try {
    const n = Number(localStorage.getItem(KEYS[place]))
    return isVariantCount(n) ? n : 1
  } catch {
    return 1
  }
}

function saveVariantCount(place: VariantPlace, count: number): void {
  try {
    localStorage.setItem(KEYS[place], String(count))
  } catch {
    // Remembering the count is only a convenience.
  }
}

/** The count chosen at `place`, remembered across views and restarts. */
export function useVariantCount(place: VariantPlace): [number, (count: number) => void] {
  const [count, setCount] = useState(() => loadVariantCount(place))
  const choose = useCallback(
    (n: number) => {
      if (!isVariantCount(n)) return
      setCount(n)
      saveVariantCount(place, n)
    },
    [place]
  )
  return [count, choose]
}

/** "Generate", "Generate ×3": a button's word with the count it sends. */
export function withVariants(label: string, count: number): string {
  return count > 1 ? `${label} ×${count}` : label
}
