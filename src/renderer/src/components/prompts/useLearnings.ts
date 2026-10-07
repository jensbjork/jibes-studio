import { useEffect, useState } from 'react'
import type { Learning } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'

export interface LearningsState {
  /** Pinned first, then most recently updated (as main lists them). */
  learnings: Learning[]
  loaded: boolean
  error?: string
}

/** Every learning, refetched whenever the user or an agent saves or deletes one. */
export function useLearnings(): LearningsState {
  const [state, setState] = useState<LearningsState>({ learnings: [], loaded: false })

  useEffect(() => {
    let active = true
    let latest = 0
    const load = () => {
      const n = ++latest
      window.studio.listLearnings().then(
        (learnings) => {
          if (active && n === latest) setState({ learnings, loaded: true })
        },
        (e) => {
          // Keep what we had; the next change tries again.
          if (active && n === latest) setState((s) => ({ ...s, loaded: true, error: ipcErrorMessage(e) }))
        }
      )
    }
    load()
    const off = window.studio.onLearningsChange(load)
    return () => {
      active = false
      off()
    }
  }, [])

  return state
}

// ── Opening a learning from another view ─────────────────────────────────────

/**
 * A learning the Prompter view should show when it opens (set by the clip drawer's "Lärdomar" links). The
 * view's own Lärdomar tab picks it up once; held here rather than as a navigation intent so the request stays
 * inside the views that know about learnings.
 */
let requestedLearning: string | undefined

export function requestLearning(id: string): void {
  requestedLearning = id
}

export function takeRequestedLearning(): string | undefined {
  const id = requestedLearning
  requestedLearning = undefined
  return id
}
