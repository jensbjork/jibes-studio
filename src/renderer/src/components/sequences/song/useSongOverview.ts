import { useCallback, useEffect, useState } from 'react'
import type { Sequence, SongOverview } from '@shared/types'
import { ipcErrorMessage } from '../../../lib/hooks'

// The peaks, beats and bars of a sequence's song (songOverview: free, cached in main), shared by everything that
// draws or snaps to the song, so one request serves them all. Asked again when the song or its vocals change and
// when a step on it (separating, finding the beat) ends.

const cache = new Map<string, Promise<SongOverview>>()
/** Kept per song and stage; older entries are dropped (a window can visit many sequences). */
const CACHE_SIZE = 8

function keyOf(sequence: Sequence): string | undefined {
  const song = sequence.song
  if (!song) return undefined
  return [sequence.id, song.path, song.vocalsPath ?? '', song.duration, sequence.songWork?.stage ?? ''].join('|')
}

function load(sequenceId: string, key: string): Promise<SongOverview> {
  const known = cache.get(key)
  if (known) return known
  const request = window.studio.songOverview(sequenceId)
  cache.set(key, request)
  // A failure is forgotten, so the next caller (or Try again) asks again.
  request.catch(() => cache.get(key) === request && cache.delete(key))
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return request
}

export interface SongOverviewState {
  /** The last overview that arrived for this song (kept while a newer one loads). */
  overview?: SongOverview
  error?: string
  loading: boolean
  retry: () => void
}

export function useSongOverview(sequence: Sequence | undefined): SongOverviewState {
  const key = sequence ? keyOf(sequence) : undefined
  const sequenceId = sequence?.id
  const [state, setState] = useState<{ songKey?: string; overview?: SongOverview; error?: string; loading: boolean }>({
    loading: false
  })
  const [attempt, setAttempt] = useState(0)
  // What identifies the song itself (not its stage): an overview of the same song stays on screen while it reloads.
  const songKey = key?.split('|').slice(0, 4).join('|')

  useEffect(() => {
    if (!key || !sequenceId) return
    let current = true
    const kept = (s: { songKey?: string; overview?: SongOverview }) => (s.songKey === songKey ? s.overview : undefined)
    setState((s) => ({ songKey, overview: kept(s), loading: true }))
    load(sequenceId, key).then(
      (overview) => current && setState({ songKey, overview, loading: false }),
      (e: unknown) => current && setState((s) => ({ songKey, overview: kept(s), error: ipcErrorMessage(e), loading: false }))
    )
    return () => {
      current = false
    }
  }, [key, attempt])

  const retry = useCallback(() => {
    if (key) cache.delete(key)
    setAttempt((n) => n + 1)
  }, [key])

  const mine = state.songKey === songKey
  return {
    overview: mine ? state.overview : undefined,
    error: mine ? state.error : undefined,
    loading: mine ? state.loading : !!key,
    retry
  }
}
