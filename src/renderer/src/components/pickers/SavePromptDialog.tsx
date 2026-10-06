import { useMemo, useState } from 'react'
import type { SavedPrompt } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import Modal from './Modal'
import { titleFromPrompt } from './text'

interface Props {
  body: string
  negativePrompt?: string
  /** The library prompt the current text came from; offers updating it instead of saving a copy. */
  existing?: SavedPrompt
  /** Every prompt in the library, for tag suggestions. */
  library: SavedPrompt[]
  onClose: () => void
  onSaved: (prompt: SavedPrompt) => void
}

const input = 'w-full rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted'

function addTag(tags: string[], tag: string): string[] {
  const t = tag.trim()
  if (!t || tags.some((x) => x.toLocaleLowerCase('sv') === t.toLocaleLowerCase('sv'))) return tags
  return [...tags, t]
}

/** Saves the current prompt (and negative prompt) to the library with a title and tags. */
export default function SavePromptDialog({ body, negativePrompt, existing, library, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(() => existing?.title ?? titleFromPrompt(body))
  const [tags, setTags] = useState<string[]>(() => existing?.tags ?? [])
  const [draft, setDraft] = useState('')
  const [favorite, setFavorite] = useState(existing?.favorite ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const unchanged =
    !!existing &&
    existing.body.trim() === body.trim() &&
    (existing.negativePrompt ?? '').trim() === (negativePrompt ?? '').trim()

  // Most used tags first, so the usual ones are one click away.
  const suggestions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of library) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    const taken = new Set(tags.map((t) => t.toLocaleLowerCase('sv')))
    return [...counts.entries()]
      .filter(([t]) => !taken.has(t.toLocaleLowerCase('sv')))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sv'))
      .slice(0, 10)
      .map(([t]) => t)
  }, [library, tags])

  const commitDraft = () => {
    const next = draft.split(',').reduce(addTag, tags)
    setTags(next)
    setDraft('')
    return next
  }

  const save = async (asNew: boolean) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const saved = await window.studio.savePrompt({
        id: asNew ? undefined : existing?.id,
        title: title.trim(),
        body: body.trim(),
        negativePrompt: negativePrompt?.trim() || undefined,
        tags: commitDraft(),
        favorite
      })
      onSaved(saved)
    } catch (e) {
      setError(ipcErrorMessage(e))
      setBusy(false)
    }
  }

  // Updating is the default only when the text is the same; otherwise a copy is the safe choice.
  const primaryIsUpdate = !!existing && unchanged
  const submitPrimary = () => void save(!primaryIsUpdate)

  const button = 'rounded-md px-4 py-2 disabled:opacity-40'
  const footer = (
    <>
      {error && <p className="mr-auto min-w-0 truncate text-accent" title={error}>{error}</p>}
      <button onClick={onClose} className={`${button} border border-line hover:bg-raised`}>
        Avbryt
      </button>
      {existing && !unchanged && (
        <button
          onClick={() => void save(false)}
          disabled={busy}
          className={`${button} max-w-56 truncate border border-line hover:bg-raised`}
          title={`Skriv över ”${existing.title}” med den nya texten`}
        >
          Uppdatera ”{existing.title}”
        </button>
      )}
      <button
        onClick={submitPrimary}
        disabled={busy}
        className={`${button} bg-accent font-medium text-white hover:bg-accent-hover`}
      >
        {busy ? 'Sparar…' : primaryIsUpdate ? 'Spara ändringar' : existing ? 'Spara som ny' : 'Spara'}
      </button>
    </>
  )

  return (
    <Modal
      title={primaryIsUpdate ? 'Redigera sparad prompt' : 'Spara prompt'}
      subtitle={
        primaryIsUpdate
          ? 'Prompten finns redan i biblioteket – ändra titel, taggar eller favorit.'
          : existing
            ? `Texten kommer från ”${existing.title}” men har ändrats.`
            : 'Spara prompten i biblioteket så kan du hämta den igen.'
      }
      onClose={onClose}
      footer={footer}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-muted">Titel</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitPrimary()}
            placeholder="Lämna tom för att använda början av prompten"
            className={input}
          />
        </label>

        <div>
          <span className="mb-1.5 block text-muted">Taggar</span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1.5 focus-within:border-muted">
            {tags.map((t) => (
              <span key={t} className="flex items-center gap-1 rounded bg-line py-0.5 pl-2 pr-1 text-[12px]">
                {t}
                <button
                  onClick={() => setTags(tags.filter((x) => x !== t))}
                  className="rounded px-1 text-muted hover:text-text"
                  title="Ta bort tagg"
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              value={draft}
              onChange={(e) => {
                const v = e.target.value
                if (v.includes(',')) {
                  const parts = v.split(',')
                  setTags(parts.slice(0, -1).reduce(addTag, tags))
                  setDraft(parts.at(-1) ?? '')
                } else setDraft(v)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (draft.trim()) commitDraft()
                  else submitPrimary()
                } else if (e.key === 'Backspace' && !draft && tags.length) {
                  setTags(tags.slice(0, -1))
                }
              }}
              onBlur={() => draft.trim() && commitDraft()}
              placeholder={tags.length ? '' : 't.ex. strand, solnedgång'}
              className="min-w-24 flex-1 bg-transparent py-0.5 outline-none"
            />
          </div>
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {suggestions.map((t) => (
                <button
                  key={t}
                  onClick={() => setTags(addTag(tags, t))}
                  className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-muted hover:text-text"
                >
                  + {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={favorite}
            onChange={(e) => setFavorite(e.target.checked)}
            className="accent-accent"
          />
          <span>Favorit</span>
          <span className="text-[11px] text-muted">– visas först i biblioteket</span>
        </label>

        <div className="rounded-md border border-line bg-bg/60 p-3">
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text">{body.trim()}</p>
          {negativePrompt?.trim() && (
            <p className="mt-2 border-t border-line pt-2 text-[12px] text-muted select-text">
              <span className="text-text">Negativ:</span> {negativePrompt.trim()}
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
