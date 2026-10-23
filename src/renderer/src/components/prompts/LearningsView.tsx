import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Generation, Learning } from '@shared/types'
import { useCreateRequest } from '../../lib/createRequest'
import { setGenerateParams } from '../../lib/generateStore'
import { useAssetsState, useFindShortcut, useModels } from '../../lib/hooks'
import { useListKeys } from '../../lib/listKeys'
import type { Navigate } from '../../lib/navigation'
import { shortcut } from '../../lib/platform'
import ClipDrawer from '../feed/ClipDrawer'
import { BulbIcon, PinIcon } from '../feed/icons'
import { buildLibraryIndex } from '../feed/references'
import { useGenerations } from '../feed/useGenerations'
import { ListHeader } from '../library/SideList'
import { CloseIcon } from '../sequences/icons'
import { FloatingBanner } from '../ui/Banner'
import EmptyState from '../ui/EmptyState'
import LearningEditor from './LearningEditor'
import LearningListItem, { type LearningRow } from './LearningListItem'
import {
  NO_LEARNING_FILTERS,
  hasLearningFilters,
  learningTagSuggestions,
  matchesLearningFilters,
  titleFromInsight,
  type AuthorFilter,
  type LearningFilters
} from './learning-utils'
import { fold } from './prompt-utils'
import { useLearningDraft, type LearningDraft } from './useLearningDraft'
import { useLearnings } from './useLearnings'

interface Props {
  navigate: Navigate
  /** The Prompts / Learnings switch, shown in the list's header. */
  tabs: ReactNode
  /** A learning to open first (from a clip's "Learnings from this clip"). */
  initialId?: string
}

const chip = (active: boolean) =>
  `rounded-full border px-2 py-0.5 text-[12px] transition ${
    active ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
  }`

const COLLAPSED_TAGS = 8

/**
 * Learnings: short insights about writing prompts that work, distilled from how clips actually turned out —
 * mostly by agents reviewing the clips over MCP, but the user can write and edit them too. Each can be pinned
 * (agents see pinned ones first), tied to a model, and backed by the clips it is based on. The list has the side
 * lists' header, search and keys, in the wider column Prompts has.
 */
