import { useSyncExternalStore } from 'react'
import type { EditRange } from '@shared/types'

// The edit view's player as one object outside React: the <video> elements (the current version and the one it is
// compared with), the playhead, J/K/L shuttle and the looped range. Components read the playhead and the play state
// through useSyncExternalStore, so a playing film re-renders only the time display and the playhead line, not the
// whole workspace.

export interface PlayerState {
  playing: boolean
  /** 1, 2 or 4 (J/L pressed again). */
  rate: number
  /** -1 while J plays backwards. */
  direction: 1 | -1
  /** Spela markeringen: the marked range plays over and over. */
  looping: boolean
}

const MAX_RATE = 4

export class PlayerController {
  /** Frames per second of the film (the timeline knows it); one frame step is 1/fps. */
  fps = 30
  /** Seconds, of the version shown. */
  duration = 0

  private time = 0
  private state: PlayerState = { playing: false, rate: 1, direction: 1, looping: false }
  private timeListeners = new Set<() => void>()
  private stateListeners = new Set<() => void>()
  private videos = new Map<string, HTMLVideoElement>()
  private shown?: string
  private loop?: EditRange
  private frame = 0
  private reverseLast = 0
  /** A time to seek to once the element has loaded (a version that just became current). */
  private pending = new Map<string, number>()

  // ── Stores for React ──

