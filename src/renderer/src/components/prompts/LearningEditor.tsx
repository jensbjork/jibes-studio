import { useEffect, useRef, useState } from 'react'
import { agentInSentence } from '@shared/agent-name'
import { generationTitle } from '@shared/generation-label'
import type { Generation, VideoModel } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { isPending } from '../feed/feedText'
import { PinIcon } from '../feed/icons'
import RatingControl from '../feed/RatingControl'
import { CloseIcon } from '../sequences/icons'
import { ConfirmDeleteButton, CopyButton, secondaryButton } from './controls'
import { MAX_INSIGHT_LENGTH, MAX_TITLE_LENGTH, titleFromInsight } from './learning-utils'
import { formatWhen } from './prompt-utils'
import TagInput from './TagInput'
import { canSaveLearning, type LearningDraft, type LearningDraftFields, type LearningSaveStatus } from './useLearningDraft'

interface Props {
  draft: LearningDraft
  status?: LearningSaveStatus
  models: readonly VideoModel[]
  /** Every generation by id, for the evidence thumbnails. */
  generations: ReadonlyMap<string, Generation>
  generationsLoaded: boolean
  tagSuggestions: string[]
  onChange: (patch: LearningDraftFields) => void
  /** Saves right away instead of waiting for the debounce. */
  onBlur: () => void
  onTogglePin: () => void
  onDelete: () => void
  /** Opens one of the evidence clips in the detail drawer. */
  onOpenClip: (id: string) => void
}

const field = 'w-full rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted'

function SaveIndicator({ draft, status }: { draft: LearningDraft; status?: LearningSaveStatus }) {
  if (status?.state === 'error') {
    return (
      <span className="truncate text-accent select-text" title={status.error}>
        Couldn't save: {status.error}
      </span>
    )
  }
  if (status?.state === 'invalid' || (!draft.id && !canSaveLearning(draft))) {
    return (
      <span className="text-muted">
        {draft.id ? "An empty learning isn't saved" : 'New learning – saved once you start writing'}
      </span>
    )
  }
  if (status?.state === 'pending' || status?.state === 'saving') return <span className="text-muted">Saving…</span>
  if (status?.state === 'saved') return <span className="text-muted">Saved</span>
  return null
}

