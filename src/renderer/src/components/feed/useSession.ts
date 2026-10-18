import { useEffect, useState } from 'react'
import type { GenerateSession } from '@shared/session'

// This session (shared/session.ts): main fixes its start when Studio starts and notes the clips still being made when
// the library opened, before the window loads; a library switch reloads the window. So the window asks once and every
// list reuses the answer.

let session: GenerateSession | undefined
let request: Promise<GenerateSession> | undefined

function loadSession(): Promise<GenerateSession> {
  request ??= window.studio.getSession().then(
    (s) => s,
    (e: unknown) => {
      // Never seen in practice; the window's own start is close enough to keep Generate's list usable.
      console.warn('Could not read when the session started', e)
      return { startedAt: Math.round(performance.timeOrigin), carriedOver: [] }
    }
  )
  return request.then((s) => (session = s))
}

/** This session, or undefined until main has answered. */
export function useSession(): GenerateSession | undefined {
  const [value, setValue] = useState(session)
  useEffect(() => {
    if (value !== undefined) return
    let active = true
    void loadSession().then((s) => active && setValue(s))
    return () => {
      active = false
    }
  }, [value])
  return value
}
