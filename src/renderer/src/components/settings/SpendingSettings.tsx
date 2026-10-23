import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import { MAX_BUDGET_USD, roomLeft, usdText } from '@shared/budget'
import type { BudgetSettings, SpendingSummary } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { COMPUTER } from '../../lib/platform'
import { useWork } from '../../lib/work'
import { BudgetMeter } from '../BudgetDialog'
import { MoreAbout, SaveActions, SettingsItem } from './SettingsLayout'

// Settings → Spending: what Studio has paid Venice for – today, this month and the last 30 days, then the optional
// daily and monthly budget (the one setting here), and under "Spending details" the days as a chart and this month by
// kind, place and who asked. Read from the library's own records (main's spending.ts); what is still rendering is on
// its way, not spent. Nothing spent in 30 days is one line, not a page of zeros.

/** The spending, read again when work starts or finishes, when the window comes back and when the budget changes. */
function useSpending(budget: BudgetSettings): { spending?: SpendingSummary; error?: string; refresh: () => void } {
  const [spending, setSpending] = useState<SpendingSummary>()
  const [error, setError] = useState<string>()
  const refresh = useCallback(() => {
    window.studio.getSpending().then(
      (s) => {
        setSpending(s)
        setError(undefined)
      },
      (e: unknown) => setError(ipcErrorMessage(e))
    )
  }, [])
  const work = useWork()
  const workKey = `${work.running.length}|${work.total.unseen}|${work.total.failed}`
  const budgetKey = `${budget.dailyUsd ?? ''}|${budget.monthlyUsd ?? ''}`
  useEffect(() => {
    const t = window.setTimeout(refresh, 300)
    return () => window.clearTimeout(t)
  }, [refresh, workKey, budgetKey])
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  return { spending, error, refresh }
}

export default function SpendingSettings({ budget, onChanged }: { budget: BudgetSettings; onChanged: () => void }) {
  const { spending, error } = useSpending(budget)
  const nothing = !!spending && !spending.last30Usd && !spending.monthUsd && !spending.pendingUsd
  return (
    <>
      <SettingsItem>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        {!spending && !error && <p className="text-[12px] text-muted">Reading…</p>}
        {nothing && <p className="text-[12px] text-muted">Nothing spent in the last 30 days.</p>}
        {spending && !nothing && <Overview spending={spending} />}
      </SettingsItem>
      <BudgetSetting budget={budget} spending={spending} onChanged={onChanged} />
      {spending && !nothing && (
        <MoreAbout summary="Spending details" plain>
          <div className="space-y-8 pt-2">
            <DayChart days={spending.days} dailyCap={spending.budget.dailyUsd} />
            <Breakdowns spending={spending} />
          </div>
        </MoreAbout>
      )}
      <MoreAbout summary="More about what counts">
        <p>
          A video counts when it is finished, at the price Venice quoted – from Generate, a sequence, a storyboard or the
          Editor’s picture fixes. A failed one costs nothing. Images count when they are made; the Editor’s sound jobs,
          transcripts and designed voices count as their parts are sent.
        </p>
        <p>
          Days follow your {COMPUTER}’s calendar. Work still rendering is on its way: not spent yet, but it counts against
          the budget.
        </p>
        <p>
          The numbers come from your library, so something you delete drops out of them. Your Venice account is the
          record of what was billed.
        </p>
        <p>
          Who asked: what an agent’s request paid for counts as that agent’s once you approved it. Everything else is
          yours – so is anything approved before Studio kept track of who asked. An agent’s request that would go past a
          budget shows the same warning in its approval dialog – approving it counts as yes.
        </p>
      </MoreAbout>
    </>
  )
}

// ── Today, this month, the last 30 days ──────────────────────────────────────

