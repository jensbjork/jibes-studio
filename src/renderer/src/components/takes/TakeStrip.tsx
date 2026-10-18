import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react'
import { sourceBadge } from '@shared/generation-label'
import { workKey, type Generation, type VideoModel } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { markSeen, useIsUnseen, useSeenWhenVisible } from '../../lib/work'
import { cancelImport, carriesFiles, DropHint, droppedVideoPaths, type ImportCard } from '../feed/ownClips'
import { CameraIcon, CloseIcon, MoreIcon, PlusIcon } from '../sequences/icons'
import { formatTakeTime, isPending, takeDuration, takeProgress } from '../sequences/sequenceUtils'
import { NewChip, Spinner } from '../work/StatusMark'
import TakeMenu, { type TakeMenuView, type TakeOwnerKind } from './TakeMenu'
import {
  formatTakeLength,
  hasReusablePrompt,
  isPlayable,
  pendingPhase,
  pendingTitle,
  stripOrder,
  takeAriaLabel,
  takeInfo,
  tileWidth
} from './takeText'

/** How a take was picked: a pointer click plays it; the keyboard only loads it (a sweep is not watching). */
export type PickedBy = 'click' | 'key'

interface Props {
  /** A sequence's clip or a storyboard's transition: the tile size and a few words differ. */
  owner: TakeOwnerKind
  /** Newest first, as main lists them. */
  takes: Generation[]
  /** The chosen take (the ring and "Selected"). */
  activeId?: string
  /** A take shown in the player without being chosen. */
  previewId?: string
  /** Focus and scroll to this take (a link to it, e.g. from Activity); `n` repeats the request. */
  focusRequest?: { id: string; n: number }
  /** The film's shape (width / height): the tiles take it. */
  aspect: number
  models: VideoModel[]
  /** A take being made now is chosen by itself when it is done (main's autoSelect), for the pending tooltip. */
  autoSelects: boolean
  /** Own films on their way in as takes (Sequences), shown as pending tiles with ✕. */
  importing?: ImportCard[]
  /** Storyboards: the take was made from other pictures than the boards hold now ("Earlier image"). */
  madeFromEarlierPictures?: (take: Generation) => boolean
  /** The take's prompt differs from the one in the editor now. */
  promptDiffers?: (take: Generation) => boolean
  /** A finished take was clicked or arrowed to: make it the chosen one (a click on the chosen one restarts it). */
  onChoose: (take: Generation, by: PickedBy) => void
  /** ⌥-click, ⌥← / ⌥→ or the menu: show it in the player without choosing it. */
  onPreview: (take: Generation, by: PickedBy) => void
  /** Esc: back to the chosen take. */
  onLeavePreview: () => void
  /** Space. */
  onTogglePlay: () => void
  /** Enter: the chosen (or previewed) take from its kept start. */
  onPlayFromStart: () => void
  onDelete: (take: Generation) => void
  onUsePrompt?: (take: Generation) => void
  onEdit?: (take: Generation) => void
  /** Video files dropped on the strip: own films as takes. */
  onImport?: (paths: string[]) => void
  /** "Add take from file…". */
  onPickFile?: () => void
}

/** Tile heights: Sequences has the room, the transition editor beside the boards is 400 px wide. */
const TILE_HEIGHT: Record<TakeOwnerKind, number> = { sequence: 72, storyboard: 56 }

/**
 * How long the pointer has to rest on another tile before the line under the strip describes it instead: on its way
 * from a tile down to that line's buttons it may cross other tiles, and the line must not change under it. Every move
 * over the tile starts the wait again, so crossing one – however slowly – never switches the line. A press on a tile
 * switches it at once: the take clicked is the one the line then describes.
 */
const HOVER_REST_MS = 120

/**
 * Every take of a clip (or transition) in one row right under the player. A click makes a finished take the one in
 * use and plays it; ← / → do the same from the keyboard without playing; ⌥ previews without choosing. The line under
 * the row describes the take last under the pointer while the pointer stays on the row or the line (else the focused
 * one, else the chosen one), so its buttons can be reached and act on the take it names. The row is a listbox with
 * one tab stop that moves with the arrows.
 */
