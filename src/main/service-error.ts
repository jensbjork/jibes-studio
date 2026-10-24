// Errors from the generation services (Venice, fal.ai), shared so the job manager and the Editor decide what to retry
// the same way whichever service answered: a ServiceError has the HTTP status the service gave, a NetworkError
// means no answer came at all.

/** A service answered with an error: its HTTP status and, when it sent one, the parsed body. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message)
  }
}

/** The service couldn't be reached at all (no network, DNS, connection dropped mid-transfer). */
export class NetworkError extends Error {}

/** fetch() rejects with a bare "TypeError: fetch failed" (or "terminated" mid-body) when the network drops. */
export function networkError(err: unknown, what: string): NetworkError {
  return new NetworkError(`${what} Check your internet connection and try again.`, { cause: err })
}

export async function fetchOrExplain(url: string, init: RequestInit | undefined, what: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    throw networkError(err, what)
  }
}

/**
 * Whether a failed poll is worth trying again: no answer, rate limiting (429) or the service's own trouble (5xx).
 * `unreachable` decides how long to keep trying (a dropped Wi-Fi mid-render must not fail a paid job).
 */
export function retryKind(err: unknown): { transient: boolean; unreachable: boolean } {
  const unreachable =
    err instanceof NetworkError || (err instanceof ServiceError && (err.status >= 500 || err.status === 429))
  return { unreachable, transient: unreachable || !(err instanceof ServiceError) }
}
