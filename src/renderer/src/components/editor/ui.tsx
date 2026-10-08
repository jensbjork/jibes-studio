import { useId, type ReactNode } from 'react'
import type { EditPlan, EditRange } from '@shared/types'
import { formatClock, formatRange, priceText } from './editorUtils'
import type { PlayerController } from './playerController'

// Form pieces shared by the edit view's operation cards: one look for every field, the run button with its price,
// and the plan's notes, warnings and problems.

export const fieldInput =
  'w-full rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none transition focus:border-muted disabled:opacity-50'
export const textArea =
  'block max-h-60 min-h-20 w-full resize-none rounded-md border border-line bg-raised px-3 py-2 leading-relaxed outline-none transition [field-sizing:content] placeholder:text-muted/60 focus:border-muted'
export const smallButton =
  'rounded-md border border-line px-2 py-1 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted'
export const linkButton =
  'rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent'

/** A labelled field. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-muted">
        <span>{label}</span>
        {hint && <span className="text-[11px]">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** A small set of choices as radio buttons, one per line (or in a row with `inline`). */
export function Choice<T extends string | number>({
  value,
  options,
  onChange,
  inline,
  label
}: {
  value: T
  options: { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean; title?: string }[]
  onChange: (value: T) => void
  inline?: boolean
  label?: string
}) {
  const name = useId()
  return (
    <div role="radiogroup" aria-label={label} className={inline ? 'flex flex-wrap gap-x-4 gap-y-1.5' : 'space-y-1.5'}>
      {options.map((o) => (
        <label
          key={String(o.value)}
          title={o.title}
          className={`flex items-start gap-2 ${o.disabled ? 'cursor-default opacity-45' : 'cursor-pointer'}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
            className="mt-0.5 accent-accent"
          />
          <span className="min-w-0">
            <span>{o.label}</span>
            {o.hint && <span className="block text-[11px] leading-snug text-muted">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

export function Check({
  checked,
  onChange,
  children,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-45' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span className="min-w-0">
        {children}
        {hint && <span className="block text-[11px] leading-snug text-muted">{hint}</span>}
      </span>
    </label>
  )
}

/** Gain in dB on a slider, "−6 dB". */
export function GainSlider({
  value,
  onChange,
  min = -24,
  max = 12,
  label = 'Volym'
}: {
  value: number
  onChange: (db: number) => void
  min?: number
  max?: number
  label?: string
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-accent"
      />
      <span className="w-14 shrink-0 text-right tabular-nums">{formatDb(value)}</span>
    </label>
  )
}

export function formatDb(db: number): string {
  if (db === 0) return '0 dB'
  return `${db > 0 ? '+' : '−'}${Math.abs(db)} dB`
}

/** What a card works on: "Hela filmen" or "Markeringen 0:41,0–0:45,0 (4,0 s)". */
export function Target({ range, whole = 'Hela filmen' }: { range?: EditRange; whole?: string }) {
  return (
    <p className="text-[12px] text-muted">
      {range ? (
        <>
          <span className="text-text">Markeringen</span> {formatRange(range)}
        </>
      ) : (
        <span className="text-text">{whole}</span>
      )}
    </p>
  )
}

/** "Behöver en markering": shown in place of a form that works on a marked range when there is none. */
export function NeedsSelection({ what = 'avsnittet' }: { what?: string }) {
  return (
    <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-[12px] leading-relaxed text-muted">
      Markera {what} på tidslinjen först – dra över den, eller använd <Kbd>I</Kbd> och <Kbd>O</Kbd> i spelaren.
    </p>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-raised px-1 py-px font-sans text-[10px] text-text">{children}</kbd>
  )
}

/** A time in the film: typed by the card, set to the playhead with "Här". */
export function TimeAt({
  label,
  value,
  onChange,
  player
}: {
  label: string
  value: number
  onChange: (seconds: number) => void
  player: PlayerController
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted">{label}</span>
      <span className="rounded-md border border-line bg-raised px-2 py-1 tabular-nums">{formatClock(value)}</span>
      <button
        type="button"
        onClick={() => onChange(Math.round(player.getTime() * 100) / 100)}
        title="Flytta hit, där spelhuvudet står"
        className={smallButton}
      >
        Här
      </button>
    </div>
  )
}

/** The plan's notes (muted), warnings (amber) and problems (red), and an error from planning or running. */
export function PlanNotes({
  plan,
  error,
  extraNotes = [],
  extraWarnings = [],
  quiet
}: {
  plan?: EditPlan
  error?: string
  extraNotes?: string[]
  extraWarnings?: string[]
  /**
   * A problem that only says a field is still empty ("Beskriv musiken."): shown as a quiet hint, not in red, since
   * the user simply hasn't got there yet.
   */
  quiet?: string
}) {
  // A note the card adds itself is left out when the plan says the same thing.
  const notes = dedupe([...(plan?.notes ?? []), ...extraNotes])
  const warnings = dedupe([...(plan?.warnings ?? []), ...extraWarnings])
  const problems = plan?.problems ?? []
  if (!notes.length && !warnings.length && !problems.length && !error) return null
  return (
    <div className="space-y-1 text-[11px] leading-relaxed">
      {problems.map((p) => (
        <p key={`p:${p}`} className={sameText(p, quiet) ? 'text-muted' : 'text-accent select-text'}>
          {p}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={`w:${w}`} className="text-amber-300/90 select-text">
          {w}
        </p>
      ))}
      {notes.map((n) => (
        <p key={`n:${n}`} className="text-muted select-text">
          {n}
        </p>
      ))}
      {error && <p className="text-accent select-text">{error}</p>}
    </div>
  )
}

const textKey = (s: string) => s.trim().toLowerCase().replace(/[–—]/g, '-')

function sameText(a: string, b: string | undefined): boolean {
  return b !== undefined && textKey(a) === textKey(b)
}

/** The same sentence once, whatever its dashes and letter case. */
function dedupe(list: string[]): string[] {
  const out: string[] = []
  for (const s of list) {
    if (textKey(s) && !out.some((o) => textKey(o) === textKey(s))) out.push(s)
  }
  return out
}

/** "$0.51", "≈ $0.70", "okänt pris", "≈ $0.45 +" (a part without a price). */
export function priceLabel(plan: EditPlan | undefined, approximate = false): string | undefined {
  if (!plan) return undefined
  if (!plan.paid) return 'Gratis'
  return priceText(plan.priceUsd, { partial: plan.partialPrice, approximate })
}

/**
 * The card's main button: what it does and, from the plan, what it costs. Disabled while the plan is being made
 * (the price on the button is the one that is sent), when the plan has problems, and while it runs.
 */
export function RunButton({
  label,
  plan,
  planning,
  running,
  runningLabel = 'Skickar…',
  disabled,
  disabledReason,
  approximate,
  onClick
}: {
  label: string
  plan?: EditPlan
  planning?: boolean
  running?: boolean
  runningLabel?: string
  disabled?: boolean
  /** Shown as the tooltip while disabled. */
  disabledReason?: string
  /** Prices that are estimates (per started minute, TTS without a quote) get "≈". */
  approximate?: boolean
  onClick: () => void
}) {
  const blocked = !!plan?.problems.length
  const off = disabled || running || planning || !plan || blocked
  const price = planning && !plan ? '…' : priceLabel(plan, approximate)
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={off}
        title={off && !running ? (disabledReason ?? plan?.problems[0]) : undefined}
        className="flex w-full items-center justify-between gap-3 rounded-md bg-accent px-3.5 py-2 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
      >
        <span className="min-w-0 truncate">{running ? runningLabel : label}</span>
        {price && !running && (
          <span className={`shrink-0 tabular-nums ${planning ? 'text-white/50' : 'text-white/80'}`}>{price}</span>
        )}
      </button>
      {plan?.paid && plan.priceNote && !running && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted select-text">{plan.priceNote}</p>
      )}
    </div>
  )
}

/** An operation in a tab: a title row that opens it, and its form below while it is open. */
export function OpCard({
  title,
  summary,
  open,
  onToggle,
  badge,
  children
}: {
  title: string
  /** One line under the title while it is closed. */
  summary?: string
  open: boolean
  onToggle: () => void
  badge?: ReactNode
  children: ReactNode
}) {
  const bodyId = useId()
  return (
    <section className={`rounded-lg border transition ${open ? 'border-line bg-panel' : 'border-transparent'}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className={`flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition ${
          open ? '' : 'hover:bg-raised/60'
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            {badge}
          </span>
          {summary && !open && <span className="mt-0.5 block text-[11px] leading-snug text-muted">{summary}</span>}
        </span>
        <span className={`mt-0.5 shrink-0 text-[11px] text-muted transition ${open ? 'rotate-90' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      {open && (
        <div id={bodyId} className="space-y-3 px-3 pb-3.5">
          {children}
        </div>
      )}
    </section>
  )
}

/** A small "gratis" or "betald" tag next to a card's title. */
export function CostTag({ paid }: { paid: boolean }) {
  return paid ? null : <span className="rounded bg-raised px-1.5 py-px text-[10px] text-muted">gratis</span>
}
