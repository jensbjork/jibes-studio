import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type Ref,
  type RefObject,
  type WheelEvent
} from 'react'
import type { Asset, AssetKind, BoardImageSource, FinishedWork, RunningWork, Still, Storyboard } from '@shared/types'
import { isStillDrag, stillIdFromDrop } from '../images/StillThumb'
import { useReorder } from '../pickers/useReorder'
import { PlusIcon } from '../sequences/icons'
import type { FlushRegistry } from '../sequences/useDraft'
import type { SegmentNews } from '../takes/takeText'
import BoardCard, { CARD_HEADER_HEIGHT, CARD_MIN_WIDTH, CARD_NOTE_HEIGHT } from './BoardCard'
import { acceptsImageDrag, droppedImagePaths, DROP_ONLY_IMAGES } from './BoardImage'
import { fitBox, transitionBetween } from './storyboardUtils'
import TransitionConnector, { CONNECTOR_WIDTH } from './TransitionConnector'
import type { StoryboardStore } from './useStoryboard'

/** Private drag type of a board being reordered (lower case: browsers lower-case drag types). */
const BOARD_DRAG_TYPE = 'application/x-studio-board'

/**
 * The pictures are as large as the window allows two boards and the clip between them to be seen side by side –
 * the "from this picture to that one" the storyboard is about – within these bounds.
 */
const IMAGE_MIN_WIDTH = 240
const IMAGE_MAX_WIDTH = 560
const IMAGE_MIN_HEIGHT = 150
const IMAGE_MAX_HEIGHT = 420
/** Before the window has been measured. */
const IMAGE_DEFAULT_WIDTH = 360
/** The row's own padding: beside (px-6) and above and below the cards, and the room a horizontal scrollbar takes. */
const ROW_PADDING_X = 24
const ROW_PADDING_Y = 28
const SCROLLBAR = 12
/** The column before the first board, with its + . */
const LEAD_WIDTH = 44

interface Props {
  storyboard: Storyboard
  store: StoryboardStore
  flushers: FlushRegistry
  /** This storyboard's own pictures, newest first. */
  stills: Still[]
  assets: Asset[]
  /** Boards whose picture is being changed. */
  busyBoards: Record<string, boolean>
  /** ffmpeg is installed (a frame of a clip can be saved as a picture). */
  ffmpegOk: boolean
  /** The transition open in the editor. */
  editorId?: string
  /** Transitions being sent to Venice right now. */
  submitting: Record<string, boolean>
  /** Per transition: its takes that finished or failed and haven't been looked at (Activity). */
  news: Map<string, SegmentNews>
  /** What finished in this storyboard and hasn't been looked at: new and failed board pictures among it. */
  unseen: FinishedWork[]
  /** What runs in this storyboard now: board pictures being made, takes being sent. */
  running: RunningWork[]
  /** A board to light up for a moment (a link pointed at it); `n` repeats it. */
  flash?: { boardId: string; n: number }
  /** A board is being added. */
  adding: boolean
  /**
   * The width the pictures are sized for: the room the row has without the transition editor, so opening the
   * editor doesn't shrink every picture. 0 while unknown.
   */
  fitWidth: number
  /** Scrolled into view when it appears (a board just added, a transition opened from a message). */
  reveal?: string
  onRevealed: () => void
  onSetImage: (boardId: string, source: BoardImageSource | null) => void
  onCreateImage: (boardId: string) => void
  onPickFrame: (boardId: string) => void
  /** One of the storyboard's pictures full size, opened from this board's menu (where "Use on board" puts it). */
  onViewStill: (boardId: string, still: Still) => void
  onDeleteBoard: (boardId: string) => void
  /** False when the move waits for the user's yes (it would remove transitions with work in them). */
  onMoveBoard: (boardId: string, toIndex: number) => boolean
  /** A new board: before or after another one (none: at the end), with a picture when one was dropped. */
  onAddBoard: (init: { afterBoardId?: string; beforeBoardId?: string; image?: BoardImageSource }) => void
  /** Several pictures dropped on "New board": a new board for each, in order. */
  onAddFiles: (paths: string[]) => void
  onOpenTransition: (transitionId: string) => void
  onGenerate: (transitionId: string) => void
  onManage: (kind: AssetKind) => void
  onError: (message: string) => void
}

