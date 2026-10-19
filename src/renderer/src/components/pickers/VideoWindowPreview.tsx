import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from '../../lib/media'
import { pauseOthers } from '../feed/playback'

interface Props {
  path: string
  /** The window that is sent, in seconds: what is shown and played. */
  start: number
  length: number
  /** Plays the window over and over (muted unless `sound`); otherwise shows its first frame. */
  playing: boolean
  /** Plays with sound (the window editor); a hover preview is silent and leaves other players alone. */
  sound?: boolean
  /** Where to show the frame while not playing, when not the window's start (the editor's playhead). */
  at?: number
  /** Called with the playhead while playing (the editor's track follows it). */
  onTime?: (time: number) => void
  /** The file's length, once the element knows it. */
  onDuration?: (seconds: number) => void
  className?: string
}

/**
 * A reference video's window as a picture that plays: its first frame while still, and while `playing` the window
 * from start to end, again and again, so a hover shows exactly the motion that is sent. One <video> element per
 * preview, loading only metadata until it plays. A file that can't be played says so instead.
 */
export default function VideoWindowPreview({
  path,
  start,
  length,
  playing,
  sound = false,
  at,
  onTime,
  onDuration,
  className = 'h-full w-full object-cover'
}: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState<string>()
  const latest = useRef({ start, length, onTime })
  latest.current = { start, length, onTime }
  const end = start + Math.max(0.1, length)

  // Still: the frame at the window's start (or the editor's playhead).
  useEffect(() => {
    const el = ref.current
    if (!el || playing) return
    const t = at ?? start
    if (Math.abs(el.currentTime - t) > 0.04) el.currentTime = t
  }, [playing, start, at, path])

  // Playing: from the start of the window, back to it at the end, until stopped.
  useEffect(() => {
    const el = ref.current
    if (!el || !playing) return
    let frame = 0
    const tick = (): void => {
      const { start: s, length: l, onTime: report } = latest.current
      if (el.currentTime >= s + Math.max(0.1, l) - 0.03 || el.currentTime < s - 0.25) el.currentTime = s
      report?.(el.currentTime)
      frame = requestAnimationFrame(tick)
    }
    el.currentTime = latest.current.start
    void el.play().catch(() => {
      // Interrupted (stopped again, another player started), or the file can't be played (the error event says so).
    })
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      el.pause()
      el.currentTime = latest.current.start
    }
  }, [playing, path])

  // The window moved while it plays: go on from its new start.
  useEffect(() => {
    const el = ref.current
    if (el && playing && (el.currentTime < start || el.currentTime > end)) el.currentTime = start
  }, [start, end])

  if (failed === path) {
    return (
      <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
        File missing
      </span>
    )
  }
  return (
    <video
      ref={ref}
      // The fragment shows the window's first frame before anything has played.
      src={`${mediaUrl(path)}#t=${Math.round(start * 100) / 100}`}
      preload="metadata"
      muted={!sound}
      playsInline
      disablePictureInPicture
      draggable={false}
      onLoadedMetadata={(e) => {
        const el = e.currentTarget
        const d = el.duration
        if (Number.isFinite(d) && d > 0) onDuration?.(d)
        // A seek decodes the frame, so a still preview shows its picture rather than black (a fragment alone
        // doesn't always paint one).
        if (!playing) el.currentTime = Math.max(0.001, at ?? start)
      }}
      onPlay={(e) => {
        if (sound) pauseOthers(e.currentTarget)
      }}
      onError={() => setFailed(path)}
      className={`pointer-events-none bg-black ${className}`}
    />
  )
}
