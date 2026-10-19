import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SavedPrompt } from '@shared/types'
import { usePromptsState } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import { shortcut } from '../../lib/platform'
import { loadTab, saveTab, type PromptsTab } from './learning-utils'
import LearningsView from './LearningsView'
import PromptEditor from './PromptEditor'
import PromptFilters from './PromptFilters'
import PromptListItem, { type PromptRow } from './PromptListItem'
import {
  collectTags,
  fold,
  hasTags,
  isSortKey,
  matchesQuery,
  sortPrompts,
  titleFromBody,
  type SortKey
} from './prompt-utils'
import { takeRequestedLearning } from './useLearnings'
import { usePromptDraft, type Draft } from './usePromptDraft'
import ViewTabs from './ViewTabs'

const SORT_KEY = 'prompts:sort'

function loadSort(): SortKey {
  try {
    const stored = localStorage.getItem(SORT_KEY)
    return isSortKey(stored) ? stored : 'updated'
  } catch {
    return 'updated'
  }
}

/** The list shows the open prompt as it is being typed, not as last saved. */
function rowFromDraft(draft: Draft, useCount: number): PromptRow {
  return {
    title: draft.title.trim() || titleFromBody(draft.body),
    body: draft.body.trim(),
    tags: draft.tags,
    favorite: draft.favorite,
    useCount
  }
}

/** Prompts: the prompt library, and (second tab) the learnings about what works in prompts. */
export default function PromptsView({ navigate }: { navigate: Navigate }) {
  // A clip's "Learnings from this clip" link opens the Learnings tab on that learning.
  const [requested] = useState(takeRequestedLearning)
  const [tab, setTabState] = useState<PromptsTab>(() => (requested ? 'learnings' : loadTab()))
  const setTab = (next: PromptsTab) => {
    setTabState(next)
    saveTab(next)
  }
  useEffect(() => {
    if (requested) saveTab('learnings')
  }, [])

  const tabs = <ViewTabs tab={tab} onTab={setTab} />
  return tab === 'learnings' ? (
    <LearningsView navigate={navigate} tabs={tabs} initialId={requested} />
  ) : (
    <PromptLibrary navigate={navigate} tabs={tabs} />
  )
}

