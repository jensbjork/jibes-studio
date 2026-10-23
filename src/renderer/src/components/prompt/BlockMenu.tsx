import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { placeBeside } from './textareaDom'
import type { BlockItem, BlockSection } from './blocks'

interface Props {
  /** For aria-controls / aria-activedescendant on the field. */
  id: string
  /** Where it hangs: the "/" on screen, or the chip that opened it. */
  anchor: DOMRect
  sections: BlockSection[]
  /** Index into all items, in display order. */
  active: number
  onActive: (index: number) => void
  onChoose: (item: BlockItem) => void
  /** What was typed after "/" (or in the search box), for the empty state. */
  query: string
  /** Opened from a chip: a search box on top that takes the focus (the "/" menu leaves it in the field). */
  search?: {
    value: string
    onChange: (value: string) => void
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
    onClose: () => void
  }
}

const WIDTH = 340
const MAX_HEIGHT = 380

export function blockOptionId(menuId: string, index: number): string {
  return `${menuId}-block-${index}`
}

/**
 * The building-block menu: ready-made phrases (Swedish label, the English text it inserts), saved prompts and
 * learnings, grouped. Typed "/" keeps the focus in the field, which handles the keys; a chip opens it with its own
 * search box.
 */
export default function BlockMenu({ id, anchor, sections, active, onActive, onChoose, query, search }: Props) {
  const optionRefs = useRef<(HTMLElement | null)[]>([])
  const box = useRef<HTMLDivElement>(null)
  const place = placeBeside(anchor, WIDTH, MAX_HEIGHT, 240)

  useEffect(() => {
    optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Opened from a chip: a click outside closes it.
  useEffect(() => {
    if (!search) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) search.onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [search?.onClose])

  let n = 0
  const empty = sections.every((s) => !s.items.length)

  return createPortal(
    <div
      ref={box}
      className="no-drag fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-line bg-panel text-text shadow-2xl shadow-black/60"
      style={{ top: place.top, bottom: place.bottom, left: place.left, width: WIDTH, maxHeight: place.maxHeight }}
      // The "/" menu: the field keeps the focus (and the caret) while the menu is used with the mouse.
      onMouseDown={(e) => !search && e.preventDefault()}
    >
      {search && (
        <div className="border-b border-line p-2">
          <input
            autoFocus
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            onKeyDown={search.onKeyDown}
            placeholder="Search building blocks…"
            aria-controls={id}
            aria-activedescendant={active >= 0 ? blockOptionId(id, active) : undefined}
            className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
          />
        </div>
      )}
      <div id={id} role="listbox" aria-label="Building blocks" className="min-h-0 flex-1 overflow-y-auto p-1">
        {empty ? (
          <p className="px-3 py-4 text-center text-[12px] text-muted">
            {query ? `No building block matches “${query}”.` : 'No building blocks here.'}
          </p>
        ) : (
          sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.title}>
              <p className="section-label px-2 pb-1 pt-2">
                {section.title}
              </p>
              {section.items.map((item) => {
                const index = n++
                const isActive = index === active
                return (
                  <div
                    key={item.key}
                    id={blockOptionId(id, index)}
                    ref={(el) => {
                      optionRefs.current[index] = el
                    }}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => !isActive && onActive(index)}
                    onClick={() => onChoose(item)}
                    className={`cursor-default rounded-md px-2 py-1.5 ${isActive ? 'bg-raised' : ''}`}
                  >
                    <span className="block truncate">{item.label}</span>
                    {item.detail && item.detail !== item.label && (
                      <span className="block truncate text-[11px] text-muted">{item.detail}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-[10px] text-muted">
        ↑ ↓ choose · ↵ insert · Esc close{search ? ' · tip: type / right in the text' : ''}
      </p>
    </div>,
    document.body
  )
}