function Overview({ spending: s }: { spending: SpendingSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Today" usd={s.todayUsd} cap={s.budget.dailyUsd} pending={s.pendingUsd} />
        <Tile label="This month" usd={s.monthUsd} cap={s.budget.monthlyUsd} pending={s.pendingUsd} />
        <Tile label="Last 30 days" usd={s.last30Usd} />
      </div>
      {s.pendingUsd > 0 && (
        <p className="text-[12px] text-muted">
          <span className="text-text tabular-nums">{usdText(s.pendingUsd)}</span> on its way – rendering now, not spent
          yet.
        </p>
      )}
    </div>
  )
}

function Tile({ label, usd, cap, pending = 0 }: { label: string; usd: number; cap?: number; pending?: number }) {
  return (
    <div className="rounded-lg border border-line bg-raised/40 px-3 py-2.5">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{usdText(usd)}</p>
      {cap !== undefined && (
        <BudgetMeter className="mt-2" label="Budget" spentUsd={usd} pendingUsd={pending} capUsd={cap} />
      )}
    </div>
  )
}

/** A clean top for the axis: 1, 2 or 5 times a power of ten at or above `max`. */
function niceCeil(max: number): number {
  if (max <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p
  return 10 * p
}

/** "Oct 3" from 'YYYY-MM-DD' (local). */
function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const CHART_H = 112

/**
 * The last 30 days as columns from one baseline: today's in full ink, a day past the daily budget in the accent, with
 * the budget as a hairline. Hovering (or focusing) a column says the day and the amount.
 */
function DayChart({ days, dailyCap }: { days: SpendingSummary['days']; dailyCap?: number }) {
  const [hover, setHover] = useState<number>()
  const max = Math.max(...days.map((d) => d.usd), dailyCap ?? 0)
  const top = niceCeil(max)
  const y = (usd: number): number => (usd / top) * CHART_H
  const shown = hover !== undefined ? days[hover] : undefined
  const tableId = useId()
  return (
    <figure className="m-0">
      <figcaption className="flex items-baseline justify-between text-[11px] text-muted">
        <span>Per day, the last 30 days</span>
        <span className="tabular-nums" aria-live="polite">
          {shown ? (
            <>
              {shortDay(shown.day)}: <span className="text-text">{usdText(shown.usd)}</span>
              {dailyCap !== undefined && shown.usd > dailyCap ? ' – over the daily budget' : ''}
            </>
          ) : null}
        </span>
      </figcaption>
      <div className="mt-2 flex gap-2">
        {/* The axis: its top and the baseline, as clean amounts. */}
        <div className="relative w-9 shrink-0 text-right text-[10px] tabular-nums text-muted" style={{ height: CHART_H }}>
          <span className="absolute right-0 -translate-y-1/2" style={{ top: 0 }}>
            {usdText(top).replace(/\.00$/, '')}
          </span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">$0</span>
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: CHART_H }} onMouseLeave={() => setHover(undefined)}>
          <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-line" />
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-line" />
          {/* The daily budget as a hairline, unless it would sit on the baseline. */}
          {dailyCap !== undefined && dailyCap <= top && y(dailyCap) >= 3 && (
            <span
              aria-hidden
              className="absolute inset-x-0 h-px bg-accent/60"
              style={{ bottom: y(dailyCap) }}
              title={`Daily budget ${usdText(dailyCap)}`}
            />
          )}
          <div className="absolute inset-0 flex items-end gap-[2px]" role="list" aria-describedby={tableId}>
            {days.map((d, i) => {
              const today = i === days.length - 1
              const over = dailyCap !== undefined && d.usd > dailyCap + 0.005
              const tone = over ? 'bg-accent' : today ? 'bg-text' : 'bg-muted/60'
              return (
                <div
                  key={d.day}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${shortDay(d.day)}: ${usdText(d.usd)}${over ? ', over the daily budget' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(undefined)}
                  className="group flex h-full min-w-0 flex-1 items-end justify-center outline-none"
                >
                  <span
                    className={`w-full max-w-6 rounded-t-[4px] transition-opacity ${tone} ${hover !== undefined && hover !== i ? 'opacity-50' : ''} group-focus-visible:ring-1 group-focus-visible:ring-text`}
                    style={{ height: d.usd > 0 ? Math.max(2, y(d.usd)) : 0 }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-11 text-[10px] text-muted">
        <span>{shortDay(days[0].day)}</span>
        <span>{shortDay(days[Math.floor(days.length / 2)].day)}</span>
        <span>Today</span>
      </div>
      <div className="mt-2">
        <MoreAbout summary="Show as a table">
          <table id={tableId} className="w-full max-w-xs tabular-nums">
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} className="border-t border-line/60">
                  <td className="py-0.5">{shortDay(d.day)}</td>
                  <td className="py-0.5 text-right text-text">{usdText(d.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </MoreAbout>
      </div>
    </figure>
  )
}

// ── This month by kind, place and who ────────────────────────────────────────

/** Nothing when this month is $0 so far: the This month tile already says so. */
function Breakdowns({ spending: s }: { spending: SpendingSummary }) {
  const month = new Date().toLocaleDateString('en-US', { month: 'long' })
  if (!s.monthUsd) return null
  const places = s.byPlace.map((p) => ({
    key: p.sequenceId ?? p.storyboardId ?? p.editId ?? p.label,
    label: p.label,
    note: p.sequenceId ? 'Sequence' : p.storyboardId ? 'Storyboard' : p.editId ? 'Edit' : undefined,
    usd: p.usd
  }))
  const who = s.byWho.map((w) => ({ key: w.who, label: w.who === 'user' ? 'You' : agentDisplayName(w.who), usd: w.usd }))
  return (
    <SettingsItem title={`${month} so far`}>
      <div className="grid gap-x-8 gap-y-6 @2xl/main:grid-cols-2">
        <Ranked title="By kind" rows={s.byKind.map((k) => ({ key: k.kind, label: k.label, usd: k.usd }))} total={s.monthUsd} />
        <Ranked title="By who asked" rows={who} total={s.monthUsd} />
        <div className="@2xl/main:col-span-2">
          <Ranked title="By place" rows={places} total={s.monthUsd} limit={8} />
        </div>
      </div>
    </SettingsItem>
  )
}

interface Row {
  key: string
  label: string
  note?: string
  usd: number
}

/** A ranked list with a thin bar per row, scaled to the largest, and the amount at its end. */
function Ranked({ title, rows, total, limit }: { title: string; rows: Row[]; total: number; limit?: number }) {
  const [all, setAll] = useState(false)
  const max = Math.max(...rows.map((r) => r.usd), 0.01)
  const shown = limit && !all ? rows.slice(0, limit) : rows
  const rest = rows.length - shown.length
  return (
    <div>
      <h4 className="text-[11px] font-medium text-muted">{title}</h4>
      <ul className="mt-2 space-y-2">
        {shown.map((r) => (
          <li key={r.key} title={`${r.label}: ${usdText(r.usd)} (${Math.round((r.usd / total) * 100)} %)`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                {r.label}
                {r.note && <span className="ml-1.5 text-[11px] text-muted">{r.note}</span>}
              </span>
              <span className="shrink-0 tabular-nums">{usdText(r.usd)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-raised">
              <div className="h-full rounded-full bg-muted/70" style={{ width: `${(r.usd / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-[12px] text-muted transition hover:text-text">
          {rest} more…
        </button>
      )}
    </div>
  )
}

// ── The budget ───────────────────────────────────────────────────────────────

/** "5", "5.50" or "5,50" → 5.5; '' → undefined (no cap); NaN when it isn't an amount. */
function parseAmount(text: string): number | undefined {
  const t = text.trim().replace(/^\$/, '').replace(',', '.')
  if (!t) return undefined
  return /^\d+(\.\d{0,2})?$/.test(t) ? Number(t) : NaN
}

const amountText = (v: number | undefined): string => (v === undefined ? '' : String(v))

function BudgetSetting({
  budget,
  spending,
  onChanged
}: {
  budget: BudgetSettings
  spending?: SpendingSummary
  onChanged: () => void
}) {
  const [daily, setDaily] = useState(amountText(budget.dailyUsd))
  const [monthly, setMonthly] = useState(amountText(budget.monthlyUsd))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  useEffect(() => setDaily(amountText(budget.dailyUsd)), [budget.dailyUsd])
  useEffect(() => setMonthly(amountText(budget.monthlyUsd)), [budget.monthlyUsd])

  const next = useMemo(() => ({ dailyUsd: parseAmount(daily), monthlyUsd: parseAmount(monthly) }), [daily, monthly])
  const invalid = [next.dailyUsd, next.monthlyUsd].some((v) => v !== undefined && (Number.isNaN(v) || v > MAX_BUDGET_USD))
  const changed = next.dailyUsd !== budget.dailyUsd || next.monthlyUsd !== budget.monthlyUsd
  // What was typed, against what is saved ("5" and "5.00" are the same budget).
  const dirty = changed || daily !== amountText(budget.dailyUsd) || monthly !== amountText(budget.monthlyUsd)

  const save = async () => {
    if (invalid || saving) return
    if (!changed) return revert()
    setSaving(true)
    setError(undefined)
    setSaved(false)
    try {
      await window.studio.setBudget(next)
      setSaved(true)
      onChanged()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const revert = () => {
    setDaily(amountText(budget.dailyUsd))
    setMonthly(amountText(budget.monthlyUsd))
    setError(undefined)
  }

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v)
    setSaved(false)
    setError(undefined)
  }

  const left = (cap: number | undefined, used: number | undefined): string | undefined => {
    const room = spending && used !== undefined ? roomLeft(cap, used, spending.pendingUsd) : undefined
    return room === undefined ? undefined : `${usdText(room)} left`
  }

  return (
    <SettingsItem
      title="Budget"
      help="Optional. Studio asks before anything paid would go past it. Leave a field empty for no limit."
    >
      <div className="flex flex-wrap items-end gap-3">
        <AmountField
          label="Per day"
          value={daily}
          onChange={edit(setDaily)}
          onEnter={() => void save()}
          onEscape={revert}
          hint={left(budget.dailyUsd, spending?.todayUsd)}
        />
        <AmountField
          label="Per month"
          value={monthly}
          onChange={edit(setMonthly)}
          onEnter={() => void save()}
          onEscape={revert}
          hint={left(budget.monthlyUsd, spending?.monthUsd)}
        />
        <span className="flex h-8 items-center">
          <SaveActions
            dirty={dirty}
            saving={saving}
            onSave={() => void save()}
            onRevert={revert}
            status={invalid ? 'Enter an amount in dollars, like 5 or 12.50.' : (error ?? (saved ? 'saved' : undefined))}
          />
        </span>
      </div>
    </SettingsItem>
  )
}

function AmountField({
  label,
  value,
  onChange,
  onEnter,
  onEscape,
  hint
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  onEscape: () => void
  /** "$4.20 left": on the label's line. */
  hint?: string
}) {
  const id = useId()
  return (
    <div className="w-40">
      <label htmlFor={id} className="block truncate text-[12px] text-muted">
        {label}
        {hint && <span className="tabular-nums"> · {hint}</span>}
      </label>
      <div className="mt-1 flex h-8 items-center rounded-md border border-line bg-raised focus-within:border-muted">
        <span className="pl-2.5 text-muted">$</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnter()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onEscape()
            }
          }}
          placeholder="No limit"
          className="min-w-0 flex-1 bg-transparent px-1.5 tabular-nums outline-none placeholder:text-muted/70"
        />
      </div>
    </div>
  )
}
