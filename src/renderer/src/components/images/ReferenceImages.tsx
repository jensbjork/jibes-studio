import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { Asset, AssetKind, Still } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
import AssetPicker from '../pickers/AssetPicker'
import { KIND_TONE } from '../pickers/assetKinds'
import { assetsByPath } from '../pickers/assetRefs'
import Popover from '../pickers/Popover'
import ReferenceViewer, { type ViewedPicture } from '../pickers/ReferenceViewer'
import { stillSourceLabel } from './imageModels'
import StillThumb, { isStillDrag, stillIdFromDrop } from './StillThumb'

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
/** Reordering inside the list (the index being dragged); kept apart from stills and files dropped from outside. */
const REORDER_TYPE = 'application/x-studio-reference-index'

const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'

/** Tab order of the library picker: who is in the picture comes first. */
const FIRST_KIND: AssetKind = 'character'

/** Whose stills the picker offers: a sequence's, a storyboard's, or (undefined) every saved picture. */
export type StillsOwner = 'sequence' | 'storyboard'

/** The stills picker's wording for each owner. */
const STILLS_COPY: Record<StillsOwner | 'all', { name: string; title: string; gone: string }> = {
  sequence: {
    name: 'Sekvensens bilder',
    title: 'Bilder och bildrutor i sekvensen',
    gone: 'Bilden finns inte bland sekvensens bilder längre.'
  },
  storyboard: {
    name: 'Storyboardbilder',
    title: 'Bilder och bildrutor i storyboarden',
    gone: 'Bilden finns inte bland storyboardens bilder längre.'
  },
  all: { name: 'Sparade bilder', title: 'Sparade bilder', gone: 'Bilden finns inte bland de sparade bilderna längre.' }
}

interface Props {
  /** Absolute paths, in the order they are sent: the first is the base the others are combined into. */
  value: string[]
  onChange: (paths: string[]) => void
  /** How many images the model takes; the ones after it are shown but not sent. */
  max: number
  /** Every library asset (all kinds), for the picker and the name captions. */
  assets: Asset[]
  /** The stills that can be picked (the sequence's or storyboard's, newest first). */
  stills: Still[]
  /** Whose the stills are (wording of the picker); undefined: every saved picture. */
  stillsOf?: StillsOwner
  /** Captions that name a picture by its role, e.g. "Föregående" for the previous board's image; win over others. */
  pathLabels?: Record<string, string>
  /** The clip's own reference images, offered with one click (a keyframe usually shows the same people). */
  clipReferences?: string[]
  clipNumber?: number
  /** Something couldn't be added (too many), in Swedish; cleared by the next change. */
  onNote: (note: string | undefined) => void
  /** Opens a library view, e.g. to create a character. Closes the dialog first. */
  onManage?: (kind: AssetKind) => void
  /**
   * Reports whether a picker is open, so the dialog around it can leave Escape and outside clicks to the
   * picker (which closes on them) instead of closing itself as well.
   */
  onPickerOpen?: (open: boolean) => void
}

type Picker = 'library' | 'stills'

/**
 * The reference images of a still: thumbnails in send order (the first is the base), with pickers for the
 * library (characters, environments, products, outfits, poses) and the sequence's stills, a file dialog, drag and
 * drop of files and stills, and drag to reorder. A click on a thumbnail (or Enter / Space) shows it large, where it
 * can be swapped for another picture in the same place or removed.
 */
