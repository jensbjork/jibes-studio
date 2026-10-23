import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { canUseAgain, generationTitle, sourceBadge } from '@shared/generation-label'
import { referenceVideosOf, videosAreReferences } from '@shared/models'
import { workKey, type Generation, type VideoModel } from '@shared/types'
import { formatSeconds, formatUsd, mediaUrl } from '../lib/media'
import type { Navigate } from '../lib/navigation'
import { FILE_MANAGER, TRASH } from '../lib/platform'
import { findTakeOwner, openTakeOwner } from '../lib/takes'
import { nativeVideoControls } from '../lib/video'
import { markSeen, useIsUnseen, useSeenWhenVisible } from '../lib/work'
import { clipSeconds, formatClipLength, isPending, progressOf, reviewCountText } from './feed/feedText'
import { CameraIcon, ReviewIcon, ScissorsIcon } from './feed/icons'
import { pauseOthers } from './feed/playback'
import RatingControl from './feed/RatingControl'
import { FilmIcon } from './icons'
import Popover from './pickers/Popover'
import SequencePicker, { type AddedToSequence } from './pickers/SequencePicker'
import { CloseIcon, PlayIcon } from './sequences/icons'
import MoreMenu, { MenuDivider, MenuItem } from './ui/MoreMenu'
import { NewChip, Spinner } from './work/StatusMark'

interface Props {
  generation: Generation
  model?: VideoModel
  onReuse: (g: Generation) => void
  /** Deletes the clip (asked first in the ⋯ menu); a promise keeps the question on "Deleting…" until it is done. */
  onDelete: (g: Generation) => void | Promise<void>
  /** Enables "Open" after adding to a sequence and opening the take's sequence or storyboard from the badge. */
  navigate?: Navigate
  /** Receives a locally patched copy, e.g. with segmentId set after "Add to sequence". */
  onChange?: (g: Generation) => void
  /** Opens the clip in the detail drawer. */
  onOpen?: (g: Generation) => void
  /** Sets (or with null clears) the user's rating: -1 = thumbs down, 1–3 stars. */
  onRate?: (g: Generation, rating: number | null) => void
  /** The clip is the one shown in the detail drawer. */
  selected?: boolean
}

const action = 'rounded px-1.5 py-0.5 hover:bg-raised hover:text-text'

/**
 * The ⋯ over the picture: as small and as dark as the chips beside it, shown on hover, on focus and while its menu is
 * open. (MoreMenu's own button is a toolbar's; this sizes it down from outside.)
 */
const overlayMenu =
  'flex rounded bg-black/70 opacity-0 backdrop-blur transition focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 [&>button]:h-[22px] [&>button]:w-[22px] [&>button]:rounded [&>button]:text-text [&>button:hover]:bg-black/90 [&_svg]:size-3'

// Cards far outside the viewport skip layout and painting, so a feed of hundreds of clips scrolls smoothly.
const offscreenHint: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 320px' }

