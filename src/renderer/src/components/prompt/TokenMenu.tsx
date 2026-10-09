import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReferenceKind } from '@shared/prompt-refs'
import { ASSET_COPY } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
import AssetAvatar from '../assets/AssetAvatar'
import AssetIcon from '../assets/AssetIcon'
import AudioPlayButton from '../pickers/AudioPlayButton'
import { KIND_TONE } from '../pickers/assetKinds'
import { audioLabel, audioLabelParts, windowLabel } from '../pickers/audioRefs'
import { formatAudioRefs, formatImageRefs, promptList } from '../pickers/text'
import { placeBeside } from './textareaDom'
import { fileName, isDisabled, type MenuItem, type MenuSection } from './promptText'

interface Props {
  /** For aria-controls / aria-activedescendant on the textarea. */
  id: string
  /** The "@" (or the token being replaced) on screen. */
  anchor: DOMRect
  sections: MenuSection[]
  /** Index into all items, in display order. */
  active: number
  onActive: (index: number) => void
  onChoose: (item: MenuItem) => void
  /** What follows the "@", for the empty state. */
  query: string
  /** Picking a picture (or clip) for a wrong token rather than completing a new one. */
  replacing: boolean
  /** Only pictures or only clips are offered. */
  only?: ReferenceKind
  /** No reference images yet: the empty state explains where they come from. */
  noReferences: boolean
}

const WIDTH = 320
const MAX_HEIGHT = 340

export function optionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}

/**
 * The "@" autocomplete next to the caret: the references (each asset, then its pictures and clips) and library
 * assets that can be added. Keyboard handling lives in the editor, which keeps the focus; the mouse works too.
 */
export default function TokenMenu({
  id,
  anchor,
  sections,
  active,
  onActive,
  onChoose,
  query,
  replacing,
  only,
  noReferences
}: Props) {
  const optionRefs = useRef<(HTMLElement | null)[]>([])
  const place = placeBeside(anchor, WIDTH, MAX_HEIGHT)

  useEffect(() => {
    optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let n = 0
  const empty = sections.every((s) => !s.items.length)

  return createPortal(
    <div
      className="no-drag fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-panel text-text shadow-2xl shadow-black/60"
      style={{ top: place.top, bottom: place.bottom, left: place.left, width: WIDTH, maxHeight: place.maxHeight }}
      // The textarea keeps the focus (and the caret) while the menu is used with the mouse.
      onMouseDown={(e) => e.preventDefault()}
    >
      {replacing && (
        <p className="border-b border-line px-3 py-2 text-[11px] text-muted">
          {only === 'audio' ? 'Välj ljudklippet som hänvisningen ska peka på' : 'Välj bilden som hänvisningen ska peka på'}
        </p>
      )}
      <div
        id={id}
        role="listbox"
        aria-label={only === 'audio' ? 'Hänvisa till ett ljudklipp' : 'Hänvisa till en bild eller ett ljudklipp'}
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {empty ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">
            {query ? <p>Inget heter ”@{query}”.</p> : <p>Inget att hänvisa till än.</p>}
            {noReferences && (
              <p className="mt-1 text-[11px]">
                Lägg till bilder med ＋ Karaktär, ＋ Miljö, ＋ Produkt, ＋ Kläder eller ＋ Pose ovanför – de får
                nummer @Image1, @Image2 … och röster @Audio1 …
              </p>
            )}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.title}>
              <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                {section.title}
              </p>
              {section.items.map((item) => {
                const index = n++
                return (
                  <Option
                    key={item.key}
                    id={optionId(id, index)}
                    item={item}
                    active={index === active}
                    refCallback={(el) => {
                      optionRefs.current[index] = el
                    }}
                    onHover={() => onActive(index)}
                    onChoose={() => onChoose(item)}
                  />
                )
              })}
              {section.more > 0 && (
                <p className="px-2 py-1 text-[11px] text-muted">
                  {section.more} till – skriv en del av namnet för att söka
                </p>
              )}
            </div>
          ))
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-[10px] text-muted">↑↓ välj · ↩ eller ⇥ infoga · esc stäng</p>
    </div>,
    document.body
  )
}

interface OptionProps {
  id: string
  item: MenuItem
  active: boolean
  refCallback: (el: HTMLElement | null) => void
  onHover: () => void
  onChoose: () => void
}

