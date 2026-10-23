import { useEffect, useId, useRef } from 'react'
import type { SavedPrompt } from '@shared/types'
import { isSubmitKey, shortcut, submitKeyHandler } from '../../lib/platform'
import PromptField from '../prompt/PromptField'
import { buttonClass } from '../ui/button'
import MoreMenu, { MenuDivider, MenuItem } from '../ui/MoreMenu'
import { CopyButton, FavoriteButton, FieldLabel, secondaryButton } from './controls'
import { formatUses, formatWhen, titleFromBody } from './prompt-utils'
import TagInput from './TagInput'
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
  /** Deletes the prompt (after the question in ⋯), or discards a new one; "Deleting…" until it settles. */
  onDelete: () => void | Promise<void>
}

/** A prompt that points at reference images or sounds by number, where the note about reference mode applies. */
const TOKENS = /@(?:Image|Audio|Video)\d/i

function SaveIndicator({ draft, status }: { draft: Draft; status?: SaveStatus }) {
  if (status?.state === 'error') {
    return (
      <span className="no-drag truncate text-danger select-text" title={status.error}>
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

/**
 * One saved prompt, laid out as every library editor is: the save status alone in the top bar; the title (with its
 * star) and a meta line; one row of actions – Generate with the prompt, Copy prompt, then ⋯ with Duplicate and
 * Delete… (a new prompt has Discard instead); then the prompt, the negative prompt and the tags. ⌘↵ from any of its
 * fields generates with it.
 */
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
  const bodyId = useId()
  const negativeId = useId()
  const tagsId = useId()
  const savable = canSave(draft)
  const isNew = !draft.id
  const name = draft.title.trim() || stored?.title || titleFromBody(draft.body) || 'Untitled'

  // A fresh prompt starts with the cursor in the body; the title can be left to fill itself in.
  useEffect(() => {
    if (isNew) bodyRef.current?.focus()
  }, [])

  const use = () => {
    if (savable) onUse()
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col" onKeyDown={submitKeyHandler(use)}>
      <div className="drag flex h-12 shrink-0 items-center justify-end px-6">
        <div className="min-w-0 truncate text-[11px]">
          <SaveIndicator draft={draft} status={status} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-4xl px-8 pb-16">
          <header>
            <div className="flex items-center gap-3">
              <input
                value={draft.title}
                onChange={(e) => onChange({ title: e.target.value })}
                onBlur={onBlur}
                onKeyDown={(e) => {
                  // Enter goes on to the prompt; ⌘↵ is the form's (Generate with the prompt).
                  if (e.key !== 'Enter' || isSubmitKey(e) || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  bodyRef.current?.focus()
                }}
                placeholder={titleFromBody(draft.body) || 'Title'}
                aria-label="Title"
                spellCheck={false}
                className="-ml-2 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold outline-none placeholder:text-muted/60 hover:border-line focus:border-muted focus:bg-raised"
              />
              <FavoriteButton active={draft.favorite} onToggle={onToggleFavorite} className="text-xl" />
            </div>
            {stored && (
              <p className="mt-0.5 text-[11px] text-muted">
                Created {formatWhen(stored.createdAt)} · Updated {formatWhen(stored.updatedAt)} ·{' '}
                {formatUses(stored.useCount)}
                {stored.lastUsedAt ? `, last ${formatWhen(stored.lastUsedAt)}` : ''}
              </p>
            )}
          </header>

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={use}
              disabled={!savable}
              title={`Opens Generate with the prompt (${shortcut('⌘↵')})`}
              className={buttonClass('primary')}
            >
              Generate with the prompt
            </button>
            <CopyButton
              text={draft.body.trim()}
              disabled={!savable}
              label="Copy prompt"
              title="Copy the prompt to the clipboard"
              size="md"
            />
            <div className="ml-auto">
              {isNew ? (
                <button type="button" onClick={() => void onDelete()} className={secondaryButton}>
                  Discard
                </button>
              ) : (
                <MoreMenu>
                  {(menu) => (
                    <>
                      <MenuItem onSelect={onDuplicate} disabled={!savable}>
                        Duplicate
                      </MenuItem>
                      <MenuDivider />
                      <MenuItem
                        danger
                        onSelect={() => menu.confirm({ question: `Delete “${name}”?`, onConfirm: onDelete })}
                      >
                        Delete…
                      </MenuItem>
                    </>
                  )}
                </MoreMenu>
              )}
            </div>
          </div>

          <div className="mt-8 space-y-6">
            <div>
              <FieldLabel htmlFor={bodyId}>Prompt</FieldLabel>
              <PromptField
                id={bodyId}
                textareaRef={bodyRef}
                value={draft.body}
                onChange={(body) => onChange({ body })}
                onBlur={onBlur}
                onSubmit={use}
                context="video"
                minRows={10}
                maxRows={24}
                title="Prompt"
                focusHint="Describe the scene, the movement and the camera. Type / for a building block. Everything is saved as you type."
                placeholder="Describe the scene, the movement and the camera… (type / for building blocks)"
              />
              {TOKENS.test(draft.body) && (
                <p className="mt-1 text-[11px] text-muted">
                  In reference mode, @Image1, @Image2 … point to the images in the order they have in the form.
                </p>
              )}
            </div>

            <div>
              <FieldLabel htmlFor={negativeId} hint="Optional">
                Negative prompt
              </FieldLabel>
              <PromptField
                id={negativeId}
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
            </div>

            <div>
              <FieldLabel htmlFor={tagsId}>Tags</FieldLabel>
              <TagInput
                id={tagsId}
                value={draft.tags}
                onChange={(tags) => onChange({ tags })}
                suggestions={tagSuggestions}
                onBlur={onBlur}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
