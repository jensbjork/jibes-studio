import { useEffect, useRef } from 'react'
import type { SavedPrompt } from '@shared/types'
import { shortcut } from '../../lib/platform'
import { ConfirmDeleteButton, CopyButton, FavoriteButton, secondaryButton } from './controls'
import { formatUses, formatWhen, titleFromBody } from './prompt-utils'
import TagInput from './TagInput'
import PromptField from '../prompt/PromptField'
import { canSave, type Draft, type DraftFields, type SaveStatus } from './usePromptDraft'

interface Props {
  draft: Draft
  /** The stored version, for usage stats; missing until a new prompt is first saved. */
  stored?: SavedPrompt
  status?: SaveStatus
  tagSuggestions: string[]
  onChange: (patch: DraftFields) => void
  /** Saves right away instead of waiting for the debounce. */
  onBlur: () => void
  onToggleFavorite: () => void
  onUse: () => void
  onDuplicate: () => void
  onDelete: () => void
}

const field = 'w-full rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted'

function SaveIndicator({ draft, status }: { draft: Draft; status?: SaveStatus }) {
  if (status?.state === 'error') {
    return (
      <span className="truncate text-accent select-text" title={status.error}>
        Couldn't save: {status.error}
      </span>
    )
  }
  if (status?.state === 'invalid' || (!draft.id && !canSave(draft))) {
    return <span className="text-muted">{draft.id ? "An empty prompt isn't saved" : 'New prompt – saved once you start writing'}</span>
  }
  if (status?.state === 'pending' || status?.state === 'saving') return <span className="text-muted">Saving…</span>
  if (status?.state === 'saved') return <span className="text-muted">Saved</span>
  return null
}

export default function PromptEditor({
  draft,
  stored,
  status,
  tagSuggestions,
  onChange,
  onBlur,
  onToggleFavorite,
  onUse,
  onDuplicate,
  onDelete
}: Props) {
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const savable = canSave(draft)
  const isNew = !draft.id

  // A fresh prompt starts with the cursor in the body; the title can be left to fill itself in.
  useEffect(() => {
    if (isNew) bodyRef.current?.focus()
  }, [])

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="drag flex h-12 shrink-0 items-center gap-3 pl-8 pr-4">
        <div className="min-w-0 flex-1 truncate text-[12px]">
          <SaveIndicator draft={draft} status={status} />
        </div>
        <div className="no-drag flex shrink-0 items-center gap-1">
          <CopyButton text={draft.body.trim()} disabled={!savable} />
          <button
            type="button"
            onClick={onDuplicate}
            disabled={isNew || !savable}
            title="Make a copy to vary"
            className={secondaryButton}
          >
            Duplicate
          </button>
          {isNew ? (
            <button type="button" onClick={onDelete} className={secondaryButton}>
              Discard
            </button>
          ) : (
            <ConfirmDeleteButton onConfirm={onDelete} />
          )}
          <button
            type="button"
            onClick={onUse}
            disabled={!savable}
            title={`Open in Generate (${shortcut('⌘ + Enter')})`}
            className="ml-1 rounded-md bg-accent px-3.5 py-1.5 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
          >
            Use
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-8 pb-10 pt-2">
          <div className="flex items-center gap-3">
            <input
              value={draft.title}
              onChange={(e) => onChange({ title: e.target.value })}
              onBlur={onBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  bodyRef.current?.focus()
                }
              }}
              placeholder={titleFromBody(draft.body) || 'Title'}
              aria-label="Title"
              className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:text-muted/60"
            />
            <FavoriteButton active={draft.favorite} onToggle={onToggleFavorite} className="text-xl" />
          </div>

          <TagInput
            value={draft.tags}
            onChange={(tags) => onChange({ tags })}
            suggestions={tagSuggestions}
            onBlur={onBlur}
          />

          <label className="block">
            <span className="mb-1.5 flex justify-between text-muted">
              <span>Prompt</span>
            </span>
            <PromptField
              textareaRef={bodyRef}
              value={draft.body}
              onChange={(body) => onChange({ body })}
              onBlur={onBlur}
              onSubmit={() => {
                if (savable) onUse()
              }}
              context="video"
              minRows={10}
              maxRows={24}
              title="Prompt"
              focusHint="Describe the scene, the movement and the camera. Type / for a building block. Everything is saved as you type."
              placeholder="Describe the scene, the movement and the camera… (type / for building blocks)"
            />
            <span className="mt-1 block text-[11px] text-muted">
              In reference mode you point to the images with @Image1, @Image2 … in the order they have in the form.
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-muted">Negative prompt (optional)</span>
            <PromptField
              value={draft.negativePrompt}
              onChange={(negativePrompt) => onChange({ negativePrompt })}
              onBlur={onBlur}
              context="negative"
              minRows={2}
              maxRows={8}
              title="Negative prompt"
              focusHint="What the model should avoid, preferably in English and comma-separated."
              placeholder="What you don't want to see…"
            />
          </label>

          {stored && (
            <p className="border-t border-line pt-4 text-[11px] text-muted">
              Created {formatWhen(stored.createdAt)} · Updated {formatWhen(stored.updatedAt)} ·{' '}
              {formatUses(stored.useCount)}
              {stored.lastUsedAt ? `, last ${formatWhen(stored.lastUsedAt)}` : ''}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
