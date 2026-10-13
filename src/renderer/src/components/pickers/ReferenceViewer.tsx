import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Still } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
import { KIND_TONE } from './assetKinds'
import { assetsByPath } from './assetRefs'
import { SwapAssetPicker, SwapImagePicker } from './SwapPicker'

/** One picture of the list the viewer steps through. */
export interface ViewedPicture {
  path: string
  /** Its place in the list: "@Image2", "Startbild", "Basbild". */
  place: string
  /** What it is when it isn't a library photo, e.g. "Bildruta"; default the file name. */
  name?: string
  /** Why it isn't sent, e.g. "Skickas inte – modellen tar max 3 bilder". */
  warning?: string
}

interface Props {
  /** What the list is (screen readers, the swap panel): "Referensbilder", "Startbild". */
  label: string
  pictures: readonly ViewedPicture[]
  /** The picture shown (clamped to the list). */
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  /** The library: names a photo ("Anna · foto 2 av 3") and is what the swap panel offers. */
  library: readonly Asset[]
  /** Saved pictures the swap panel offers; left out, it lists them itself (a sequence's, or all of them). */
  stills?: Still[]
  sequenceId?: string
  /** The saved pictures' heading in the swap panel, e.g. "Storyboardbilder". */
  stillsLabel?: string
  /** Under the swap panel's title: what a swap keeps, e.g. "numret och prompten är kvar". */
  swapHint?: string
  /**
   * "Byt bilden…": another picture takes this place (same number). Returns a note to show, e.g. what the swap left
   * as it was or why nothing changed.
   */
  onSwapImage?: (index: number, path: string) => string | undefined
  /** "Byt hela Anna…": every place of the picture's asset taken by another one. Returns a note, as above. */
  onSwapAsset?: (index: number, to: Asset) => string | undefined
  onRemove?: (index: number) => void
  /**
   * Where focus goes when it closes: the thumbnail of the picture shown last (`index`). Default (or when it gives
   * nothing): what had focus when it opened, if it is still there.
   */
  returnFocus?: (index: number) => HTMLElement | null | undefined
}

const button =
  'rounded-md px-3 py-1.5 text-muted outline-none transition hover:bg-raised hover:text-text focus-visible:ring-2 focus-visible:ring-muted disabled:opacity-30 disabled:hover:bg-transparent'

type Panel = 'image' | 'asset'

/**
 * A reference picture large, over the window: what it is, ← / → through the list's pictures, and its actions –
 * swap it (in place, so its @ImageN and the prompt stay), swap every place of its asset, show it in Finder, remove it.
 * Esc or a click outside closes (the swap panel first, when it is open).
 */
