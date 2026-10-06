import { useState, type ReactNode } from 'react'
import { mediaUrl } from '../lib/media'

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i

/** A label on a thumbnail, e.g. the library asset the photo belongs to. */
export interface ImageCaption {
  text: string
  /** Tooltip; defaults to the text. */
  title?: string
  /** Background of the name strip (e.g. the asset kind's colour); defaults to a dark strip. */
  className?: string
}

interface Props {
  label: string
  hint?: string
  multiple?: boolean
  max?: number
  value: string[]
  onChange: (paths: string[]) => void
  /** Extra controls in the header row, e.g. library picker buttons. */
  action?: ReactNode
  /** Short label on a thumbnail, e.g. the character or environment the image belongs to. */
  caption?: (path: string) => ImageCaption | string | undefined
  /** Show "n/max" in the header (multiple only); off when the form shows the image budget elsewhere. */
  showCount?: boolean
}

/** Drop zone + thumbnails for one or more local images. */
export default function ImageInput({
  label,
  hint,
  multiple = false,
  max = 1,
  value,
  onChange,
  action,
  caption,
  showCount = true
}: Props) {
  const [over, setOver] = useState(false)
  // Remembered images can point at files that were deleted since (e.g. a removed character photo).
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())

  const add = (paths: string[]) => {
    const images = paths.filter((p) => IMAGE_EXT.test(p))
    if (!images.length) return
    if (!multiple) return onChange(images.slice(0, 1))
    onChange([...value, ...images.filter((p, i) => !value.includes(p) && images.indexOf(p) === i)].slice(0, max))
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    add(Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f)))
  }

  const pick = async () => add(await window.studio.pickImages(multiple))
  const full = value.length >= (multiple ? max : 1)

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-muted">{label}</span>
        <span className="flex items-center gap-2">
          {action}
          {multiple && showCount && (
            <span className={`text-[11px] ${value.length > max ? 'text-accent' : 'text-muted'}`}>
              {value.length}/{max}
            </span>
          )}
        </span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex flex-wrap gap-2 rounded-md border border-dashed p-2 transition ${
          over ? 'border-accent bg-accent/5' : 'border-line'
        }`}
      >
        {value.map((p, i) => {
          const overflow = multiple && i >= max
          const raw = caption?.(p)
          const cap = typeof raw === 'string' ? { text: raw } : raw
          const name = p.split('/').pop()
          return (
            <div
              key={p + i}
              title={
                overflow
                  ? `Skickas inte – modellen tar max ${max} bilder`
                  : missing.has(p)
                    ? `Filen saknas: ${p}`
                    : cap
                      ? `${cap.title ?? cap.text} · ${name}`
                      : name
              }
              className={`group relative h-16 w-16 overflow-hidden rounded bg-raised ${overflow ? 'opacity-40' : ''} ${
                missing.has(p) ? 'ring-1 ring-accent' : ''
              }`}
            >
              {missing.has(p) ? (
                <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
                  Filen saknas
                </span>
              ) : (
                <img
                  src={mediaUrl(p)}
                  onError={() => setMissing((s) => new Set(s).add(p))}
                  className="h-full w-full object-cover"
                />
              )}
              {multiple && (
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">@Image{i + 1}</span>
              )}
              {cap && (
                <span
                  className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${
                    cap.className ?? 'bg-black/70'
                  }`}
                >
                  {cap.text}
                </span>
              )}
              <button
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] group-hover:flex"
                title="Ta bort"
              >
                ✕
              </button>
            </div>
          )
        })}
        {!full && (
          <button
            onClick={pick}
            className="flex h-16 min-w-16 flex-1 items-center justify-center rounded text-muted hover:bg-raised hover:text-text"
          >
            {value.length ? '+' : 'Släpp bild här eller klicka'}
          </button>
        )}
      </div>
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  )
}
