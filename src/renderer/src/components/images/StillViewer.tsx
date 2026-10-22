import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { workKey, type Still } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { fileName } from '../../lib/library'
import { mediaUrl } from '../../lib/media'
import { FILE_MANAGER, TRASH } from '../../lib/platform'
import { useSeenWhenVisible } from '../../lib/work'
import ConfirmButton from '../sequences/ConfirmButton'
import {
  formatImagePrice,
  formatStillTime,
  qualityLabel,
  stillSourceLabel,
  useImageModels
} from './imageModels'

interface Props {
  /** The still shown; the viewer is open while it is set. */
  still?: Still
  /** Stills to browse with ← and → (e.g. a storyboard's images), in the order they are shown there. */
  stills?: Still[]
  onClose: () => void
  /**
   * Offers "Delete" (two steps). Main refuses, or moves the file to Reference images instead of the Trash, when a
   * clip or a board still uses the image; its message is shown here.
   */
  deletable?: boolean
  onDeleted?: (still: Still) => void
  /** Extra buttons for the still on screen, e.g. "Use as start image". */
  actions?: (still: Still) => ReactNode
  /**
   * An agent opened it (open_in_studio): the still it opened on isn't marked seen by being on screen until the user
   * steps with ← or → (from then on every still shown is).
   */
  openedByAgent?: boolean
}

const button =
  'rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent'

/** A still at full size with what it was made from: prompt, model, settings, references and price. */
export default function StillViewer({
  still,
  stills,
  onClose,
  deletable = false,
  onDeleted,
  actions,
  openedByAgent = false
}: Props) {
  const [currentId, setCurrentId] = useState(still?.id)
  // Held back from the seen rule while an agent's still is all that has been shown; the user stepping releases it.
  const [stepped, setStepped] = useState(false)
  useEffect(() => {
    setCurrentId(still?.id)
    setStepped(false)
  }, [still?.id])
  const heldId = openedByAgent && !stepped ? still?.id : undefined
  const step = (id: string) => {
    setCurrentId(id)
    setStepped(true)
  }

  // Deleted here: left out even while the parent still passes them (its list or `still` may update later).
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const list = useMemo(() => {
    if (!still) return []
    const all = !stills?.length ? [still] : stills.some((s) => s.id === still.id) ? stills : [still, ...stills]
    return all.filter((s) => !gone.has(s.id))
  }, [still, stills, gone])
  const index = list.findIndex((s) => s.id === currentId)
  const current = index === -1 ? undefined : list[index]

  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  useEffect(() => setError(undefined), [currentId])

  const open = !!current
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const field = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')
      if (e.key === 'Escape') onClose()
      else if (field) return
      else if (e.key === 'ArrowLeft' && index > 0) step(list[index - 1].id)
      else if (e.key === 'ArrowRight' && index < list.length - 1) step(list[index + 1].id)
      else return
      // Captured and stopped here, so a dialog or view underneath doesn't act on the same key (and close too).
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, index, list, onClose])

  const remove = async (s: Still) => {
    setDeleting(true)
    setError(undefined)
    // Where to go next if it goes: the following still, else the one before.
    const next = list[index + 1] ?? list[index - 1]
    try {
      await window.studio.deleteStill(s.id)
      setGone((g) => new Set(g).add(s.id))
      onDeleted?.(s)
      if (next && next.id !== s.id) setCurrentId(next.id)
      else onClose()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setDeleting(false)
    }
  }

  if (!current) return null

  return createPortal(
    // no-drag: the overlay covers the views' title-bar drag regions.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={stillSourceLabel(current)}
      className="no-drag fixed inset-0 z-[60] flex flex-col bg-black/85 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-10 pt-12"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <StillImage key={current.id} still={current} markSeen={current.id !== heldId} />
        {list.length > 1 && (
          <>
            <NavButton side="left" disabled={index <= 0} onClick={() => step(list[index - 1].id)} />
            <NavButton
              side="right"
              disabled={index >= list.length - 1}
              onClick={() => step(list[index + 1].id)}
            />
          </>
        )}
      </div>

      <StillInfo still={current} position={list.length > 1 ? `${index + 1} of ${list.length}` : undefined}>
        {error && <p className="max-w-md text-[12px] text-accent select-text">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-1">
          {actions?.(current)}
          <button onClick={() => void window.studio.revealFile(current.path)} className={button}>
            Show in {FILE_MANAGER}
          </button>
          {deletable && (
            <ConfirmButton
              question="Delete the image?"
              onConfirm={() => void remove(current)}
              disabled={deleting}
              title={`Moves the image to ${TRASH} (to “Reference images” if a clip or a board uses it)`}
              className={`${button} hover:text-accent`}
            >
              Delete
            </ConfirmButton>
          )}
          <button onClick={onClose} className={button}>
            Close
          </button>
        </div>
      </StillInfo>
    </div>,
    document.body
  )
}

