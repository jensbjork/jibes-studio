import { useEffect, useState } from 'react'
import type { ApprovalImageRequest, ApprovalRequest, GenerationParams, Storyboard, VideoModel } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { PictureHover } from './ApprovalPictures'

// What the approval dialog shows for a request about a storyboard (ApprovalRequest.sequenceKind 'storyboard'): a
// transition is the clip from one board's picture to the next one's, so the user sees the two pictures side by
// side with the prompt and the settings – and, for a picture an agent wants to make, which board it becomes.
// The storyboard is read live, so the dialog can say before the click what main would refuse.

/** The storyboard a request is about, read live and kept up to date; nothing for other requests. */
export function useStoryboard(id: string | undefined): { storyboard?: Storyboard; error?: string } {
  const [state, setState] = useState<{ id?: string; storyboard?: Storyboard; error?: string }>({})
  useEffect(() => {
    if (!id) return
    let active = true
    const load = () =>
      window.studio.getStoryboard(id).then(
        (storyboard) => active && setState({ id, storyboard }),
        (e: unknown) => active && setState({ id, error: ipcErrorMessage(e) })
      )
    void load()
    const off = window.studio.onStoryboardChange((changed) => {
      if (changed === id) void load()
    })
    return () => {
      active = false
      off()
    }
  }, [id])
  return state.id === id ? state : {}
}

/** One transition as the dialog shows it. */
export interface TransitionView {
  /** The transition's id. */
  key: string
  /** 1-based, as the storyboard has it now (as it was asked for while it is being read). */
  number: number
  from: BoardView
  to: BoardView
  /** What is sent: the first board's picture as start image, the second's as end image. */
  params: GenerationParams
  /** Why it can't be generated as it stands. */
  problem?: string
}

interface BoardView {
  /** 1-based; undefined when the board can't be found. */
  number?: number
  note?: string
}

/** The settings a transition is sent with, apart from its pictures. */
function settingsKey(p: GenerationParams): string {
  return JSON.stringify([p.model, p.prompt.trim(), p.negativePrompt?.trim() ?? '', p.duration, p.resolution ?? '', p.audio ?? null])
}

const samePath = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '').normalize('NFC') === (b ?? '').normalize('NFC')

/**
 * The transitions a storyboard request generates, and why it can't be approved as it stands. One transition
 * ('segment') is shown with exactly what was asked for (its params, both pictures included) and compared with the
 * storyboard as it is now: another picture in a board, or another prompt or setting, makes main refuse it, so the
 * dialog says so first. The missing transitions ('generate-all') are shown as they are now, like a sequence's
 * missing clips; main refuses the request when they are no longer the ones it was made for.
 */