  getTime = (): number => this.time
  subscribeTime = (cb: () => void): (() => void) => {
    this.timeListeners.add(cb)
    return () => this.timeListeners.delete(cb)
  }
  getState = (): PlayerState => this.state
  subscribeState = (cb: () => void): (() => void) => {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  private setTime(t: number): void {
    if (Math.abs(t - this.time) < 1e-6) return
    this.time = t
    for (const cb of this.timeListeners) cb()
  }

  private setState(patch: Partial<PlayerState>): void {
    const next = { ...this.state, ...patch }
    if (
      next.playing === this.state.playing &&
      next.rate === this.state.rate &&
      next.direction === this.state.direction &&
      next.looping === this.state.looping
    ) {
      return
    }
    this.state = next
    for (const cb of this.stateListeners) cb()
  }

  // ── Elements ──

  /** Called by the Player with each version's element (null when it unmounts). */
  attach(id: string, el: HTMLVideoElement | null): void {
    if (el) {
      this.videos.set(id, el)
      el.muted = id !== this.shown
      const pending = this.pending.get(id)
      if (pending !== undefined && el.readyState >= 1) {
        el.currentTime = Math.min(pending, el.duration || pending)
        this.pending.delete(id)
      }
    } else if (this.videos.get(id)) {
      this.videos.delete(id)
    }
  }

  /** The element has loaded its metadata: a time waiting for it is applied now. */
  loaded(id: string): void {
    const el = this.videos.get(id)
    const pending = this.pending.get(id)
    if (!el || pending === undefined) return
    this.pending.delete(id)
    el.currentTime = Math.min(pending, Number.isFinite(el.duration) ? el.duration : pending)
    if (id === this.shown && this.state.playing && this.state.direction === 1) void el.play().catch(() => {})
  }

  private current(): HTMLVideoElement | undefined {
    return this.shown ? this.videos.get(this.shown) : undefined
  }

  /**
   * Shows another version at the same playhead (Compare ⇄, a new current version). A playing film goes on playing
   * in the version shown now.
   */
  show(id: string | undefined): void {
    if (id === this.shown) return
    const before = this.current()
    const wasPlaying = this.state.playing && this.state.direction === 1
    before?.pause()
    if (before) before.muted = true
    this.shown = id
    const el = this.current()
    if (!el) {
      if (id) this.pending.set(id, this.time)
      return
    }
    el.muted = false
    if (el.readyState >= 1) {
      el.currentTime = Math.min(this.time, Number.isFinite(el.duration) ? el.duration : this.time)
      if (wasPlaying) void el.play().catch(() => this.setState({ playing: false }))
    } else {
      this.pending.set(id!, this.time)
    }
  }

  shownId(): string | undefined {
    return this.shown
  }

  // ── Playing ──

  play(): void {
    this.stopReverse()
    const el = this.current()
    if (!el) return
    if (el.ended || el.currentTime >= (el.duration || this.duration) - 0.02) el.currentTime = this.loop?.start ?? 0
    el.playbackRate = 1
    this.setState({ rate: 1, direction: 1 })
    void el.play().catch(() => this.setState({ playing: false }))
  }

  pause(): void {
    this.stopReverse()
    const el = this.current()
    el?.pause()
    if (el) el.playbackRate = 1
    this.setState({ playing: false, rate: 1, direction: 1 })
  }

  toggle(): void {
    if (this.state.playing) this.pause()
    else this.play()
  }

  seek(t: number): void {
    const end = this.duration || this.current()?.duration || 0
    const time = Math.max(0, Math.min(end > 0 ? end : t, t))
    const el = this.current()
    if (el) el.currentTime = time
    this.setTime(time)
  }

  /** The frame on screen (0-based). */
  frameIndex(): number {
    return Math.floor(this.time * this.fps + 1e-4)
  }

  /** ← / →: n frames, paused, landing in the middle of the frame so rounding can't show its neighbour. */
  stepFrames(n: number): void {
    this.pause()
    const last = Math.max(0, Math.ceil(this.duration * this.fps) - 1)
    const target = Math.max(0, Math.min(last, this.frameIndex() + n))
    this.seek((target + 0.5) / this.fps)
  }

  /** ⇧← / ⇧→: n seconds. */
  stepSeconds(n: number): void {
    this.seek(this.time + n)
  }

  /** Where Mark in puts the range's start: the start of the frame on screen. */
  markInTime(): number {
    return Math.min(this.duration, this.frameIndex() / this.fps)
  }

  /** Where Mark out puts the range's end: the end of the frame on screen, so that frame is included. */
  markOutTime(): number {
    return Math.min(this.duration, (this.frameIndex() + 1) / this.fps)
  }

  /** J / K / L: backwards, stop, forwards; pressed again, twice as fast (up to 4×). */
  shuttle(key: 'j' | 'k' | 'l'): void {
    if (key === 'k') {
      this.pause()
      return
    }
    const direction = key === 'l' ? 1 : -1
    const rate = this.state.playing && this.state.direction === direction ? Math.min(MAX_RATE, this.state.rate * 2) : 1
    if (direction === 1) {
      this.stopReverse()
      const el = this.current()
      if (!el) return
      el.playbackRate = rate
      this.setState({ rate, direction: 1 })
      if (el.paused) void el.play().catch(() => this.setState({ playing: false }))
      return
    }
    // Chromium can't play a video backwards, so J steps it back on every animation frame (no sound).
    const el = this.current()
    el?.pause()
    this.setState({ playing: true, rate, direction: -1 })
    if (!this.frame) {
      this.reverseLast = performance.now()
      this.frame = requestAnimationFrame(this.reverseTick)
    }
  }

  private reverseTick = (now: number): void => {
    const el = this.current()
    const dt = (now - this.reverseLast) / 1000
    this.reverseLast = now
    if (!el || this.state.direction !== -1 || !this.state.playing) {
      this.frame = 0
      return
    }
    const floor = this.state.looping && this.loop ? this.loop.start : 0
    let next = this.time - dt * this.state.rate
    if (next <= floor) {
      if (this.state.looping && this.loop) next = this.loop.end
      else {
        this.seek(floor)
        this.stopReverse()
        this.setState({ playing: false, rate: 1, direction: 1 })
        return
      }
    }
    this.seek(next)
    this.frame = requestAnimationFrame(this.reverseTick)
  }

  private stopReverse(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    if (this.state.direction === -1) this.setState({ direction: 1, playing: false, rate: 1 })
  }

  // ── Looping the marked range ──

  /** Spela markeringen: starts the range from its beginning and loops it; undefined stops looping. */
  loopRange(range: EditRange | undefined): void {
    this.loop = range
    this.setState({ looping: !!range })
    if (!range) return
    this.seek(range.start)
    this.play()
  }

  /** The marked range changed: a loop follows it, and stops when it is cleared. */
  rangeChanged(range: EditRange | undefined): void {
    if (!this.state.looping) return
    if (!range) {
      this.loop = undefined
      this.setState({ looping: false })
    } else this.loop = range
  }

  // ── Events from the shown element ──

  /** Playback state and time from the element's own events (play, pause, timeupdate, seeked, ended). */
  elementEvent(id: string, type: string): void {
    if (id !== this.shown) return
    const el = this.videos.get(id)
    if (!el) return
    if (type === 'play' || type === 'playing') {
      this.setState({ playing: true })
      this.startTicking()
    } else if (type === 'pause' || type === 'ended') {
      // A J shuttle pauses the element but keeps "playing" backwards.
      if (this.state.direction === 1) this.setState({ playing: false, rate: 1 })
    }
    if (this.state.direction === 1) this.setTime(el.currentTime)
  }

  private ticking = 0
  private startTicking(): void {
    if (this.ticking) return
    const tick = () => {
      const el = this.current()
      if (!el || el.paused || this.state.direction !== 1) {
        this.ticking = 0
        return
      }
      if (this.state.looping && this.loop && el.currentTime >= this.loop.end - 0.01) {
        el.currentTime = this.loop.start
      }
      this.setTime(el.currentTime)
      this.ticking = requestAnimationFrame(tick)
    }
    this.ticking = requestAnimationFrame(tick)
  }

  destroy(): void {
    this.stopReverse()
    if (this.ticking) cancelAnimationFrame(this.ticking)
    this.ticking = 0
    for (const el of this.videos.values()) el.pause()
    this.videos.clear()
  }
}

/** The playhead (seconds), live. */
export function usePlayhead(player: PlayerController): number {
  return useSyncExternalStore(player.subscribeTime, player.getTime)
}

/**
 * Something derived from the playhead (a primitive: the line being spoken, a rounded time), re-rendering only when
 * it changes rather than on every frame.
 */
export function usePlayheadValue<T extends string | number | boolean | undefined>(
  player: PlayerController,
  select: (time: number) => T
): T {
  return useSyncExternalStore(player.subscribeTime, () => select(player.getTime()))
}

export function usePlayerState(player: PlayerController): PlayerState {
  return useSyncExternalStore(player.subscribeState, player.getState)
}
