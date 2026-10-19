import { useCallback, useEffect, useId, useRef, type HTMLAttributes, type KeyboardEvent, type Ref } from 'react'
import type { Asset, AssetKind, BoardImageSource, FinishedWork, Still, StoryboardBoard } from '@shared/types'
import { shortcut } from '../../lib/platform'
import ConfirmButton from '../sequences/ConfirmButton'
import { CloseIcon } from '../sequences/icons'
import { useDraft, useRegisterFlush, type FlushRegistry } from '../sequences/useDraft'
import BoardImage from './BoardImage'
import type { StoryboardStore } from './useStoryboard'

/** Height of a card's top line (number, badges, remove); the connectors line up with the picture below it. */
export const CARD_HEADER_HEIGHT = 30
/** What the note under the picture takes (two lines and the gap above it). */
export const CARD_NOTE_HEIGHT = 66
/** Cards are never narrower than this, so a tall picture still has room for its note and the remove button. */
export const CARD_MIN_WIDTH = 236

interface Props {
  board: StoryboardBoard
  /** 1-based. */
  number: number
  count: number
  imageWidth: number
  imageHeight: number
  stills: Still[]
  assets: Asset[]
  busy: boolean
  /** Its picture is being made (Create image, also after the dialog closed, or an agent's request). */
  making: boolean
  /** Its picture couldn't be made, not seen yet. */
  failure?: FinishedWork
  /** Light up for a moment (a link pointed at this board); a new number lights it up again. */
  flash?: number
  /** ffmpeg is installed (see BoardImage). */
  ffmpegOk: boolean
  store: StoryboardStore
  flushers: FlushRegistry
  /** Being dragged to another place (shown faded). */
  dragging: boolean
  /** The reorder hook's props for this card: its place on screen, dragging, ⌥← / ⌥→. */
  item: HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> }
  onSetImage: (source: BoardImageSource | null) => void
  onCreateImage: () => void
  onPickFrame: () => void
  onViewStill: (still: Still) => void
  onManage: (kind: AssetKind) => void
  onDelete: () => void
  onError: (message: string) => void
}

/**
 * One board: a milestone of the film as one large picture and a short note of what it shows. Dragged by its
 * picture or top line, or moved with ⌥← / ⌥→ while it (or something in it other than the note) has focus.
 */
export default function BoardCard({
  board,
  number,
  count,
  imageWidth,
  imageHeight,
  stills,
  assets,
  busy,
  making,
  failure,
  flash,
  ffmpegOk,
  store,
  flushers,
  dragging,
  item,
  onSetImage,
  onCreateImage,
  onPickFrame,
  onViewStill,
  onManage,
  onDelete,
  onError
}: Props) {
  const { ref, draggable, onDragStart, onDragEnd, onKeyDown, ...rest } = item
  const width = Math.max(CARD_MIN_WIDTH, imageWidth)

  // Pointed at by a link: one soft ring that fades, so the eye finds the board in a long row.
  const card = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (flash === undefined || !card.current) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    card.current.animate(
      [
        { boxShadow: '0 0 0 2px rgba(236, 236, 241, 0.7)' },
        { boxShadow: '0 0 0 2px rgba(236, 236, 241, 0.7)', offset: 0.6 },
        { boxShadow: '0 0 0 2px rgba(236, 236, 241, 0)' }
      ],
      { duration: 1600, easing: 'ease-out' }
    )
  }, [flash])

  // ⌥← / ⌥→ move the board – except in the note, where they move the caret by a word as usual.
  const onCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('textarea, input, select')) return
    onKeyDown?.(e)
  }

  return (
    <div
      ref={(el) => {
        card.current = el
        const forward = ref as Ref<HTMLDivElement>
        if (typeof forward === 'function') forward(el)
        else if (forward) forward.current = el
      }}
      {...rest}
      tabIndex={0}
      onKeyDown={onCardKeyDown}
      role="group"
      aria-roledescription="board"
      aria-label={`Board ${number} of ${count}${board.note ? `: ${board.note}` : ''}`}
      className={`group/card flex shrink-0 flex-col rounded-xl outline-none ring-offset-4 ring-offset-bg transition focus-visible:ring-2 focus-visible:ring-muted ${
        dragging ? 'opacity-40' : ''
      }`}
      style={{ width }}
    >
      <div
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className={`flex flex-col items-center ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <div className="flex w-full items-center gap-2 px-0.5" style={{ height: CARD_HEADER_HEIGHT }}>
          <span
            className="text-[12px] font-medium text-muted"
            title={count > 1 ? shortcut('Drag the image to move the board, or use ⌥← and ⌥→') : undefined}
          >
            Board {number}
          </span>
          <span className="ml-auto" />
          <ConfirmButton
            question="Remove the board?"
            confirmLabel="Remove"
            onConfirm={onDelete}
            title="Remove the board. The transitions to and from it go too, with their prompts; their clips stay in Media."
            className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition hover:bg-raised hover:text-accent focus-visible:opacity-100 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
          >
            <CloseIcon size={11} />
          </ConfirmButton>
        </div>
        <BoardImage
          board={board}
          number={number}
          width={imageWidth}
          height={imageHeight}
          stills={stills}
          assets={assets}
          busy={busy}
          making={making}
          failure={failure}
          ffmpegOk={ffmpegOk}
          onSet={onSetImage}
          onCreateImage={onCreateImage}
          onPickFrame={onPickFrame}
          onViewStill={onViewStill}
          onManage={onManage}
          onError={onError}
        />
      </div>
      <BoardNote board={board} store={store} flushers={flushers} />
    </div>
  )
}

interface Note {
  note: string
}

/**
 * "What does the image show?": the board's note, saved by itself as the user types (a note-only change, so it never
 * touches the picture), and saved right away when the field goes away. The transition prompts' "Suggest" builds
 * on these notes.
 */
function BoardNote({
  board,
  store,
  flushers
}: {
  board: StoryboardBoard
  store: StoryboardStore
  flushers: FlushRegistry
}) {
  const { mutate } = store
  const boardId = board.id
  const save = useCallback(
    (v: Note) => mutate(() => window.studio.updateBoard(boardId, { note: v.note })),
    [mutate, boardId]
  )
  const draft = useDraft<Note>({ note: board.note ?? '' }, save, 700)
  useRegisterFlush(flushers, draft.flush)
  const id = useId()

  return (
    <div className="mt-2.5 w-full">
      <label htmlFor={id} className="sr-only">
        What does the image show?
      </label>
      <textarea
        id={id}
        value={draft.value.note}
        onChange={(e) => draft.setValue({ note: e.target.value })}
        onBlur={() => void draft.flush()}
        placeholder="What does the image show?"
        spellCheck={false}
        rows={2}
        className="block max-h-32 min-h-[3.25rem] w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[12px] leading-snug outline-none transition [field-sizing:content] placeholder:text-muted/60 hover:border-line focus:border-muted focus:bg-raised"
      />
      {draft.error && (
        <p className="mt-0.5 px-2 text-[11px] text-accent" title={draft.error}>
          The note couldn’t be saved
        </p>
      )}
    </div>
  )
}
