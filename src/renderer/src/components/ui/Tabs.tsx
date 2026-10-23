import { useEffect, useRef, type ReactNode } from 'react'
import { rovingKeyDown } from './roving'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  title?: string
  /** After the label: a "new" dot. */
  dot?: ReactNode
}

interface Props<T extends string> {
  tabs: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  ariaLabel: string
}

// When a tab was chosen with the arrow keys. Some views draw their header again for another tab (a new element),
// and the focus would fall back to the window: a tab row that mounts right after takes it on its chosen tab.
let switchedByKeyAt = 0
const SWITCH_MS = 500

/**
 * A view's tabs (Media's Clips · Images · Films, Prompts · Learnings): text tabs, the chosen one bright. One Tab stop;
 * ← → (Home, End) move and switch.
 */
export default function Tabs<T extends string>({ tabs, value, onChange, ariaLabel }: Props<T>) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (Date.now() - switchedByKeyAt > SWITCH_MS) return
    switchedByKeyAt = 0
    // Only focus that was lost with the old row: never taken from a field the view focused on purpose.
    if (!document.activeElement || document.activeElement === document.body) {
      list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    }
  }, [])
  const ids = tabs.map((t) => t.id)
  // The Tab stop: the chosen tab (the first while none is).
  const stop = ids.includes(value) ? value : ids[0]
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(e) =>
        rovingKeyDown(e, ids, value, (id) => {
          switchedByKeyAt = Date.now()
          onChange(id)
        })
      }
      className="no-drag flex shrink-0 items-center gap-1"
    >
      {tabs.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            data-roving-id={t.id}
            tabIndex={t.id === stop ? 0 : -1}
            onClick={() => onChange(t.id)}
            title={t.title}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 font-semibold outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
              on ? 'text-text' : 'text-muted hover:text-text'
            }`}
          >
            {t.label}
            {t.dot}
          </button>
        )
      })}
    </div>
  )
}

export { Tabs }