export default function ReferenceImages({
  value,
  onChange,
  max,
  assets,
  stills,
  stillsOf,
  pathLabels,
  clipReferences = [],
  clipNumber,
  onNote,
  onManage,
  onPickerOpen
}: Props) {
  const [picker, setPicker] = useState<Picker | null>(null)
  // The picture shown large (its index), or null.
  const [viewing, setViewing] = useState<number | null>(null)
  // Whether the press that ends in a click started a drag (a reorder): that click doesn't open the viewer.
  const dragged = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  // The viewer counts as a picker: Escape and clicks in it are its own, not the dialog's.
  useEffect(() => onPickerOpen?.(picker !== null || viewing !== null), [picker, viewing !== null])
  const libraryButton = useRef<HTMLButtonElement>(null)
  const stillsButton = useRef<HTMLButtonElement>(null)
  const [over, setOver] = useState(false)
  const [dragIndex, setDragIndex] = useState<number>()
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())

  const byPath = useMemo(() => assetsByPath(assets), [assets])
  const stillByPath = useMemo(() => new Map(stills.map((s) => [s.path, s])), [stills])
  const stillById = useMemo(() => new Map(stills.map((s) => [s.id, s])), [stills])
  const copy = STILLS_COPY[stillsOf ?? 'all']

  /** Adds images after the ones there (duplicates skipped), as many as the model takes. */
  const add = (paths: string[]) => {
    if (paths.length && !paths.some((p) => IMAGE_EXT.test(p))) {
      onNote('Bara bilder i formatet JPG, PNG eller WebP kan användas.')
      return
    }
    const fresh = paths.filter((p, i) => IMAGE_EXT.test(p) && !value.includes(p) && paths.indexOf(p) === i)
    if (!fresh.length) return
    const room = Math.max(0, max - value.length)
    onNote(
      fresh.length > room
        ? room
          ? `Bara ${room === 1 ? 'en bild till' : `${room} bilder till`} fick plats – modellen tar högst ${max}.`
          : `Modellen tar högst ${max} bilder. Ta bort en för att lägga till en annan.`
        : undefined
    )
    if (room) onChange([...value, ...fresh.slice(0, room)])
  }

  /** Picking an image that is already there takes it out again, so the pickers work as toggles. */
  const toggle = (path: string) => {
    if (value.includes(path)) {
      onNote(undefined)
      onChange(value.filter((p) => p !== path))
    } else add([path])
  }

  const remove = (i: number) => {
    onNote(undefined)
    onChange(value.filter((_, j) => j !== i))
  }

  const move = (from: number, to: number) => {
    if (from === to || from < 0 || from >= value.length) return
    const next = value.slice()
    const [moved] = next.splice(from, 1)
    next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
    onChange(next)
  }

  const acceptsDrop = (e: DragEvent) =>
    isStillDrag(e) || Array.from(e.dataTransfer.types).includes('Files') || e.dataTransfer.types.includes(REORDER_TYPE)

  const onDrop = (e: DragEvent, at?: number) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const reorder = e.dataTransfer.getData(REORDER_TYPE)
    if (reorder !== '') {
      move(Number(reorder), at ?? value.length - 1)
      return
    }
    const stillId = stillIdFromDrop(e)
    if (stillId) {
      const still = stillById.get(stillId)
      if (still) add([still.path])
      else onNote(copy.gone)
      return
    }
    add(Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f)))
  }

  const pickFiles = async () => add(await window.studio.pickImages(true))

  /**
   * "Byt bilden…" in the viewer: the picture takes this one's place, the order (and so "image 2" in the prompt)
   * stays. A picture already among the references isn't added twice.
   */
  const swap = (i: number, path: string): string | undefined => {
    if (!IMAGE_EXT.test(path)) return 'Bara bilder i formatet JPG, PNG eller WebP kan användas.'
    if (value.some((p, j) => j !== i && p === path)) return 'Bilden finns redan bland referensbilderna.'
    onNote(undefined)
    onChange(value.map((p, j) => (j === i ? path : p)))
    return undefined
  }

  /** "Ta bort" in the viewer: the viewer goes on to the next picture, or closes after the last. */
  const removeViewed = (i: number) => {
    remove(i)
    setViewing(value.length > 1 ? Math.min(i, value.length - 2) : null)
  }

  const place = (i: number): string => (i === 0 ? 'Basbild' : `Bild ${i + 1}`)

  /** What a picture is called in the viewer (its place; a role, a still's source or the file when it isn't a photo). */
  const viewed = (path: string, i: number): ViewedPicture => {
    const still = stillByPath.get(path)
    return {
      path,
      place: place(i),
      name: pathLabels?.[path] ?? (still ? stillSourceLabel(still) : undefined),
      warning: i >= max ? `Skickas inte – modellen tar högst ${max} bilder.` : undefined
    }
  }

  const clipMissing = clipReferences.filter((p) => !value.includes(p))
  const overflow = value.length > max

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-muted">
          Referensbilder
          {value.length > 0 && (
            <span className={`ml-1.5 text-[11px] ${overflow ? 'text-accent' : ''}`}>
              {value.length}/{max}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center justify-end">
          <button
            ref={libraryButton}
            onClick={() => setPicker((p) => (p === 'library' ? null : 'library'))}
            className={`${smallButton} ${picker === 'library' ? 'bg-raised text-text' : ''}`}
            title="Karaktärer, miljöer, produkter, kläder och poser"
          >
            Från biblioteket
          </button>
          <button
            ref={stillsButton}
            onClick={() => setPicker((p) => (p === 'stills' ? null : 'stills'))}
            className={`${smallButton} ${picker === 'stills' ? 'bg-raised text-text' : ''}`}
            title={copy.title}
          >
            {copy.name}
          </button>
          <button onClick={() => void pickFiles()} className={smallButton} title="Välj bildfiler på datorn">
            Från fil…
          </button>
        </span>
      </div>

      <div
        ref={list}
        role="list"
        aria-label="Referensbilder"
        onDragOver={(e) => {
          if (!acceptsDrop(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes(REORDER_TYPE) ? 'move' : 'copy'
          setOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={(e) => onDrop(e)}
        className={`flex min-h-[84px] flex-wrap gap-2 rounded-md border border-dashed p-2 transition ${
          over ? 'border-accent bg-accent/5' : 'border-line'
        }`}
      >
        {value.map((path, i) => {
          const asset = byPath.get(path)
          const still = stillByPath.get(path)
          const notSent = i >= max
          const name = path.split('/').pop() ?? path
          const role = pathLabels?.[path]
          const caption = role
            ? { text: role, className: 'bg-black/70' }
            : asset
              ? { text: asset.name, className: KIND_TONE[asset.kind].caption }
              : still
                ? { text: still.source === 'frame' ? 'Bildruta' : 'Bild', className: 'bg-black/70' }
                : undefined
          const described = asset
            ? `${asset.name} (${ASSET_COPY[asset.kind].singular}) · ${name}`
            : still
              ? `${stillSourceLabel(still)}${still.prompt ? ` · ${still.prompt}` : ''}`
              : name
          const title = notSent
            ? `Skickas inte – modellen tar högst ${max} bilder`
            : missing.has(path)
              ? `Filen saknas: ${path}`
              : role
                ? `${role} · ${described}`
                : described
          return (
            <div
              key={path}
              role="listitem"
              tabIndex={0}
              aria-label={`${place(i)}: ${caption?.text ?? name}. Enter visar den större.`}
              draggable
              onMouseDown={() => {
                dragged.current = false
              }}
              onDragStart={(e) => {
                dragged.current = true
                e.dataTransfer.setData(REORDER_TYPE, String(i))
                e.dataTransfer.effectAllowed = 'move'
                setDragIndex(i)
              }}
              onDragEnd={() => setDragIndex(undefined)}
              onDragOver={(e) => {
                if (!acceptsDrop(e)) return
                e.preventDefault()
              }}
              onDrop={(e) => onDrop(e, i)}
              onClick={(e) => {
                // A click shows it large; not the end of a drag, nor a click on ✕ or "Gör till bas".
                if (dragged.current || (e.target as HTMLElement).closest('button')) return
                setViewing(i)
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                setViewing(i)
              }}
              title={`${title}\nKlicka för att visa den större – dra för att ändra ordningen`}
              className={`group relative h-[66px] w-[66px] cursor-grab overflow-hidden rounded bg-raised outline-none ring-offset-2 ring-offset-panel focus-visible:ring-2 focus-visible:ring-muted active:cursor-grabbing ${
                notSent ? 'opacity-40' : ''
              } ${missing.has(path) ? 'ring-1 ring-accent' : i === 0 ? 'ring-1 ring-accent/70' : ''} ${
                dragIndex === i ? 'opacity-50' : ''
              }`}
            >
              {missing.has(path) ? (
                <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
                  Filen saknas
                </span>
              ) : (
                <img
                  src={mediaUrl(path)}
                  alt=""
                  draggable={false}
                  decoding="async"
                  onError={() => setMissing((s) => new Set(s).add(path))}
                  className="h-full w-full object-cover"
                />
              )}
              <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">
                {i === 0 ? 'Bas' : i + 1}
              </span>
              {caption && (
                <span
                  className={`pointer-events-none absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${caption.className}`}
                >
                  {caption.text}
                </span>
              )}
              <button
                onClick={() => remove(i)}
                className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] group-hover:flex"
                title="Ta bort"
              >
                ✕
              </button>
              {i > 0 && (
                <button
                  onClick={() => move(i, 0)}
                  className="absolute bottom-4 left-1/2 hidden -translate-x-1/2 rounded bg-black/75 px-1.5 text-[10px] whitespace-nowrap group-hover:block"
                  title="Gör till basbild (skickas först)"
                >
                  Gör till bas
                </button>
              )}
            </div>
          )
        })}
        {value.length < max && (
          <button
            onClick={() => void pickFiles()}
            className="flex min-h-[66px] min-w-[66px] flex-1 items-center justify-center rounded px-3 text-center text-[12px] leading-relaxed text-muted hover:bg-raised hover:text-text"
          >
            {value.length
              ? '+'
              : 'Inga referensbilder – bilden skapas bara från prompten. Släpp bilder här eller välj ovan.'}
          </button>
        )}
      </div>

      {clipMissing.length > 0 && (
        <button
          onClick={() => add(clipMissing)}
          className="mt-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-text"
          title="Samma karaktärer, miljöer, produkter, kläder och poser som klippet använder"
        >
          ＋ {clipNumber ? `Klipp ${clipNumber}s` : 'Klippets'} referensbilder ({clipMissing.length})
        </button>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {value.length > 1
          ? 'Den första bilden är basen som de andra kombineras in i. Dra bilderna för att ändra ordning, och ' +
            'hänvisa gärna till dem i prompten, t.ex. ”the woman from image 2”.'
          : 'Med referensbilder kombinerar modellen dem till en ny bild – t.ex. en karaktär i en miljö, i vissa ' +
            'kläder och en viss pose, eller med en produkt i handen.'}
      </p>

      {viewing !== null && value.length > 0 && (
        <ReferenceViewer
          label="Referensbilder"
          pictures={value.map(viewed)}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          library={assets}
          stills={stills}
          stillsLabel={copy.name}
          swapHint="Bilden byts på samma plats i ordningen, så prompten behöver inte ändras."
          onSwapImage={swap}
          onRemove={removeViewed}
          returnFocus={(i) => list.current?.querySelectorAll<HTMLElement>(':scope > [role=listitem]')[i]}
        />
      )}

      <Popover
        anchorRef={libraryButton}
        open={picker === 'library'}
        onClose={() => setPicker(null)}
        align="end"
        width={340}
        maxHeight={480}
        label="Referensbilder från biblioteket"
      >
        <AssetPicker
          assets={assets}
          initialKind={FIRST_KIND}
          title="Från biblioteket"
          hint={`Klicka på en bild för att lägga till eller ta bort den – på namnet för omslagsbilden. Högst ${max}.`}
          selectedPaths={value}
          onPickImage={(path) => toggle(path)}
          onManage={
            onManage
              ? (kind) => {
                  setPicker(null)
                  onManage(kind)
                }
              : undefined
          }
        />
      </Popover>

      <Popover
        anchorRef={stillsButton}
        open={picker === 'stills'}
        onClose={() => setPicker(null)}
        align="end"
        width={360}
        maxHeight={420}
        label={copy.name}
      >
        <div className="border-b border-line px-3 py-2.5">
          <p className="font-medium">{copy.name}</p>
          <p className="mt-0.5 text-[11px] text-muted">Klicka för att lägga till eller ta bort en bild.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {stills.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-muted">
              Inga bilder än. Bilder du skapar och bildrutor du sparar ur klipp hamnar här.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {stills.map((s) => (
                <StillThumb
                  key={s.id}
                  still={s}
                  selected={value.includes(s.path)}
                  onOpen={() => toggle(s.path)}
                  className="aspect-video w-full"
                />
              ))}
            </div>
          )}
        </div>
      </Popover>
    </div>
  )
}
