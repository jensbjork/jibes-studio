import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent
} from 'react'
import type { EditRange, EditTimeline } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { shortcut } from '../../lib/platform'
import Popover from '../pickers/Popover'
import { CloseIcon } from '../sequences/icons'
import { useCardRun, useEditor } from './EditorContext'
import {
  formatClock,
  formatRange,
  layerRows,
  rangeBetween,
  rulerStep,
  snapPoints,
  snapTime
} from './editorUtils'
import { LoopIcon, ZoomInIcon, ZoomOutIcon } from './icons'
import { usePlayhead, usePlayerState, type PlayerController } from './playerController'
import { actionButton, GainSlider, PlanNotes } from './ui'

// The timeline under the player: Picture (a filmstrip with the cut markers), Sound (the waveform, muted stretches
// shaded), and once there is something on them Layers (added voices, music and effects as bars) and Text (the
// transcript's lines). Drag on any lane to mark a range; it snaps to cut markers and line edges (hold ⌥ to snap to
// frames only). A click moves the playhead. The marked range's chip above the lanes loops it or clears it.

const LABEL_WIDTH = 56
const DRAG_THRESHOLD_PX = 3
const SNAP_PX = 8
const EDGE_GRAB_PX = 6
const ZOOMS = [1, 2, 4, 8, 16, 32]
const LAYER_ROW_PX = 18

const HATCH = 'repeating-linear-gradient(135deg, #00000099 0 4px, #00000055 4px 8px)'

const LAYER_TONE: Record<string, string> = {
  speech: 'border-sky-300/60 bg-sky-400/20',
  voice: 'border-sky-300/60 bg-sky-400/20',
  music: 'border-violet-300/60 bg-violet-400/20',
  effect: 'border-amber-300/60 bg-amber-400/20',
  audio: 'border-emerald-300/60 bg-emerald-400/20'
}

const LAYER_KIND: Record<string, string> = {
  speech: 'Line',
  voice: 'Voice',
  music: 'Music',
  effect: 'Sound effect',
  audio: 'Sound'
}

const MUTED_TARGET: Record<string, string> = { all: 'muted', voice: 'no voice', background: 'voice only' }

interface Props {
  timeline?: EditTimeline
  loading: boolean
  error?: string
  /** The part the open operation card works on (snapped by its plan), outlined on the lanes. */
  opRange?: EditRange
}