export default function TakeStrip({
  owner,
  takes,
  activeId,
  previewId,
  focusRequest,
  aspect,
  models,
  autoSelects,
  importing = [],
  madeFromEarlierPictures,
  promptDiffers,
  onChoose,
  onPreview,
  onLeavePreview,
  onTogglePlay,
  onPlayFromStart,
  onDelete,
  onUsePrompt,
  onEdit,
  onImport,
  onPickFile
}: Props) {
  const ordered = useMemo(() => stripOrder(takes), [takes])
  const height = TILE_HEIGHT[owner]
  const width = tileWidth(height, aspect)

  const [focusId, setFocusId] = useState<string>()
  const [hasFocus, setHasFocus] = useState(false)
  const [hoverId, setHoverId] = useState<string>()
  const hoverTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])
  /**
   * The pointer is on a tile (it entered or moved): described at once when nothing else is, else once the pointer has
   * rested there a moment.
   */
  const hoverTile = (id: string) => {
    window.clearTimeout(hoverTimer.current)
    if (!hoverId || hoverId === id) setHoverId(id)
    else hoverTimer.current = window.setTimeout(() => setHoverId(id), HOVER_REST_MS)
  }
  const leaveTile = () => window.clearTimeout(hoverTimer.current)
  /** A press on a tile is a choice: the line describes that take at once, whatever the pointer crossed before. */
  const pressTile = (id: string) => {
    window.clearTimeout(hoverTimer.current)
    setHoverId(id)
  }
  /** The pointer left the row and its line: the line goes back to the focused or the chosen take. */
  const leaveZone = () => {
    window.clearTimeout(hoverTimer.current)
    setHoverId(undefined)
  }
  const [menu, setMenu] = useState<{ id: string; view: TakeMenuView }>()
  const [dropping, setDropping] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const tiles = useRef(new Map<string, HTMLDivElement>())
  const menuAnchor = useRef<HTMLElement | null>(null)

  const has = (id: string | undefined): id is string => !!id && ordered.some((t) => t.id === id)
  const tabbableId = has(focusId) ? focusId : has(activeId) ? activeId : ordered[0]?.id

  // The chosen take changed from elsewhere (a click, main, an agent): the tab stop follows it unless the user is
  // moving through the strip with the keyboard.
  useEffect(() => {
    if (!hasFocus && activeId) setFocusId(activeId)
  }, [activeId])

  // The chosen take is always in view (nearest: no jump when it already is).
  useEffect(() => {
    const el = activeId ? tiles.current.get(activeId) : undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeId])

  useEffect(() => {
    if (!focusRequest || !has(focusRequest.id)) return
    setFocusId(focusRequest.id)
    const el = tiles.current.get(focusRequest.id)
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
    el?.focus({ preventScroll: true })
    // Only when the request is new; the takes arriving later (a fresh fetch) mustn't steal the focus again.
  }, [focusRequest?.n, focusRequest?.id, ordered.length > 0])

  // ── Edge fades: shown on the side the row can scroll to ──────────────────────

  const [edges, setEdges] = useState({ left: false, right: false })
  const updateEdges = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])
  useLayoutEffect(() => {
    updateEdges()
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateEdges, ordered.length, importing.length])

  // ── Focus, keys and the pointer ──────────────────────────────────────────────

  const focusTile = (id: string) => {
    setFocusId(id)
    const el = tiles.current.get(id)
    el?.focus({ preventScroll: true })
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }

  const openMenu = (id: string, view: TakeMenuView) => {
    menuAnchor.current = tiles.current.get(id) ?? null
    setMenu({ id, view })
  }

  /** Arrows: focus moves; a finished take is chosen (or with ⌥ previewed) as focus reaches it. */
  const moveTo = (index: number, preview: boolean) => {
    const take = ordered[Math.max(0, Math.min(ordered.length - 1, index))]
    if (!take) return
    focusTile(take.id)
    if (!isPlayable(take)) return
    if (preview) {
      if (take.id === activeId) onLeavePreview()
      else onPreview(take, 'key')
    } else if (take.id !== activeId || previewId) {
      onChoose(take, 'key')
    }
  }

  const onTileKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (e.target !== e.currentTarget) return
    const take = ordered[index]
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        moveTo(index + (e.key === 'ArrowLeft' ? -1 : 1), e.altKey)
        break
      case 'Home':
        moveTo(0, false)
        break
      case 'End':
        moveTo(ordered.length - 1, false)
        break
      case ' ':
        onTogglePlay()
        break
      case 'Enter':
        onPlayFromStart()
        break
      case 'Backspace':
      case 'Delete':
        if (isPending(take)) return
        openMenu(take.id, 'delete')
        break
      case 'ContextMenu':
        if (isPending(take)) return
        openMenu(take.id, 'menu')
        break
      case 'F10':
        if (!e.shiftKey || isPending(take)) return
        openMenu(take.id, 'menu')
        break
      case 'Escape':
        // Unhandled, Esc goes on to what is around the strip (it closes the transition editor).
        if (!previewId) return
        onLeavePreview()
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const onTileClick = (e: MouseEvent, take: Generation, fresh: boolean) => {
    setFocusId(take.id)
    pressTile(take.id)
    // A take still being made, a failed one or one whose file is gone: focus only (the line below says why).
    if (!isPlayable(take)) return
    if (e.altKey) {
      onPreview(take, 'click')
      return
    }
    // Choosing it on purpose is looking at it (D4); arrowing past it is not.
    if (fresh) markSeen([workKey.generation(take.id)])
    onChoose(take, 'click')
  }

  // ── Drops (own films as takes) ────────────────────────────────────────────────

  const onDragOver = (e: DragEvent) => {
    if (!onImport || !carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!onImport || !carriesFiles(e)) return
    e.preventDefault()
    setDropping(false)
    const { paths } = droppedVideoPaths(e)
    if (paths.length) onImport(paths)
  }

  // ── The line under the row ────────────────────────────────────────────────────

  // A take removed while the pointer stays in the zone no longer holds the line.
  const infoId = (has(hoverId) ? hoverId : undefined) ?? (hasFocus ? focusId : undefined) ?? previewId ?? activeId
  const infoTake = ordered.find((t) => t.id === infoId)
  const menuTake = menu ? ordered.find((t) => t.id === menu.id) : undefined
  const count = takes.length + importing.length
  const empty = count === 0

  return (
    <section
      className="relative"
      aria-label="Takes"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
    >
      {dropping && <DropHint text="Drop to add as takes" />}
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-medium">Takes</h3>
        {takes.length > 0 && <span className="text-[12px] text-muted">{takes.length}</span>}
        {onPickFile && (
          <button
            type="button"
            onClick={onPickFile}
            title="Add take from file…"
            aria-label="Add take from file"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-raised hover:text-text"
          >
            <PlusIcon size={12} />
          </button>
        )}
      </div>

      <div
        // The row and the line under it are one zone: what the line describes holds while the pointer or the focus is
        // anywhere in it, so moving down to "Use prompt" or "Delete" (or tabbing there) keeps the same take.
        onMouseLeave={leaveZone}
        onFocus={() => setHasFocus(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false)
        }}
      >
        {empty ? (
          <div className="rounded-lg border border-dashed border-line px-5 py-5 text-center text-[12px] leading-relaxed text-muted">
            No takes yet. Write a prompt and click <span className="text-text">Generate take</span>
            {onImport ? ', or drop a film of your own here.' : '.'} Every attempt is kept here, so you can pick the best.
          </div>
        ) : (
          <div className="relative">
            <div
              ref={scroller}
              onScroll={updateEdges}
              className="flex gap-2 overflow-x-auto px-1 pb-2 pt-1.5 [scrollbar-width:thin]"
            >
              {importing.map((card) => (
                <ImportTile key={card.path} card={card} width={width} height={height} />
              ))}
              <div role="listbox" aria-orientation="horizontal" aria-label="Takes" className="flex gap-2">
                {ordered.map((take, i) => (
                  <TakeTile
                    key={take.id}
                    take={take}
                    owner={owner}
                    width={width}
                    height={height}
                    active={take.id === activeId}
                    previewed={take.id === previewId}
                    tabbable={take.id === tabbableId}
                    autoSelects={autoSelects}
                    stale={!!madeFromEarlierPictures && take.status === 'completed' && madeFromEarlierPictures(take)}
                    refCallback={(el) => {
                      if (el) tiles.current.set(take.id, el)
                      else tiles.current.delete(take.id)
                    }}
                    onClick={(e, fresh) => onTileClick(e, take, fresh)}
                    onKeyDown={(e) => onTileKeyDown(e, i)}
                    onFocus={() => setFocusId(take.id)}
                    onHover={(on) => (on ? hoverTile(take.id) : leaveTile())}
                    onPress={() => pressTile(take.id)}
                    onMenu={(view) => openMenu(take.id, view)}
                  />
                ))}
              </div>
              {onPickFile && (
                <button
                  type="button"
                  onClick={onPickFile}
                  title="Add a film of your own as a take of the clip"
                  className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line px-2 text-center text-[11px] leading-tight text-muted transition hover:border-muted hover:text-text"
                  style={{ width, height }}
                >
                  <PlusIcon size={12} />
                  Add from file…
                </button>
              )}
            </div>
            {edges.left && (
              <span className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-linear-to-r from-bg to-transparent" aria-hidden />
            )}
            {edges.right && (
              <span className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l from-bg to-transparent" aria-hidden />
            )}
          </div>
        )}

        {infoTake && (
          <InfoLine
            // Its own line per take: a click that began on one take's button can never land on another's.
            key={infoTake.id}
            take={infoTake}
            position={{ index: ordered.indexOf(infoTake), count: ordered.length }}
            modelName={models.find((m) => m.id === infoTake.model)?.name ?? infoTake.model}
            promptDiffers={!!promptDiffers && hasReusablePrompt(infoTake) && promptDiffers(infoTake)}
            onUsePrompt={onUsePrompt && (() => onUsePrompt(infoTake))}
            onDelete={() => openMenu(infoTake.id, 'delete')}
          />
        )}
      </div>

      {menu && menuTake && (
        <TakeMenu
          anchorRef={menuAnchor}
          open
          view={menu.view}
          take={menuTake}
          owner={owner}
          active={menuTake.id === activeId}
          promptDiffers={!!promptDiffers && promptDiffers(menuTake)}
          onView={(view) => setMenu({ id: menuTake.id, view })}
          onClose={() => setMenu(undefined)}
          onPreview={() => onPreview(menuTake, 'click')}
          onUsePrompt={onUsePrompt && (() => onUsePrompt(menuTake))}
          onEdit={
            onEdit &&
            (() => {
              // Opening it in the Editor is choosing to look at it (D4).
              markSeen([workKey.generation(menuTake.id)])
              onEdit(menuTake)
            })
          }
          onDelete={() => onDelete(menuTake)}
        />
      )}
    </section>
  )
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** One take: its picture (scrubbed silently under the pointer), its state and its chips. */
function TakeTile({
  take,
  owner,
  width,
  height,
  active,
  previewed,
  tabbable,
  autoSelects,
  stale,
  refCallback,
  onClick,
  onKeyDown,
  onFocus,
  onHover,
  onPress,
  onMenu
}: {
  take: Generation
  owner: TakeOwnerKind
  width: number
  height: number
  active: boolean
  previewed: boolean
  tabbable: boolean
  autoSelects: boolean
  stale: boolean
  refCallback: (el: HTMLDivElement | null) => void
  onClick: (e: MouseEvent, fresh: boolean) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onFocus: () => void
  onHover: (on: boolean) => void
  /** The pointer went down on it (before the click). */
  onPress: () => void
  onMenu: (view: TakeMenuView) => void
}) {
  const key = workKey.generation(take.id)
  const unseen = useIsUnseen(key)
  const pending = isPending(take)
  const failed = take.status === 'failed'
  const playable = isPlayable(take)
  const fresh = unseen && take.status === 'completed'
  const tile = useRef<HTMLDivElement | null>(null)
  // A failure counts as seen once it has been on screen for a moment (D4).
  useSeenWhenVisible(tile, failed && unseen ? key : undefined)

  // A take that lands while the strip is open glows once.
  const lastStatus = useRef(take.status)
  useEffect(() => {
    const before = lastStatus.current
    lastStatus.current = take.status
    if (before === take.status || take.status !== 'completed' || !fresh || prefersReducedMotion()) return
    tile.current?.animate(
      [{ boxShadow: '0 0 0 0 rgba(52, 211, 153, 0.75)' }, { boxShadow: '0 0 0 7px rgba(52, 211, 153, 0)' }],
      { duration: 600, easing: 'ease-out' }
    )
  }, [take.status, fresh])

  // ── Silent scrub: a muted video mounted only while the pointer is over the tile ─────────────────────────

  const [scrub, setScrub] = useState<number>()
  const video = useRef<HTMLVideoElement>(null)
  const wanted = useRef<number | undefined>(undefined)
  const seekTo = (fraction: number) => {
    const el = video.current
    if (!el || !Number.isFinite(el.duration) || el.seeking) {
      wanted.current = fraction
      return
    }
    wanted.current = undefined
    el.currentTime = Math.min(el.duration - 0.05, Math.max(0, fraction * el.duration))
  }
  const fractionAt = (e: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
  }

  const badge = sourceBadge(take)
  const own = badge?.kind === 'own' || badge?.kind === 'edited'
  const progress = takeProgress(take)
  const title = pending ? pendingTitle(autoSelects) : undefined
  const surface = playable
    ? 'cursor-pointer bg-black'
    : failed
      ? 'cursor-default bg-accent/10'
      : 'cursor-default bg-raised'
  // The chosen take: the accent ring (with "Selected"); a previewed one: a quiet ring, so it is found in the row.
  const ring = active
    ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg'
    : previewed
      ? 'ring-1 ring-muted ring-offset-1 ring-offset-bg'
      : ''

  return (
    <div
      ref={(el) => {
        tile.current = el
        refCallback(el)
      }}
      role="option"
      aria-selected={active}
      aria-disabled={!playable || undefined}
      aria-label={takeAriaLabel(take, { active, fresh, previewed })}
      tabIndex={tabbable ? 0 : -1}
      title={title}
      onPointerDown={(e) => {
        if (e.button === 0) onPress()
      }}
      onClick={(e) => onClick(e, fresh)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onContextMenu={(e) => {
        if (pending) return
        e.preventDefault()
        onMenu('menu')
      }}
      onMouseEnter={(e) => {
        onHover(true)
        if (playable) setScrub(fractionAt(e))
      }}
      onMouseLeave={() => {
        onHover(false)
        setScrub(undefined)
      }}
      onPointerMove={(e) => {
        // Still on the move: the line under the strip waits for the pointer to rest (see hoverTile).
        onHover(true)
        if (!playable || e.pointerType === 'touch') return
        const f = fractionAt(e)
        setScrub(f)
        seekTo(f)
      }}
      className={`group/tile relative shrink-0 overflow-hidden rounded-md outline-none transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted ${surface} ${ring}`}
      style={{ width, height }}
    >
      {take.status === 'completed' && take.thumbPath && !take.fileMissing && (
        <img
          src={mediaUrl(take.thumbPath)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {playable && scrub !== undefined && (
        <video
          ref={video}
          src={mediaUrl(take.filePath!)}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          onLoadedMetadata={() => seekTo(wanted.current ?? scrub)}
          onSeeked={() => wanted.current !== undefined && seekTo(wanted.current)}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        />
      )}

      {pending && (
        <>
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1 text-center text-[10px] leading-tight text-muted">
            <Spinner size={12} />
            {pendingPhase(take)}
          </span>
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
            <span
              className="block h-full bg-accent transition-[width] duration-1000"
              style={{ width: `${(progress ?? (take.status === 'queued' ? 0.02 : 0.05)) * 100}%` }}
            />
          </span>
        </>
      )}
      {failed && (
        <span className="absolute inset-0 flex items-center justify-center px-1 text-center text-[10px] font-medium text-accent">
          Failed
        </span>
      )}
      {take.fileMissing && (
        <span className="absolute inset-0 flex items-center justify-center px-1 text-center text-[10px] text-muted">
          File missing
        </span>
      )}

      {(active || fresh || (own && badge)) && (
        <span className="pointer-events-none absolute left-1 top-1 flex max-w-[calc(100%-1.75rem)] flex-wrap items-center gap-0.5">
          {active && <span className="rounded bg-accent px-1 py-px text-[10px] font-medium leading-none text-white">Selected</span>}
          {fresh && <NewChip variant="overlay" title="New – you haven’t looked at it yet" />}
          {own && badge && (
            <span
              title={badge.description}
              className="flex items-center gap-0.5 rounded bg-black/75 px-1 py-px text-[10px] leading-none text-text"
            >
              <CameraIcon size={9} />
              {badge.label}
            </span>
          )}
        </span>
      )}
      {stale && (
        <span
          title="Made with an earlier image in one of the boards"
          className="pointer-events-none absolute bottom-1 left-1 rounded bg-amber-500/90 px-1 py-px text-[9px] font-medium leading-none text-black"
        >
          Earlier image
        </span>
      )}
      {take.status === 'completed' && !take.fileMissing && !stale && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/75 px-1 py-px text-[10px] leading-none tabular-nums text-text">
          {formatTakeLength(takeDuration(take))}
        </span>
      )}
      {!pending && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation()
            onMenu('menu')
          }}
          title={owner === 'storyboard' ? 'More options for the take' : 'More options for the take (or right-click)'}
          className="absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded bg-black/70 text-white/90 opacity-0 transition hover:bg-black/90 group-hover/tile:opacity-100"
        >
          <MoreIcon size={11} />
        </button>
      )}
      {playable && scrub !== undefined && (
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
          style={{ left: `${scrub * 100}%` }}
          aria-hidden
        />
      )}
    </div>
  )
}