/**
 * The storyboard's boards as one row of large pictures in film order, with the clip between every two of them
 * on the arrow that joins them, from the top of the view. Scrolls sideways (also with an ordinary scroll wheel); the
 * pictures are as large as two boards and the clip between them side by side allow, within the window's height.
 * ← / → go along the row, board – clip – board; boards are reordered by dragging or with ⌥← / ⌥→ (useReorder); +
 * before and between them (on hover) and "New board" after them add one, and pictures dropped on "New board" become
 * new boards.
 */
export default function BoardRow({
  storyboard,
  store,
  flushers,
  stills,
  assets,
  busyBoards,
  ffmpegOk,
  editorId,
  submitting,
  news,
  unseen,
  running,
  flash,
  adding,
  fitWidth,
  reveal,
  onRevealed,
  onSetImage,
  onCreateImage,
  onPickFrame,
  onViewStill,
  onDeleteBoard,
  onMoveBoard,
  onAddBoard,
  onAddFiles,
  onOpenTransition,
  onGenerate,
  onManage,
  onError
}: Props) {
  const boards = storyboard.boards
  const scroller = useRef<HTMLDivElement>(null)
  const height = useOuterHeight(scroller)
  const imageHeight = Math.max(
    IMAGE_MIN_HEIGHT,
    Math.min(IMAGE_MAX_HEIGHT, height - CARD_HEADER_HEIGHT - CARD_NOTE_HEIGHT - 2 * ROW_PADDING_Y - SCROLLBAR)
  )
  const twoBoards = Math.floor((fitWidth - 2 * ROW_PADDING_X - LEAD_WIDTH - CONNECTOR_WIDTH - SCROLLBAR) / 2)
  const imageWidth =
    fitWidth > 0 ? Math.max(IMAGE_MIN_WIDTH, Math.min(IMAGE_MAX_WIDTH, twoBoards)) : IMAGE_DEFAULT_WIDTH
  const image = fitBox(storyboard.aspectRatio, imageWidth, imageHeight)

  // Board pictures from Activity: one being made (also after its dialog closed, or by an agent), and one that
  // couldn't be made. A take on its way to Venice counts as being made for its transition.
  const boardWork = useMemo(() => {
    const making = new Set<string>()
    const sending = new Set<string>()
    for (const w of running) {
      if (w.kind === 'still' && w.target?.boardId) making.add(w.target.boardId)
      if (w.kind === 'sending' && w.segmentId) sending.add(w.segmentId)
    }
    const failures = new Map<string, FinishedWork>()
    for (const w of unseen) {
      const boardId = w.target.boardId
      if (w.failureOf === 'still' && boardId && !failures.has(boardId)) failures.set(boardId, w)
    }
    return { making, sending, failures }
  }, [running, unseen])

  // Whether the last move waits for the user's yes, so a screen reader isn't told it happened.
  const moveAsked = useRef(false)
  const reorder = useReorder({
    type: BOARD_DRAG_TYPE,
    keys: boards.map((b) => b.id),
    onMove: (from, to) => {
      moveAsked.current = !onMoveBoard(boards[from].id, to)
    },
    describeMove: (from, to) =>
      moveAsked.current ? '' : `Board ${from + 1} is now board ${to + 1} of ${boards.length}.`
  })

  // ── Scrolling things into view, and the focus along the row ───────────────

  const elements = useRef(new Map<string, HTMLElement>())
  const track = (id: string) => (el: HTMLElement | null) => {
    if (el) elements.current.set(id, el)
    else elements.current.delete(id)
  }

  /**
   * Scrolls the row – only the row: scrollIntoView would move the window too – so `el` is in view: not at all when
   * it already is, otherwise centred.
   */
  const scrollToShow = (el: HTMLElement) => {
    const box = scroller.current
    if (!box) return
    const r = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (r.left >= b.left && r.right <= b.right) return
    const left = box.scrollLeft + r.left - b.left - (box.clientWidth - r.width) / 2
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    box.scrollTo({ left: Math.max(0, left), behavior: still ? 'auto' : 'smooth' })
  }

  useEffect(() => {
    if (!reveal) return
    const el = elements.current.get(reveal)
    if (!el) return
    scrollToShow(el)
    onRevealed()
  })

  // ← / → from a board or a clip: the next one along the row, board – clip – board (a clip that main hasn't made
  // for a new order yet is skipped).
  const order = boards.flatMap((b, i) => {
    const t = i < boards.length - 1 ? transitionBetween(storyboard, b.id, boards[i + 1].id) : undefined
    return t ? [b.id, t.id] : [b.id]
  })
  const focusAlong = (from: string, dir: -1 | 1) => {
    const id = order[order.indexOf(from) + dir]
    const tracked = id ? elements.current.get(id) : undefined
    // A clip's tracked element is its wrapper; the card in it takes the focus.
    const el = tracked?.tabIndex === 0 ? tracked : tracked?.querySelector<HTMLElement>('[tabindex="0"]')
    if (!el) return
    el.focus({ preventScroll: true })
    scrollToShow(el)
  }

  /** An ordinary (vertical) scroll wheel scrolls the row sideways, since it has nothing to scroll up and down. */
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollHeight > el.clientHeight + 1) return
    if ((e.target as HTMLElement).closest('textarea')) return
    el.scrollLeft += e.deltaY
  }

  // ── Drops on the row: boards being reordered ───────────────────────────────

  const onDragOver = (e: DragEvent) => {
    reorder.onDragOver(e)
  }
  const onDrop = (e: DragEvent) => {
    reorder.onDrop(e)
  }

  return (
    <div
      ref={scroller}
      onWheel={onWheel}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={reorder.onDragLeave}
      // relative: the row's sr-only and absolute parts are placed (and clipped) in it, not in the window.
      className="relative min-h-0 flex-1 overflow-auto"
    >
      {/* From the top, under the header (as the Sequences strip): the pictures are sized by the width. */}
      <div className="flex min-h-full w-max items-start" style={{ paddingBlock: ROW_PADDING_Y, paddingInline: ROW_PADDING_X }}>
        <div className="flex items-start">
          {/* Before the first board: + to add one there, and the drop marker for gap 0. */}
          <div
            className="group/lead relative flex shrink-0 items-center justify-center"
            style={{ width: LEAD_WIDTH, height: image.height, marginTop: CARD_HEADER_HEIGHT }}
          >
            {reorder.gap === 0 && <DropMarker />}
            {boards.length > 0 && (
              <button
                type="button"
                onClick={() => onAddBoard({ beforeBoardId: boards[0].id })}
                disabled={adding}
                title="Add a board at the start"
                aria-label="Add a board at the start"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-muted opacity-0 transition hover:border-muted hover:text-text focus-visible:opacity-100 group-hover/lead:opacity-100 disabled:opacity-0"
              >
                <PlusIcon size={11} />
              </button>
            )}
          </div>

          {boards.map((board, i) => {
            const next = boards[i + 1]
            const transition = next ? transitionBetween(storyboard, board.id, next.id) : undefined
            const item = reorder.itemProps(i)
            const itemRef = item.ref as (el: HTMLElement | null) => void
            const tracked: Ref<HTMLElement> = (el) => {
              itemRef(el)
              track(board.id)(el)
            }
            return (
              <Fragment key={board.id}>
                <BoardCard
                  board={board}
                  number={i + 1}
                  count={boards.length}
                  imageWidth={image.width}
                  imageHeight={image.height}
                  stills={stills}
                  assets={assets}
                  busy={!!busyBoards[board.id]}
                  making={boardWork.making.has(board.id)}
                  failure={boardWork.failures.get(board.id)}
                  flash={flash?.boardId === board.id ? flash.n : undefined}
                  ffmpegOk={ffmpegOk}
                  store={store}
                  flushers={flushers}
                  dragging={reorder.dragging === i}
                  item={{ ...item, ref: tracked }}
                  onSetImage={(source) => onSetImage(board.id, source)}
                  onCreateImage={() => onCreateImage(board.id)}
                  onPickFrame={() => onPickFrame(board.id)}
                  onViewStill={(still) => onViewStill(board.id, still)}
                  onManage={onManage}
                  onDelete={() => onDeleteBoard(board.id)}
                  onError={onError}
                  onArrow={(dir) => focusAlong(board.id, dir)}
                />
                {next && (
                  <div ref={transition ? track(transition.id) : undefined} className="shrink-0">
                    <TransitionConnector
                      storyboard={storyboard}
                      transition={transition}
                      height={image.height}
                      offsetTop={CARD_HEADER_HEIGHT}
                      selected={!!transition && transition.id === editorId}
                      submitting={!!transition && (!!submitting[transition.id] || boardWork.sending.has(transition.id))}
                      news={transition ? news.get(transition.id) : undefined}
                      dropHere={reorder.gap === i + 1}
                      adding={adding}
                      onOpen={() => transition && onOpenTransition(transition.id)}
                      onGenerate={() => transition && onGenerate(transition.id)}
                      onInsert={() => onAddBoard({ afterBoardId: board.id })}
                      onArrow={(dir) => transition && focusAlong(transition.id, dir)}
                    />
                  </div>
                )}
              </Fragment>
            )
          })}

          <div className="relative shrink-0" style={{ width: 28, height: image.height, marginTop: CARD_HEADER_HEIGHT }}>
            {reorder.gap === boards.length && boards.length > 0 && <DropMarker />}
          </div>
          <AddCard
            width={Math.max(CARD_MIN_WIDTH, image.width)}
            height={image.height}
            first={boards.length === 0}
            adding={adding}
            onAdd={() => onAddBoard({})}
            onAddStill={(stillId) => onAddBoard({ image: { kind: 'still', stillId } })}
            onAddFiles={onAddFiles}
            onError={onError}
          />
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>
    </div>
  )
}

