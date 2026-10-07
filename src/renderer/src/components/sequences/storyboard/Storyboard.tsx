import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject
} from 'react'
import type {
  AssetKind,
  ConsentRequest,
  Generation,
  SegmentImageSlot,
  SegmentImageSource,
  Sequence,
  Still,
  VideoModel
} from '@shared/types'
import { ASSET_VIEW } from '../../../lib/assets'
import { ipcErrorMessage, useAssets } from '../../../lib/hooks'
import { formatUsd } from '../../../lib/media'
import type { Navigate } from '../../../lib/navigation'
import ConsentDialog from '../../ConsentDialog'
import CreateImageDialog from '../../images/CreateImageDialog'
import FramePickerDialog from '../../images/FramePickerDialog'
import { useStills } from '../../images/imageModels'
import { GridIcon, PlusIcon } from '../icons'
import { clipKey, effectiveParams, parseConsent } from '../sequenceUtils'
import { SEGMENT_DRAG_TYPE } from '../Timeline'
import type { FlushRegistry } from '../useDraft'
import type { SequenceStore } from '../useSequence'
import { useClipQuote } from '../useTotalQuote'
import { sequenceAspect, slotSize } from './slots'
import StillsStrip from './StillsStrip'
import StoryboardPanel from './StoryboardPanel'

interface Props {
  sequence: Sequence
  store: SequenceStore
  models: VideoModel[]
  modelsError?: string
  ffmpegOk: boolean
  /** The clip selected in the sequence (shared with the timeline). */
  selectedId?: string
  adding: boolean
  flushers: FlushRegistry
  /** Saves every open draft, so main acts on what is on screen. Resolves false if a save failed. */
  flushAll: () => Promise<boolean>
  navigate: Navigate
  /** The segment editor, shown beside the panels while it is open. */
  editor?: ReactNode
  onSelect: (segmentId: string) => void
  /** Opens the clip in the editor beside the panels. */
  onEdit: (segmentId: string) => void
  /** Adds a clip after the given one, or at the end. */
  onAdd: (afterSegmentId?: string) => void
  onMove: (segmentId: string, toIndex: number) => void
  onBridge: (segmentId: string) => Promise<void>
  /** Shows the clip in the timeline, where its takes and trims are. */
  onShowTakes: (segmentId: string) => void
  onPreviewFrom: (segmentId: string) => void
  onError: (message: string) => void
}

/** Where a dialog was opened from: a panel's slot, or the stills strip (no slot). */
interface DialogTarget {
  segmentId?: string
  slot?: SegmentImageSlot
}

interface Drop {
  /** Gap g sits before panel g (g = count is after the last one). */
  gap: number
  /** The panel the indicator is drawn on, and on which side. */
  at: number
  side: 'before' | 'after'
}

/** A slot is never narrower than this (16:9), so a panel's pictures stay readable; panels per row follow from it. */
const SLOT_MIN_WIDTH = 160
const SLOT_MAX_WIDTH = 300
const SLOT_MAX_HEIGHT = 170
/** Arrow column, the gaps beside it, the panel's padding and border. */
const PANEL_CHROME = 48 + 8 + 24 + 2
const GAP_X = 24
const GRID_PADDING_X = 24
const EDITOR_WIDTH = 360
/** Below this, the editor beside the panels would leave no room for one: it then lies over them instead. */
const MIN_GRID_WIDTH = SLOT_MIN_WIDTH * 2 + PANEL_CHROME + 2 * GRID_PADDING_X

/**
 * How many panels fit side by side in the grid's width, and how large their slots can be: the slots grow with the
 * panels, so a wide window shows bigger pictures rather than empty space.
 */
function gridLayout(width: number, aspect: string): { columns: number; slot: { width: number; height: number } } {
  const minPanel = SLOT_MIN_WIDTH * 2 + PANEL_CHROME
  const columns = Math.max(1, Math.floor((width + GAP_X) / (minPanel + GAP_X)))
  const panel = width > 0 ? (width - GAP_X * (columns - 1)) / columns : minPanel
  const slotWidth = Math.max(SLOT_MIN_WIDTH, Math.min(SLOT_MAX_WIDTH, Math.floor((panel - PANEL_CHROME) / 2)))
  return { columns, slot: slotSize(aspect, slotWidth, SLOT_MAX_HEIGHT) }
}

