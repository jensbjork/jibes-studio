import { useRef, useState, type DragEvent } from 'react'
import type { Asset, AssetKind, BoardImageSource, Still, StoryboardBoard } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import StillThumb, { isStillDrag, stillIdFromDrop } from '../images/StillThumb'
import AssetPicker from '../pickers/AssetPicker'
import Popover from '../pickers/Popover'
import { ImageIcon, SparkleIcon } from '../sequences/icons'
import { menuRow, onMenuKeyDown, SubView } from './ui'

const IMAGE_FILE = /\.(jpe?g|png|webp)$/i

/** Image files among dropped files, in the order they were dropped. */
export function droppedImagePaths(e: Pick<DragEvent, 'dataTransfer'>): { paths: string[]; other: boolean } {
  const files = Array.from(e.dataTransfer.files)
  const images = files.filter((f) => IMAGE_FILE.test(f.name))
  return { paths: images.map((f) => window.studio.pathForFile(f)), other: images.length < files.length }
}

/** Whether a drag carries something a board can take: a still of Studio's, or files from Finder. */
export function acceptsImageDrag(e: Pick<DragEvent, 'dataTransfer'>): boolean {
  return isStillDrag(e) || Array.from(e.dataTransfer.types).includes('Files')
}

export const DROP_ONLY_IMAGES = 'Släpp en bild i JPG-, PNG- eller WebP-format.'

interface Props {
  board: StoryboardBoard
  /** 1-based. */
  number: number
  width: number
  height: number
  /** This storyboard's pictures ("Storyboardbilder"), newest first. */
  stills: Still[]
  assets: Asset[]
  /** A change to the picture is being saved (a file copied, a frame cut out). */
  busy: boolean
  /** ffmpeg is installed: without it no frame can be cut out of a clip. */
  ffmpegOk: boolean
  onSet: (source: BoardImageSource | null) => void
  onCreateImage: () => void
  onPickFrame: () => void
  /** Shows one of the storyboard's pictures full size, where it can be used here or deleted. */
  onViewStill: (still: Still) => void
  /** Opens a library view (from the library picker's empty state). */
  onManage: (kind: AssetKind) => void
  onError: (message: string) => void
}

type MenuView = 'menu' | 'library' | 'stills'

/**
 * A board's one picture, large. Empty, it offers the two ways in (make one, or pick one); filled, the picture is
 * the button that opens the same menu: Skapa bild…, Från biblioteket, Storyboardbilder, Ladda upp, Bildruta ur
 * ett klipp, Ta bort bilden. A picture or a still dropped on it replaces what is there. The storyboard's pictures
 * can also be opened full size from there (onViewStill), to be used or deleted.
 */
