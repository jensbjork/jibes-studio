import { useEffect, useRef } from 'react'

// "＋ New …" asked for from outside a view's side list (⌘K's "New sequence", "New character" …): the list presses
// its own button, so something new starts exactly as it does from there – a name to type, the storyboard's form,
// the Editor's menu. Only one view is on screen, so a plain request needs no address: navigate to the view, then
// ask. A view with more than one kind of thing (Prompts: prompts and learnings) names which with a target; its
// listeners register with the same target, and a plain request (taken by SideList, which has none) never reaches
// them.

/** A request older than this is dropped instead of creating something long after it was asked for. */
const FRESH_MS = 5000

let pending: { at: number; target?: string } | undefined
const listeners = new Set<() => void>()

/**
 * Asks the view on screen to create something new: its side list, or with a `target` the listener registered for
 * it ('prompts', 'learnings'). Call it right after navigating there: the listeners are told once the navigation
 * has rendered (a list already open hears it then; one that is about to open takes it when its items have loaded),
 * so the view being left never sees it.
 */
export function requestCreate(target?: string): void {
  pending = { at: Date.now(), target }
  window.setTimeout(() => {
    for (const listener of [...listeners]) listener()
  }, 0)
}

/**
 * The target of a request still waiting to be taken, without taking it: a view picks the tab it opens on (Prompts
 * or Learnings) before the tab's listener has mounted.
 */
export function pendingCreateTarget(): string | undefined {
  return pending && Date.now() - pending.at < FRESH_MS ? pending.target : undefined
}

/**
 * Runs `create` for a request, once the view is ready for it (its items loaded, not creating). SideList listens
 * without a target; a view that names one only takes requests for that target.
 */
export function useCreateRequest(ready: boolean, create: () => void, target?: string): void {
  const latest = useRef(create)
  latest.current = create
  useEffect(() => {
    if (!ready) return
    const take = (): void => {
      if (!pending || pending.target !== target) return
      const fresh = Date.now() - pending.at < FRESH_MS
      pending = undefined
      if (fresh) latest.current()
    }
    take()
    listeners.add(take)
    return () => {
      listeners.delete(take)
    }
  }, [ready, target])
}
