import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Generation, VideoModel } from '@shared/types'
import { formatSeconds, formatUsd, mediaUrl } from '../lib/media'
import type { Navigate } from '../lib/navigation'
import { isPending, progressOf, reviewCountText } from './feed/feedText'
import { ExpandIcon, ReviewIcon } from './feed/icons'
import { pauseOthers } from './feed/playback'
import StarRating from './feed/StarRating'
import Popover from './pickers/Popover'
import SequencePicker, { type AddedToSequence } from './pickers/SequencePicker'
import { PlayIcon } from './sequences/icons'

interface Props {
  generation: Generation
  model?: VideoModel
  onReuse: (g: Generation) => void
  onDelete: (g: Generation) => void
  /** Enables "Öppna" after adding to a sequence and opening the sequence from the badge. */
  navigate?: Navigate
  /** Receives a locally patched copy, e.g. with segmentId set after "Lägg i sekvens". */
  onChange?: (g: Generation) => void
  /** Opens the clip in the detail drawer. */
  onOpen?: (g: Generation) => void
  /** Sets (or with null clears) the user's star rating. */
  onRate?: (g: Generation, rating: number | null) => void
  /** The clip is the one shown in the detail drawer. */
  selected?: boolean
}

const action = 'rounded px-1.5 py-0.5 hover:bg-raised hover:text-text'

// Cards far outside the viewport skip layout and painting, so a feed of hundreds of clips scrolls smoothly.
const offscreenHint: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 320px' }

