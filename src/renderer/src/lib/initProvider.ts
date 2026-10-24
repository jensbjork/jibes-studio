// The service the window works with (Settings → Service), read before any other module: the stores and forms take
// their default models (DEFAULT_MODEL) as they load. main.tsx imports this first. A switch reloads the window (main
// does it, as for a library switch), so every list, default and price is the new service's.

import { asProvider, rememberProvider } from '@shared/provider'

rememberProvider(asProvider(window.studio.initialProvider) ?? 'venice')

const RETURN_KEY = 'studio.returnToSettings'

/** Before a switch of service, which reloads the window: it then opens on Settings again, where the switch was made. */
export function returnToSettingsAfterReload(): void {
  try {
    sessionStorage.setItem(RETURN_KEY, '1')
  } catch {
    // Without session storage the window opens on Generate: nothing is lost.
  }
}

/** Whether the window was started over by a switch of service (taken once): it then opens on Settings. */
export function takeReturnToSettings(): boolean {
  try {
    const back = sessionStorage.getItem(RETURN_KEY) === '1'
    sessionStorage.removeItem(RETURN_KEY)
    return back
  } catch {
    return false
  }
}
