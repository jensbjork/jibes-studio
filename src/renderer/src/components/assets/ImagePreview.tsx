import { useEffect } from 'react'
import type { AssetImage } from '@shared/types'
import { originText } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
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

const base = 'rounded-md px-3 py-1.5 text-muted hover:bg-raised disabled:opacity-30 disabled:hover:bg-transparent'
const button = `${base} hover:text-text`
const arrow = `${base} text-base leading-none hover:text-text`

/** Full-size view of one library image, with arrow-key navigation. */
export default function ImagePreview({ images, index, size, onSize, onIndex, onClose, onMakeCover, onRemove }: Props) {
  const image = images[index]
  const issues = size ? imageIssues(size) : []
  const origin = originText(image.origin)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onClose, onIndex])

  if (!image) return null

  return (
    // no-drag: the overlay covers the views' title-bar drag regions.
    <div className="no-drag fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-0 flex-1 items-center justify-center p-10 pt-12">
        <img
          key={image.id}
          src={mediaUrl(image.path)}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onLoad={(e) =>
            onSize(image.id, { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
          }
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
        />
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-panel px-5 py-3"
      >
        <div className="flex items-center gap-1">
          <button onClick={() => onIndex(index - 1)} disabled={index === 0} className={arrow} title="Föregående (←)">
            ‹
          </button>
          <span className="min-w-20 text-center tabular-nums">
            Bild {index + 1} av {images.length}
          </span>
          <button
            onClick={() => onIndex(index + 1)}
            disabled={index === images.length - 1}
            className={arrow}
            title="Nästa (→)"
          >
            ›
          </button>
        </div>
        {size && (
          <span className="text-muted tabular-nums">
            {size.width} × {size.height} px
          </span>
        )}
        {index === 0 && <span className="rounded bg-raised px-1.5 py-0.5 text-[11px]">Omslag</span>}
        {origin && <span className="min-w-0 truncate text-muted">{origin}</span>}
        {issues.map((issue) => (
          <span key={issue.label} className="text-amber-400">
            ⚠ {issue.detail}
          </span>
        ))}

        <div className="ml-auto flex items-center gap-1">
          {index > 0 && (
            <button onClick={onMakeCover} className={button}>
              Sätt som omslag
            </button>
          )}
          <button onClick={() => void window.studio.revealFile(image.path)} className={button}>
            Visa i Finder
          </button>
          <button onClick={onRemove} className={`${base} hover:text-accent`}>
            Ta bort
          </button>
          <button onClick={onClose} className={button} title="Stäng (Esc)">
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
