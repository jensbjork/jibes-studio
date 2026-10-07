import { useEffect, useState } from 'react'
import type { SegmentImageSlot, Still } from '@shared/types'
import { ipcErrorMessage } from '../../../lib/hooks'
import StillThumb from '../../images/StillThumb'
import StillViewer from '../../images/StillViewer'
import { CloseIcon, ImageIcon, SparkleIcon } from '../icons'

interface Props {
  stills: Still[]
  loaded: boolean
  /** The selected panel, so the viewer can put a still straight into it. */
  target?: { segmentId: string; number: number }
  onCreateImage: () => void
  onPickFrame: () => void
  onAssign: (segmentId: string, slot: SegmentImageSlot, still: Still) => void
  onError: (message: string) => void
}

const toolButton =
  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text'

/**
 * Every still of the sequence along the bottom of the storyboard (generated images, uploads, frames saved from
 * clips): drag one onto a slot, click to look at it, or delete it in two steps.
 */
export default function StillsStrip({ stills, loaded, target, onCreateImage, onPickFrame, onAssign, onError }: Props) {
  const [viewing, setViewing] = useState<Still>()
  const [confirming, setConfirming] = useState<string>()
  const [deleting, setDeleting] = useState<string>()

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(undefined), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  const remove = async (still: Still) => {
    setConfirming(undefined)
    setDeleting(still.id)
    try {
      // Main refuses, or moves it to Referensbilder instead of the Trash, while a clip still uses it.
      await window.studio.deleteStill(still.id)
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setDeleting(undefined)
    }
  }

  return (
    <section className="shrink-0 border-t border-line bg-panel/50" aria-label="Stillbilder">
      <div className="flex items-center gap-3 px-4 pt-2">
        <h3 className="text-[12px] font-medium">Stillbilder</h3>
        {stills.length > 0 && <span className="text-[11px] text-muted tabular-nums">{stills.length}</span>}
        {stills.length > 0 && <span className="min-w-0 truncate text-[11px] text-muted">Dra en bild till en ruta</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={onPickFrame} className={toolButton} title="Spara en bildruta ur en tagning som stillbild">
            <ImageIcon size={12} />
            Bildruta från ett klipp…
          </button>
          <button type="button" onClick={onCreateImage} className={toolButton} title="Skapa en ny bild med en bildmodell (kostar lite)">
            <SparkleIcon size={12} />
            Skapa bild…
          </button>
        </div>
      </div>

      <div className="flex h-[84px] items-center gap-2 overflow-x-auto px-4 pb-2.5 pt-1.5">
        {!loaded ? null : stills.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted">
            Inga stillbilder än. Bilder du skapar, laddar upp till en ruta eller sparar ur ett klipp samlas här.
          </p>
        ) : (
          stills.map((s) => (
            <StillThumb
              key={s.id}
              still={s}
              draggable
              onOpen={setViewing}
              selected={confirming === s.id}
              className="aspect-video h-full"
            >
              {confirming === s.id ? null : (
                <button
                  type="button"
                  onClick={() => setConfirming(s.id)}
                  disabled={deleting === s.id}
                  title="Radera bilden"
                  aria-label="Radera bilden"
                  className="flex h-5 w-5 items-center justify-center rounded bg-black/70 text-white/80 opacity-0 transition hover:text-accent focus:opacity-100 group-hover:opacity-100"
                >
                  <CloseIcon size={9} />
                </button>
              )}
            </StillThumb>
          ))
        )}
      </div>

      {confirming && (
        <ConfirmBar
          still={stills.find((s) => s.id === confirming)}
          onConfirm={(s) => void remove(s)}
          onCancel={() => setConfirming(undefined)}
        />
      )}

      <StillViewer
        still={viewing}
        stills={stills}
        onClose={() => setViewing(undefined)}
        deletable
        actions={
          target
            ? (s) => (
                <>
                  <button
                    onClick={() => {
                      onAssign(target.segmentId, 'start', s)
                      setViewing(undefined)
                    }}
                    className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text"
                  >
                    Startbild för klipp {target.number}
                  </button>
                  <button
                    onClick={() => {
                      onAssign(target.segmentId, 'end', s)
                      setViewing(undefined)
                    }}
                    className="rounded-md px-3 py-1.5 text-muted transition hover:bg-raised hover:text-text"
                  >
                    Slutbild för klipp {target.number}
                  </button>
                </>
              )
            : undefined
        }
      />
    </section>
  )
}

/** The second step of deleting a still, under the strip (a thumbnail is too small to hold it). */
function ConfirmBar({
  still,
  onConfirm,
  onCancel
}: {
  still?: Still
  onConfirm: (still: Still) => void
  onCancel: () => void
}) {
  if (!still) return null
  return (
    <div className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-[11px]">
      <span className="text-muted">
        Radera bilden? Används den av ett klipp flyttas den till Referensbilder i stället.
      </span>
      <button
        type="button"
        autoFocus
        onClick={() => onConfirm(still)}
        className="rounded bg-accent px-2 py-0.5 font-medium text-white hover:bg-accent-hover"
      >
        Radera
      </button>
      <button type="button" onClick={onCancel} className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-text">
        Avbryt
      </button>
    </div>
  )
}
