import { useEffect, useState } from 'react'

/**
 * The current time of a media element, live: every frame while it plays, and on every seek or pause. Used only by
 * the small parts that move with it (the playhead, the clock), so the rest of the strip doesn't redraw 60 times a
 * second.
 */
export function useMediaTime(el: HTMLMediaElement | null): number {
  const [time, setTime] = useState(0)
  useEffect(() => {
    if (!el) return
    let raf = 0
    const read = () => setTime(el.currentTime)
    const tick = () => {
      read()
      raf = requestAnimationFrame(tick)
    }
    const start = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      read()
    }
    read()
    if (!el.paused) start()
    el.addEventListener('play', start)
    el.addEventListener('pause', stop)
    el.addEventListener('ended', stop)
    el.addEventListener('seeked', read)
    el.addEventListener('seeking', read)
    el.addEventListener('emptied', read)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('play', start)
      el.removeEventListener('pause', stop)
      el.removeEventListener('ended', stop)
      el.removeEventListener('seeked', read)
      el.removeEventListener('seeking', read)
      el.removeEventListener('emptied', read)
    }
  }, [el])
  return time
}

/** Whether a media element is playing, live. */
export function useMediaPlaying(el: HTMLMediaElement | null): boolean {
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!el) return
    const read = () => setPlaying(!el.paused && !el.ended)
    read()
    el.addEventListener('play', read)
    el.addEventListener('pause', read)
    el.addEventListener('ended', read)
    return () => {
      el.removeEventListener('play', read)
      el.removeEventListener('pause', read)
      el.removeEventListener('ended', read)
    }
  }, [el])
  return playing
}
