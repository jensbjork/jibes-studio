import { useCallback, useEffect, useRef, useState } from 'react'
import type { GenerationReview } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'

export interface ReviewsState {
  /** The user's own first, then the agents' newest first (as main lists them). */
  reviews: GenerationReview[]
  loaded: boolean
  error?: string
  reload: () => void
}

/** A generation's reviews, refetched whenever the user or an agent changes one of them. */
export function useReviews(generationId: string | undefined): ReviewsState {
  const [state, setState] = useState<{ id?: string; reviews: GenerationReview[]; loaded: boolean; error?: string }>({
    reviews: [],
    loaded: false
  })
  const latest = useRef(0)

  const load = useCallback(() => {
    if (!generationId) return
    const n = ++latest.current
    window.studio.listReviews(generationId).then(
      (reviews) => {
        if (n === latest.current) setState({ id: generationId, reviews, loaded: true })
      },
      (e) => {
        if (n === latest.current) {
          setState((s) => ({ id: generationId, reviews: s.id === generationId ? s.reviews : [], loaded: true, error: ipcErrorMessage(e) }))
        }
      }
    )
  }, [generationId])

  useEffect(() => {
    load()
    return window.studio.onReviewChange((id) => {
      if (id === generationId) load()
    })
  }, [load, generationId])

  // Another generation's reviews are never shown, not even for the moment before its own have loaded.
  const current = state.id === generationId
  return {
    reviews: current ? state.reviews : [],
    loaded: current && state.loaded,
    error: current ? state.error : undefined,
    reload: load
  }
}
