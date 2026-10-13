import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Asset } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { KIND_TONE } from '../pickers/assetKinds'
import ReferenceViewer, { type ViewedPicture } from '../pickers/ReferenceViewer'

// The pictures of an approval request: small tiles that light up with the prompt's tokens naming them, and the
// large viewer they open in. The viewer is read only here – a request can be looked at from the dialog, not changed.

/** A library photo: its asset and its place among the asset's photos. */
export interface Photo {
  asset: Asset
  /** 1-based among the asset's photos. */
  number: number
}

/** Opens `pictures` in the viewer at `index`; `label` says what the list is ("Referensbilder"). */
type View = (label: string, pictures: readonly ViewedPicture[], index: number) => void

const ViewContext = createContext<View | undefined>(undefined)

/** The viewer for the request's pictures, over the dialog; Esc closes it first, the dialog stays. */
export function ApprovalViewer({ library, children }: { library: readonly Asset[]; children: ReactNode }) {
  const [viewing, setViewing] = useState<{ label: string; pictures: readonly ViewedPicture[]; index: number }>()
  return (
    <ViewContext.Provider value={(label, pictures, index) => setViewing({ label, pictures, index })}>
      {children}
      {viewing && viewing.pictures.length > 0 && (
        <ReferenceViewer
          label={viewing.label}
          pictures={viewing.pictures}
          index={viewing.index}
          onIndex={(index) => setViewing((v) => v && { ...v, index })}
          onClose={() => setViewing(undefined)}
          library={library}
        />
      )}
    </ViewContext.Provider>
  )
}

/** Opens pictures large in the dialog's viewer; undefined outside ApprovalViewer (the tiles then don't open). */
export function useViewPictures(): View | undefined {
  return useContext(ViewContext)
}

/**
 * One picture of a request: a reference photo, a start or end image, a frame. Clicking it (with `onOpen`) shows it
 * large; `lit` rings it while a token naming it is hovered, and `onLight` tells while it is hovered itself.
 */
export function ImageTile({
  path,
  badge,
  photo,
  caption,
  captionTone,
  large,
  title,
  onOpen,
  lit,
  onLight
}: {
  path: string
  badge: string
  photo?: Photo
  /** Shown along the bottom instead of the photo's asset name. */
  caption?: string
  captionTone?: string
  /** A bigger, wide tile (frames and stills rather than reference photos). */
  large?: boolean
  /** The hover text's name when it says more than the caption. */
  title?: string
  onOpen?: () => void
  lit?: boolean
  onLight?: (on: boolean) => void
}) {
  const [missing, setMissing] = useState(false)
  const name =
    title ?? caption ?? (photo ? `${photo.asset.name} (foto ${photo.number})` : (path.split('/').pop() ?? path))
  const Root = onOpen ? 'button' : 'div'
  return (
    <Root
      type={onOpen ? 'button' : undefined}
      onClick={onOpen}
      onMouseEnter={() => onLight?.(true)}
      onMouseLeave={() => onLight?.(false)}
      onFocus={(e) => e.currentTarget.matches(':focus-visible') && onLight?.(true)}
      onBlur={() => onLight?.(false)}
      title={`${missing ? `Filen saknas: ${path}` : `${badge} · ${name}`}${onOpen ? ' – klicka för att förstora' : ''}`}
      className={`relative block shrink-0 overflow-hidden rounded bg-raised text-left transition-shadow ${large ? 'h-24 w-40' : 'h-16 w-16'} ${
        lit ? 'ring-2 ring-white/70' : missing ? 'ring-1 ring-accent' : ''
      } ${onOpen ? 'cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-white/70' : ''}`}
    >
      {missing ? (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
          Filen saknas
        </span>
      ) : (
        <img
          src={mediaUrl(path)}
          alt=""
          draggable={false}
          onError={() => setMissing(true)}
          className="h-full w-full object-cover"
        />
      )}
      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">{badge}</span>
      {caption ? (
        <span
          className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${captionTone ?? 'bg-black/60'}`}
        >
          {caption}
        </span>
      ) : (
        photo && (
          <span
            className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${KIND_TONE[photo.asset.kind].caption}`}
          >
            {photo.asset.name}
          </span>
        )
      )}
    </Root>
  )
}
