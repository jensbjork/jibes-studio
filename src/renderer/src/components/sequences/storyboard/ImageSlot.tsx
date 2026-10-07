import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { Asset, AssetKind, SegmentImageSlot, SegmentImageSource, Still } from '@shared/types'
import { mediaUrl } from '../../../lib/media'
import StillThumb, { isStillDrag, stillIdFromDrop } from '../../images/StillThumb'
import AssetPicker from '../../pickers/AssetPicker'
import Popover from '../../pickers/Popover'
import { ImageIcon, LinkIcon, MoreIcon, SparkleIcon } from '../icons'
import { formatFrameTime } from '../sequenceUtils'
import { autoLabel, type ImageLabel, type SlotState } from './slots'

const IMAGE_FILE = /\.(jpe?g|png|webp)$/i

/** The automatic frame of an 'auto' slot, as previewSegmentFrames found it. */
export interface AutoFrame {
  path?: string
  /** Seconds into the neighbour's take. */
  time?: number
  loading: boolean
}

interface Props {
  slot: SegmentImageSlot
  state: SlotState
  /** 1-based number of the clip the slot belongs to. */
  number: number
  hasPrevious: boolean
  hasNext: boolean
  autoFrame?: AutoFrame
  /** Caption of an 'image' slot (which still or library photo it is). */
  label?: ImageLabel
  width: number
  height: number
  stills: Still[]
  assets: Asset[]
  /** A change to this slot is being saved (a frame may be extracted, a file copied). */
  busy: boolean
  onSet: (source: SegmentImageSource | null) => void
  onCreateImage: () => void
  onPickFrame: () => void
  /** Opens a library view (from the library picker's empty state). */
  onManage?: (kind: AssetKind) => void
  onError: (message: string) => void
}

type MenuView = 'menu' | 'library' | 'stills'

const menuRow =
  'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left outline-none transition hover:bg-raised focus-visible:bg-raised disabled:pointer-events-none disabled:opacity-40'

function onMenuKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-menu-item]:not(:disabled)')]
  if (!items.length) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1
  items[next].focus()
}

/**
 * One keyframe slot of a storyboard panel (start or end image). Shows the picture, the neighbour's frame it is
 * taken from, or the choices for an empty slot; accepts a dropped still or image file; its menu offers every way
 * to fill it: upload, the library, the sequence's stills, a frame from a clip, a new image, the neighbour's frame.
 */
