import { countsAria } from './workText'

// The marks of Pågår och klart, one system for the whole app: a neutral spinner (with a count) while something
// runs, a 6 px emerald dot when something finished that the user hasn't seen, an accent dot for a new failure.
// At most one spinner and one dot per row.

interface SpinnerProps {
  /** Outer size in px. */
  size?: number
  /** Colours the moving arc (currentColor); the track is always the line colour. */
  className?: string
}

/** A small ring with a quarter arc turning: "pågår". Still for reduced motion. */
export function Spinner({ size = 12, className = 'text-text' }: SpinnerProps) {
  const stroke = size <= 10 ? 1.25 : 1.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      aria-hidden
      className={`shrink-0 animate-spin [animation-duration:900ms] motion-reduce:animate-none ${className}`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-line)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c / 4} ${c}`}
      />
    </svg>
  )
}

interface MarkProps {
  running?: number
  /** Finished and not seen yet. */
  fresh?: number
  /** Failed and not seen yet: the dot turns accent. */
  failed?: number
  /**
   * inline: right-aligned in a row, "◌ 2 •". badge: on the corner of an icon or thumbnail (the parent must be
   * `relative`): a small spinner bottom-right, the dot top-right, both cut out of the background with a ring in
   * `--row-bg` (the panel colour unless the row sets it).
   */
  variant: 'inline' | 'badge'
  /** Tooltip; the accessible label is built from the counts either way. */
  title?: string
  className?: string
}

/** The status of one place: nothing when nothing runs and nothing is new. */
export function StatusMark({ running = 0, fresh = 0, failed = 0, variant, title, className = '' }: MarkProps) {
  if (running <= 0 && fresh <= 0 && failed <= 0) return null
  const dot = failed > 0 ? 'bg-accent' : fresh > 0 ? 'bg-emerald-400' : undefined
  const label = countsAria({ running, unseen: fresh, failed })

  if (variant === 'badge') {
    return (
      <span role="img" aria-label={label} title={title} className={`pointer-events-none ${className}`}>
        {dot && (
          <span
            className={`absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--row-bg,var(--color-panel))] ${dot}`}
            data-status-dot={failed > 0 ? 'failed' : 'new'}
          />
        )}
        {running > 0 && (
          <span className="absolute -bottom-1.5 -right-2 flex rounded-full bg-[var(--row-bg,var(--color-panel))] p-px">
            <Spinner size={10} />
          </span>
        )}
      </span>
    )
  }

  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted ${className}`}
    >
      {running > 0 && (
        <span className="flex items-center gap-1">
          <Spinner />
          {running}
        </span>
      )}
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
    </span>
  )
}

interface ChipProps {
  label?: string
  /** soft: on the panel background. overlay: over a picture or video, like the other badges there. */
  variant?: 'soft' | 'overlay'
  title?: string
  className?: string
}

/** "Ny": finished and not looked at yet. */
export function NewChip({ label = 'Ny', variant = 'soft', title, className = '' }: ChipProps) {
  if (variant === 'overlay') {
    return (
      <span
        title={title}
        className={`flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 backdrop-blur ${className}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
        {label}
      </span>
    )
  }
  return (
    <span
      title={title}
      className={`rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-semibold text-emerald-300 ${className}`}
    >
      {label}
    </span>
  )
}

/** The dot alone (table rows, the panel): emerald for new, accent for a new failure. 6 px, or 8 px as an icon. */
export function StatusDot({ failed = false, large = false, className = '' }: { failed?: boolean; large?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${large ? 'h-2 w-2' : 'h-1.5 w-1.5'} ${failed ? 'bg-accent' : 'bg-emerald-400'} ${className}`}
    />
  )
}