export default function Timeline({ timeline, loading, error, opRange }: Props) {
  const { selection, setSelection, player, duration, fps, transcript } = useEditor()
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [viewWidth, setViewWidth] = useState(0)
  const width = viewWidth * zoom

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setViewWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The view follows the playhead while it plays out of sight.
  useEffect(
    () =>
      player.subscribeTime(() => {
        const el = scroller.current
        if (!el || zoom === 1 || !duration) return
        const x = (player.getTime() / duration) * el.scrollWidth
        if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - 48)
      }),
    [player, zoom, duration]
  )

  const lines = useMemo(
    () => transcript?.segments ?? timeline?.transcript?.segments ?? [],
    [transcript, timeline?.transcript]
  )
  // Layers and Text only when they have something on them. Each keeps its last known state while the next version's
  // timeline or transcript loads (⌘Z, Compare, a new version), so the player above doesn't jump.
  const hasLayers = timeline ? timeline.layers.length > 0 : undefined
  const hasText = transcript !== undefined || timeline?.transcript ? lines.length > 0 : undefined
  const [showLayers, setShowLayers] = useState(false)
  const [showText, setShowText] = useState(false)
  useEffect(() => {
    if (hasLayers !== undefined) setShowLayers(hasLayers)
  }, [hasLayers])
  useEffect(() => {
    if (hasText !== undefined) setShowText(hasText)
  }, [hasText])
  // Edges snap to the cut markers and to where transcript lines start and end.
  const points = useMemo(
    () => snapPoints({ cuts: timeline?.cuts ?? [], transcript: transcript ?? timeline?.transcript }),
    [timeline?.cuts, timeline?.transcript, transcript]
  )
  const latest = useRef({ selection, duration, fps, points, width })
  latest.current = { selection, duration, fps, points, width }

  const timeAt = (clientX: number) => {
    const r = content.current?.getBoundingClientRect()
    if (!r || !r.width || !latest.current.duration) return 0
    return Math.min(latest.current.duration, Math.max(0, ((clientX - r.left) / r.width) * latest.current.duration))
  }

  const snap = (t: number, frameOnly: boolean) => {
    const { duration: d, fps: f, points: p, width: w } = latest.current
    return snapTime(t, { points: frameOnly ? [] : p, tolerance: w ? (SNAP_PX / w) * d : 0, fps: f, duration: d })
  }

  /** Drag to mark (or to move an edge of the marking); a click without dragging moves the playhead. */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !duration) return
    const target = e.target as HTMLElement
    if (target.closest('[data-layer]')) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const r = content.current!.getBoundingClientRect()
    const pxPerSecond = r.width / duration
    const sel = latest.current.selection
    // Grabbing an edge of the marking moves that edge; anywhere else starts a new marking.
    let anchor = snap(timeAt(x0), e.altKey)
    if (sel) {
      const xs = r.left + sel.start * pxPerSecond
      const xe = r.left + sel.end * pxPerSecond
      if (Math.abs(x0 - xe) <= EDGE_GRAB_PX) anchor = sel.start
      else if (Math.abs(x0 - xs) <= EDGE_GRAB_PX) anchor = sel.end
    }
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD_PX) return
      moved = true
      const t = snap(timeAt(ev.clientX), ev.altKey)
      setSelection(rangeBetween(anchor, t, latest.current.fps))
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (moved) return
      // A transcript line seeks to where it starts; anywhere else to the time under the pointer.
      const line = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-line-start]')
      player.seek(line ? Number(line.dataset.lineStart) : timeAt(ev.clientX))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const zoomBy = (dir: 1 | -1, anchorClientX?: number) => {
    const el = scroller.current
    const i = ZOOMS.indexOf(zoom)
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))]
    if (!el || next === zoom) return
    // Keep the time under the pointer (or the playhead) where it is on screen.
    const r = el.getBoundingClientRect()
    const x = anchorClientX !== undefined ? anchorClientX - r.left : (player.getTime() / (duration || 1)) * el.scrollWidth - el.scrollLeft
    const at = (el.scrollLeft + x) / (el.scrollWidth || 1)
    setZoom(next)
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, at * el.scrollWidth - x)
    })
  }

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX)
  }

  const pct = (t: number) => `${(Math.min(duration, Math.max(0, t)) / (duration || 1)) * 100}%`
  const span = (r: EditRange) => ({ left: pct(r.start), width: pct(r.end - r.start) })
  const rows = useMemo(() => layerRows(timeline?.layers ?? []), [timeline?.layers])
  const layerHeight = Math.max(1, rows.count) * LAYER_ROW_PX + 8
  const step = rulerStep(duration, width)

  const cutsNote =
    timeline?.cutsSource === 'export'
      ? 'Cuts from the export'
      : timeline?.cutsSource === 'scenes' && timeline.cuts.length
        ? 'Cuts found in the picture'
        : undefined

  return (
    <section aria-label="Timeline" className="shrink-0 border-t border-line">
      <div className="flex h-8 items-center gap-3 px-3 text-[11px] text-muted">
        {selection ? (
          <span className="flex items-center gap-1.5">
            <span className="text-text">Selection</span> {formatRange(selection)}
            <LoopToggle player={player} selection={selection} />
            <button
              type="button"
              onClick={() => setSelection(undefined)}
              title="Clear selection (Esc)"
              aria-label="Clear selection"
              className="flex h-5 w-5 items-center justify-center rounded text-muted transition hover:bg-raised hover:text-text"
            >
              <CloseIcon size={9} />
            </button>
          </span>
        ) : (
          <span>Drag across the timeline to mark a section.</span>
        )}
        {cutsNote && <span className="hidden @min-[67rem]/main:inline">· {cutsNote}</span>}
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => zoomBy(-1)}
            disabled={zoom === ZOOMS[0]}
            title={`Zoom out (${shortcut('⌘-scroll')})`}
            aria-label="Zoom out"
            className="flex h-6 w-6 items-center justify-center rounded transition hover:bg-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ZoomOutIcon size={13} />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1)}
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            title={`Zoom in (${shortcut('⌘-scroll')})`}
            aria-label="Zoom in"
            className="flex h-6 w-6 items-center justify-center rounded transition hover:bg-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ZoomInIcon size={13} />
          </button>
        </span>
      </div>

      <div className="flex pb-2">
        <div className="shrink-0 select-none text-[11px] text-muted" style={{ width: LABEL_WIDTH }}>
          <div className="h-5" />
          <LaneLabel height={48}>Picture</LaneLabel>
          <LaneLabel height={40}>Sound</LaneLabel>
          {showLayers && <LaneLabel height={layerHeight}>Layers</LaneLabel>}
          {showText && <LaneLabel height={30}>Text</LaneLabel>}
        </div>
        <div ref={scroller} onWheel={onWheel} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pr-3">
          <div
            ref={content}
            onPointerDown={onPointerDown}
            className="relative cursor-text touch-none select-none"
            style={{ width: zoom === 1 ? '100%' : width }}
          >
            {/* Ruler */}
            <div className="relative h-5 text-[10px] tabular-nums text-muted">
              {duration > 0 &&
                Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step).map((t) => (
                  <span key={t} className="absolute top-0 flex h-full items-start" style={{ left: pct(t) }}>
                    <span className="h-1.5 w-px bg-line" />
                    {/* Whole-second steps are labelled without the tenths. */}
                    <span className="ml-1 -mt-px">{step < 1 ? formatClock(t) : formatClock(t).replace(/,\d$/, '')}</span>
                  </span>
                ))}
              {timeline?.cuts.map((c) => (
                <span
                  key={c}
                  title={`Cut ${formatClock(c)}`}
                  className="absolute bottom-0 h-0 w-0 -translate-x-1/2 border-x-[4px] border-t-[5px] border-x-transparent border-t-amber-300/80"
                  style={{ left: pct(c) }}
                />
              ))}
            </div>

            {/* Picture */}
            <Lane height={48} loading={loading && !timeline}>
              {timeline?.filmstrip.map((f, i, all) => {
                // Frames are sampled inside their stretch, so the first tile starts at 0:00 to leave no gap.
                const start = i === 0 ? 0 : f.time
                const next = all[i + 1]?.time ?? duration
                return (
                  <img
                    key={f.path}
                    src={mediaUrl(f.path)}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute inset-y-0 h-full object-cover opacity-90"
                    style={{ left: pct(start), width: pct(next - start) }}
                  />
                )
              })}
              {timeline?.cuts.map((c) => (
                <span key={c} className="pointer-events-none absolute inset-y-0 w-px bg-amber-300/80" style={{ left: pct(c) }} />
              ))}
            </Lane>

            {/* Sound */}
            <Lane height={40} loading={loading && !timeline}>
              {timeline && !timeline.hasAudio ? (
                <span className="absolute inset-0 flex items-center px-2 text-[11px] text-muted">No sound</span>
              ) : (
                timeline && <Waveform peaks={timeline.waveform} />
              )}
              {timeline?.muted.map((m, i) => (
                <span
                  key={i}
                  title={`${formatClock(m.start)}–${formatClock(m.end)} ${MUTED_TARGET[m.target] ?? ''}`}
                  className="absolute inset-y-0 flex items-end overflow-hidden px-1 text-[9px] text-white/70"
                  style={{ ...span(m), backgroundImage: HATCH }}
                >
                  {m.target !== 'all' && MUTED_TARGET[m.target]}
                </span>
              ))}
            </Lane>

            {/* Layers */}
            {showLayers && (
              <Lane height={layerHeight} loading={false}>
                {timeline?.layers.map((l) => (
                  <LayerBar
                    key={l.id}
                    layer={l}
                    row={rows.row.get(l.id) ?? 0}
                    left={pct(l.start)}
                    width={pct(l.end - l.start)}
                    player={player}
                  />
                ))}
              </Lane>
            )}

            {/* Text */}
            {showText && (
              <Lane height={30} loading={false}>
                {lines.map((s) => (
                  <span
                    key={s.id}
                    data-line-start={s.start}
                    title={`${formatClock(s.start)} ${s.text}`}
                    className="absolute inset-y-1 cursor-pointer overflow-hidden whitespace-nowrap rounded border border-line bg-raised px-1 text-[10px] leading-[20px] text-muted hover:text-text"
                    style={span(s)}
                  >
                    {s.text}
                  </span>
                ))}
              </Lane>
            )}

            {/* What the open card will use, as its plan snapped it. */}
            {opRange && (
              <span
                className="pointer-events-none absolute bottom-0 top-5 rounded-sm border border-dashed border-accent/80"
                style={span(opRange)}
              />
            )}
            {selection && (
              <span className="pointer-events-none absolute bottom-0 top-5 bg-accent/15" style={span(selection)}>
                <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
                <span className="absolute inset-y-0 right-0 w-0.5 bg-accent" />
              </span>
            )}
            <Playhead player={player} duration={duration} />
          </div>
        </div>
      </div>
      {error && <p className="px-3 pb-2 text-[11px] text-danger select-text">The timeline couldn’t be shown: {error}</p>}
    </section>
  )
}

