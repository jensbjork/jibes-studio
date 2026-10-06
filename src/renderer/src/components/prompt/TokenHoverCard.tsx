import { createPortal } from 'react-dom'
import { ASSET_COPY } from '../../lib/assets'
import { KIND_TONE } from '../pickers/assetKinds'
import { placeBeside } from './textareaDom'
import { Thumb } from './TokenMenu'
import { fileName, referenceTitle, type PromptMark, type PromptReference } from './promptText'

interface Props {
  mark: PromptMark
  /** The picture a valid token names. */
  reference?: PromptReference
  /** The token's line box on screen. */
  rect: DOMRect
}

const WIDTH = 260

/** What an @ImageN token in the prompt points at, or what is wrong with it. Shown while hovering it. */
export default function TokenHoverCard({ mark, reference, rect }: Props) {
  const place = placeBeside(rect, WIDTH, 200, 120)
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-lg border border-line bg-panel p-2 text-text shadow-2xl shadow-black/60"
      style={{ top: place.top, bottom: place.bottom, left: place.left, width: WIDTH }}
    >
      {mark.tone === 'valid' && reference ? (
        <div className="flex items-center gap-2.5">
          <Thumb path={reference.path} className="h-14 w-14" />
          <span className="min-w-0">
            <span className="block font-medium">{referenceTitle(reference)}</span>
            <span
              className={`block truncate text-[11px] ${reference.asset ? KIND_TONE[reference.asset.kind].text : 'text-muted'}`}
            >
              {reference.asset ? ASSET_COPY[reference.asset.kind].singular : fileName(reference.path)}
            </span>
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2.5">
          {reference && <Thumb path={reference.path} className="h-10 w-10 opacity-60" />}
          <span className="min-w-0">
            <span
              className={`block text-[12px] leading-snug ${mark.tone === 'warning' ? 'text-amber-200' : 'text-red-300'}`}
            >
              {mark.problem ?? 'Hänvisningen är fel.'}
            </span>
            {mark.tone === 'error' && (
              <span className="mt-1 block text-[11px] text-muted">Rättningsförslag finns under prompten.</span>
            )}
          </span>
        </div>
      )}
    </div>,
    document.body
  )
}
