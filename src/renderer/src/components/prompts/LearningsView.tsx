import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Generation, Learning } from '@shared/types'
import { setGenerateParams } from '../../lib/generateStore'
import { useAssetsState, useModels } from '../../lib/hooks'
import type { Navigate } from '../../lib/navigation'
import ClipDrawer from '../feed/ClipDrawer'
import { BulbIcon, PinIcon } from '../feed/icons'
import { buildLibraryIndex } from '../feed/references'
import { useGenerations } from '../feed/useGenerations'
import { CloseIcon } from '../sequences/icons'
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
  /** The Prompter / Lärdomar switch, shown in the list's header. */
  tabs: ReactNode
  /** A learning to open first (from a clip's "Lärdomar från klippet"). */
  initialId?: string
}

const chip = (active: boolean) =>
  `rounded-full border px-2 py-0.5 text-[12px] transition ${
    active ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
  }`

const COLLAPSED_TAGS = 8

/**
 * Lärdomar: short insights about writing prompts that work, distilled from how clips actually turned out —
 * mostly by agents reviewing the clips over MCP, but the user can write and edit them too. Each can be pinned
 * (agents see pinned ones first), tied to a model, and backed by the clips it is based on.
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
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'sv'))
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

  const set = (patch: Partial<LearningFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleTag = (key: string) =>
    set({ tags: filters.tags.includes(key) ? filters.tags.filter((k) => k !== key) : [...filters.tags, key] })

  const remove = () => {
    const at = visible.findIndex((l) => l.id === draft?.id)
    const rest = visible.filter((l) => l.id !== draft?.id)
    void editor.remove(rest[Math.min(Math.max(at, 0), rest.length - 1)])
  }

  const step = (direction: 1 | -1) => {
    if (!visible.length) return
    const at = visible.findIndex((l) => l.id === draft?.id)
    const next = at === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, at + direction))
    editor.select(visible[next])
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    }
  }

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
        <div className="drag flex h-12 shrink-0 items-center justify-between pl-3 pr-3">
          {tabs}
          <button
            type="button"
            onClick={() => editor.create({ model: filters.model, pinned: filters.pinnedOnly })}
            className="no-drag rounded-md px-2.5 py-1 text-muted transition hover:bg-raised hover:text-text"
          >
            ＋ Ny lärdom
          </button>
        </div>

        {learnings.length > 0 && (
          <div className="shrink-0 space-y-2.5 px-4 pb-2">
            <div className="relative">
              <input
                ref={searchRef}
                value={filters.query}
                onChange={(e) => set({ query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && filters.query) {
                    e.preventDefault()
                    set({ query: '' })
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    listRef.current?.focus()
                    if (!visible.some((l) => l.id === draft?.id)) step(1)
                  }
                }}
                placeholder="Sök i lärdomarna…"
                className="w-full rounded-md border border-line bg-raised py-1.5 pl-3 pr-8 outline-none focus:border-muted"
              />
              {filters.query && (
                <button
                  type="button"
                  onClick={() => {
                    set({ query: '' })
                    searchRef.current?.focus()
                  }}
                  title="Rensa sökningen"
                  className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
                >
                  <CloseIcon size={9} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => set({ pinnedOnly: !filters.pinnedOnly })} className={chip(filters.pinnedOnly)}>
                <PinIcon size={11} filled={filters.pinnedOnly} className="-mt-px mr-0.5 inline text-amber-400" /> Fästa
              </button>
              {(['user', 'agents'] as AuthorFilter[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => set({ author: filters.author === a ? undefined : a })}
                  className={chip(filters.author === a)}
                >
                  {a === 'user' ? 'Dina' : 'Agenternas'}
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
                  {tagsExpanded ? 'Visa färre' : `+${tags.length - visibleTags.length} till`}
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
              <span>
                {visible.length === learnings.length
                  ? `${learnings.length} ${learnings.length === 1 ? 'lärdom' : 'lärdomar'}`
                  : `${visible.length} av ${learnings.length}`}
              </span>
              {usedModels.length > 0 && (
                <select
                  value={filters.model ?? ''}
                  onChange={(e) => set({ model: e.target.value || undefined })}
                  aria-label="Modell"
                  className="min-w-0 max-w-44 cursor-pointer truncate rounded bg-transparent py-0.5 text-right text-muted outline-none hover:text-text"
                >
                  <option value="">Alla modeller</option>
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
          role="listbox"
          aria-label="Lärdomar"
          tabIndex={0}
          onKeyDown={onListKey}
          className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 outline-none"
        >
          {showDraftRow && (
            <LearningListItem
              row={rowFromDraft(draft, modelName(draft.model))}
              selected
              unsaved={!draft.id}
              onSelect={() => undefined}
              onTogglePin={() => undefined}
            />
          )}
          {visible.map((l) => {
            const selected = l.id === draft?.id
            return (
              <LearningListItem
                key={l.id}
                row={selected && draft ? rowFromDraft(draft, modelName(draft.model)) : rowFromLearning(l, modelName(l.model))}
                selected={selected}
                onSelect={() => editor.select(l)}
                onTogglePin={() => editor.togglePin(l)}
              />
            )
          })}

          {learnings.length > 0 && visible.length === 0 && filtering && (
            <div className="px-3 py-8 text-center text-muted">
              <p>Inga lärdomar matchar.</p>
              <button
                type="button"
                onClick={() => setFilters(NO_LEARNING_FILTERS)}
                className="mt-2 text-text underline-offset-2 hover:underline"
              >
                Rensa sökning och filter
              </button>
            </div>
          )}
          {loaded && learnings.length === 0 && !draft && (
            <p className="px-3 py-8 text-center text-muted">Inga lärdomar ännu.</p>
          )}
        </div>

        {(editor.error || feed.error || loadError) && (
          <div className="flex items-start gap-2 border-t border-line px-4 py-3 text-accent">
            <p className="min-w-0 flex-1 select-text">{editor.error ?? feed.error ?? loadError}</p>
            {(editor.error || feed.error) && (
              <button
                type="button"
                onClick={editor.error ? editor.clearError : feed.clearError}
                title="Stäng"
                className="text-muted hover:text-text"
              >
                ✕
              </button>
            )}
          </div>
        )}
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
        <EmptyLearnings hasLearnings={learnings.length > 0} onNew={() => editor.create()} />
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
          reuseTitle="Öppna Generera med klippets inställningar"
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
      <div className="flex flex-1 items-center justify-center px-8 pb-12">
        {hasLearnings ? (
          <div className="text-center text-muted">
            <p>Välj en lärdom i listan, eller skriv en ny.</p>
            <p className="mt-1 text-[11px]">⌘ F söker · ↑ ↓ bläddrar</p>
          </div>
        ) : (
          <div className="max-w-md text-center">
            <BulbIcon size={34} className="mx-auto mb-4 text-muted" />
            <h2 className="mb-2 text-base font-semibold">Lärdomar</h2>
            <p className="mb-5 leading-relaxed text-muted">
              Korta insikter om vad som fungerar när du skriver prompter – hur en modell hanterar kläder, röster
              eller kamerarörelser. En ansluten agent kan titta på dina klipp, jämföra dem med prompten och spara
              det den lär sig här, och läser lärdomarna innan den skriver nästa prompt. Du kan också skriva egna.
            </p>
            <button
              type="button"
              onClick={onNew}
              className="rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover"
            >
              Skriv första lärdomen
            </button>
            <p className="mt-4 text-[11px] text-muted">
              Betygsätt klippen i Mediabanken – dina betyg och anteckningar hjälper agenten att dra rätt slutsatser.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
