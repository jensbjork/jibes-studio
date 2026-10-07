import { useCallback, useEffect, useRef, useState } from 'react'
import type { Generation, GenerationReview } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'

type ReviewSummary = Pick<Generation, 'rating' | 'reviewCount' | 'agentReviewCount'>

/** The user's rating and the review counts, as listGenerations reports them. */
export function reviewSummary(reviews: readonly GenerationReview[]): ReviewSummary {
  return {
    rating: reviews.find((r) => r.author === 'user')?.rating,
    reviewCount: reviews.length,
    agentReviewCount: reviews.filter((r) => r.author !== 'user').length
  }
}

/**
 * An update from the job queue may come without the review summary (it describes the job, not its reviews);
 * the summary the list already has is kept then.
 */
export function mergeUpdate(previous: Generation | undefined, update: Generation): Generation {
  if (typeof update.reviewCount === 'number' || !previous) {
    return { ...update, reviewCount: update.reviewCount ?? 0, agentReviewCount: update.agentReviewCount ?? 0 }
  }
  return {
    ...update,
    rating: previous.rating,
    reviewCount: previous.reviewCount,
    agentReviewCount: previous.agentReviewCount
  }
}

/** Puts an updated (or new) generation into a newest-first list. */
export function upsertGeneration(list: readonly Generation[], g: Generation): Generation[] {
  const i = list.findIndex((x) => x.id === g.id)
  if (i === -1) return [mergeUpdate(undefined, g), ...list]
  const next = list.slice()
  next[i] = mergeUpdate(list[i], g)
  return next
}

export interface GenerationsState {
  /** Newest first. */
  generations: Generation[]
  /** False until the first list has arrived. */
  loaded: boolean
  error?: string
  clearError: () => void
  /** A generation this window started or changed, before main's event arrives. */
  upsert: (g: Generation) => void
  /** Moves the video to the Trash and drops it from the list; false (with `error` set) when that failed. */
  remove: (g: Generation) => Promise<boolean>
  /** A locally patched copy, e.g. with segmentId set after "Lägg i sekvens". */
  patch: (g: Generation) => void
  /** Sets (or with null clears) the user's star rating, showing it right away. */
  rate: (g: Generation, rating: number | null) => Promise<void>
}

/**
 * Every generation, kept live: jobs that start, render and finish (onGenerationUpdate), generations deleted in
 * another view (onGenerationDelete) and reviews that are added by the user or an agent (onReviewChange).
 */
export function useGenerations(): GenerationsState {
  const [generations, setGenerations] = useState<Generation[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  // Review refreshes per generation are numbered so that only the newest answer lands.
  const reviewRequests = useRef(new Map<string, number>())

  const refreshReviews = useCallback((id: string) => {
    const n = (reviewRequests.current.get(id) ?? 0) + 1
    reviewRequests.current.set(id, n)
    window.studio.listReviews(id).then(
      (reviews) => {
        if (reviewRequests.current.get(id) !== n) return
        const summary = reviewSummary(reviews)
        setGenerations((list) => list.map((g) => (g.id === id ? { ...g, ...summary } : g)))
      },
      () => {
        // The badge is a convenience; the next change (or reopening the view) brings it up to date.
      }
    )
  }, [])

  useEffect(() => {
    let active = true
    window.studio.listGenerations().then(
      (list) => {
        if (!active) return
        // Updates that arrived while the list loaded are newer than what it says; replayed oldest first so new
        // generations among them end up in newest-first order.
        setGenerations((early) => early.reduceRight((acc, g) => upsertGeneration(acc, g), list))
        setLoaded(true)
      },
      (e) => {
        if (!active) return
        setError(ipcErrorMessage(e))
        setLoaded(true)
      }
    )
    const offUpdate = window.studio.onGenerationUpdate((g) => setGenerations((list) => upsertGeneration(list, g)))
    // Deleted elsewhere (a take in the sequence editor): gone from the list too.
    const offDelete = window.studio.onGenerationDelete((id) =>
      setGenerations((list) => (list.some((g) => g.id === id) ? list.filter((g) => g.id !== id) : list))
    )
    const offReview = window.studio.onReviewChange(refreshReviews)
    return () => {
      active = false
      offUpdate()
      offDelete()
      offReview()
    }
  }, [refreshReviews])

  const upsert = useCallback((g: Generation) => setGenerations((list) => upsertGeneration(list, g)), [])

  const patch = useCallback(
    (g: Generation) => setGenerations((list) => list.map((x) => (x.id === g.id ? g : x))),
    []
  )

  const remove = useCallback(async (g: Generation) => {
    try {
      await window.studio.deleteGeneration(g.id)
      setGenerations((list) => list.filter((x) => x.id !== g.id))
      return true
    } catch (e) {
      setError(ipcErrorMessage(e))
      return false
    }
  }, [])

  const rate = useCallback(
    async (g: Generation, rating: number | null) => {
      const before: ReviewSummary = {
        rating: g.rating,
        reviewCount: g.reviewCount,
        agentReviewCount: g.agentReviewCount
      }
      setGenerations((list) => list.map((x) => (x.id === g.id ? { ...x, rating: rating ?? undefined } : x)))
      try {
        await window.studio.setUserReview(g.id, { rating })
        // main announces the change too, but the count (a first review, a cleared one) is settled here at once.
        refreshReviews(g.id)
      } catch (e) {
        setGenerations((list) => list.map((x) => (x.id === g.id ? { ...x, ...before } : x)))
        setError(ipcErrorMessage(e))
      }
    },
    [refreshReviews]
  )

  return {
    generations,
    loaded,
    error,
    clearError: useCallback(() => setError(undefined), []),
    upsert,
    remove,
    patch,
    rate
  }
}