function DropMarker() {
  return <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent" aria-hidden />
}

/** "New board" after the last board, as large as a board's picture; pictures dropped on it become new boards. */
function AddCard({
  width,
  height,
  first,
  adding,
  onAdd,
  onAddStill,
  onAddFiles,
  onError
}: {
  width: number
  height: number
  first: boolean
  adding: boolean
  onAdd: () => void
  onAddStill: (stillId: string) => void
  onAddFiles: (paths: string[]) => void
  onError: (message: string) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div className="shrink-0" style={{ width, paddingTop: CARD_HEADER_HEIGHT }}>
      <button
        type="button"
        onClick={onAdd}
        disabled={adding}
        onDragOver={(e) => {
          if (!acceptsImageDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
          setOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={(e) => {
          if (!acceptsImageDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          if (isStillDrag(e)) {
            const stillId = stillIdFromDrop(e)
            if (stillId) onAddStill(stillId)
            return
          }
          const { paths, other } = droppedImagePaths(e)
          if (paths.length) onAddFiles(paths)
          if (other) {
            onError(paths.length ? 'Only the images were added – drop JPG, PNG or WebP files.' : DROP_ONLY_IMAGES)
          }
        }}
        title="Add a board at the end – or drop one or more images here, and each image becomes a new board"
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted transition hover:border-muted hover:text-text disabled:opacity-40 ${
          over ? 'border-accent bg-accent/5 text-text' : 'border-line'
        }`}
        style={{ height }}
      >
        <PlusIcon size={18} />
        <span>{first ? 'First board' : 'New board'}</span>
        <span className="text-[11px] text-muted">or drop images here</span>
      </button>
    </div>
  )
}

/**
 * The element's outer height, kept up to date as the window changes. Outer, scrollbar included: the pictures'
 * size follows from it, and a height that shrank when a scrollbar appeared could make the scrollbar go away
 * again, and so on.
 */
function useOuterHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setHeight(el.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return height
}
