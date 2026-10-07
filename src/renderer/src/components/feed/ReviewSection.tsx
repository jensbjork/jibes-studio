import { useEffect, useRef, useState } from 'react'
import type { Generation, GenerationReview } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { formatWhen } from '../prompts/prompt-utils'
import ConfirmButton from '../sequences/ConfirmButton'
import { REVIEW_TAGS, authorLabel, tagChipClass, tagLabel } from './feedText'
import StarRating from './StarRating'

const NOTE_DELAY = 700

const sectionTitle = 'mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted'

/**
 * The user's own verdict on a clip: 1–5 stars, a note and optional tags. Agents read these (list_reviews) when
 * they look for what works, so even a one-line note helps them write better prompts.
 */
export function YourReview({
  generation: g,
  review,
  loaded,
  onRate
}: {
  generation: Generation
  /** The user's stored review, if any. */
  review?: GenerationReview
  /** False until the reviews have been read; the note isn't editable before that. */
  loaded: boolean
  onRate: (g: Generation, rating: number | null) => void
}) {
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tags, setTags] = useState<string[]>()
  const [error, setError] = useState<string>()
  const shownTags = tags ?? review?.tags ?? []

  // A stored change (ours echoing back, or made elsewhere) replaces the optimistic tags.
  useEffect(() => setTags(undefined), [review?.updatedAt])

  const toggleTag = async (tag: string) => {
    const next = shownTags.includes(tag) ? shownTags.filter((t) => t !== tag) : [...shownTags, tag]
    setTags(next)
    setError(undefined)
    try {
      await window.studio.setUserReview(g.id, { tags: next })
    } catch (e) {
      setTags(undefined)
      setError(ipcErrorMessage(e))
    }
  }

  const done = g.status === 'completed'

  return (
    <section>
      <h3 className={sectionTitle}>Ditt omdöme</h3>
      <div className="rounded-lg border border-line bg-raised/30 p-3">
        <div className="flex items-center gap-3">
          {done ? (
            <StarRating value={g.rating} onChange={(r) => onRate(g, r)} size="lg" />
          ) : (
            <span className="text-[12px] text-muted">
              {g.status === 'failed'
                ? 'Klippet blev aldrig klart, så det finns inget att betygsätta – men en anteckning går bra.'
                : 'Du kan sätta betyg när klippet är klart.'}
            </span>
          )}
          {done && (
            <span className="text-[12px] text-muted">
              {g.rating ? ['', 'Dåligt', 'Svagt', 'Okej', 'Bra', 'Mycket bra'][g.rating] : 'Hur blev det?'}
            </span>
          )}
        </div>

        {loaded ? (
          <NoteField key={g.id} generationId={g.id} stored={review?.note ?? ''} onError={setError} />
        ) : (
          <div className="mt-2.5 h-[58px] rounded-md border border-line bg-raised/60" />
        )}

        <div className="mt-2">
          <button
            type="button"
            onClick={() => setTagsOpen((o) => !o)}
            aria-expanded={tagsOpen}
            className="text-[12px] text-muted transition hover:text-text"
          >
            {tagsOpen ? '▾' : '▸'} Taggar{shownTags.length ? ` (${shownTags.length})` : ' – valfritt'}
          </button>
          {!tagsOpen && shownTags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {shownTags.map((t) => (
                <span key={t} className={`rounded px-1.5 py-px text-[11px] ${tagChipClass(t)}`} title={t}>
                  {tagLabel(t)}
                </span>
              ))}
            </div>
          )}
          {tagsOpen && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[...REVIEW_TAGS.map((t) => t.tag), ...shownTags.filter((t) => !REVIEW_TAGS.some((r) => r.tag === t))].map(
                (t) => {
                  const on = shownTags.includes(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => void toggleTag(t)}
                      title={t}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                        on ? `border-transparent ${tagChipClass(t)}` : 'border-line text-muted hover:border-muted hover:text-text'
                      }`}
                    >
                      {tagLabel(t)}
                    </button>
                  )
                }
              )}
            </div>
          )}
        </div>
        {error && <p className="mt-2 text-[12px] text-accent select-text">{error}</p>}
      </div>
    </section>
  )
}

/** The note, saved a moment after typing stops (and when leaving the clip). */
function NoteField({
  generationId,
  stored,
  onError
}: {
  generationId: string
  stored: string
  onError: (message: string | undefined) => void
}) {
  const [text, setText] = useState(stored)
  const [state, setState] = useState<'idle' | 'pending' | 'saving' | 'saved'>('idle')
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savedText = useRef(stored)

  // A note changed elsewhere (another window) shows up unless the user is typing here. Our own save echoing
  // back is stored trimmed, so it is only taken when it differs by more than whitespace: the space just typed
  // before the next word must survive.
  useEffect(() => {
    if (pending.current !== null) return
    savedText.current = stored
    setText((current) => (current.trim() === stored.trim() ? current : stored))
  }, [stored])

  const save = async () => {
    clearTimeout(timer.current)
    const note = pending.current
    pending.current = null
    if (note === null || note.trim() === savedText.current.trim()) {
      setState((s) => (s === 'pending' ? 'idle' : s))
      return
    }
    setState('saving')
    try {
      await window.studio.setUserReview(generationId, { note: note.trim() })
      savedText.current = note.trim()
      onError(undefined)
      setState(pending.current === null ? 'saved' : 'pending')
    } catch (e) {
      onError(ipcErrorMessage(e))
      setState('idle')
    }
  }

  // Leaving the clip (or the view) saves what was typed.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => () => void saveRef.current(), [])

  return (
    <div className="mt-2.5">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          pending.current = e.target.value
          setState('pending')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => void save(), NOTE_DELAY)
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            e.currentTarget.blur()
          }
        }}
        rows={2}
        placeholder="Vad blev bra, vad blev fel? T.ex. ”rösten stämmer, men kavajen blev blå”"
        aria-label="Din anteckning om klippet"
        className="block w-full resize-y rounded-md border border-line bg-raised px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-muted/60 focus:border-muted"
      />
      <p className="mt-1 h-3.5 text-right text-[11px] text-muted">
        {state === 'pending' || state === 'saving' ? 'Sparar…' : state === 'saved' ? 'Sparad' : ''}
      </p>
    </div>
  )
}

/** What agents (and earlier sessions of the user) wrote about the clip, newest first. */
export function AgentReviews({ reviews, onDelete }: { reviews: GenerationReview[]; onDelete: (r: GenerationReview) => void }) {
  if (!reviews.length) return null
  return (
    <section>
      <h3 className={sectionTitle}>Agenternas granskningar</h3>
      <ol className="space-y-2">
        {reviews.map((r) => (
          <li key={r.id} className="group rounded-lg border border-line bg-raised/30 p-3">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 truncate font-medium">{authorLabel(r.author)}</span>
              {r.rating ? <StarRating value={r.rating} size="sm" /> : null}
              <span className="ml-auto shrink-0 text-[11px] text-muted" title={new Date(r.updatedAt).toLocaleString('sv-SE')}>
                {formatWhen(r.updatedAt)}
              </span>
              <span className="shrink-0 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                <ConfirmButton
                  question="Ta bort?"
                  confirmLabel="Ta bort"
                  onConfirm={() => onDelete(r)}
                  title="Ta bort granskningen"
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-accent"
                >
                  Ta bort
                </ConfirmButton>
              </span>
            </div>
            {r.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {r.tags.map((t) => (
                  <span key={t} className={`rounded px-1.5 py-px text-[11px] ${tagChipClass(t)}`} title={t}>
                    {tagLabel(t)}
                  </span>
                ))}
              </div>
            )}
            {r.note && <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed select-text">{r.note}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}