export default function ImageSlot({
  slot,
  state,
  number,
  hasPrevious,
  hasNext,
  autoFrame,
  label,
  width,
  height,
  stills,
  assets,
  busy,
  onSet,
  onCreateImage,
  onPickFrame,
  onManage,
  onError
}: Props) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<MenuView>()
  const [over, setOver] = useState(false)
  const [missing, setMissing] = useState<string>()
  const name = slot === 'start' ? 'Startbild' : 'Slutbild'
  // The neighbour this slot can take its frame from, by clip number.
  const neighbour = slot === 'start' ? (hasPrevious ? number - 1 : undefined) : hasNext ? number + 1 : undefined
  const filled = state.kind !== 'empty'
  // Small slots keep the choices on one row: "Skapa bild" shrinks to its icon.
  const roomy = width >= 210

  const close = () => setView(undefined)
  const toggleMenu = () => setView(view ? undefined : 'menu')
  const choose = (source: SegmentImageSource | null) => {
    close()
    onSet(source)
  }

  const upload = async () => {
    close()
    const [path] = await window.studio.pickImages(false)
    if (path) onSet({ kind: 'file', path })
  }

  // ── Drop ───────────────────────────────────────────────────────────────────

  const accepts = (e: DragEvent) => isStillDrag(e) || Array.from(e.dataTransfer.types).includes('Files')

  const onDragOver = (e: DragEvent) => {
    // Anything else (a panel being reordered) is left to the storyboard around it.
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const stillId = stillIdFromDrop(e)
    if (stillId) return onSet({ kind: 'still', stillId })
    const file = Array.from(e.dataTransfer.files).find((f) => IMAGE_FILE.test(f.name))
    if (file) onSet({ kind: 'file', path: window.studio.pathForFile(file) })
    else onError('Släpp en bild i JPG-, PNG- eller WebP-format.')
  }

  // ── Content ────────────────────────────────────────────────────────────────

  let content: ReactNode
  if (state.kind === 'auto') {
    const caption = autoLabel(slot, state.fromClip)
    const time = autoFrame?.time !== undefined && (slot === 'start' || autoFrame.time > 0) ? ` (${formatFrameTime(autoFrame.time)})` : ''
    content = (
      <SlotButton anchor={anchor} name={name} onOpen={toggleMenu} title={`${name}: ${caption.toLowerCase()}${time}. Klicka för att ändra.`}>
        {autoFrame?.path && missing !== autoFrame.path ? (
          <img src={mediaUrl(autoFrame.path)} alt="" draggable={false} onError={() => setMissing(autoFrame.path)} className="h-full w-full object-cover" />
        ) : (
          <span
            className={`flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-line bg-panel px-3 pb-5 text-center text-[11px] text-muted ${
              autoFrame?.loading ? 'animate-pulse' : ''
            }`}
          >
            <LinkIcon size={14} />
            {autoFrame?.loading
              ? 'Hämtar bildrutan…'
              : autoFrame?.path
                ? 'Bildrutan kunde inte visas'
                : `Klipp ${state.fromClip} har ingen färdig tagning än`}
          </span>
        )}
        <Caption>
          <LinkIcon size={10} className="mt-px shrink-0 self-start" />
          <span className="line-clamp-2">
            {caption}
            {time}
          </span>
        </Caption>
      </SlotButton>
    )
  } else if (state.kind === 'image') {
    content = (
      <SlotButton
        anchor={anchor}
        name={name}
        onOpen={toggleMenu}
        title={`${name}: ${label?.title ?? label?.text ?? ''}${state.unsent ? `\n${state.unsent}` : ''}${state.refused ? `\n${state.refused}` : ''}\nKlicka för att ändra.`}
      >
        {missing === state.path ? (
          <span className="flex h-full w-full items-center justify-center bg-raised p-2 text-center text-[11px] text-accent">
            Bilden saknas
          </span>
        ) : (
          <img src={mediaUrl(state.path)} alt="" draggable={false} onError={() => setMissing(state.path)} className="h-full w-full object-cover" />
        )}
        {(state.unsent || state.refused) && (
          <span className="absolute left-1.5 top-1.5 rounded bg-amber-500/90 px-1.5 py-px text-[10px] font-medium text-black">
            {state.refused ? 'Byt modell' : 'Skickas inte'}
          </span>
        )}
        {label && (
          <Caption>
            <span className="truncate">{label.text}</span>
          </Caption>
        )}
      </SlotButton>
    )
  } else {
    content = (
      <div
        className={`flex h-full w-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed px-2 text-center transition ${
          over ? 'border-accent bg-accent/5' : 'border-line'
        }`}
      >
        <span className="text-[11px] text-muted">{slot === 'start' ? 'Startbild' : 'Slutbild (valfri)'}</span>
        <div className="flex flex-wrap items-center justify-center gap-1">
          <button
            ref={anchor}
            type="button"
            onClick={toggleMenu}
            aria-haspopup="menu"
            aria-expanded={!!view}
            title="Ladda upp, välj ur biblioteket eller stillbilderna, eller ta en bildruta ur ett klipp"
            className="flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-[11px] text-text transition hover:border-muted"
          >
            <ImageIcon size={11} />
            Välj bild
          </button>
          <button
            type="button"
            onClick={onCreateImage}
            title="Skapa bild – en ny bild med en bildmodell (kostar lite)"
            aria-label="Skapa bild"
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-muted transition hover:border-muted hover:text-text"
          >
            <SparkleIcon size={11} />
            {roomy && 'Skapa bild'}
          </button>
        </div>
        {neighbour !== undefined ? (
          <button
            type="button"
            onClick={() => onSet(slot === 'start' ? { kind: 'previous' } : { kind: 'next' })}
            title={autoLabel(slot, neighbour)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text"
          >
            <LinkIcon size={11} />
            Från klipp {neighbour}
          </button>
        ) : (
          <span className="text-[10px] text-muted/70">eller släpp en bild här</span>
        )}
      </div>
    )
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
      {content}
      {over && filled && (
        <span className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-accent ring-inset" aria-hidden />
      )}
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/60 text-[11px] text-muted">
          <span className="animate-pulse">Sparar…</span>
        </span>
      )}

      <Popover
        anchorRef={anchor}
        open={!!view}
        onClose={close}
        width={view === 'menu' ? 260 : 340}
        maxHeight={view === 'menu' ? 420 : 480}
        label={`${name} för klipp ${number}`}
      >
        {view === 'library' ? (
          <SubView onBack={() => setView('menu')}>
            <AssetPicker
              assets={assets}
              initialKind="environment"
              title={`${name} för klipp ${number}`}
              hint="Klicka på en bild – eller på namnet för omslagsbilden."
              selectedPaths={state.kind === 'image' ? [state.path] : []}
              onPickImage={(path, asset) => {
                const image = asset.images.find((img) => img.path === path)
                if (image) choose({ kind: 'asset-image', imageId: image.id })
              }}
              onManage={
                onManage
                  ? (k) => {
                      close()
                      onManage(k)
                    }
                  : undefined
              }
            />
          </SubView>
        ) : view === 'stills' ? (
          <SubView title={`${name} från stillbilderna`} onBack={() => setView('menu')}>
            <div className="grid min-h-0 flex-1 grid-cols-3 gap-1.5 overflow-y-auto p-2">
              {stills.map((s) => (
                <StillThumb
                  key={s.id}
                  still={s}
                  className="aspect-video w-full"
                  selected={state.kind === 'image' && state.path === s.path}
                  onOpen={() => choose({ kind: 'still', stillId: s.id })}
                />
              ))}
            </div>
          </SubView>
        ) : (
          <div role="menu" aria-label={`${name} för klipp ${number}`} onKeyDown={onMenuKeyDown} className="overflow-y-auto p-1">
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted">
              {name} för klipp {number}
            </p>
            <button type="button" role="menuitem" data-menu-item autoFocus onClick={() => void upload()} className={menuRow}>
              Ladda upp en bild…
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
              title={stills.length ? undefined : 'Sekvensen har inga stillbilder än'}
              className={menuRow}
            >
              Från stillbilderna…
              {stills.length > 0 && <span className="ml-auto text-[11px] text-muted tabular-nums">{stills.length}</span>}
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => {
                close()
                onPickFrame()
              }}
              className={menuRow}
            >
              Bildruta från ett klipp…
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => {
                close()
                onCreateImage()
              }}
              className={menuRow}
            >
              <SparkleIcon size={12} className="shrink-0 text-muted" />
              Skapa bild…
            </button>
            {(neighbour !== undefined || filled) && <div className="mx-2 my-1 border-t border-line" />}
            {neighbour !== undefined && (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={state.kind === 'auto'}
                data-menu-item
                onClick={() => choose(slot === 'start' ? { kind: 'previous' } : { kind: 'next' })}
                className={menuRow}
              >
                <LinkIcon size={12} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">{slot === 'start' ? `Från föregående klipp (${neighbour})` : `Från nästa klipp (${neighbour})`}</span>
                {state.kind === 'auto' && <span className="text-[11px] text-accent">✓</span>}
              </button>
            )}
            {filled && (
              <button type="button" role="menuitem" data-menu-item onClick={() => choose(null)} className={`${menuRow} text-muted hover:text-accent`}>
                Ta bort {slot === 'start' ? 'startbilden' : 'slutbilden'}
              </button>
            )}
          </div>
        )}
      </Popover>
    </div>
  )
}

/** A filled slot: the picture is the button that opens the slot's menu. */
function SlotButton({
  anchor,
  name,
  title,
  onOpen,
  children
}: {
  anchor: RefObject<HTMLButtonElement | null>
  name: string
  title: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <button
      ref={anchor}
      type="button"
      onClick={onOpen}
      aria-haspopup="menu"
      aria-label={`${name} – ändra`}
      title={title}
      className="group/slot relative block h-full w-full overflow-hidden rounded-md bg-black outline-none ring-offset-2 ring-offset-panel focus-visible:ring-2 focus-visible:ring-muted"
    >
      {children}
      <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-text opacity-0 transition group-hover/slot:opacity-100 group-focus-visible/slot:opacity-100">
        <MoreIcon size={11} />
      </span>
    </button>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/85 to-black/0 px-1.5 pb-1 pt-3 text-left text-[10px] text-white/90">
      {children}
    </span>
  )
}

function SubView({ title, onBack, children }: { title?: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-1.5 py-1">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text"
        >
          ‹ Tillbaka
        </button>
        {title && <span className="truncate text-[11px] text-muted">{title}</span>}
      </div>
      {children}
    </div>
  )
}
