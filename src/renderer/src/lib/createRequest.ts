import { useEffect, useRef } from 'react'

// "＋ New …" asked for from outside a view's side list (⌘K's "New sequence", "New character" …): the list presses
// its own button, so something new starts exactly as it does from there – a name to type, the storyboard's form,
// the Editor's menu. Only one view is on screen, so the request needs no address: navigate to the view, then ask.

/** A request older than this is dropped instead of creating something long after it was asked for. */
const FRESH_MS = 5000

let pendingAt: number | undefined
const listeners = new Set<() => void>()

/**
 * Asks the side list of the view on screen to create something new. Call it right after navigating there: the
 * listeners are told once the navigation has rendered (a list already open hears it then; one that is about to open
 * takes it when its items have loaded), so the view being left never sees it.
 */
export function requestCreate(): void {
  pendingAt = Date.now()
  window.setTimeout(() => {
    for (const listener of [...listeners]) listener()
  }, 0)
}

/** For SideList: runs `create` for a request, once the list is ready for it (its items loaded, not creating). */
export function useCreateRequest(ready: boolean, create: () => void): void {
  const latest = useRef(create)
  latest.current = create
  useEffect(() => {
    if (!ready) return
    const take = (): void => {
      if (pendingAt === undefined) return
      const fresh = Date.now() - pendingAt < FRESH_MS
      pendingAt = undefined
      if (fresh) latest.current()
    }
    take()
    listeners.add(take)
    return () => {
      listeners.delete(take)
    }
  }, [ready])
}