function Option({ id, item, active, refCallback, onHover, onChoose }: OptionProps) {
  const disabled = isDisabled(item)
  return (
    <div
      id={id}
      ref={refCallback}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      onMouseMove={() => !active && !disabled && onHover()}
      onClick={() => !disabled && onChoose()}
      className={`flex cursor-default items-center gap-2 rounded-md px-2 py-1 ${
        disabled ? 'opacity-45' : active ? 'bg-raised' : ''
      } ${
        (item.type === 'image' && item.reference.asset) || (item.type === 'audio' && item.audio.source) ? 'pl-4' : ''
      }`}
    >
      <OptionContent item={item} />
    </div>
  )
}

function OptionContent({ item }: { item: MenuItem }) {
  if (item.type === 'group') {
    const { asset, indices, outfits, audios, people, holder } = item.group
    const tone = KIND_TONE[asset.kind]
    return (
      <>
        <AssetAvatar asset={asset} className={`h-6 w-6 rounded-full ring-1 ${tone.ring}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{asset.name}</span>
          <span className="block truncate text-[11px] text-muted">
            {ASSET_COPY[asset.kind].singular}
            {audios?.length ? (asset.kind === 'character' ? ' · med röst' : ' · med ljud') : ''}
            {outfits?.length ? ` · bär ${promptList(outfits.map((o) => o.name), 'sv')}` : ''}
            {asset.kind === 'pose' && people?.length ? ` · ${promptList(people.map((p) => p.name), 'sv')}` : ''}
            {asset.kind === 'product' && holder ? ` · hålls av ${holder.name}` : ''}
          </span>
        </span>
        <span className={`shrink-0 text-[11px] ${tone.text}`}>
          {formatImageRefs(indices)}
          {audios?.length ? `, ${formatAudioRefs(audios)}` : ''}
        </span>
      </>
    )
  }
  if (item.type === 'audio') {
    const a = item.audio
    const kind = a.source?.asset.kind
    const { name, detail } = audioLabelParts(a)
    return (
      <>
        <AudioPlayButton path={a.path} start={a.start} length={a.length} label={audioLabel(a)} className="h-6 w-6" />
        <span className={`shrink-0 font-medium ${kind ? KIND_TONE[kind].text : 'text-text'}`}>@Audio{a.index}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {name} · {detail} · {windowLabel(a)}
        </span>
        {!a.sent && <span className="shrink-0 text-[11px] text-accent">skickas inte</span>}
      </>
    )
  }
  if (item.type === 'image') {
    const r = item.reference
    return (
      <>
        <Thumb path={r.path} />
        <span className={`shrink-0 font-medium ${r.asset ? KIND_TONE[r.asset.kind].text : 'text-text'}`}>
          @Image{r.index}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {r.asset ? `${r.asset.name} · foto ${r.photo ?? 1}` : `egen bild · ${fileName(r.path)}`}
        </span>
        {!r.sent && <span className="shrink-0 text-[11px] text-accent">skickas inte</span>}
      </>
    )
  }
  const { asset, status, warning } = item
  return (
    <>
      <AssetAvatar asset={asset} className="h-7 w-7 rounded-md" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`flex shrink-0 text-[11px] ${KIND_TONE[asset.kind].text}`}>
            <AssetIcon kind={asset.kind} />
          </span>
          <span className="truncate font-medium">{asset.name}</span>
        </span>
        <span className="block truncate text-[11px] text-muted">
          {status}
          {warning && <span className="text-accent"> · {warning}</span>}
        </span>
      </span>
      {!item.disabled && <span className="shrink-0 pr-0.5 text-muted">＋</span>}
    </>
  )
}

/** A small thumbnail of a reference picture; a blank square when the file can't be shown. */
export function Thumb({ path, className = 'h-6 w-6' }: { path: string; className?: string }) {
  const [failed, setFailed] = useState<string>()
  if (failed === path) return <span className={`${className} shrink-0 rounded bg-raised`} />
  return (
    <img
      src={mediaUrl(path)}
      draggable={false}
      decoding="async"
      onError={() => setFailed(path)}
      className={`${className} shrink-0 rounded bg-raised object-cover`}
    />
  )
}