/** "Loop" in the selection's chip: plays the marked range over and over, until pressed again. */
function LoopToggle({ player, selection }: { player: PlayerController; selection: EditRange }) {
  const { looping } = usePlayerState(player)
  return (
    <button
      type="button"
      onClick={() => player.loopRange(looping ? undefined : selection)}
      aria-pressed={looping}
      title="Play the selection over and over"
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition ${
        looping ? 'bg-accent/15 text-text' : 'text-muted hover:bg-raised hover:text-text'
      }`}
    >
      <LoopIcon size={11} />
      Loop
    </button>
  )
}

function LaneLabel({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div className="flex items-center border-t border-line/60 pl-3" style={{ height }}>
      {children}
    </div>
  )
}

function Lane({ height, loading, children }: { height: number; loading: boolean; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden border-t border-line/60" style={{ height }}>
      {loading ? <div className="absolute inset-1 animate-pulse rounded bg-raised" /> : children}
    </div>
  )
}

/** The sound's peaks as mirrored bars. */
function Waveform({ peaks }: { peaks: number[] }) {
  const path = useMemo(() => {
    let d = ''
    peaks.forEach((p, i) => {
      const h = Math.max(0.5, Math.min(1, p) * 46)
      d += `M${i + 0.5} ${50 - h}V${50 + h}`
    })
    return d
  }, [peaks])
  if (!peaks.length) return null
  return (
    <svg
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full text-sky-300/70"
      aria-hidden
    >
      <path d={path} stroke="currentColor" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Playhead({ player, duration }: { player: PlayerController; duration: number }) {
  const t = usePlayhead(player)
  if (!duration) return null
  return (
    <span
      className="pointer-events-none absolute bottom-0 top-0 w-px bg-white"
      style={{ left: `${(Math.min(duration, Math.max(0, t)) / duration) * 100}%` }}
    >
      <span className="absolute -left-[4px] top-0 h-0 w-0 border-x-[4.5px] border-t-[6px] border-x-transparent border-t-white" />
    </span>
  )
}

type LayerInfo = EditTimeline['layers'][number]

/**
 * A layer as a labelled bar; a click opens Change the volume / Move to the playhead / Remove the layer (each a free
 * version).
 */
function LayerBar({
  layer,
  row,
  left,
  width,
  player
}: {
  layer: LayerInfo
  row: number
  left: string
  width: string
  player: PlayerController
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-layer
        onClick={() => setOpen((o) => !o)}
        title={`${LAYER_KIND[layer.kind] ?? 'Sound'}: ${layer.label}`}
        className={`absolute h-[15px] overflow-hidden whitespace-nowrap rounded border px-1 text-left text-[10px] leading-[13px] text-text/90 transition hover:brightness-125 ${
          LAYER_TONE[layer.kind] ?? LAYER_TONE.audio
        } ${open ? 'ring-1 ring-white/60' : ''}`}
        style={{ left, width, top: 4 + row * LAYER_ROW_PX, minWidth: 6 }}
      >
        {layer.label}
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} width={300} label={layer.label}>
        {open && <LayerMenu layer={layer} player={player} onDone={() => setOpen(false)} />}
      </Popover>
    </>
  )
}

function LayerMenu({ layer, player, onDone }: { layer: LayerInfo; player: PlayerController; onDone: () => void }) {
  const card = useCardRun()
  const [gain, setGain] = useState(Math.round(layer.gainDb))
  const [busy, setBusy] = useState<string>()
  const go = async (key: string, patch: { gainDb?: number; at?: number; remove?: boolean }, label: string) => {
    setBusy(key)
    const outcome = await card.run({ op: { op: 'layer', layerId: layer.id, ...patch }, label })
    setBusy(undefined)
    if (outcome.ok) onDone()
  }
  const row = `${actionButton} w-full text-left`
  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="truncate font-medium">{layer.label}</p>
        <p className="text-[11px] text-muted">
          {LAYER_KIND[layer.kind] ?? 'Sound'} · {formatClock(layer.start)}–{formatClock(layer.end)}
        </p>
      </div>
      <GainSlider value={gain} onChange={setGain} min={-30} max={12} />
      <button
        type="button"
        disabled={!!busy || gain === Math.round(layer.gainDb)}
        onClick={() => void go('gain', { gainDb: gain }, 'Layer volume')}
        className={row}
      >
        {busy === 'gain' ? 'Creating version…' : 'Change the volume'}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void go('move', { at: Math.round(player.getTime() * 100) / 100 }, 'Move the layer')}
        className={row}
      >
        {busy === 'move' ? 'Creating version…' : `Move to the playhead (${formatClock(player.getTime())})`}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void go('remove', { remove: true }, 'Remove the layer')}
        className={`${row} text-muted hover:text-danger`}
      >
        {busy === 'remove' ? 'Creating version…' : 'Remove the layer'}
      </button>
      <p className="text-[11px] text-muted">Free – every change becomes a new version.</p>
      <PlanNotes error={card.error} />
    </div>
  )
}
