import { useEffect, useSyncExternalStore } from 'react'
import { mediaUrl } from '../../lib/media'
import { pauseOthers, registerOffPagePlayer } from '../feed/playback'

// One <audio> element for the whole window plays the reference window of a clip (from `start`, `length` seconds),
// so starting one clip stops any other: chips, picker rows and the prompt's key all share it. It also takes part
// in the window's one-player rule: it pauses the clip feed's videos when it starts, and stops when one of them does.

interface Playing {
  key: string
  start: number
  end: number
  /** 0–1 through the window. */
  progress: number
}

let element: HTMLAudioElement | undefined
let playing: Playing | undefined
let frame = 0
/** Keys of clips whose file could not be played (missing or unreadable), until they are tried again. */
const failed = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version++
  for (const l of [...listeners]) l()
}

/**
 * Ends the preview at the window's end within a frame: timeupdate comes only about every quarter second, which
 * would play on into audio that isn't sent (the library editor's player polls the same way).
 */
function watchEnd(el: HTMLAudioElement): void {
  cancelAnimationFrame(frame)
  const tick = (): void => {
    if (!playing || el.paused) return
    if (el.currentTime >= playing.end - 0.02) {
      stopClip()
      return
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}

function audio(): HTMLAudioElement {
  if (element) return element
  const el = new Audio()
  el.preload = 'auto'
  registerOffPagePlayer(el, () => stopClip())
  el.addEventListener('play', () => {
    pauseOthers(el)
    watchEnd(el)
  })
  // Progress for the ring (often enough for it), and the end again in case frames don't run (window hidden).
  el.addEventListener('timeupdate', () => {
    if (!playing) return
    if (el.currentTime >= playing.end - 0.02) {
      stopClip()
      return
    }
    const span = Math.max(0.1, playing.end - playing.start)
    playing = { ...playing, progress: Math.min(1, Math.max(0, (el.currentTime - playing.start) / span)) }
    emit()
  })
  el.addEventListener('ended', () => stopClip())
  el.addEventListener('error', () => {
    if (!playing) return
    failed.add(playing.key)
    playing = undefined
    emit()
  })
  element = el
  return el
}

function keyOf(path: string, start: number, length: number): string {
  return `${path}\u0000${start}\u0000${length}`
}

/** Plays the window of the file; stops whatever was playing. */
export function playClip(path: string, start: number, length: number): void {
  const el = audio()
  const key = keyOf(path, start, length)
  failed.delete(key)
  const src = mediaUrl(path)
  playing = { key, start, end: start + Math.max(0.1, length), progress: 0 }
  emit()
  const begin = (): void => {
    // Another clip may have been started while this file was loading.
    if (playing?.key !== key) return
    el.currentTime = start
    void el.play().catch(() => {
      // Interrupted by another clip, or the file can't be played (the error event marks it).
      if (playing?.key === key) {
        playing = undefined
        emit()
      }
    })
  }
  if (el.src !== src) {
    el.src = src
    el.addEventListener('loadedmetadata', begin, { once: true })
    el.load()
  } else begin()
}

export function stopClip(): void {
  element?.pause()
  cancelAnimationFrame(frame)
  if (!playing) return
  playing = undefined
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether this clip window is playing (and how far), or could not be played. */
export function useClipState(path: string, start: number, length: number): {
  playing: boolean
  progress: number
  failed: boolean
} {
  useSyncExternalStore(subscribe, () => version, () => version)
  const key = keyOf(path, start, length)
  const mine = playing?.key === key ? playing : undefined
  return { playing: !!mine, progress: mine?.progress ?? 0, failed: failed.has(key) }
}

interface Props {
  path: string
  /** The window that is played: the part of the file sent to Venice. */
  start: number
  length: number
  /** What the clip is, for the button's label ("Anna · röst"). */
  label: string
  /** Size and colour; defaults to a small round button. */
  className?: string
}

/**
 * ▶ / ■ for a clip's reference window, with a ring that fills while it plays. Stops when the button goes away,
 * so a removed chip doesn't keep talking.
 */
export default function AudioPlayButton({ path, start, length, label, className = 'h-5 w-5' }: Props) {
  const state = useClipState(path, start, length)
  const playingNow = state.playing
  useEffect(
    () => () => {
      if (playing?.key === keyOf(path, start, length)) stopClip()
    },
    [path, start, length]
  )
  const title = state.failed
    ? `Filen går inte att spela upp: ${path.split('/').pop() ?? path}`
    : playingNow
      ? `Stoppa ${label}`
      : `Lyssna på ${label}`
  const ring = `conic-gradient(currentColor ${Math.round(state.progress * 360)}deg, transparent 0deg)`
  return (
    <button
      type="button"
      // Keeps the focus where it is (e.g. the caret in the prompt).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        if (playingNow) stopClip()
        else playClip(path, start, length)
      }}
      title={title}
      aria-label={title}
      aria-pressed={playingNow}
      className={`relative flex shrink-0 items-center justify-center rounded-full bg-black/30 text-text transition hover:bg-black/50 ${
        state.failed ? 'text-accent' : ''
      } ${className}`}
    >
      {playingNow && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full opacity-60 [mask:radial-gradient(circle,transparent_58%,black_60%)]"
          style={{ background: ring }}
        />
      )}
      <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden>
        {state.failed ? (
          <path d="M3.4 0.5h1.2v4.5H3.4zM3.4 6h1.2v1.5H3.4z" />
        ) : playingNow ? (
          <rect x="1" y="1" width="6" height="6" rx="0.8" />
        ) : (
          <path d="M1.6 0.6v6.8L7.4 4z" />
        )}
      </svg>
    </button>
  )
}
