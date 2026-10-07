import { useEffect, useState } from 'react'
import type { GenerationParams } from '@shared/types'

const CACHE_MS = 10 * 60_000

// Quotes only depend on these fields, and a sequence tends to repeat the same settings for every clip.
const cache = new Map<string, { at: number; quote: Promise<number> }>()

function quoteKey(p: GenerationParams): string {
  return [p.model, p.duration, p.resolution ?? '', p.aspectRatio ?? '', String(p.audio ?? '')].join('|')
}

function cachedQuote(p: GenerationParams): Promise<number> {
  const key = quoteKey(p)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.quote
  const quote = window.studio.quote(p)
  cache.set(key, { at: Date.now(), quote })
  quote.catch(() => cache.delete(key))
  return quote
}

/**
 * USD price of one take with the params (from the same cache as the totals, since a storyboard shows a price on
 * every panel and they mostly share their settings); undefined while loading or if the quote fails.
 */
export function useClipQuote(params: GenerationParams | undefined): number | undefined {
  const [quote, setQuote] = useState<number>()
  const key = params ? quoteKey(params) : ''

  useEffect(() => {
    setQuote(undefined)
    if (!params) return
    let cancelled = false
    const t = setTimeout(() => {
      cachedQuote(params).then(
        (q) => !cancelled && setQuote(q),
        () => !cancelled && setQuote(undefined)
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // `key` captures everything in `params` that affects the price.
  }, [key])

  return quote
}

/** Summed USD price for generating one take with each of the params; undefined while loading or if a quote fails. */
export function useTotalQuote(list: GenerationParams[]): number | undefined {
  const [total, setTotal] = useState<number>()
  const signature = list.map(quoteKey).join('\n')

  useEffect(() => {
    setTotal(list.length ? undefined : 0)
    if (!list.length) return
    let cancelled = false
    const t = setTimeout(() => {
      Promise.all(list.map(cachedQuote)).then(
        (quotes) => !cancelled && setTotal(quotes.reduce((a, b) => a + b, 0)),
        () => !cancelled && setTotal(undefined)
      )
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // `signature` captures everything in `list` that affects the price.
  }, [signature])

  return total
}
