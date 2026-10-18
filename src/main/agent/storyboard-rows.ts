import type { SequenceKind } from '@shared/types'
import { fromStoredPath } from '../paths'
import * as store from '../sequence-store'
import { getBoardRow, listBoardRows } from '../storyboards'

// Storyboards are stored as sequences of kind 'storyboard': their transitions are segments, their boards rows of
// storyboard_boards. The agent tools need a few answers synchronously – which kind an id is, which storyboard a
// board belongs to, which two boards a transition joins – for messages that point an agent at the right tools,
// and for the guards that run right before a paid take is sent (which can't wait for a service call).

/** What a row of `sequences` is, or undefined when there is none. */
export function sequenceKind(id: string): SequenceKind | undefined {
  const row = typeof id === 'string' && id ? store.getSequenceRow(id) : undefined
  return row ? store.kindOf(row) : undefined
}

export const isStoryboardId = (id: string | undefined): boolean => !!id && sequenceKind(id) === 'storyboard'

/** The storyboard a board belongs to; undefined when the board is gone. */
export function storyboardOfBoard(boardId: string): string | undefined {
  return getBoardRow(boardId)?.sequence_id
}

/** A board's picture right now, as Studio shows it (Storyboard.boards[].imagePath); undefined when it has none. */
export function boardImagePath(boardId: string): string | undefined {
  const stored = getBoardRow(boardId)?.image_path
  return stored ? fromStoredPath(stored) : undefined
}

/** A board's 0-based place among its storyboard's boards right now; -1 when it is gone. */
export function boardIndex(boardId: string): number {
  const storyboardId = storyboardOfBoard(boardId)
  return storyboardId ? listBoardRows(storyboardId).findIndex((b) => b.id === boardId) : -1
}

/** The two boards a transition (a segment of a storyboard) goes between, as its row says now. */
export function transitionPair(segmentId: string): { from?: string; to?: string } | undefined {
  const row = store.getSegmentRow(segmentId)
  return row ? { from: row.from_board_id ?? undefined, to: row.to_board_id ?? undefined } : undefined
}

/** Says that a storyboard id was given to a tool for sequences, and which tool to use instead. */
export function storyboardNotSequence(instead: string): Error {
  return new Error(
    `This is a storyboard, not a sequence: storyboards have their own tools. Use ${instead} (list_storyboards lists every storyboard).`
  )
}
