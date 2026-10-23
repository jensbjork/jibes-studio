import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { AssetImage } from '@shared/types'
import { originText } from '../../lib/assets'
import { useViewerKeys } from '../../lib/dialogs'
import { focusedWithKeyboard, refocused } from '../../lib/focusOrigin'
import { mediaUrl } from '../../lib/media'
import { FILE_MANAGER, TRASH } from '../../lib/platform'
import ConfirmButton from '../ui/ConfirmButton'
import ViewerNavButton from '../ui/ViewerNavButton'
import { imageIssues, type Size } from './imageUtils'

interface Props {
  images: AssetImage[]
  index: number
  size?: Size
  onSize: (id: string, size: Size) => void
  onIndex: (index: number) => void
  onClose: () => void
  onMakeCover: () => void
  onRemove: () => void
}

/** What removing an image says, here and on its tile: the file isn't simply gone. */
export const REMOVE_IMAGE_TITLE = `Remove the image – the file is moved to ${TRASH}, or to “Reference images” if generations have used it`

const base = 'rounded-md px-3 py-1.5 text-muted hover:bg-raised disabled:opacity-30 disabled:hover:bg-transparent'
const button = `${base} hover:text-text`

/**
 * Full-size view of one library image, as the app's other viewers work: a modal over the window (so ⌘F, ⌘K and the
 * list behind it leave it alone), ← → and the ‹ › on the picture to step, Esc or a click beside the picture to close.
 * Remove asks first, as the tile's ✕ does. It takes the focus while open and gives it back when it closes.
 */
export default function ImagePreview({ images, index, size, onSize, onIndex, onClose, onMakeCover, onRemove }: Props) {
  const image = images[index]
  const issues = size ? imageIssues(size) : []
  const origin = image ? originText(image.origin) : undefined
  const last = images.length - 1

  // At the ends the arrows do nothing, but are still the viewer's: nothing behind it sees them.
  useViewerKeys({
    onClose,
    onPrev: () => index > 0 && onIndex(index - 1),
    onNext: () => index < last && onIndex(index + 1)
  })

  // The keys are the preview's while it is open: the tile behind it (Space, Enter) no longer takes them.
  const dialogRef = useRef<HTMLDivElement>(null)
  const open = !!image
  useEffect(() => {
    if (!open) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const byKeyboard = focusedWithKeyboard(before)
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      // Only when the focus went down with the preview: never taken from what the closing action focused.
      const lost = !document.activeElement || document.activeElement === document.body
      if (lost && before?.isConnected) refocused(before, byKeyboard)
    }
  }, [open])

  if (!image) return null

  return createPortal(
    // no-drag: the overlay covers the views' title-bar drag regions.
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${index + 1} of ${images.length}`}
      tabIndex={-1}
      className="no-drag fixed inset-0 z-[60] flex flex-col bg-black/85 outline-none backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-10 pt-12"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <img
          key={image.id}
          src={mediaUrl(image.path)}
          alt=""
          draggable={false}
          onLoad={(e) =>
            onSize(image.id, { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
          }
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
        />
        {images.length > 1 && (
          <>
            <ViewerNavButton
              side="prev"
              label="Previous image"
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
            />
            <ViewerNavButton
              side="next"
              label="Next image"
              disabled={index === last}
              onClick={() => onIndex(index + 1)}
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-panel px-5 py-3">
        <span className="tabular-nums">
          Image {index + 1} of {images.length}
        </span>
        {size && (
          <span className="text-muted tabular-nums">
            {size.width} × {size.height} px
          </span>
        )}
        {index === 0 && <span className="rounded bg-raised px-1.5 py-0.5 text-[11px]">Cover</span>}
        {origin && <span className="min-w-0 truncate text-muted">{origin}</span>}
        {issues.map((issue) => (
          <span key={issue.label} className="text-warning">
            ⚠ {issue.detail}
          </span>
        ))}

        <div className="ml-auto flex items-center gap-1">
          {index > 0 && (
            <button type="button" onClick={onMakeCover} className={button}>
              Make cover
            </button>
          )}
          <button type="button" onClick={() => void window.studio.revealFile(image.path)} className={button}>
            Show in {FILE_MANAGER}
          </button>
          {/* Keyed by the image: stepping to another one never leaves the question armed for it. */}
          <ConfirmButton
            key={image.id}
            question="Remove the image?"
            confirmLabel="Remove"
            onConfirm={onRemove}
            title={REMOVE_IMAGE_TITLE}
            className={`${base} hover:text-danger`}
          >
            Remove
          </ConfirmButton>
          <button type="button" onClick={onClose} className={button} title="Close (Esc)">
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