export function storyboardTransitions(
  a: ApprovalRequest,
  storyboard: Storyboard | undefined
): {
  transitions: TransitionView[]
  blocking?: string
  /** `blocking` is a change since the agent asked (the agent has to ask again), not a problem it can fix. */
  lapsed?: boolean
} {
  const boardOf = (id: string | undefined): BoardView => {
    const index = storyboard && id ? storyboard.boards.findIndex((b) => b.id === id) : -1
    return index < 0 ? {} : { number: index + 1, note: storyboard!.boards[index].note }
  }
  if (a.kind === 'segment') {
    const id = a.segmentIds?.[0]
    if (!a.params || !id) return { transitions: [], blocking: 'The request doesn’t say which transition' }
    const index = storyboard ? storyboard.transitions.findIndex((t) => t.id === id) : -1
    const live = index >= 0 ? storyboard!.transitions[index] : undefined
    const number = live ? index + 1 : (a.clipNumbers?.[0] ?? 1)
    const view: TransitionView = {
      key: id,
      number,
      from: live ? boardOf(live.fromBoardId) : { number },
      to: live ? boardOf(live.toBoardId) : { number: number + 1 },
      params: a.params
    }
    let blocking: string | undefined
    let lapsed = true
    if (storyboard && !live) blocking = 'The transition is gone – the boards around it have changed since the agent asked'
    else if (live && (!samePath(live.params.startImage, a.params.startImage) || !samePath(live.params.endImage, a.params.endImage))) {
      blocking = 'One of the boards has a different image since the agent asked'
    } else if (live && settingsKey(live.params) !== settingsKey(a.params)) {
      blocking = 'The transition has changed since the agent asked'
    } else if (live?.problems.length) {
      blocking = live.problems[0].replace(/\.$/, '')
      lapsed = false
    }
    return {
      transitions: [{ ...view, ...(blocking ? { problem: blocking } : {}) }],
      ...(blocking ? { blocking, lapsed } : {})
    }
  }
  if (a.kind !== 'generate-all' || !storyboard) return { transitions: [] }
  const ids = a.segmentIds ?? []
  const transitions: TransitionView[] = []
  let blocking: string | undefined
  let lapsed = false
  for (const [i, id] of ids.entries()) {
    const index = storyboard.transitions.findIndex((t) => t.id === id)
    if (index < 0) {
      if (!blocking) {
        blocking = `Transition ${a.clipNumbers?.[i] ?? i + 1} is gone – the boards around it have changed since the agent asked`
        lapsed = true
      }
      continue
    }
    const t = storyboard.transitions[index]
    const problem = t.problems[0]?.replace(/\.$/, '')
    if (problem) blocking ??= `Transition ${index + 1}: ${problem}`
    transitions.push({
      key: t.id,
      number: index + 1,
      from: boardOf(t.fromBoardId),
      to: boardOf(t.toBoardId),
      params: t.params,
      ...(problem ? { problem } : {})
    })
  }
  return { transitions, ...(blocking ? { blocking, lapsed } : {}) }
}

/** The board an image request's picture becomes, as the storyboard has it now; undefined while it is read. */
export interface BoardTarget {
  number?: number
  note?: string
  /** The picture the board has now, which the new one replaces. */
  currentImage?: string
  /** Why the request no longer applies (main refuses it then too). */
  problem?: string
}

export function boardTargetNow(
  target: ApprovalImageRequest['assignToBoard'],
  storyboard: Storyboard | undefined
): BoardTarget | undefined {
  if (!target || !storyboard) return undefined
  const index = storyboard.boards.findIndex((b) => b.id === target.boardId)
  if (index < 0) return { problem: 'The board the image was meant for is gone' }
  const board = storyboard.boards[index]
  const now = { number: index + 1, note: board.note, ...(board.imagePath ? { currentImage: board.imagePath } : {}) }
  if (index + 1 !== target.boardNumber) {
    return {
      ...now,
      problem: `The board has moved since the agent asked (it was board ${target.boardNumber}, now board ${index + 1})`
    }
  }
  return now
}

/** "16:9" → "16 / 9", for a picture box in the storyboard's format. */
function boxRatio(aspectRatio: string | undefined): string {
  const m = /^(\d+):(\d+)$/.exec(aspectRatio ?? '')
  return m ? `${m[1]} / ${m[2]}` : '16 / 9'
}

