// The service Studio generates with: Venice.ai or fal.ai. One is active at a time (Settings → Service); work made with
// the other stays, and a job already sent finishes where it was sent. Which service a model belongs to is part of its
// id: fal's models are `fal:<endpoint id>` (fal:bytedance/seedance-2.5/reference-to-video), Venice's are bare
// (seedance-2-5-reference-to-video-basic), as every id stored before fal existed. So a pending job, a take's params or
// a voice clone always say where they go, without a column of their own.

export type Provider = 'venice' | 'fal'

export const PROVIDERS: readonly Provider[] = ['venice', 'fal']

/** The prefix of fal's model ids in Studio. */
export const FAL_PREFIX = 'fal:'

/** The service's name as the app shows it. */
export function providerName(provider: Provider): string {
  return provider === 'fal' ? 'fal.ai' : 'Venice'
}

/** Where a key is made (Settings links to it). */
export function providerKeyPage(provider: Provider): string {
  return provider === 'fal' ? 'https://fal.ai/dashboard/keys' : 'https://venice.ai/settings/api'
}

/** The service a model id belongs to. */
export function providerOf(modelId: string | undefined | null): Provider {
  return typeof modelId === 'string' && modelId.startsWith(FAL_PREFIX) ? 'fal' : 'venice'
}

/** fal's endpoint id behind a Studio model id (fal:bytedance/seedance-2.5/text-to-video → bytedance/seedance-2.5/…). */
export function falEndpoint(modelId: string): string {
  return modelId.startsWith(FAL_PREFIX) ? modelId.slice(FAL_PREFIX.length) : modelId
}

/** A value as a provider, or undefined. */
export function asProvider(value: unknown): Provider | undefined {
  return value === 'venice' || value === 'fal' ? value : undefined
}

// The active service, as main has it from the settings and the window from settings:get: shared code that picks a
// default model (DEFAULT_MODEL, the Editor's models) asks here. Venice until told otherwise, as before fal existed.
let active: Provider = 'venice'

/** Main and the window each call this when they read the settings (and when the choice changes). */
export function rememberProvider(provider: Provider): void {
  active = provider
}

/** The service new work is sent to. */
export function activeProvider(): Provider {
  return active
}