function GenerationCard({
  generation: g,
  model,
  onReuse,
  onDelete,
  navigate,
  onChange,
  onOpen,
  onRate,
  selected
}: Props) {
  const pending = isPending(g)
  const progress = progressOf(g)
  const playable = g.status === 'completed' && !!g.filePath

  const sequenceButton = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const closePicker = useCallback(() => setPickerOpen(false), [])
  const [added, setAdded] = useState<{ sequenceId: string; segmentId: string; name: string; clipNumber: number }>()
  const [openingSequence, setOpeningSequence] = useState(false)

  // The <video> element is only mounted while the pointer is over the card (or it plays): a feed of hundreds
  // of clips then costs hundreds of poster images, not hundreds of video decoders.
  const [live, setLive] = useState(false)
  const [autoPlay, setAutoPlay] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hovered = useRef(false)

  // Started from the poster button (perhaps with the keyboard): the button is gone, so the player takes the focus.
  useEffect(() => {
    if (live && autoPlay) videoRef.current?.focus()
  }, [live, autoPlay])

  // The confirmation is only useful right after adding; don't let it linger on the card.
  useEffect(() => {
    if (!added) return
    const t = setTimeout(() => setAdded(undefined), 15_000)
    return () => clearTimeout(t)
  }, [added])

  const onAdded = ({ sequence, clipNumber, segmentId }: AddedToSequence) => {
    setPickerOpen(false)
    setAdded({ sequenceId: sequence.id, segmentId, name: sequence.name, clipNumber })
    // Main assigns a free generation to the new segment; mirror that so the badge shows without a refetch.
    if (!g.segmentId) onChange?.({ ...g, segmentId })
  }

  const openSequence = (sequenceId: string) => navigate?.('sequences', { type: 'open-sequence', sequenceId })

  // A take of a sequence clip or of a storyboard transition: looked up on click (a linear scan is fine there).
  const openOwner = async () => {
    if (!g.segmentId || openingSequence || !navigate) return
    if (added?.segmentId === g.segmentId) return openSequence(added.sequenceId)
    setOpeningSequence(true)
    try {
      const owner = await findTakeOwner(g.segmentId)
      if (owner) openTakeOwner(owner, g.segmentId, navigate, g.id)
    } catch (e) {
      // The badge is only a shortcut; if the lookup fails the take is still reachable from the sidebar.
      console.warn('Could not find where the take belongs', e)
    } finally {
      setOpeningSequence(false)
    }
  }

  const enter = () => {
    hovered.current = true
    if (playable) setLive(true)
  }
  /** Back to the poster once the pointer is gone and the clip is paused – never while it is shown full screen. */
  const settle = () => {
    const video = videoRef.current
    if (hovered.current || (video && document.fullscreenElement === video)) return
    if (!video || video.paused) {
      setLive(false)
      setAutoPlay(false)
    }
  }
  const leave = () => {
    hovered.current = false
    // Going full screen moves the player out from under the pointer, and its mouseleave comes before (or as) the
    // player becomes the full-screen element: look again a moment later, so it isn't unmounted on its way there.
    setTimeout(settle, 250)
  }
  // Leaving full screen with the pointer elsewhere: a paused clip goes back to its poster then.
  useEffect(() => {
    if (!live) return
    const onChange = () => {
      if (!document.fullscreenElement) settle()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [live])
  const play = () => {
    setAutoPlay(true)
    setLive(true)
  }

  // Agents' reviews only: the user's own (a rating, or just a note or tags) isn't a "review" to read.
  const otherReviews = g.agentReviewCount
  // Own films and versions from the Editor: named by their title, marked by the badge, without a model; their
  // settings aren't a form.
  const badge = sourceBadge(g)
  const own = badge?.kind === 'own' || badge?.kind === 'edited'
  const title = generationTitle(g)
  const editable = g.status === 'completed' && !!g.filePath && !!navigate
  const deletable = !pending
  const reusable = canUseAgain(g)
  const addable = g.status !== 'failed'
  const seconds = clipSeconds(g)

  // Activity: a finished clip the user hasn't played or opened yet is "New"; a failure counts as seen once
  // its message has been on screen for a moment.
  const key = workKey.generation(g.id)
  const unseen = useIsUnseen(key)
  const fresh = unseen && g.status === 'completed'
  const failureRef = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(failureRef, g.status === 'failed' ? key : undefined)
  const rate = onRate
    ? (r: number | null) => {
        // Rating a clip is looking at it on purpose.
        markSeen([key])
        onRate(g, r)
      }
    : undefined
  const edit = () => {
    // Taking a clip into the Editor is choosing it on purpose.
    markSeen([key])
    navigate?.('editor', { type: 'open-editor', generationId: g.id })
  }

  return (
    <div
      data-generation-id={g.id}
      style={offscreenHint}
      className={`group overflow-hidden rounded-lg border bg-panel transition-colors ${
        selected ? 'border-accent/70 ring-1 ring-accent/40' : 'border-line'
      }`}
    >
      <div className="relative aspect-video bg-black" onMouseEnter={enter} onMouseLeave={leave}>
        {playable &&
          (live ? (
            <video
              ref={videoRef}
              src={mediaUrl(g.filePath!)}
              poster={g.thumbPath ? mediaUrl(g.thumbPath) : undefined}
              {...nativeVideoControls}
              loop
              autoPlay={autoPlay}
              preload="metadata"
              onPlay={(e) => pauseOthers(e.currentTarget)}
              // Paused after the pointer left (e.g. with the keyboard): back to the poster, unless it is full screen.
              onPause={settle}
              className="h-full w-full object-contain"
            />
          ) : (
            <button
              type="button"
              onClick={play}
              title="Play"
              className="group/poster flex h-full w-full items-center justify-center outline-none"
            >
              {g.thumbPath && (
                <img
                  src={mediaUrl(g.thumbPath)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              )}
              <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white/90 opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible/poster:opacity-100">
                <PlayIcon size={16} />
              </span>
            </button>
          ))}
        {pending && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-muted">
            <span className="flex items-center gap-2">
              <Spinner />
              {g.status === 'queued' ? 'Queued…' : 'Generating…'}
            </span>
            <div className="h-1 w-full max-w-48 overflow-hidden rounded bg-raised">
              <div
                className="h-full bg-accent transition-all duration-1000"
                style={{ width: `${(progress ?? 0.03) * 100}%` }}
              />
            </div>
            <span className="text-[11px]">
              {formatSeconds(g.executionDuration)}
              {g.averageExecutionTime ? ` of ~${formatSeconds(g.averageExecutionTime)}` : ''}
            </span>
          </div>
        )}
        {g.status === 'failed' && (
          <div
            ref={failureRef}
            className="flex h-full items-center justify-center overflow-y-auto p-4 text-center text-danger"
          >
            {g.error ?? 'Failed'}
          </div>
        )}
        {(g.segmentId || badge || fresh) && (
          <div className="absolute left-2 top-2 flex items-center gap-1">
            {fresh && <NewChip variant="overlay" title="Done and not watched yet" />}
            {badge && (
              <span
                title={badge.description}
                className="flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-text backdrop-blur"
              >
                {badge.kind === 'own' ? <CameraIcon size={10} /> : <ScissorsIcon size={10} />}
                {badge.label}
              </span>
            )}
            {g.segmentId && (
              <button
                onClick={navigate ? () => void openOwner() : undefined}
                disabled={!navigate || openingSequence}
                title={
                  navigate
                    ? 'Take in a sequence or storyboard – click to open it'
                    : 'Take in a sequence or storyboard'
                }
                className="flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-text backdrop-blur transition enabled:hover:bg-black/90 disabled:cursor-default"
              >
                <FilmIcon size={10} />
                {openingSequence ? 'Opening…' : 'Take'}
              </button>
            )}
          </div>
        )}

        <div className="absolute right-2 top-2 flex items-center gap-1">
          {otherReviews > 0 && (
            <button
              type="button"
              onClick={() => onOpen?.(g)}
              title={`${reviewCountText(otherReviews)} – open to read`}
              className="flex h-[22px] items-center gap-1 rounded bg-black/70 px-1.5 text-[10px] text-text backdrop-blur hover:bg-black/90"
            >
              <ReviewIcon size={11} />
              {otherReviews}
            </button>
          )}
          {g.status === 'completed' && rate && (
            <div
              className={`flex h-[22px] items-center rounded bg-black/70 px-1 backdrop-blur transition ${
                g.rating ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
              }`}
            >
              <RatingControl value={g.rating} onChange={rate} size="sm" />
            </div>
          )}
          {(editable || g.filePath || deletable) && (
            <span className={overlayMenu}>
              <MoreMenu>
                {(menu) => (
                  <>
                    {editable && (
                      <MenuItem icon={<ScissorsIcon size={13} />} onSelect={edit}>
                        Edit…
                      </MenuItem>
                    )}
                    {g.filePath && (
                      <MenuItem onSelect={() => void window.studio.revealFile(g.filePath!)}>
                        Show in {FILE_MANAGER}
                      </MenuItem>
                    )}
                    {deletable && (
                      <>
                        {(editable || g.filePath) && <MenuDivider />}
                        {/* Deleting trashes a paid video and, for a take, can clear its clip's selection: asked first. */}
                        <MenuItem
                          danger
                          onSelect={() =>
                            menu.confirm({
                              question: g.segmentId ? 'Used as a take – delete?' : 'Delete the video?',
                              note: `The video file goes to ${TRASH}.`,
                              onConfirm: () => onDelete(g)
                            })
                          }
                        >
                          Delete…
                        </MenuItem>
                      </>
                    )}
                  </>
                )}
              </MoreMenu>
            </span>
          )}
        </div>
      </div>
      <div className="p-3">
        {onOpen ? (
          <button
            type="button"
            data-card-open
            onClick={() => onOpen(g)}
            title="Show details"
            className="mb-2 line-clamp-2 w-full text-left outline-none transition hover:text-white focus-visible:underline"
          >
            {title}
          </button>
        ) : (
          <p className="mb-2 line-clamp-2 select-text" title={title}>
            {title}
          </p>
        )}
        <div className="relative flex items-center gap-2 text-[11px] text-muted">
          {/* An own clip or a version is named by its badge: the line starts with its length. */}
          {joinFacts([
            !own && (
              <span key="model" className="truncate" title={g.model}>
                {model?.name ?? g.model}
              </span>
            ),
            seconds > 0 && (
              <span key="length" className="shrink-0">
                {formatClipLength(seconds)}
              </span>
            ),
            g.params.resolution && (
              <span key="resolution" className="shrink-0">
                {g.params.resolution}
              </span>
            ),
            // An import cost nothing; a version only what its own sound cost.
            (!own || g.quote !== undefined) && (
              <span key="cost" className="shrink-0">
                {formatUsd(g.quote)}
              </span>
            ),
            (g.params.referenceAudios?.length ?? 0) > 0 && (
              <span key="sound" className="shrink-0" title="With a sound reference">
                ♪
              </span>
            ),
            referenceVideosOf(g.params).length > 0 && videosAreReferences(g.params) && (
              <span key="video" className="shrink-0" title="With a reference video (motion, camera, style)">
                video ref
              </span>
            )
          ])}
          {/* Overlays the metadata on hover so the model name isn't squeezed by invisible buttons. The rarer actions
              are in ⋯, and every one of them in the drawer. */}
          {(reusable || addable) && (
            <div
              className={`absolute inset-y-0 right-0 flex items-center gap-1 bg-linear-to-l from-panel from-75% to-transparent pl-10 transition ${
                pickerOpen ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
              }`}
            >
              {reusable && (
                <button type="button" onClick={() => onReuse(g)} className={action}>
                  Use again
                </button>
              )}
              {addable && (
                <button
                  ref={sequenceButton}
                  type="button"
                  onClick={() => setPickerOpen((o) => !o)}
                  className={`${action} ${pickerOpen ? 'bg-raised text-text' : ''}`}
                >
                  Add to sequence
                </button>
              )}
            </div>
          )}
        </div>

        {added && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-[11px]">
            <span className="text-success">✓</span>
            <span className="min-w-0 flex-1 truncate">
              Clip {added.clipNumber} in “{added.name}”
            </span>
            {navigate && (
              <button onClick={() => openSequence(added.sequenceId)} className="shrink-0 font-medium text-accent hover:underline">
                Open
              </button>
            )}
            <button
              type="button"
              onClick={() => setAdded(undefined)}
              aria-label="Close"
              title="Close"
              className="shrink-0 text-muted hover:text-text"
            >
              <CloseIcon size={9} />
            </button>
          </div>
        )}
      </div>

      <Popover anchorRef={sequenceButton} open={pickerOpen} onClose={closePicker} align="end" width={300} label="Add to sequence">
        <SequencePicker generation={g} onAdded={onAdded} />
      </Popover>
    </div>
  )
}

/** The meta line's facts with a "·" between them, leaving out the ones that are false. */
function joinFacts(facts: (ReactNode | false | undefined)[]): ReactNode[] {
  return facts
    .filter((f): f is ReactNode => !!f)
    .flatMap((f, i) => (i ? [<span key={`dot${i}`}>·</span>, f] : [f]))
}

/** Memoized: a feed re-renders on every job update, but only the card whose generation changed needs to. */
export default memo(GenerationCard)