function PromptLibrary({ navigate, tabs }: { navigate: Navigate; tabs: ReactNode }) {
  const { prompts, loaded } = usePromptsState()
  const editor = usePromptDraft(prompts)
  const { draft } = editor

  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sort, setSort] = useState<SortKey>(loadSort)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const tags = useMemo(() => collectTags(prompts), [prompts])
  // Filters on tags that no longer exist (renamed or deleted) would hide everything.
  const activeTags = tagFilter.filter((k) => tags.some((t) => t.key === k))
  const filtering = query.trim() !== '' || activeTags.length > 0 || favoritesOnly

  const sorted = useMemo(() => sortPrompts(prompts, sort), [prompts, sort])
  // The open prompt stays listed even if an edit makes it stop matching the filters.
  const visible = sorted.filter(
    (p) =>
      p.id === draft?.id ||
      (matchesQuery(p, query) && hasTags(p, activeTags) && (!favoritesOnly || p.favorite))
  )
  const stored = draft?.id ? prompts.find((p) => p.id === draft.id) : undefined
  const showDraftRow = !!draft && !stored

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort)
    } catch {
      // Remembering the sort order is only a convenience.
    }
  }, [sort])

  // Open the top prompt the first time the list arrives, so the editor isn't empty.
  const autoSelected = useRef(false)
  useEffect(() => {
    if (autoSelected.current || !sorted.length) return
    autoSelected.current = true
    if (!draft) editor.select(sorted[0])
  }, [sorted])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.defaultPrevented && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleTag = (key: string) =>
    setTagFilter((list) =>
      list.includes(key) ? list.filter((k) => k !== key) : [...list.filter((k) => activeTags.includes(k)), key]
    )

  const clearFilters = () => {
    setQuery('')
    setTagFilter([])
    setFavoritesOnly(false)
  }

  // A new prompt inherits the active filters, so it shows up where it was created.
  const newPrompt = () => {
    const labels = activeTags.map((k) => tags.find((t) => t.key === k)?.label ?? k)
    editor.create(labels, favoritesOnly)
  }

  // Saved right away (not debounced) so the list re-sorts the favourite immediately.
  const toggleOpenFavorite = () => {
    if (!draft) return
    editor.update({ favorite: !draft.favorite })
    void editor.flush()
  }

  const use = async (p?: SavedPrompt) => {
    const promptId = p && p.id !== draft?.id ? p.id : await editor.commit()
    if (promptId) navigate('generate', { type: 'use-prompt', promptId })
  }

  const remove = () => {
    const index = visible.findIndex((p) => p.id === draft?.id)
    const rest = visible.filter((p) => p.id !== draft?.id)
    void editor.remove(rest[Math.min(Math.max(index, 0), rest.length - 1)])
  }

  const step = (direction: 1 | -1) => {
    if (!visible.length) return
    const index = visible.findIndex((p) => p.id === draft?.id)
    const next = index === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, index + direction))
    editor.select(visible[next])
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && draft?.id) {
      e.preventDefault()
      void use()
    }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <div className="drag flex h-12 shrink-0 items-center justify-between pl-3 pr-3">
          {tabs}
          <button
            type="button"
            onClick={newPrompt}
            className="no-drag rounded-md px-2.5 py-1 text-muted transition hover:bg-raised hover:text-text"
          >
            ＋ New prompt
          </button>
        </div>

        {prompts.length > 0 && (
          <PromptFilters
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            onSearchArrowDown={() => {
              listRef.current?.focus()
              if (!visible.some((p) => p.id === draft?.id)) step(1)
            }}
            tags={tags}
            activeTags={activeTags}
            onToggleTag={toggleTag}
            favoritesOnly={favoritesOnly}
            onFavoritesOnly={setFavoritesOnly}
            hasFavorites={prompts.some((p) => p.favorite)}
            sort={sort}
            onSort={setSort}
            shown={visible.length}
            total={prompts.length}
          />
        )}

        <div
          ref={listRef}
          role="listbox"
          aria-label="Prompts"
          tabIndex={0}
          onKeyDown={onListKey}
          className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 outline-none"
        >
          {showDraftRow && (
            <PromptListItem
              row={rowFromDraft(draft, 0)}
              selected
              unsaved={!draft.id}
              activeTags={activeTags}
              onSelect={() => undefined}
              onToggleFavorite={toggleOpenFavorite}
              onTagClick={(tag) => toggleTag(fold(tag))}
            />
          )}
          {visible.map((p) => {
            const selected = p.id === draft?.id
            return (
              <PromptListItem
                key={p.id}
                row={selected ? rowFromDraft(draft, p.useCount) : p}
                selected={selected}
                activeTags={activeTags}
                onSelect={() => editor.select(p)}
                onToggleFavorite={() => editor.toggleFavorite(p.id)}
                onUse={() => void use(p)}
                onTagClick={(tag) => toggleTag(fold(tag))}
              />
            )
          })}

          {prompts.length > 0 && visible.length === 0 && filtering && (
            <div className="px-3 py-8 text-center text-muted">
              <p>No prompts match.</p>
              <button type="button" onClick={clearFilters} className="mt-2 text-text underline-offset-2 hover:underline">
                Clear search and filters
              </button>
            </div>
          )}
          {loaded && prompts.length === 0 && !draft && (
            <p className="px-3 py-8 text-center text-muted">No saved prompts yet.</p>
          )}
        </div>

        {editor.error && (
          <div className="flex items-start gap-2 border-t border-line px-4 py-3 text-accent">
            <p className="min-w-0 flex-1 select-text">{editor.error}</p>
            <button type="button" onClick={editor.clearError} title="Close" className="text-muted hover:text-text">
              ✕
            </button>
          </div>
        )}
      </aside>

      {draft ? (
        <PromptEditor
          key={draft.key}
          draft={draft}
          stored={stored}
          status={editor.status}
          tagSuggestions={tags.map((t) => t.label)}
          onChange={editor.update}
          onBlur={() => void editor.flush()}
          onToggleFavorite={toggleOpenFavorite}
          onUse={() => void use()}
          onDuplicate={() => void editor.duplicate()}
          onDelete={remove}
        />
      ) : loaded ? (
        <EmptyEditor hasPrompts={prompts.length > 0} onNew={newPrompt} />
      ) : (
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="drag h-12 shrink-0" />
        </section>
      )}
    </div>
  )
}

function EmptyEditor({ hasPrompts, onNew }: { hasPrompts: boolean; onNew: () => void }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="drag h-12 shrink-0" />
      <div className="flex flex-1 items-center justify-center px-8 pb-12">
        {hasPrompts ? (
          <div className="text-center text-muted">
            <p>Pick a prompt in the list, or create a new one.</p>
            <p className="mt-1 text-[11px]">{shortcut('⌘ F')} to search · ↑ ↓ to browse · Enter to open in Generate</p>
          </div>
        ) : (
          <div className="max-w-md text-center">
            <div className="mb-4 text-4xl text-muted">❝</div>
            <h2 className="mb-2 text-base font-semibold">Your prompt library</h2>
            <p className="mb-5 leading-relaxed text-muted">
              Save the prompts that work and reuse them with a click. Tag them to find the right one, and star
              your favourites to keep them on top – in the library in Generate too.
            </p>
            <button
              type="button"
              onClick={onNew}
              className="rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover"
            >
              Create your first prompt
            </button>
            <p className="mt-4 text-[11px] text-muted">
              You can also save straight from Generate with the Save button by the prompt.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