/** Finds the sequence that owns a segment; only used on click, so a linear scan is fine. */
async function findSequenceOfSegment(segmentId: string): Promise<string | undefined> {
  for (const summary of await window.studio.listSequences()) {
    const sequence = await window.studio.getSequence(summary.id)
    if (sequence.segments.some((s) => s.id === segmentId)) return sequence.id
  }
  return undefined
}

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
  // Deleting trashes a paid video and, for a sequence take, can silently clear that clip's selection;
  // so it takes a second click, like deleting a take in the sequence editor.
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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

  useEffect(() => {
    if (!confirmingDelete) return
    const t = setTimeout(() => setConfirmingDelete(false), 5000)
    return () => clearTimeout(t)
  }, [confirmingDelete])

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

  const openOwningSequence = async () => {
    if (!g.segmentId || openingSequence) return
    if (added?.segmentId === g.segmentId) return openSequence(added.sequenceId)
    setOpeningSequence(true)
    try {
      const id = await findSequenceOfSegment(g.segmentId)
      if (id) openSequence(id)
    } catch (e) {
      // The badge is only a shortcut; if the lookup fails the sequence is still reachable from the sidebar.
      console.warn('Kunde inte hitta sekvensen för tagningen', e)
    } finally {
      setOpeningSequence(false)
    }
  }

  const enter = () => {
    hovered.current = true
    if (playable) setLive(true)
  }
  const leave = () => {
    hovered.current = false
    // A clip that is playing keeps playing; a paused one goes back to its poster.
    const video = videoRef.current
    if (!video || video.paused) {
      setLive(false)
      setAutoPlay(false)
    }
  }
  const play = () => {
    setAutoPlay(true)
    setLive(true)
  }

  const keepActionsVisible = pickerOpen || confirmingDelete
  // Agents' reviews only: the user's own (stars, or just a note or tags) isn't a "granskning" to read.
  const otherReviews = g.agentReviewCount

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
              controls
              loop
              autoPlay={autoPlay}
              preload="metadata"
              onPlay={(e) => pauseOthers(e.currentTarget)}
              // Paused after the pointer left (e.g. with the keyboard): back to the poster.
              onPause={() => {
                if (!hovered.current) {
                  setLive(false)
                  setAutoPlay(false)
                }
              }}
              className="h-full w-full object-contain"
            />
          ) : (
            <button
              type="button"
              onClick={play}
              title="Spela upp"
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
            <span className="animate-pulse">{g.status === 'queued' ? 'I kö…' : 'Genererar…'}</span>
            <div className="h-1 w-full max-w-48 overflow-hidden rounded bg-raised">
              <div
                className="h-full bg-accent transition-all duration-1000"
                style={{ width: `${(progress ?? 0.03) * 100}%` }}
              />
            </div>
            <span className="text-[11px]">
              {formatSeconds(g.executionDuration)}
              {g.averageExecutionTime ? ` av ~${formatSeconds(g.averageExecutionTime)}` : ''}
            </span>
          </div>
        )}
        {g.status === 'failed' && (
          <div className="flex h-full items-center justify-center overflow-y-auto p-4 text-center text-accent">
            {g.error ?? 'Misslyckades'}
          </div>
        )}
        {g.segmentId && (
          <button
            onClick={navigate ? openOwningSequence : undefined}
            disabled={!navigate || openingSequence}
            title={navigate ? 'Tagning i en sekvens – klicka för att öppna sekvensen' : 'Tagning i en sekvens'}
            className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-text backdrop-blur transition enabled:hover:bg-black/90 disabled:cursor-default"
          >
            ▤ {openingSequence ? 'Öppnar…' : 'I sekvens'}
          </button>
        )}

        <div className="absolute right-2 top-2 flex items-center gap-1">
          {otherReviews > 0 && (
            <button
              type="button"
              onClick={() => onOpen?.(g)}
              title={`${reviewCountText(otherReviews)} – öppna för att läsa`}
              className="flex h-[22px] items-center gap-1 rounded bg-black/70 px-1.5 text-[10px] text-text backdrop-blur hover:bg-black/90"
            >
              <ReviewIcon size={11} />
              {otherReviews}
            </button>
          )}
          {g.status === 'completed' && onRate && (
            <div
              className={`flex h-[22px] items-center rounded bg-black/70 px-1 backdrop-blur transition ${
                g.rating ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
              }`}
            >
              <StarRating value={g.rating} onChange={(r) => onRate(g, r)} size="sm" />
            </div>
          )}
          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(g)}
              title="Visa detaljer"
              className="flex h-[22px] w-[22px] items-center justify-center rounded bg-black/70 text-text opacity-0 backdrop-blur transition hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <ExpandIcon size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="p-3">
        {onOpen ? (
          <button
            type="button"
            data-card-open
            onClick={() => onOpen(g)}
            title="Visa detaljer"
            className="mb-2 line-clamp-2 w-full text-left outline-none transition hover:text-white focus-visible:underline"
          >
            {g.prompt}
          </button>
        ) : (
          <p className="mb-2 line-clamp-2 select-text" title={g.prompt}>
            {g.prompt}
          </p>
        )}
        <div className="relative flex items-center gap-2 text-[11px] text-muted">
          <span className="truncate" title={g.model}>
            {model?.name ?? g.model}
          </span>
          <span>·</span>
          <span className="shrink-0">{g.params.duration}</span>
          {g.params.resolution && (
            <>
              <span>·</span>
              <span className="shrink-0">{g.params.resolution}</span>
            </>
          )}
          <span>·</span>
          <span className="shrink-0">{formatUsd(g.quote)}</span>
          {(g.params.referenceAudios?.length ?? 0) > 0 && (
            <span className="shrink-0" title="Med ljudreferens">
              · ♪
            </span>
          )}
          {/* Overlays the metadata on hover so the model name isn't squeezed by invisible buttons. */}
          <div
            className={`absolute inset-y-0 right-0 flex items-center gap-1 bg-linear-to-l from-panel from-75% to-transparent pl-10 transition ${
              keepActionsVisible ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
            }`}
          >
            {confirmingDelete ? (
              <>
                <span className="whitespace-nowrap">{g.segmentId ? 'Ingår i en sekvens – radera?' : 'Radera videon?'}</span>
                <button
                  autoFocus
                  onClick={() => {
                    setConfirmingDelete(false)
                    onDelete(g)
                  }}
                  className="rounded bg-accent px-2 py-0.5 font-medium text-white hover:bg-accent-hover"
                >
                  Radera
                </button>
                <button onClick={() => setConfirmingDelete(false)} className={action}>
                  Avbryt
                </button>
              </>
            ) : (
              <>
                <button onClick={() => onReuse(g)} className={action}>
                  Använd igen
                </button>
                {g.status !== 'failed' && (
                  <button
                    ref={sequenceButton}
                    onClick={() => setPickerOpen((o) => !o)}
                    className={`${action} ${pickerOpen ? 'bg-raised text-text' : ''}`}
                  >
                    Lägg i sekvens
                  </button>
                )}
                {g.filePath && (
                  <button onClick={() => window.studio.revealFile(g.filePath!)} className={action}>
                    Visa fil
                  </button>
                )}
                {!pending && (
                  <button
                    onClick={() => {
                      setPickerOpen(false)
                      setConfirmingDelete(true)
                    }}
                    title="Flyttar videon till papperskorgen"
                    className="rounded px-1.5 py-0.5 hover:bg-raised hover:text-accent"
                  >
                    Radera
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {added && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-[11px]">
            <span className="text-emerald-400">✓</span>
            <span className="min-w-0 flex-1 truncate">
              Klipp {added.clipNumber} i ”{added.name}”
            </span>
            {navigate && (
              <button onClick={() => openSequence(added.sequenceId)} className="shrink-0 font-medium text-accent hover:underline">
                Öppna
              </button>
            )}
            <button onClick={() => setAdded(undefined)} className="shrink-0 text-muted hover:text-text" title="Stäng">
              ✕
            </button>
          </div>
        )}
      </div>

      <Popover anchorRef={sequenceButton} open={pickerOpen} onClose={closePicker} align="end" width={300} label="Lägg i sekvens">
        <SequencePicker generation={g} onAdded={onAdded} />
      </Popover>
    </div>
  )
}

/** Memoized: a feed re-renders on every job update, but only the card whose generation changed needs to. */
export default memo(GenerationCard)
