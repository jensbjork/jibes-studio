import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SavedPrompt } from '@shared/types'
import { pendingCreateTarget, requestCreate, useCreateRequest } from '../../lib/createRequest'
import { useFindShortcut, usePromptsState } from '../../lib/hooks'
import { useListKeys } from '../../lib/listKeys'
import type { Navigate } from '../../lib/navigation'
import { shortcut } from '../../lib/platform'
import { QuoteIcon } from '../icons'
import { ListHeader } from '../library/SideList'
import { FloatingBanner } from '../ui/Banner'
import EmptyState from '../ui/EmptyState'
import { loadTab, saveTab, type PromptsTab } from './learning-utils'
import LearningsView from './LearningsView'
import PromptEditor from './PromptEditor'
import PromptFilters from './PromptFilters'
import PromptListItem, { type PromptRow } from './PromptListItem'
import {
  collectTags,
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

/** The tab a "New prompt" or "New learning" from ⌘K is for, while it waits for its list. */
function requestedTab(): PromptsTab | undefined {
  const target = pendingCreateTarget()
  return target === 'prompts' || target === 'learnings' ? target : undefined
}

/** Prompts: the prompt library, and (second tab) the learnings about what works in prompts. */
export default function PromptsView({ navigate }: { navigate: Navigate }) {
  // A clip's "Learnings from this clip" link opens the Learnings tab on that learning; ⌘K's "New …" opens its tab.
  const [requested] = useState(takeRequestedLearning)
  const [tab, setTabState] = useState<PromptsTab>(() => (requested ? 'learnings' : (requestedTab() ?? loadTab())))
  const setTab = (next: PromptsTab) => {
    setTabState(next)
    saveTab(next)
  }
  // Remembered as if chosen: the tab a link or ⌘K opened is the one to come back to.
  useEffect(() => saveTab(tab), [])

  // "New prompt" or "New learning" from ⌘K while the other tab is open: that tab opens, and the request is passed on
  // to its list, which takes it once it has loaded.
  useCreateRequest(
    tab === 'learnings',
    () => {
      setTab('prompts')
      requestCreate('prompts')
    },
    'prompts'
  )
  useCreateRequest(
    tab === 'prompts',
    () => {
      setTab('learnings')
      requestCreate('learnings')
    },
    'learnings'
  )

  const tabs = <ViewTabs tab={tab} onTab={setTab} />
  return tab === 'learnings' ? (
    <LearningsView navigate={navigate} tabs={tabs} initialId={requested} />
  ) : (
    <PromptLibrary navigate={navigate} tabs={tabs} />
  )
}

/**
 * The prompt library: its list (the side lists' header, search and keys, in a wider column for the text previews and
 * the filter chips) and the open prompt's editor.
 */
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
  const matches = (p: SavedPrompt) =>
    matchesQuery(p, query) && hasTags(p, activeTags) && (!favoritesOnly || p.favorite)
  // The open prompt stays listed even if an edit makes it stop matching the filters.
  const visible = sorted.filter((p) => p.id === draft?.id || matches(p))
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
    autoSelected.current = true
    const labels = activeTags.map((k) => tags.find((t) => t.key === k)?.label ?? k)
    editor.create(labels, favoritesOnly)
  }

  // "New prompt" from ⌘K: as the header's button does, once the prompts have loaded.
  useCreateRequest(loaded, newPrompt, 'prompts')

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
    return editor.remove(rest[Math.min(Math.max(index, 0), rest.length - 1)])
  }

  const byId = (id: string) => visible.find((p) => p.id === id)

  // The side lists' keys: ↑ ↓ (Home, End) open a row, ⌘↵ generates with it; in the search ↓ goes to the rows,
  // Enter opens the first match and Esc clears it. ⌘F goes to the search.
  const { onSearchKeyDown, onListKeyDown } = useListKeys({
    ids: visible.map((p) => p.id),
    matchIds: visible.filter(matches).map((p) => p.id),
    selectedId: draft?.id,
    onSelect: (id) => editor.select(byId(id)),
    searchRef,
    listRef,
    onClearSearch: () => setQuery(''),
    onModEnter: (id) => void use(byId(id))
  })
  useFindShortcut(searchRef)

  return (
    <div className="relative flex h-full">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <ListHeader title={tabs} createLabel="New prompt" onCreate={newPrompt} />

        {prompts.length > 0 && (
          <PromptFilters
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            onSearchKeyDown={onSearchKeyDown}
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
          aria-label="Prompts"
          onKeyDown={onListKeyDown}
          className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
        >
          {showDraftRow && (
            <PromptListItem row={rowFromDraft(draft, 0)} selected unsaved={!draft.id} onSelect={() => undefined} />
          )}
          {visible.map((p) => {
            const selected = p.id === draft?.id
            return (
              <PromptListItem
                key={p.id}
                id={p.id}
                row={selected ? rowFromDraft(draft, p.useCount) : p}
                selected={selected}
                onSelect={() => editor.select(p)}
              />
            )
          })}

          {prompts.length > 0 && visible.length === 0 && filtering && (
            <div className="px-2 py-2 text-[12px] leading-relaxed text-muted">
              <p>No prompts match.</p>
              <button type="button" onClick={clearFilters} className="mt-1 text-text underline-offset-2 hover:underline">
                Clear search and filters
              </button>
            </div>
          )}
        </div>
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

      {editor.error && (
        <FloatingBanner key={editor.error} tone="error" onDismiss={editor.clearError}>
          {editor.error}
        </FloatingBanner>
      )}
    </div>
  )
}

function EmptyEditor({ hasPrompts, onNew }: { hasPrompts: boolean; onNew: () => void }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="drag h-12 shrink-0" />
      {hasPrompts ? (
        <div className="flex flex-1 items-center justify-center px-8 pb-12">
          <div className="text-center text-muted">
            <p>Pick a prompt in the list, or create a new one.</p>
            <p className="mt-1 text-[11px]">
              {shortcut('⌘F')} to search · ↑ ↓ to browse · {shortcut('⌘↵')} to generate with it
            </p>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<QuoteIcon size={22} />}
          title="Your prompt library"
          text="Save the prompts that work and reuse them with a click. Tag them to find the right one, and star your favourites to keep them on top – in the library in Generate too."
          action={{ label: 'Create your first prompt', onClick: onNew }}
          footnote="You can also save straight from Generate with the Save button by the prompt."
        />
      )}
    </section>
  )
}
