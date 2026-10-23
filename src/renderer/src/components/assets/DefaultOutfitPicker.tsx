import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Asset } from '@shared/types'
import Popover from '../pickers/Popover'
import { ChevronDownIcon } from '../sequences/icons'
import AssetAvatar from './AssetAvatar'
import AssetIcon from './AssetIcon'
import { imageCountLabel } from './imageUtils'

interface Props {
  outfits: Asset[]
  /** False until the outfits have loaded. */
  loaded: boolean
  /** The chosen outfit's id; null for none. */
  value: string | null
  onChange: (outfitId: string | null) => void
  /** Shows the outfit under Outfits. */
  onOpen: (outfitId: string) => void
  /** Goes to Outfits, e.g. to create the first outfit. */
  onManage: () => void
}

/** A character's "Default outfit": a select with thumbnails, plus a link to the chosen outfit. */
export default function DefaultOutfitPicker({ outfits, loaded, value, onChange, onOpen, onManage }: Props) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // An id the list doesn't know is an outfit deleted a moment ago; main clears it from the character.
  const current = value ? outfits.find((o) => o.id === value) : undefined

  // Focus the chosen row once the panel has been placed, so the arrow keys start from there.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
      const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ;(selected ?? options?.[0])?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  const choose = (id: string | null) => {
    setOpen(false)
    anchorRef.current?.focus()
    if (id !== (current?.id ?? null)) onChange(id)
  }

  const onListKey = (e: KeyboardEvent) => {
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    if (!options.length) return
    const i = options.indexOf(document.activeElement as HTMLElement)
    const target =
      e.key === 'ArrowDown'
        ? options[Math.min(options.length - 1, i + 1)]
        : e.key === 'ArrowUp'
          ? options[Math.max(0, i - 1)]
          : e.key === 'Home'
            ? options[0]
            : e.key === 'End'
              ? options[options.length - 1]
              : undefined
    if (!target) return
    e.preventDefault()
    target.focus()
  }

  if (loaded && outfits.length === 0 && !current) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-line px-3 py-2.5">
        <span className="text-muted">No outfits saved yet.</span>
        <button onClick={onManage} className="text-muted underline-offset-2 hover:text-text hover:underline">
          Go to Outfits →
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!loaded}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-72 max-w-full items-center gap-2.5 rounded-md border border-line bg-raised p-1.5 pr-3 text-left outline-none transition hover:border-muted focus-visible:border-muted disabled:opacity-40"
      >
        {current ? (
          <AssetAvatar asset={current} className="h-9 w-9 rounded" />
        ) : (
          <NoOutfitThumb className="h-9 w-9" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{current?.name ?? 'None'}</span>
          <span className="block truncate text-[11px] text-muted">
            {current ? imageCountLabel(current.images.length) : loaded ? 'Choose from your outfits' : 'Loading outfits…'}
          </span>
        </span>
        <ChevronDownIcon size={12} className="shrink-0 text-muted" />
      </button>
      {current && (
        <button
          type="button"
          onClick={() => onOpen(current.id)}
          className="rounded-md px-3 py-2 text-muted hover:bg-raised hover:text-text"
        >
          Show outfit →
        </button>
      )}

      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        width={300}
        maxHeight={380}
        label="Choose default outfit"
      >
        <div
          ref={listRef}
          role="listbox"
          aria-label="Default outfit"
          onKeyDown={onListKey}
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          <Option selected={!current} onClick={() => choose(null)}>
            <NoOutfitThumb className="h-8 w-8" />
            <span className="min-w-0 flex-1">
              <span className="block">None</span>
              <span className="block text-[11px] text-muted">Only the character's own images</span>
            </span>
          </Option>
          {outfits.map((o) => (
            <Option key={o.id} selected={o.id === current?.id} onClick={() => choose(o.id)}>
              <AssetAvatar asset={o} className="h-8 w-8 rounded" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.name}</span>
                <span className="block text-[11px] text-muted">{imageCountLabel(o.images.length)}</span>
              </span>
            </Option>
          ))}
        </div>
        <div className="border-t border-line p-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
            className="w-full rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-raised hover:text-text"
          >
            Manage outfits →
          </button>
        </div>
      </Popover>
    </div>
  )
}

function Option({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md p-1.5 pr-2.5 text-left outline-none transition hover:bg-raised focus-visible:bg-raised ${
        selected ? 'text-text' : 'text-text/90'
      }`}
    >
      {children}
      <span className={`w-3 shrink-0 text-center text-accent ${selected ? '' : 'invisible'}`}>✓</span>
    </button>
  )
}

function NoOutfitThumb({ className }: { className: string }) {
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded border border-dashed border-line text-muted/60`}
    >
      <AssetIcon kind="outfit" />
    </span>
  )
}
