import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssetAudio } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import type { ClipWindow } from './audioUtils'

/** file: the whole recording. window: exactly the part that is sent to Venice, then stop. */
export type PlayMode = 'file' | 'window'

export interface PlayerState {
  /** The clip loaded in the player (the playhead belongs to it). */
  clipId?: string
  mode: PlayMode
  playing: boolean
  /** Playhead, seconds into the loaded clip. */
  time: number
}

export interface ClipPlayer {
  state: PlayerState
  /** Clips the window can't play (e.g. AIFF, which Chromium doesn't decode); they are still sent as usual. */
  failed: ReadonlySet<string>
  /** Plays the whole recording from the playhead (from the start once it has played to the end), or pauses. */
  toggleFile: (clip: AssetAudio) => void
  /** Plays exactly the window and stops at its end, or stops a preview that is playing. */
  toggleWindow: (clip: AssetAudio, window: ClipWindow) => void
  /** The window was moved or resized: a preview that is playing stops at the new end. */
  windowChanged: (clipId: string, window: ClipWindow) => void
  /** Moves the playhead (and keeps playing the whole recording from there if it was playing). */
  seek: (clip: AssetAudio, time: number) => void
  /** Stops whatever is playing, e.g. before its clip is removed. */
  stop: () => void
}

function ignoreAbort(e: unknown): void {
  // play() is "interrupted" whenever playback is paused or switched while it starts; that isn't a failure,
  // and real failures arrive as the element's error event.
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotSupportedError')) return
  console.warn('Kunde inte spela upp ljudet', e)
}

/**
 * One <audio> element shared by every clip of an asset, so only one plays at a time. The playhead is
 * followed with requestAnimationFrame while playing: smooth on the track, and a window preview stops within
 * a frame of its end instead of the quarter second timeupdate allows.
 */
export function useClipPlayer(): ClipPlayer {
  const element = useRef<HTMLAudioElement | null>(null)
  const loaded = useRef<{ clipId?: string; path?: string; mode: PlayMode; window?: ClipWindow }>({ mode: 'file' })
  const [state, setState] = useState<PlayerState>({ mode: 'file', playing: false, time: 0 })
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())

  const audio = useCallback((): HTMLAudioElement => {
    if (element.current) return element.current
    const a = new Audio()
    a.preload = 'auto'
    a.addEventListener('play', () => setState((s) => ({ ...s, playing: true })))
    a.addEventListener('pause', () => setState((s) => ({ ...s, playing: false, time: a.currentTime })))
    a.addEventListener('seeked', () => setState((s) => (s.time === a.currentTime ? s : { ...s, time: a.currentTime })))
    a.addEventListener('error', () => {
      const id = loaded.current.clipId
      if (id) setFailed((f) => (f.has(id) ? f : new Set(f).add(id)))
      setState((s) => ({ ...s, playing: false }))
    })
    element.current = a
    return a
  }, [])

  /** Puts the clip in the player unless it is there already (a renamed asset moves its files: reload). */
  const load = useCallback(
    (clip: AssetAudio): HTMLAudioElement => {
      const a = audio()
      if (loaded.current.clipId !== clip.id || loaded.current.path !== clip.path) {
        a.pause()
        a.src = mediaUrl(clip.path)
        loaded.current = { clipId: clip.id, path: clip.path, mode: 'file' }
        setState({ clipId: clip.id, mode: 'file', playing: false, time: 0 })
      }
      return a
    },
    [audio]
  )

  const toggleFile = useCallback(
    (clip: AssetAudio) => {
      const a = load(clip)
      if (!a.paused && loaded.current.mode === 'file') {
        a.pause()
        return
      }
      loaded.current = { ...loaded.current, mode: 'file', window: undefined }
      if (a.ended || (Number.isFinite(a.duration) && a.currentTime >= a.duration - 0.05)) a.currentTime = 0
      setState((s) => ({ ...s, mode: 'file' }))
      a.play().catch(ignoreAbort)
    },
    [load]
  )

  const toggleWindow = useCallback(
    (clip: AssetAudio, window: ClipWindow) => {
      const a = load(clip)
      if (!a.paused && loaded.current.mode === 'window') {
        a.pause()
        a.currentTime = window.start
        return
      }
      loaded.current = { ...loaded.current, mode: 'window', window }
      a.currentTime = window.start
      setState((s) => ({ ...s, mode: 'window', time: window.start }))
      a.play().catch(ignoreAbort)
    },
    [load]
  )

  const windowChanged = useCallback((clipId: string, window: ClipWindow) => {
    if (loaded.current.clipId === clipId && loaded.current.mode === 'window') {
      loaded.current = { ...loaded.current, window }
    }
  }, [])

  const seek = useCallback(
    (clip: AssetAudio, time: number) => {
      const a = load(clip)
      // Scrubbing leaves the preview: from here on the recording plays on past the window.
      loaded.current = { ...loaded.current, mode: 'file', window: undefined }
      a.currentTime = Math.max(0, time)
      setState((s) => ({ ...s, mode: 'file', time: Math.max(0, time) }))
    },
    [load]
  )

  const stop = useCallback(() => {
    element.current?.pause()
  }, [])

  // Follow the playhead while playing, and end a window preview at the window's end.
  useEffect(() => {
    if (!state.playing) return
    let raf = 0
    const tick = () => {
      const a = element.current
      if (a) {
        const { mode, window } = loaded.current
        if (mode === 'window' && window && a.currentTime >= window.start + window.length - 0.02) {
          a.pause()
          a.currentTime = window.start + window.length
        }
        const time = a.currentTime
        setState((s) => (s.time === time ? s : { ...s, time }))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.playing])

  // Leaving the asset (or the view) silences it and lets the file go. The next use starts from a fresh
  // element (React's development double mount runs this cleanup once while the component stays).
  useEffect(
    () => () => {
      const a = element.current
      element.current = null
      loaded.current = { mode: 'file' }
      if (!a) return
      a.pause()
      a.removeAttribute('src')
      a.load()
    },
    []
  )

  return useMemo(
    () => ({ state, failed, toggleFile, toggleWindow, windowChanged, seek, stop }),
    [state, failed, toggleFile, toggleWindow, windowChanged, seek, stop]
  )
}
