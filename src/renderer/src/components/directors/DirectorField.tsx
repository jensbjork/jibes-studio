import { useId, useMemo } from 'react'
import type { Asset } from '@shared/types'
import { directorById, directorEntries } from '../../lib/directors'

const select = 'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted'

/** The select's value for "follow the sequence" (no own director): params.director left out. */
const FOLLOW = ''
/** …and for "none" (params.director null in a clip; left out in Generate). */
const NONE = '\u0000none'

interface Props {
  /** params.director: an id, null (none even where the owner has one) or undefined (the owner's; none in Generate). */
  value: string | null | undefined
  /**
   * A sequence clip or a storyboard transition: whose director it follows unless it chooses its own ("Follow the
   * sequence"), and that director's id (undefined: the sequence has none). Left out in Generate.
   */
  follow?: { what: string; directorId?: string }
  /** The library (any kinds): the user's own directors among them. */
  assets: readonly Asset[]
  /** undefined: follow (a clip) or none (Generate); null: none in a clip; an id: that director. */
  onChange: (value: string | null | undefined) => void
  /** Opens a director in Directors. */
  onOpen?: (id: string) => void
}

/**
 * "Director" in the form, under the model: none, the user's own or a ready-made one – in a sequence clip also "Follow
 * the sequence (Noir)", the default. Choosing one applies its defaults (the form does that); the line under it says
 * what the director adds and links to it.
 */
export default function DirectorField({ value, follow, assets, onChange, onOpen }: Props) {
  const id = useId()
  const entries = useMemo(() => directorEntries(assets), [assets])
  const own = entries.filter((e) => !e.preset)
  const presets = entries.filter((e) => e.preset)
  const followed = follow ? directorById(follow.directorId, assets) : undefined
  // A director that is gone (deleted, an unknown ready-made one) keeps an option, so the select doesn't lie.
  const missing = typeof value === 'string' && value && !directorById(value, assets) ? value : undefined
  const selected = value === null ? NONE : value === undefined ? (follow ? FOLLOW : NONE) : value
  const effective = value === null ? undefined : value === undefined ? followed : directorById(value, assets)

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-muted">
          {follow ? 'Directed by' : 'Director'}
        </label>
        {effective && onOpen && (
          <button
            type="button"
            onClick={() => onOpen(effective.id)}
            className="text-[11px] text-muted transition hover:text-text hover:underline"
            title={`Open ${effective.name} in Directors`}
          >
            Open
          </button>
        )}
      </div>
      <select
        id={id}
        value={selected}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === FOLLOW ? undefined : v === NONE ? (follow ? null : undefined) : v)
        }}
        className={select}
      >
        {follow && (
          <option value={FOLLOW}>
            {followed ? `Follow the ${follow.what} (${followed.name})` : `Follow the ${follow.what} (none)`}
          </option>
        )}
        <option value={NONE}>None</option>
        {missing && <option value={missing}>A deleted director</option>}
        {own.length > 0 && (
          <optgroup label="Yours">
            {own.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Ready-made">
          {presets.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      </select>
      {effective?.description && (
        <p className="mt-1 truncate text-[11px] text-muted" title={effective.description}>
          {effective.description}
        </p>
      )}
      {missing && value === missing && (
        <p className="mt-1 text-[11px] text-accent">The director no longer exists – nothing of it is sent.</p>
      )}
    </div>
  )
}