/** The inner width of an element (without its scrollbar), kept up to date as the window or the editor column change. */
function useInnerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * The sequence as a storyboard: one panel per clip with its start and end images, notes and take, in cut order;
 * new panels between or after the others, reordering by drag, and the sequence's stills along the bottom. The
 * clip editor opens beside the panels.
 */
export default function Storyboard({
  sequence,
  store,
  models,
  modelsError,
  ffmpegOk,
  selectedId,
  adding,
  flushers,
  flushAll,
  navigate,
  editor,
  onSelect,
  onEdit,
  onAdd,
  onMove,
  onBridge,
  onShowTakes,
  onPreviewFrom,
  onError
}: Props) {
  const segments = sequence.segments
  const assets = useAssets()
  const { stills, loaded: stillsLoaded } = useStills(sequence.id)
  const outer = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const editorOverlays = useInnerWidth(outer) - EDITOR_WIDTH < MIN_GRID_WIDTH
  // The grid's own side padding (px-6) is not room for panels.
  const { columns, slot } = gridLayout(Math.max(0, useInnerWidth(scroller) - 2 * GRID_PADDING_X), sequenceAspect(sequence))

  const [submitting, setSubmitting] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [busySlots, setBusySlots] = useState<Record<string, SegmentImageSlot | undefined>>({})
  // Venice's terms for a model, with the clip as it was when it asked: accepting generates only that clip.
  const [consent, setConsent] = useState<{ request: ConsentRequest; segmentId: string; clip: string }>()
  const [createFor, setCreateFor] = useState<DialogTarget>()
  const [frameFor, setFrameFor] = useState<DialogTarget>()

  // The latest sequence, for comparing a clip after the consent dialog.
  const latest = useRef(sequence)
  useEffect(() => {
    latest.current = sequence
  })

  // ── Panels ─────────────────────────────────────────────────────────────────

  const panels = useRef(new Map<string, HTMLElement>())
  // A click in a panel selects it; only a selection made elsewhere (the timeline, an agent) scrolls to it, so a
  // panel never moves under the pointer between mousedown and click.
  const selectedHere = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!selectedId || selectedHere.current === selectedId) return
    panels.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])
  const select = (id: string) => {
    selectedHere.current = id
    onSelect(id)
  }

  const setImage = async (segmentId: string, slotName: SegmentImageSlot, source: SegmentImageSource | null) => {
    setBusySlots((m) => ({ ...m, [segmentId]: slotName }))
    try {
      // The editor may have unsaved typing for this clip; save it first so main changes the clip as it is now.
      await flushAll()
      await store.mutate(() => window.studio.setSegmentImage(segmentId, slotName, source))
    } catch (e) {
      onError(ipcErrorMessage(e))
      store.refresh()
    } finally {
      setBusySlots((m) => ({ ...m, [segmentId]: undefined }))
    }
  }

  const generate = async (segmentId: string) => {
    if (submitting[segmentId]) return
    setSubmitting((m) => ({ ...m, [segmentId]: true }))
    setErrors((m) => ({ ...m, [segmentId]: undefined }))
    try {
      // main generates from the stored clip, so open drafts (the editor, notes) must be saved first.
      if (!(await flushAll())) throw new Error('Ändringarna kunde inte sparas. Försök igen.')
      store.addTake(await window.studio.generateSegment(segmentId))
    } catch (e) {
      const message = ipcErrorMessage(e)
      const request = parseConsent(message)
      const index = latest.current.segments.findIndex((s) => s.id === segmentId)
      if (request && index !== -1) setConsent({ request, segmentId, clip: clipKey(latest.current, index) })
      else setErrors((m) => ({ ...m, [segmentId]: message }))
    } finally {
      setSubmitting((m) => ({ ...m, [segmentId]: false }))
    }
  }

  const acceptConsent = async () => {
    if (!consent) return
    const { request, segmentId, clip } = consent
    setConsent(undefined)
    try {
      await window.studio.acceptConsent(request.flow, request.version)
    } catch (e) {
      setErrors((m) => ({ ...m, [segmentId]: ipcErrorMessage(e) }))
      return
    }
    // The clip may have changed while the terms were shown (an agent can edit it): then nothing is sent until the
    // user has looked at it again and pressed the button, which shows the price.
    const index = latest.current.segments.findIndex((s) => s.id === segmentId)
    if (index === -1 || clipKey(latest.current, index) !== clip) {
      setErrors((m) => ({
        ...m,
        [segmentId]: 'Klippet ändrades medan villkoren visades. Kontrollera det och tryck på Generera tagning igen.'
      }))
      return
    }
    await generate(segmentId)
  }
  const consentIndex = consent ? segments.findIndex((s) => s.id === consent.segmentId) : -1
  const consentQuote = useClipQuote(consentIndex === -1 ? undefined : effectiveParams(segments[consentIndex], consentIndex))

  const deleteSegment = async (segmentId: string) => {
    try {
      await store.mutate(() => window.studio.deleteSegment(segmentId))
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  const chooseTake = (segmentId: string, take: Generation) => {
    store.patchSegment(segmentId, { selectedGenerationId: take.id }).catch((e: unknown) => onError(ipcErrorMessage(e)))
  }

  const bridge = (segmentId: string) => {
    selectedHere.current = segmentId
    void onBridge(segmentId)
  }

  // ── Reordering by drag ─────────────────────────────────────────────────────

  const [dragId, setDragId] = useState<string>()
  const [drop, setDrop] = useState<Drop>()
  const dragFrom = dragId ? segments.findIndex((s) => s.id === dragId) : -1

  /** The gap nearest the pointer: beside the closest panel, on the side the pointer is on. */
  const dropAt = (x: number, y: number): Drop | undefined => {
    let best: { i: number; d: number; r: DOMRect } | undefined
    segments.forEach((s, i) => {
      const r = panels.current.get(s.id)?.getBoundingClientRect()
      if (!r) return
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
      const d = dx * dx + dy * dy
      if (!best || d < best.d) best = { i, d, r }
    })
    if (!best) return undefined
    const after = x > best.r.left + best.r.width / 2
    return { gap: after ? best.i + 1 : best.i, at: best.i, side: after ? 'after' : 'before' }
  }

  const onDragOver = (e: DragEvent) => {
    if (dragFrom === -1) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const target = dropAt(e.clientX, e.clientY)
    // Dropping right before or after itself changes nothing, so don't suggest it.
    setDrop(!target || target.gap === dragFrom || target.gap === dragFrom + 1 ? undefined : target)
  }

  const onDrop = (e: DragEvent) => {
    if (dragFrom === -1 || !dragId) return
    e.preventDefault()
    const target = dropAt(e.clientX, e.clientY)
    if (target) {
      const to = target.gap > dragFrom ? target.gap - 1 : target.gap
      if (to !== dragFrom) onMove(dragId, to)
    }
    setDragId(undefined)
    setDrop(undefined)
  }

  const manage = useCallback((kind: AssetKind) => navigate(ASSET_VIEW[kind]), [navigate])

  // ── Dialog targets ─────────────────────────────────────────────────────────

  const createTarget = createFor?.segmentId ? segments.findIndex((s) => s.id === createFor.segmentId) : -1
  const createSegment = createTarget === -1 ? undefined : segments[createTarget]
  const frameTarget = frameFor?.segmentId ? segments.findIndex((s) => s.id === frameFor.segmentId) : -1
  // A start image is usually a frame from the clip before (its end), an end image one from the clip after (its start).
  const frameSource =
    frameTarget === -1
      ? undefined
      : frameFor?.slot === 'start'
        ? (segments[frameTarget - 1] ?? segments[frameTarget])
        : frameFor?.slot === 'end'
          ? (segments[frameTarget + 1] ?? segments[frameTarget])
          : segments[frameTarget]
  const selectedIndex = selectedId ? segments.findIndex((s) => s.id === selectedId) : -1

  return (
    <div ref={outer} className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(undefined)
          }}
        >
          {segments.length === 0 ? (
            <EmptyStoryboard adding={adding} onAdd={() => onAdd()} />
          ) : (
            <div
              className="grid items-stretch gap-y-5 py-5"
              style={{
                columnGap: GAP_X,
                paddingInline: GRID_PADDING_X,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
              }}
            >
              {segments.map((s, i) => (
                <StoryboardPanel
                  key={s.id}
                  sequence={sequence}
                  segment={s}
                  index={i}
                  selected={s.id === selectedId}
                  models={models}
                  modelsError={modelsError}
                  stills={stills}
                  assets={assets}
                  ffmpegOk={ffmpegOk}
                  slotWidth={slot.width}
                  slotHeight={slot.height}
                  store={store}
                  flushers={flushers}
                  submitting={!!submitting[s.id]}
                  error={errors[s.id]}
                  busySlot={busySlots[s.id]}
                  dragging={s.id === dragId}
                  dropSide={drop?.at === i ? drop.side : undefined}
                  adding={adding}
                  panelRef={(el) => {
                    if (el) panels.current.set(s.id, el)
                    else panels.current.delete(s.id)
                  }}
                  onSelect={() => select(s.id)}
                  onEdit={() => {
                    selectedHere.current = s.id
                    onEdit(s.id)
                  }}
                  onGenerate={() => void generate(s.id)}
                  onBridge={() => bridge(s.id)}
                  onShowTakes={() => onShowTakes(s.id)}
                  onPreview={() => onPreviewFrom(s.id)}
                  onAddAfter={() => onAdd(s.id)}
                  onDelete={() => void deleteSegment(s.id)}
                  onDismissError={() => setErrors((m) => ({ ...m, [s.id]: undefined }))}
                  onUseTake={(take) => chooseTake(s.id, take)}
                  onSetImage={(slotName, source) => void setImage(s.id, slotName, source)}
                  onCreateImage={(slotName) => setCreateFor({ segmentId: s.id, slot: slotName })}
                  onPickFrame={(slotName) => setFrameFor({ segmentId: s.id, slot: slotName })}
                  onManage={manage}
                  onError={onError}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    // A private type, so dropping a panel on a text field doesn't paste anything.
                    e.dataTransfer.setData(SEGMENT_DRAG_TYPE, s.id)
                    setDragId(s.id)
                  }}
                  onDragEnd={() => {
                    setDragId(undefined)
                    setDrop(undefined)
                  }}
                />
              ))}
              <button
                type="button"
                onClick={() => onAdd()}
                disabled={adding}
                title="Lägg till en ruta sist"
                className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line py-10 text-muted transition hover:border-muted hover:text-text disabled:opacity-40"
              >
                <PlusIcon size={18} />
                Ny ruta
              </button>
            </div>
          )}
        </div>

        <StillsStrip
          stills={stills}
          loaded={stillsLoaded}
          target={selectedIndex === -1 ? undefined : { segmentId: segments[selectedIndex].id, number: selectedIndex + 1 }}
          onCreateImage={() => setCreateFor({})}
          onPickFrame={() => setFrameFor({ segmentId: selectedId })}
          onAssign={(segmentId, slotName, still) => void setImage(segmentId, slotName, { kind: 'still', stillId: still.id })}
          onError={onError}
        />
      </div>

      {editor && (
        <section
          className={`flex shrink-0 flex-col border-l border-line ${
            editorOverlays ? 'absolute inset-y-0 right-0 z-20 bg-bg shadow-2xl shadow-black/60' : ''
          }`}
          style={{ width: EDITOR_WIDTH }}
        >
          {editor}
        </section>
      )}

      <CreateImageDialog
        open={!!createFor}
        sequenceId={sequence.id}
        initialPrompt={createSegment ? createSegment.params.prompt.trim() || createSegment.notes : undefined}
        assign={createFor?.segmentId && createFor.slot ? { segmentId: createFor.segmentId, slot: createFor.slot } : undefined}
        onClose={() => setCreateFor(undefined)}
        onAssigned={(updated) => void store.mutate(() => Promise.resolve(updated))}
        navigate={navigate}
      />
      <FramePickerDialog
        open={!!frameFor}
        sequenceId={sequence.id}
        segment={frameSource}
        at={frameFor?.slot === 'start' ? 'end' : 'start'}
        onClose={() => setFrameFor(undefined)}
        onPicked={(still: Still) => {
          const target = frameFor
          setFrameFor(undefined)
          if (target?.segmentId && target.slot) void setImage(target.segmentId, target.slot, { kind: 'still', stillId: still.id })
        }}
      />
      {consent && (
        <ConsentDialog
          request={consent.request}
          cost={`klipp ${consentIndex + 1} · ${formatUsd(consentQuote)}`}
          onAccept={() => void acceptConsent()}
          onCancel={() => setConsent(undefined)}
        />
      )}
    </div>
  )
}

function EmptyStoryboard({ adding, onAdd }: { adding: boolean; onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <GridIcon size={28} className="mx-auto mb-4 text-muted" />
        <h2 className="mb-2 text-base font-semibold">Planera filmen ruta för ruta</h2>
        <p className="mb-5 leading-relaxed text-muted">
          Varje ruta blir ett klipp. Sätt en startbild – och gärna en slutbild – och skriv vad som händer. Klippen
          genereras sedan från bilderna, så att du bestämmer hur varje scen börjar och slutar.
        </p>
        <button
          onClick={onAdd}
          disabled={adding}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
        >
          <PlusIcon size={13} />
          Första rutan
        </button>
      </div>
    </div>
  )
}