/** One learning: what was learned, for which model, and the clips it is based on. */
export default function LearningEditor({
  draft,
  status,
  models,
  generations,
  generationsLoaded,
  tagSuggestions,
  onChange,
  onBlur,
  onTogglePin,
  onDelete,
  onOpenClip
}: Props) {
  const insightRef = useRef<HTMLTextAreaElement>(null)
  const isNew = !draft.id

  // A fresh learning starts with the cursor in the insight; the title can be left to fill itself in.
  useEffect(() => {
    if (isNew) insightRef.current?.focus()
  }, [])

  const modelOptions = models.map((m) => ({ id: m.id, name: m.name }))
  if (draft.model && !modelOptions.some((m) => m.id === draft.model)) {
    modelOptions.unshift({ id: draft.model, name: draft.model })
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="drag flex h-12 shrink-0 items-center gap-3 pl-8 pr-4">
        <div className="min-w-0 flex-1 truncate text-[12px]">
          <SaveIndicator draft={draft} status={status} />
        </div>
        <div className="no-drag flex shrink-0 items-center gap-1">
          <CopyButton text={[draft.title.trim(), draft.insight.trim()].filter(Boolean).join('\n\n')} disabled={!canSaveLearning(draft)} />
          <button
            type="button"
            onClick={onTogglePin}
            disabled={isNew}
            aria-pressed={draft.pinned}
            title={
              draft.pinned
                ? 'Unpin – stop showing it at the top'
                : 'Pin to top – agents read pinned learnings first when they write prompts'
            }
            className={`${secondaryButton} flex items-center gap-1.5 ${draft.pinned ? 'text-amber-400 hover:text-amber-300' : ''}`}
          >
            <PinIcon size={13} filled={draft.pinned} />
            {draft.pinned ? 'Pinned' : 'Pin to top'}
          </button>
          {isNew ? (
            <button type="button" onClick={onDelete} className={secondaryButton}>
              Discard
            </button>
          ) : (
            <ConfirmDeleteButton onConfirm={onDelete} confirmLabel="Delete learning" />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-8 pb-10 pt-2">
          <input
            value={draft.title}
            onChange={(e) => onChange({ title: e.target.value })}
            onBlur={onBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                insightRef.current?.focus()
              }
            }}
            maxLength={MAX_TITLE_LENGTH}
            placeholder={titleFromInsight(draft.insight) || 'Title'}
            aria-label="Title"
            className="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-muted/60"
          />

          <label className="block">
            <span className="mb-1.5 flex justify-between text-muted">
              <span>Learning</span>
              <span className="text-[11px]">{draft.insight.length > 3000 ? `${draft.insight.length} / ${MAX_INSIGHT_LENGTH}` : ''}</span>
            </span>
            <textarea
              ref={insightRef}
              value={draft.insight}
              onChange={(e) => onChange({ insight: e.target.value })}
              onBlur={onBlur}
              maxLength={MAX_INSIGHT_LENGTH}
              rows={6}
              placeholder="What works, and what doesn't? E.g. “Seedance 2.5: mention the clothes after the character's images, or it changes them.”"
              className={`${field} min-h-32 resize-y text-[14px] leading-relaxed`}
            />
            <span className="mt-1 block text-[11px] text-muted">
              Write it as a rule you can follow next time. Agents read the learnings before they write new prompts.
            </span>
          </label>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
            <label className="block">
              <span className="mb-1.5 block text-muted">Applies to model</span>
              <select
                value={draft.model ?? ''}
                onChange={(e) => {
                  onChange({ model: e.target.value || undefined })
                  onBlur()
                }}
                className={`${field} cursor-pointer py-[7px]`}
              >
                <option value="">All models</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-1.5 block text-muted">Tags</span>
              <TagInput value={draft.tags} onChange={(tags) => onChange({ tags })} suggestions={tagSuggestions} onBlur={onBlur} />
            </div>
          </div>

          <Evidence
            ids={draft.evidence}
            generations={generations}
            loaded={generationsLoaded}
            onOpen={onOpenClip}
            onRemove={(id) => {
              onChange({ evidence: draft.evidence.filter((e) => e !== id) })
              onBlur()
            }}
          />

          {draft.id && (
            <p className="border-t border-line pt-4 text-[11px] text-muted">
              {draft.author === 'user' ? 'Written by you' : `Written by ${agentInSentence(draft.author)}`}
              {draft.createdAt ? ` · Created ${formatWhen(draft.createdAt)}` : ''}
              {draft.updatedAt && draft.updatedAt !== draft.createdAt ? ` · Updated ${formatWhen(draft.updatedAt)}` : ''}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** The clips a learning is based on, as thumbnails that open in the detail drawer. */
function Evidence({
  ids,
  generations,
  loaded,
  onOpen,
  onRemove
}: {
  ids: string[]
  generations: ReadonlyMap<string, Generation>
  loaded: boolean
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <section>
      <span className="mb-1.5 block text-muted">Evidence</span>
      {ids.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-4 py-4 text-[12px] leading-relaxed text-muted">
          No clips linked. When an agent reviews your clips and saves a learning, it links the clips it is based on
          here – so you can see for yourself whether the conclusion holds.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
          {ids.map((id) => {
            const g = generations.get(id)
            return (
              <li key={id} className="group relative">
                <EvidenceThumb id={id} g={g} loaded={loaded} onOpen={onOpen} />
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  title="Remove the clip from the evidence (the clip itself stays)"
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-text opacity-0 backdrop-blur transition hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <CloseIcon size={9} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function EvidenceThumb({
  id,
  g,
  loaded,
  onOpen
}: {
  id: string
  g?: Generation
  loaded: boolean
  onOpen: (id: string) => void
}) {
  const [failed, setFailed] = useState(false)
  if (!g) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-md border border-line bg-raised/40 p-2 text-center text-[11px] text-muted">
        {loaded ? 'The clip no longer exists' : ''}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      title={generationTitle(g)}
      className="block w-full overflow-hidden rounded-md border border-line text-left transition hover:border-muted"
    >
      <span className="relative block aspect-video bg-black">
        {g.thumbPath && !failed ? (
          <img
            src={mediaUrl(g.thumbPath)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-[11px] text-muted">
            {isPending(g) ? 'Generating…' : g.status === 'failed' ? 'Failed' : ''}
          </span>
        )}
        {g.rating ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 backdrop-blur">
            <RatingControl value={g.rating} size="sm" filledOnly />
          </span>
        ) : null}
      </span>
      <span className="block truncate px-2 py-1 text-[11px] text-muted">
        {g.prompt || g.title ? generationTitle(g, 80) : 'No prompt'}
      </span>
    </button>
  )
}
