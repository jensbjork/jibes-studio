import { useEffect, useMemo, useRef, useState } from 'react'
import type { SavedPrompt } from '@shared/types'
import { matchesQuery } from './text'

interface Props {
  prompts: SavedPrompt[]
  onPick: (prompt: SavedPrompt) => void
  /** Opens the prompt library view. */
  onManage?: () => void
}

/** Popover content: searchable prompt library, favourites first, arrow keys + Enter to pick. */
export default function PromptLibraryPicker({ prompts, onPick, onManage }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const visible = useMemo(() => {
    const hits = prompts.filter((p) =>
      matchesQuery(`${p.title} ${p.body} ${p.negativePrompt ?? ''} ${p.tags.join(' ')}`, query)
    )
    // Stable sort keeps the library's own order (most recently updated) within each group.
    return hits.sort((a, b) => Number(b.favorite) - Number(a.favorite))
  }, [prompts, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, visible.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && visible[active]) {
      e.preventDefault()
      onPick(visible[active])
    }
  }

  return (
    <>
      <div className="border-b border-line p-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search title, text and tags…"
          className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {prompts.length === 0 ? (
          <div className="px-3 py-6 text-center text-muted">
            <p>The library is empty.</p>
            <p className="mt-1 text-[11px]">Write a prompt and click “Save” to put it here.</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted">No prompts match “{query}”.</p>
        ) : (
          visible.map((p, i) => (
            <button
              key={p.id}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              onClick={() => onPick(p)}
              onMouseMove={() => active !== i && setActive(i)}
              className={`block w-full rounded-md px-2.5 py-2 text-left ${i === active ? 'bg-raised' : ''}`}
            >
              <span className="flex items-center gap-1.5">
                {p.favorite && <span className="text-amber-400">★</span>}
                <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
                {p.useCount > 0 && (
                  <span className="shrink-0 text-[10px] text-muted" title="Times used">
                    {p.useCount}×
                  </span>
                )}
              </span>
              <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{p.body}</span>
              {(p.tags.length > 0 || p.negativePrompt) && (
                <span className="mt-1 flex flex-wrap gap-1">
                  {p.tags.map((t) => (
                    <span key={t} className="rounded bg-line px-1.5 py-px text-[10px] text-muted">
                      {t}
                    </span>
                  ))}
                  {p.negativePrompt && (
                    <span className="rounded border border-line px-1.5 py-px text-[10px] text-muted">
                      + negative prompt
                    </span>
                  )}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[11px] text-muted">
        <span>↑ ↓ choose · Enter use</span>
        {onManage && (
          <button onClick={onManage} className="hover:text-text">
            Open the library →
          </button>
        )}
      </div>
    </>
  )
}