/** An own film on its way in as a take: its progress, and ✕ to stop it. */
function ImportTile({ card, width, height }: { card: ImportCard; width: number; height: number }) {
  const percent = Math.round(card.fraction * 100)
  return (
    <div
      className="group/import relative flex shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md bg-raised px-1 text-center text-[10px] leading-tight text-muted"
      style={{ width, height }}
      title={card.note ? `${card.name}\n${card.note}` : card.name}
    >
      <Spinner size={12} />
      <span>Importing {percent}%</span>
      <span className="w-full truncate">{card.name}</span>
      <button
        type="button"
        onClick={() => cancelImport(card.path)}
        title="Cancel – what has been copied so far is removed"
        aria-label={`Cancel the import of ${card.name}`}
        className="absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded bg-black/60 text-white/90 opacity-0 transition hover:bg-black/90 focus-visible:opacity-100 group-hover/import:opacity-100"
      >
        <CloseIcon size={9} />
      </button>
      <span className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
        <span className="block h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(3, percent)}%` }} />
      </span>
    </div>
  )
}

/** One line about a take, with what can be done about it right there. */
function InfoLine({
  take,
  position,
  modelName,
  promptDiffers,
  onUsePrompt,
  onDelete
}: {
  take: Generation
  /** Its place in the row (0 = the first tile), so the buttons' names tell takes made the same minute apart. */
  position: { index: number; count: number }
  modelName: string
  promptDiffers: boolean
  onUsePrompt?: () => void
  onDelete: () => void
}) {
  const info = takeInfo(take, modelName)
  const link = 'shrink-0 rounded px-1 py-px text-text transition hover:bg-raised'
  // Which take the buttons act on, in their names: the line may describe another take than the chosen one.
  const which = `take ${position.index + 1} of ${position.count} (${formatTakeTime(take.createdAt)})`
  return (
    <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] text-muted">
      <span className={`max-w-full truncate select-text ${info.tone === 'error' ? 'text-[#ffb3b5]' : ''}`} title={info.text}>
        {info.text}
      </span>
      {take.status === 'failed' && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`${take.keptByEdit ? 'Remove' : 'Delete'} ${which}`}
          className={`${link} hover:text-accent`}
        >
          {take.keptByEdit ? 'Remove' : 'Delete'}
        </button>
      )}
      {promptDiffers && take.status !== 'failed' && (
        <>
          <span className="shrink-0">· Not the current prompt</span>
          {onUsePrompt && (
            <button
              type="button"
              onClick={onUsePrompt}
              className={link}
              title={`Put the prompt from ${which} in the editor`}
              aria-label={`Use the prompt from ${which}`}
            >
              Use prompt
            </button>
          )}
        </>
      )}
    </p>
  )
}