/** One board's picture with its number and note under it; hovering it shows it larger, with what it is. */
function BoardPicture({
  path,
  board,
  role,
  aspectRatio
}: {
  path: string | undefined
  board: BoardView
  role: 'Start' | 'End'
  aspectRatio?: string
}) {
  const [missing, setMissing] = useState(false)
  const name = board.number ? `Board ${board.number}` : 'Board'
  const className = `relative block w-full overflow-hidden rounded-md bg-raised ${missing || !path ? 'ring-1 ring-accent' : ''}`
  const style = { aspectRatio: boxRatio(aspectRatio) }
  const content = (
    <>
      {path && !missing ? (
        <img
          src={mediaUrl(path)}
          draggable={false}
          onError={() => setMissing(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center p-2 text-center text-[11px] text-accent">
          {path ? 'Image missing' : 'No image'}
        </span>
      )}
      <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[10px]">{role}</span>
    </>
  )
  return (
    <figure className="min-w-0 flex-1">
      {path ? (
        <PictureHover
          path={path}
          badge={role}
          info={{ name }}
          className={`${className} outline-none focus-visible:ring-2 focus-visible:ring-white/70`}
          style={style}
        >
          {content}
        </PictureHover>
      ) : (
        <div className={className} style={style}>
          {content}
        </div>
      )}
      <figcaption className="mt-1.5 text-[12px] leading-snug">
        <span className="font-medium">{name}</span>
        {board.note?.trim() && <span className="line-clamp-2 text-muted select-text">{board.note.trim()}</span>}
      </figcaption>
    </figure>
  )
}

/**
 * A transition as the user approves it: the two board pictures it goes between, side by side, the prompt that
 * says what happens between them, and the settings. Compact for several in one request.
 */
export function TransitionSummary({
  view,
  models,
  aspectRatio,
  compact
}: {
  view: TransitionView
  models: VideoModel[]
  aspectRatio?: string
  compact: boolean
}) {
  const p = view.params
  const model = models.find((m) => m.id === p.model)
  // Always image-to-video from the two pictures, so the mode goes unsaid.
  const settings = [
    model?.name ?? p.model,
    p.duration,
    p.resolution,
    p.audio === undefined ? undefined : p.audio ? 'with sound' : 'without sound'
  ].filter(Boolean)
  return (
    <section className={compact ? 'rounded-lg border border-line p-3' : ''}>
      <h3 className="mb-1.5 font-medium">
        Transition {view.number}
        {view.from.number && view.to.number ? (
          <span className="font-normal text-muted">
            {' '}
            · board {view.from.number} → {view.to.number}
          </span>
        ) : null}
      </h3>
      <p className="mb-3 text-[12px] text-muted">{settings.join(' · ')}</p>

      <div className={`flex items-start gap-3 ${compact ? 'max-w-[420px]' : ''}`}>
        <BoardPicture
          path={p.startImage}
          board={view.from}
          role="Start"
          aspectRatio={aspectRatio}
        />
        <span aria-hidden className="mt-[18%] shrink-0 text-lg text-muted">
          →
        </span>
        <BoardPicture
          path={p.endImage}
          board={view.to}
          role="End"
          aspectRatio={aspectRatio}
        />
      </div>

      <p className="mb-1.5 mt-3 text-[11px] text-muted">What happens?</p>
      {p.prompt.trim() ? (
        <p
          className={`overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 leading-relaxed select-text ${compact ? 'max-h-24' : 'max-h-48'}`}
        >
          {p.prompt}
        </p>
      ) : (
        <p className="text-accent">The prompt is empty.</p>
      )}
      {p.negativePrompt && (
        <>
          <p className="mb-1.5 mt-3 text-[11px] text-muted">Negative prompt</p>
          <p className="whitespace-pre-wrap text-muted select-text">{p.negativePrompt}</p>
        </>
      )}
      {view.problem && <p className="mt-2 text-[12px] text-accent">{view.problem}.</p>}
    </section>
  )
}

/** Where an image request's picture goes in a storyboard: the board, its note, and the picture it replaces. */
export function BoardTargetSummary({ target, storyboardName }: { target: BoardTarget; storyboardName?: string }) {
  const where = storyboardName ? ` in “${storyboardName}”` : ''
  const current = target.currentImage
  return (
    <div className="mt-3 flex items-start gap-3">
      {current && (
        <PictureHover
          path={current}
          badge="Replaced"
          info={{ name: `The image of board ${target.number ?? ''}`.trim() }}
          className="relative h-16 w-24 shrink-0 overflow-hidden rounded bg-raised outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <img src={mediaUrl(current)} alt="" draggable={false} className="h-full w-full object-cover opacity-70" />
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">Replaced</span>
        </PictureHover>
      )}
      <p className="text-[12px] leading-relaxed text-muted">
        {target.number
          ? `The image is saved among the storyboard’s images and becomes the image of board ${target.number}${where}.`
          : `The image is saved among the storyboard’s images${where}.`}
        {target.note?.trim() && (
          <>
            {' '}
            The board: <span className="text-text select-text">“{target.note.trim()}”</span>
          </>
        )}
        {target.currentImage && ' The board’s current image stays among the storyboard’s images.'}
      </p>
    </div>
  )
}