export default function BoardImage({
  board,
  number,
  width,
  height,
  stills,
  assets,
  busy,
  ffmpegOk,
  onSet,
  onCreateImage,
  onPickFrame,
  onViewStill,
  onManage,
  onError
}: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<MenuView>()
  const [over, setOver] = useState(false)
  const [missing, setMissing] = useState<string>()
  const path = board.imagePath
  const label = `Ruta ${number}`

  const close = () => setView(undefined)
  const toggleMenu = () => setView(view ? undefined : 'menu')
  const choose = (source: BoardImageSource | null) => {
    close()
    onSet(source)
  }

  const upload = async () => {
    close()
    const [picked] = await window.studio.pickImages(false)
    if (picked) onSet({ kind: 'file', path: picked })
  }

  // ── Drop ───────────────────────────────────────────────────────────────────

  const onDragOver = (e: DragEvent) => {
    // Anything else (a board being reordered) is left to the row around it.
    if (!acceptsImageDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  const onDrop = (e: DragEvent) => {
    if (!acceptsImageDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const stillId = stillIdFromDrop(e)
    if (stillId) return onSet({ kind: 'still', stillId })
    const [first] = droppedImagePaths(e).paths
    if (first) onSet({ kind: 'file', path: first })
    else onError(DROP_ONLY_IMAGES)
  }

  return (
    <div
      className="relative shrink-0"
      style={{ width, height }}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={onDrop}
    >
      {path ? (
        <button
          ref={anchor}
          type="button"
          onClick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={!!view}
          aria-label={`Bilden i ${label.toLowerCase()} – byt eller ta bort`}
          title={board.note ? `${board.note}\n\nKlicka för att byta bild.` : 'Klicka för att byta bild.'}
          className="group/image relative block h-full w-full overflow-hidden rounded-lg bg-black outline-none ring-offset-2 ring-offset-bg focus-visible:ring-2 focus-visible:ring-muted"
        >
          {missing === path ? (
            <span className="flex h-full w-full items-center justify-center p-3 text-center text-[12px] text-accent">
              Bildfilen saknas – välj en ny bild
            </span>
          ) : (
            <img
              src={mediaUrl(path)}
              alt={board.note || label}
              draggable={false}
              decoding="async"
              onError={() => setMissing(path)}
              className="h-full w-full object-contain"
            />
          )}
          <span className="absolute right-2 top-2 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white/90 opacity-0 transition group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
            Byt bild
          </span>
          {board.aspectMismatch && (
            <span
              title="Bildformatet skiljer sig – klippet får bildens format"
              className="absolute bottom-2 left-2 rounded bg-amber-500/90 px-1.5 py-px text-[10px] font-medium text-black"
            >
              Annat format
            </span>
          )}
        </button>
      ) : (
        <div
          className={`flex h-full w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-3 text-center transition ${
            over ? 'border-accent bg-accent/5' : 'border-line bg-panel/40'
          }`}
        >
          <ImageIcon size={22} className="text-muted/70" />
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <button
              type="button"
              onClick={onCreateImage}
              title="Skapa en ny bild med en bildmodell (kostar lite)"
              className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] text-text transition hover:border-muted"
            >
              <SparkleIcon size={12} />
              Skapa bild…
            </button>
            <button
              ref={anchor}
              type="button"
              onClick={toggleMenu}
              aria-haspopup="menu"
              aria-expanded={!!view}
              title="Från biblioteket, storyboardens bilder, en fil eller en bildruta ur ett klipp"
              className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-muted transition hover:border-muted hover:text-text"
            >
              Välj bild…
            </button>
          </div>
          <span className="text-[11px] text-muted/70">eller släpp en bild här</span>
        </div>
      )}

      {over && path && (
        <span className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-accent ring-inset" aria-hidden />
      )}
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-[12px] text-muted">
          <span className="animate-pulse">Sparar…</span>
        </span>
      )}

      <Popover
        anchorRef={anchor}
        open={!!view}
        onClose={close}
        width={view === 'menu' ? 250 : 340}
        maxHeight={view === 'menu' ? 400 : 480}
        label={`Bild för ${label.toLowerCase()}`}
      >
        {view === 'library' ? (
          <SubView onBack={() => setView('menu')}>
            <AssetPicker
              assets={assets}
              initialKind="environment"
              title={`Bild för ${label.toLowerCase()}`}
              hint="Klicka på en bild – eller på namnet för omslagsbilden."
              selectedPaths={path ? [path] : []}
              onPickImage={(picked, asset) => {
                const image = asset.images.find((img) => img.path === picked)
                if (image) choose({ kind: 'asset-image', imageId: image.id })
              }}
              onManage={(kind) => {
                close()
                onManage(kind)
              }}
            />
          </SubView>
        ) : view === 'stills' ? (
          <SubView title="Storyboardens bilder" onBack={() => setView('menu')}>
            <div className="grid min-h-0 flex-1 grid-cols-3 gap-1.5 overflow-y-auto p-2">
              {stills.map((s) => (
                <StillThumb
                  key={s.id}
                  still={s}
                  className="aspect-video w-full"
                  selected={s.id === board.stillId || s.path === path}
                  onOpen={() => choose({ kind: 'still', stillId: s.id })}
                >
                  <button
                    type="button"
                    onClick={() => {
                      close()
                      onViewStill(s)
                    }}
                    title="Visa bilden i full storlek – med hur den gjordes, och Radera"
                    aria-label="Visa bilden"
                    className="rounded bg-black/70 px-1.5 py-px text-[10px] text-white/90 opacity-0 transition hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    Visa
                  </button>
                </StillThumb>
              ))}
            </div>
          </SubView>
        ) : (
          <div role="menu" aria-label={`Bild för ${label.toLowerCase()}`} onKeyDown={onMenuKeyDown} className="overflow-y-auto p-1">
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted">{label}</p>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              autoFocus
              onClick={() => {
                close()
                onCreateImage()
              }}
              className={menuRow}
            >
              <SparkleIcon size={12} className="shrink-0 text-muted" />
              Skapa bild…
            </button>
            <button type="button" role="menuitem" data-menu-item onClick={() => setView('library')} className={menuRow}>
              Från biblioteket…
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={!stills.length}
              onClick={() => setView('stills')}
              title={stills.length ? undefined : 'Storyboarden har inga egna bilder än'}
              className={menuRow}
            >
              Storyboardbilder…
              {stills.length > 0 && <span className="ml-auto text-[11px] tabular-nums text-muted">{stills.length}</span>}
            </button>
            <button type="button" role="menuitem" data-menu-item onClick={() => void upload()} className={menuRow}>
              Ladda upp en bild…
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              disabled={!ffmpegOk}
              onClick={() => {
                close()
                onPickFrame()
              }}
              title={ffmpegOk ? undefined : 'Kräver ffmpeg (brew install ffmpeg)'}
              className={menuRow}
            >
              Bildruta ur ett klipp…
              {/* A disabled row shows no tooltip, so the reason is in the row itself. */}
              {!ffmpegOk && <span className="ml-auto text-[11px] text-muted">kräver ffmpeg</span>}
            </button>
            {path && (
              <>
                <div className="mx-2 my-1 border-t border-line" />
                <button
                  type="button"
                  role="menuitem"
                  data-menu-item
                  onClick={() => choose(null)}
                  title="Rutan blir tom igen. Själva bilden raderas inte."
                  className={`${menuRow} text-muted hover:text-accent`}
                >
                  Ta bort bilden
                </button>
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  )
}