function StillImage({ still, markSeen }: { still: Still; markSeen: boolean }) {
  const [missing, setMissing] = useState(false)
  // A new picture (Activity) has been looked at once it has been on screen here for a moment.
  const imgRef = useRef<HTMLImageElement>(null)
  useSeenWhenVisible(imgRef, missing || !markSeen ? undefined : workKey.still(still.id))
  if (missing) {
    return (
      <p className="max-w-sm text-center text-muted select-text">
        The image file no longer exists.
        <br />
        <span className="text-[11px] break-all">{still.path}</span>
      </p>
    )
  }
  return (
    <img
      ref={imgRef}
      src={mediaUrl(still.path)}
      alt=""
      draggable={false}
      onError={() => setMissing(true)}
      className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
    />
  )
}

function NavButton({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? 'Previous image' : 'Next image'}
      title={side === 'left' ? 'Previous (←)' : 'Next (→)'}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-lg leading-none text-white/80 transition hover:bg-black/80 hover:text-white disabled:opacity-0 ${
        side === 'left' ? 'left-3' : 'right-3'
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}

/** The bottom panel: what the still is and how it was made, with the actions on the right. */
function StillInfo({ still, position, children }: { still: Still; position?: string; children: ReactNode }) {
  const { models } = useImageModels()
  const modelName = still.model ? (models.find((m) => m.id === still.model)?.name ?? still.model) : undefined
  const { aspectRatio, resolution, quality, negativePrompt, referenceImages } = still.params
  const facts = [
    stillSourceLabel(still),
    formatStillTime(still.createdAt),
    modelName,
    aspectRatio && (aspectRatio === 'auto' ? 'aspect ratio of the base image' : aspectRatio),
    resolution,
    quality && `${qualityLabel(quality)} quality`,
    still.costUsd !== undefined && formatImagePrice(still.costUsd),
    position
  ].filter((f): f is string => !!f)

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-line bg-panel px-5 py-3 text-text">
      <div className="min-w-0 flex-1 basis-80">
        <p className="text-[12px] text-muted">{facts.join(' · ')}</p>
        {still.prompt && (
          <p className="mt-1 max-h-24 overflow-y-auto leading-relaxed whitespace-pre-wrap select-text">{still.prompt}</p>
        )}
        {negativePrompt && (
          <p className="mt-1 text-[12px] text-muted select-text">
            <span className="text-text/70">Avoid:</span> {negativePrompt}
          </p>
        )}
        {referenceImages && referenceImages.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted">Made from</span>
            {referenceImages.map((path, i) => (
              <span
                key={path + i}
                title={i === 0 ? `Base image · ${fileName(path)}` : fileName(path)}
                className={`h-8 w-8 overflow-hidden rounded bg-raised ${i === 0 ? 'ring-1 ring-accent/70' : ''}`}
              >
                <img src={mediaUrl(path)} alt="" draggable={false} className="h-full w-full object-cover" />
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">{children}</div>
    </div>
  )
}

export { StillViewer }
