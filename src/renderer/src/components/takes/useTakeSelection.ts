import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the keyboard's choice waits for another one before main is told (a sweep with ← → sends once). */
export const KEY_SELECT_DELAY = 200

interface Waiting {
  ownerId: string
  id: string
  timer: ReturnType<typeof setTimeout>
  settle: { resolve: () => void; reject: (e: unknown) => void }[]
}

export interface TakeSelection {
  /** The take shown as chosen: one picked here that main hasn't confirmed yet, else main's. */
  activeId?: string
  /** A choice is waiting out the keyboard's delay or on its way to main. */
  pending: boolean
  /**
   * Makes `id` the chosen take of the open clip or transition: shown at once, sent to main at once (`delay` 0, a
   * click) or once `delay` ms pass without another choice (the keyboard; the last one wins). Resolves when main has
   * it; rejects with main's refusal, and the choice is then undone on screen.
   */
  choose: (id: string, delay?: number) => Promise<void>
}

/**
 * The chosen take of one clip (or transition) as the take strip shows it: optimistic, so a click or an arrow key
 * moves the ring at once, while main hears about it once (debounced for the keyboard). A choice still waiting when
 * another clip is opened (or the view closes) is sent right away, so it is never lost.
 *
 * `commit` sends the choice for `ownerId`; it should save what depends on the old take first (its trims).
 */
export function useTakeSelection(
  ownerId: string | undefined,
  serverId: string | undefined,
  commit: (ownerId: string, id: string) => Promise<unknown>
): TakeSelection {
  const [local, setLocal] = useState<{ ownerId: string; id: string }>()
  const [inFlight, setInFlight] = useState(0)
  const waiting = useRef<Waiting | undefined>(undefined)
  const commitRef = useRef(commit)
  const ownerRef = useRef(ownerId)
  useEffect(() => {
    commitRef.current = commit
    ownerRef.current = ownerId
  })

  const send = useCallback((owner: string, id: string): Promise<void> => {
    setInFlight((n) => n + 1)
    const done = Promise.resolve()
      .then(() => commitRef.current(owner, id))
      .then(() => undefined)
    void done
      .catch(() => undefined)
      .finally(() => {
        setInFlight((n) => n - 1)
        // Main has it now (or refused it): its answer is what the strip shows, unless another choice is on its way.
        if (!waiting.current) setLocal((cur) => (cur && cur.ownerId === owner && cur.id === id ? undefined : cur))
      })
    return done
  }, [])

  /** Sends a choice still waiting for the keyboard's delay now. */
  const flushWaiting = useCallback(() => {
    const w = waiting.current
    if (!w) return
    clearTimeout(w.timer)
    waiting.current = undefined
    const done = send(w.ownerId, w.id)
    for (const s of w.settle) done.then(s.resolve, s.reject)
  }, [send])

  // Another clip opened, or the view closing: what was chosen with the keyboard still reaches main.
  useEffect(() => flushWaiting, [ownerId, flushWaiting])

  const choose = useCallback(
    (id: string, delay = 0): Promise<void> => {
      const owner = ownerRef.current
      if (!owner) return Promise.resolve()
      setLocal({ ownerId: owner, id })
      const before = waiting.current
      if (before && before.ownerId !== owner) flushWaiting()
      const earlier = waiting.current?.settle ?? []
      if (waiting.current) clearTimeout(waiting.current.timer)
      waiting.current = undefined
      if (delay <= 0) {
        const done = send(owner, id)
        // Earlier keyboard choices end with this one (the last one wins).
        for (const s of earlier) done.then(s.resolve, s.reject)
        return done
      }
      return new Promise<void>((resolve, reject) => {
        waiting.current = {
          ownerId: owner,
          id,
          settle: [...earlier, { resolve, reject }],
          timer: setTimeout(flushWaiting, delay)
        }
      })
    },
    [send, flushWaiting]
  )

  const activeId = local && local.ownerId === ownerId ? local.id : serverId
  return { activeId, pending: !!local && local.ownerId === ownerId && (inFlight > 0 || !!waiting.current), choose }
}