export default function ReferenceViewer({
  label,
  pictures,
  index: wanted,
  onIndex,
  onClose,
  library,
  stills,
  sequenceId,
  stillsLabel,
  swapHint,
  onSwapImage,
  onSwapAsset,
  onRemove,
  returnFocus
}: Props) {
  const index = Math.max(0, Math.min(wanted, pictures.length - 1))
  const picture = pictures[index]
  const byPath = useMemo(() => assetsByPath(library), [library])
  const asset = picture && byPath.get(picture.path)
  // The assets among the list, marked in the asset picker.
  const present = useMemo(
    () => new Set(pictures.flatMap((p) => byPath.get(p.path)?.id ?? [])),
    [pictures, byPath]
  )
  const [panel, setPanel] = useState<Panel | null>(null)
  const [note, setNote] = useState<string>()

  // A new picture on screen (stepped to, or swapped in) starts without the panel; a note stays a while.
  const shownPath = picture?.path
  useEffect(() => setPanel(null), [index, shownPath])
  useEffect(() => setNote(undefined), [index])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(undefined), 8000)
    return () => clearTimeout(t)
  }, [note])

  // Back on the thumbnail of the picture shown last (or whatever opened it) when it closes.
  const opener = useRef<Element | null>(null)
  const first = useRef<HTMLButtonElement>(null)
  const last = useRef({ index, returnFocus })
  last.current = { index, returnFocus }
  useEffect(() => {
    opener.current = document.activeElement
    first.current?.focus({ preventScroll: true })
    return () => {
      const { index: at, returnFocus: target } = last.current
      const el = target?.(at) ?? opener.current
      if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true })
    }
  }, [])

  /** Closes the swap panel, focus back on the actions (the panel's field or button it had goes with it). */
  const closePanel = () => {
    setPanel(null)
    first.current?.focus({ preventScroll: true })
  }

  const open = !!picture
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const field = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')
      if (e.key === 'Escape') {
        if (panel) closePanel()
        else onClose()
      } else if (field) return
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      else if (e.key === 'ArrowRight' && index < pictures.length - 1) onIndex(index + 1)
      else return
      // Captured and stopped here, so a dialog or view underneath doesn't act on the same key (and close too).
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, panel, index, pictures.length, onIndex, onClose])

  if (!picture) return null

  const fileName = picture.path.split('/').pop() ?? picture.path
  const photo = asset ? asset.images.findIndex((img) => img.path === picture.path) : -1
  const what = asset
    ? [asset.name, asset.images.length > 1 ? `foto ${photo + 1} av ${asset.images.length}` : undefined]
    : [picture.name ?? fileName]
  const heading = [picture.place, ...what].filter(Boolean).join(' · ')

  const closeOrPanel = () => (panel ? closePanel() : onClose())
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p))

  // The picture swapped in shows at once, in the same place; what the swap left as it was is said under it.
  const swapImage = (path: string) => {
    const said = onSwapImage?.(index, path)
    closePanel()
    setNote(said)
  }
  const swapAsset = (to: Asset) => {
    const said = onSwapAsset?.(index, to)
    closePanel()
    setNote(said)
  }

  const placeOf = (path: string): string | undefined => {
    const at = pictures.findIndex((p) => p.path === path)
    return at === -1 ? undefined : pictures[at].place
  }

  return createPortal(
    // no-drag: the overlay covers the views' title-bar drag regions.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${label}: ${heading}`}
      className="no-drag fixed inset-0 z-[60] flex bg-black/85 text-text backdrop-blur-sm"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center p-10 pt-12"
          onMouseDown={(e) => e.target === e.currentTarget && closeOrPanel()}
        >
          <Picture key={picture.path} path={picture.path} dim={!!picture.warning} />
          {pictures.length > 1 && (
            <>
              <NavButton side="left" disabled={index <= 0} onClick={() => onIndex(index - 1)} />
              <NavButton side="right" disabled={index >= pictures.length - 1} onClick={() => onIndex(index + 1)} />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-line bg-panel px-5 py-3">
          <div className="min-w-0 flex-1 basis-72">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{heading}</span>
              {asset && <span className={`text-[11px] ${KIND_TONE[asset.kind].text}`}>{ASSET_COPY[asset.kind].singular}</span>}
              {pictures.length > 1 && (
                <span className="text-[11px] text-muted">
                  {index + 1} av {pictures.length}
                </span>
              )}
            </p>
            {picture.warning && <p className="mt-0.5 text-[12px] text-accent">{picture.warning}</p>}
            {asset && (
              <p className="mt-0.5 truncate text-[11px] text-muted select-text" title={picture.path}>
                {fileName}
              </p>
            )}
            {note && (
              <p role="status" className="mt-1 max-w-xl text-[12px] leading-snug text-accent">
                {note}
              </p>
            )}
            {pictures.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label={label} role="group">
                {pictures.map((p, i) => (
                  <button
                    key={`${p.path}\u0000${i}`}
                    onClick={() => onIndex(i)}
                    aria-label={p.place}
                    aria-current={i === index ? 'true' : undefined}
                    title={p.warning ? `${p.place} · ${p.warning}` : p.place}
                    className={`h-10 w-10 overflow-hidden rounded bg-raised outline-none ring-offset-2 ring-offset-panel transition focus-visible:ring-2 focus-visible:ring-muted ${
                      i === index ? 'ring-2 ring-text' : 'opacity-70 hover:opacity-100'
                    } ${p.warning ? 'opacity-40' : ''}`}
                  >
                    <img src={mediaUrl(p.path)} alt="" draggable={false} decoding="async" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {onSwapImage && (
              <button
                ref={first}
                onClick={() => toggle('image')}
                aria-expanded={panel === 'image'}
                className={`${button} ${panel === 'image' ? 'bg-raised text-text' : ''}`}
                title="Välj en annan bild till samma plats – numret och prompten är kvar"
              >
                Byt bilden…
              </button>
            )}
            {onSwapAsset && asset && (
              <button
                onClick={() => toggle('asset')}
                aria-expanded={panel === 'asset'}
                className={`${button} ${panel === 'asset' ? 'bg-raised text-text' : ''}`}
                title={`Byt ${asset.name} mot något annat ur biblioteket på alla platser – numren och prompten är kvar`}
              >
                Byt hela {asset.name}…
              </button>
            )}
            <button onClick={() => void window.studio.revealFile(picture.path)} className={button}>
              Visa i Finder
            </button>
            {onRemove && (
              <button onClick={() => onRemove(index)} className={`${button} hover:text-accent`}>
                Ta bort
              </button>
            )}
            <button ref={onSwapImage ? undefined : first} onClick={onClose} className={button}>
              Stäng
            </button>
          </div>
        </div>
      </div>

      {panel && (
        <aside className="flex w-[360px] max-w-[45vw] shrink-0 flex-col border-l border-line bg-panel" aria-label="Byt">
          {panel === 'image' ? (
            <SwapImagePicker
              title={`Byt ${
                picture.place.startsWith('@')
                  ? picture.place
                  : picture.place.charAt(0).toLocaleLowerCase('sv') + picture.place.slice(1)
              } mot…`}
              hint={swapHint}
              library={library}
              current={picture.path}
              currentKind={asset?.kind}
              placeOf={placeOf}
              stills={stills}
              sequenceId={sequenceId}
              stillsLabel={stillsLabel}
              onPick={swapImage}
              onClose={closePanel}
            />
          ) : (
            asset && (
              <SwapAssetPicker
                title={`Byt hela ${asset.name} mot…`}
                hint={
                  `Alla platser där ${asset.name} finns får den nya i stället – numren i prompten är desamma, och ` +
                  `namnet framför dem byts. Har båda ${asset.kind === 'character' ? 'en röst' : 'ljud'} byts ${
                    asset.kind === 'character' ? 'den' : 'det'
                  } också.`
                }
                library={library}
                from={asset}
                present={present}
                onPick={swapAsset}
                onClose={closePanel}
              />
            )
          )}
        </aside>
      )}
    </div>,
    document.body
  )
}

function Picture({ path, dim }: { path: string; dim: boolean }) {
  const [missing, setMissing] = useState(false)
  if (missing) {
    return (
      <p className="max-w-sm text-center text-muted select-text">
        Bildfilen finns inte längre.
        <br />
        <span className="text-[11px] break-all">{path}</span>
      </p>
    )
  }
  return (
    <img
      src={mediaUrl(path)}
      alt=""
      draggable={false}
      onError={() => setMissing(true)}
      className={`max-h-full max-w-full rounded-md object-contain shadow-2xl ${dim ? 'opacity-60' : ''}`}
    />
  )
}

function NavButton({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? 'Föregående bild' : 'Nästa bild'}
      title={side === 'left' ? 'Föregående (←)' : 'Nästa (→)'}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-lg leading-none text-white/80 transition hover:bg-black/80 hover:text-white disabled:opacity-0 ${
        side === 'left' ? 'left-3' : 'right-3'
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}
