import { castFollowAt, castIsEmpty } from '@shared/cast'
import { continuationPlan, ownReferences } from '@shared/continuation'
import type { Segment, Sequence } from '@shared/types'

interface Props {
  sequence: Sequence
  /** The clip as its editor holds it (the draft's params), at `index`. */
  segment: Segment
  index: number
  busy: boolean
  /** "Use the cast": the clip's references become the cast's (main; its prompt's tokens follow their pictures). */
  onUseCast: () => void
}

/**
 * Above a clip's references: whether it follows the sequence's cast (changes with it), carries it from the clip it
 * continues from, or has references of its own – then "Use the cast" gives it the cast's. Nothing without a cast, or
 * for a clip that sends no references.
 */
export default function CastLine({ sequence, segment, index, busy, onUseCast }: Props) {
  if (castIsEmpty(sequence.cast)) return null
  const chain = sequence.segments.map((s, i) => (i === index ? segment : s))
  const follow = castFollowAt(chain, index, sequence.cast)
  if (follow.state === 'none') return null
  // What it has instead: references of its own, those of a clip before it that doesn't follow, or none.
  const own = ownReferences(segment.params)
  const carried = follow.state === 'differs' && !own ? continuationPlan(chain, index)?.carried : undefined
  const instead = own
    ? { label: 'Own references', title: "The clip has references of its own, so changing the cast doesn't change it." }
    : carried
      ? {
          label: `Carries clip ${carried.fromClip}'s references`,
          title: `The clip carries the references of clip ${carried.fromClip}, which doesn't follow the cast.`
        }
      : { label: 'No references yet', title: 'The clip has no references; the cast would give it some.' }
  const dot = (on: boolean) => (
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-emerald-400' : 'bg-muted/60'}`} />
  )
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]"
      data-cast-state={follow.state}
    >
      {follow.state === 'follows' ? (
        <span
          className="flex min-w-0 items-center gap-2"
          title="The clip's references are the sequence's cast: changing the cast changes this clip too. Change them here and it stops following."
        >
          {dot(true)}
          Follows the cast
        </span>
      ) : follow.state === 'carries' ? (
        <span
          className="flex min-w-0 items-center gap-2"
          title={`The clip carries the references of clip ${follow.fromClip}, which follows the cast – so it changes with the cast too.`}
        >
          {dot(true)}
          Carries the cast from clip {follow.fromClip}
        </span>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2 text-muted" title={instead.title}>
            {dot(false)}
            {instead.label}
          </span>
          <button
            type="button"
            onClick={onUseCast}
            disabled={busy}
            title="Give the clip the cast's references – the prompt's tokens follow their pictures, and it follows the cast again"
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[12px] text-text transition hover:bg-raised disabled:opacity-40"
          >
            Use the cast
          </button>
        </>
      )}
    </div>
  )
}