export default function LearningsView({ navigate, tabs, initialId }: Props) {
  const { learnings, loaded, error: loadError } = useLearnings()
  const editor = useLearningDraft(learnings)
  const { draft } = editor
  const { models } = useModels()
  const feed = useGenerations()
  const { assets } = useAssetsState()
  const index = useMemo(() => buildLibraryIndex(assets), [assets])
  const generationsById = useMemo(() => new Map(feed.generations.map((g) => [g.id, g])), [feed.generations])

  const [filters, setFilters] = useState<LearningFilters>(NO_LEARNING_FILTERS)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [clipId, setClipId] = useState<string>()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const modelName = useCallback((id?: string) => (id ? (models.find((m) => m.id === id)?.name ?? id) : undefined), [models])

  // The open learning stays listed even if an edit makes it stop matching the filters.
  const visible = learnings.filter((l) => l.id === draft?.id || matchesLearningFilters(l, filters))
  const stored = draft?.id ? learnings.find((l) => l.id === draft.id) : undefined
  const showDraftRow = !!draft && !stored
  const filtering = hasLearningFilters(filters)

  const tags = useMemo(() => {
    const counts = new Map<string, { key: string; label: string; count: number }>()
    for (const l of learnings) {
      for (const t of l.tags) {
        const key = fold(t)
        const entry = counts.get(key)
        if (entry) entry.count++
        else counts.set(key, { key, label: t.trim(), count: 1 })
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'en'))
  }, [learnings])
  const visibleTags = tagsExpanded ? tags : tags.filter((t, i) => i < COLLAPSED_TAGS || filters.tags.includes(t.key))
  const usedModels = useMemo(
    () => [...new Set(learnings.flatMap((l) => (l.model ? [l.model] : [])))].sort((a, b) => a.localeCompare(b)),
    [learnings]
  )
  const tagSuggestions = useMemo(() => learningTagSuggestions(learnings), [learnings])

  // Open the requested learning, else the top one, the first time the list arrives.
  const autoSelected = useRef(false)
  useEffect(() => {
    if (autoSelected.current || !loaded) return
    autoSelected.current = true
    const wanted = initialId ? learnings.find((l) => l.id === initialId) : undefined
    if (wanted) editor.select(wanted)
    else if (!draft && learnings[0]) editor.select(learnings[0])
  }, [loaded])

  const set = (patch: Partial<LearningFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleTag = (key: string) =>
    set({ tags: filters.tags.includes(key) ? filters.tags.filter((k) => k !== key) : [...filters.tags, key] })

  // A new learning inherits the model and pin filters, so it shows up where it was created.
  const newLearning = () => {
    autoSelected.current = true
    editor.create({ model: filters.model, pinned: filters.pinnedOnly })
  }

  // "New learning" from ⌘K: as the header's button does, once the learnings have loaded.
  useCreateRequest(loaded, newLearning, 'learnings')

  const remove = () => {
    const at = visible.findIndex((l) => l.id === draft?.id)
    const rest = visible.filter((l) => l.id !== draft?.id)
    return editor.remove(rest[Math.min(Math.max(at, 0), rest.length - 1)])
  }

  // The side lists' keys: ↑ ↓ (Home, End) open a row; in the search ↓ goes to the rows, Enter opens the first match
  // and Esc clears it. ⌘F goes to the search.
  const { onSearchKeyDown, onListKeyDown } = useListKeys({
    ids: visible.map((l) => l.id),
    matchIds: visible.filter((l) => matchesLearningFilters(l, filters)).map((l) => l.id),
    selectedId: draft?.id,
    onSelect: (id) => editor.select(visible.find((l) => l.id === id)),
    searchRef,
    listRef,
    onClearSearch: () => set({ query: '' })
  })
  useFindShortcut(searchRef)

  // ── The clip drawer, stepping through the open learning's evidence ──────────

  const evidence = draft?.evidence ?? []
  const clip = clipId ? generationsById.get(clipId) : undefined
  const clipIndex = clipId ? evidence.indexOf(clipId) : -1
  const openClip = (id: string | undefined) => setClipId(id)
  useEffect(() => setClipId(undefined), [draft?.key])

  const reuse = useCallback(
    (g: Generation) => {
      setGenerateParams({ ...g.params })
      navigate('generate')
    },
    [navigate]
  )

  return (
    <div className="relative flex h-full">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <ListHeader title={tabs} createLabel="New learning" onCreate={newLearning} />

        {learnings.length > 0 && (
          <div className="shrink-0 space-y-2.5 px-2 pb-2">
            <div className="relative">
              <input
                ref={searchRef}
                type="text"
                role="searchbox"
                value={filters.query}
                onChange={(e) => set({ query: e.target.value })}
                onKeyDown={onSearchKeyDown}
                placeholder="Search learnings…"
                aria-label="Search learnings"
                title={shortcut('Search learnings (⌘F)')}
                spellCheck={false}
                className="w-full rounded-md border border-line bg-raised py-1.5 pl-2.5 pr-7 outline-none focus:border-muted"
              />
              {filters.query && (
                <button
                  type="button"
                  onClick={() => {
                    set({ query: '' })
                    searchRef.current?.focus()
                  }}
                  title="Clear search"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
                >
                  <CloseIcon size={9} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => set({ pinnedOnly: !filters.pinnedOnly })} className={chip(filters.pinnedOnly)}>
                <PinIcon size={11} filled={filters.pinnedOnly} className="-mt-px mr-0.5 inline text-amber-400" /> Pinned
              </button>
              {(['user', 'agents'] as AuthorFilter[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => set({ author: filters.author === a ? undefined : a })}
                  className={chip(filters.author === a)}
                >
                  {a === 'user' ? 'Yours' : "Agents'"}
                </button>
              ))}
              {visibleTags.map((t) => (
                <button key={t.key} type="button" onClick={() => toggleTag(t.key)} className={chip(filters.tags.includes(t.key))}>
                  {t.label}
                  <span className="ml-1 text-[11px] text-muted">{t.count}</span>
                </button>
              ))}
              {tags.length > COLLAPSED_TAGS && (
                <button
                  type="button"
                  onClick={() => setTagsExpanded(!tagsExpanded)}
                  className="px-1 text-[12px] text-muted hover:text-text"
                >
                  {tagsExpanded ? 'Show fewer' : `+${tags.length - visibleTags.length} more`}
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
              <span>
                {visible.length === learnings.length
                  ? `${learnings.length} ${learnings.length === 1 ? 'learning' : 'learnings'}`
                  : `${visible.length} of ${learnings.length}`}
              </span>
              {usedModels.length > 0 && (
                <select
                  value={filters.model ?? ''}
                  onChange={(e) => set({ model: e.target.value || undefined })}
                  aria-label="Model"
                  className="min-w-0 max-w-44 cursor-pointer truncate rounded bg-transparent py-0.5 text-right text-muted outline-none hover:text-text focus-visible:ring-1 focus-visible:ring-muted"
                >
                  <option value="">All models</option>
                  {usedModels.map((id) => (
                    <option key={id} value={id}>
                      {modelName(id)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        <div
          ref={listRef}
          aria-label="Learnings"
          onKeyDown={onListKeyDown}
          className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
        >
          {showDraftRow && (
            <LearningListItem
              row={rowFromDraft(draft, modelName(draft.model))}
              selected
              unsaved={!draft.id}
              onSelect={() => undefined}
            />
          )}
          {visible.map((l) => {
            const selected = l.id === draft?.id
            return (
              <LearningListItem
                key={l.id}
                id={l.id}
                row={selected && draft ? rowFromDraft(draft, modelName(draft.model)) : rowFromLearning(l, modelName(l.model))}
                selected={selected}
                onSelect={() => editor.select(l)}
              />
            )
          })}

          {learnings.length > 0 && visible.length === 0 && filtering && (
            <div className="px-2 py-2 text-[12px] leading-relaxed text-muted">
              <p>No learnings match.</p>
              <button
                type="button"
                onClick={() => setFilters(NO_LEARNING_FILTERS)}
                className="mt-1 text-text underline-offset-2 hover:underline"
              >
                Clear search and filters
              </button>
            </div>
          )}
          {/* Loading the list failed: said where the list would be, until the next change loads it again. */}
          {loadError && (
            <p role="alert" className="px-2 py-2 text-[12px] leading-relaxed text-danger select-text">
              {loadError}
            </p>
          )}
        </div>
      </aside>

      {draft ? (
        <LearningEditor
          key={draft.key}
          draft={draft}
          status={editor.status}
          models={models}
          generations={generationsById}
          generationsLoaded={feed.loaded}
          tagSuggestions={tagSuggestions}
          onChange={editor.update}
          onBlur={() => void editor.flush()}
          onTogglePin={() => {
            editor.update({ pinned: !draft.pinned })
            void editor.flush()
          }}
          onDelete={remove}
          onOpenClip={openClip}
        />
      ) : loaded ? (
        <EmptyLearnings hasLearnings={learnings.length > 0} onNew={newLearning} />
      ) : (
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="drag h-12 shrink-0" />
        </section>
      )}

      {clip && (
        <ClipDrawer
          generation={clip}
          models={models}
          index={index}
          position={clipIndex >= 0 ? { index: clipIndex, total: evidence.length } : undefined}
          onPrev={clipIndex > 0 ? () => openClip(evidence[clipIndex - 1]) : undefined}
          onNext={clipIndex >= 0 && clipIndex < evidence.length - 1 ? () => openClip(evidence[clipIndex + 1]) : undefined}
          onClose={() => openClip(undefined)}
          onReuse={reuse}
          reuseTitle="Open Generate with the clip's settings"
          onDelete={(g) => {
            void feed.remove(g).then((removed) => removed && openClip(undefined))
          }}
          onChange={feed.patch}
          onRate={feed.rate}
          navigate={navigate}
          onOpenLearning={(id) => {
            const l = learnings.find((x) => x.id === id)
            if (l) editor.select(l)
          }}
        />
      )}

      {(editor.error || feed.error) && (
        <FloatingBanner
          key={editor.error ?? feed.error}
          tone="error"
          onDismiss={editor.error ? editor.clearError : feed.clearError}
        >
          {editor.error ?? feed.error}
        </FloatingBanner>
      )}
    </div>
  )
}

function rowFromDraft(d: LearningDraft, modelName?: string): LearningRow {
  return {
    title: d.title.trim() || titleFromInsight(d.insight),
    insight: d.insight.trim(),
    modelName,
    author: d.author,
    pinned: d.pinned,
    evidenceCount: d.evidence.length
  }
}

function rowFromLearning(l: Learning, modelName?: string): LearningRow {
  return {
    title: l.title,
    insight: l.insight,
    modelName,
    author: l.author,
    pinned: l.pinned,
    evidenceCount: l.evidence.length
  }
}

function EmptyLearnings({ hasLearnings, onNew }: { hasLearnings: boolean; onNew: () => void }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="drag h-12 shrink-0" />
      {hasLearnings ? (
        <div className="flex flex-1 items-center justify-center px-8 pb-12">
          <div className="text-center text-muted">
            <p>Pick a learning in the list, or write a new one.</p>
            <p className="mt-1 text-[11px]">{shortcut('⌘F')} to search · ↑ ↓ to browse</p>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<BulbIcon size={22} />}
          title="Learnings"
          text="Short insights into what works when you write prompts – how a model handles clothes, voices or camera moves. A connected agent can look at your clips, compare them with the prompt and save what it learns here, and reads the learnings before it writes the next prompt. You can write your own too."
          action={{ label: 'Write the first learning', onClick: onNew }}
          footnote="Rate the clips in Media – your ratings and notes help the agent draw the right conclusions."
        />
      )}
    </section>
  )
}
