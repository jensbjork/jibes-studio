import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { roomLeft, usdText } from '@shared/budget'
import type { OverBudget, SpendingSummary } from '@shared/types'
import { overBudgetNow } from '../../budget'
import { callService } from '../local-ipc'
import { READ_ONLY, defineTool, type ToolContext } from './kit'

// Spending, as Settings → Spending shows it: what Studio recorded as paid today, this month and over the last 30
// days, by kind, place and who asked, with the user's budget and the room it leaves. Read-only: only the user sets
// the budget. A paid request that would go past it still only asks the user (see overBudgetAnswer).

const COUNTS =
  'What Studio recorded as paid: completed videos (Generate, sequence clips, storyboard transitions, the Editor’s picture operations) at their price, created images, and what the Editor’s sound jobs, transcriptions and voice designs sent. Failed generations cost nothing; work still rendering is on its way (on_its_way_usd), not spent, but counts against the budget. Days are the user’s local days; anything deleted from the library drops out. Venice’s own account is the record of what was billed.'

/**
 * For a paid request's answer: when its price would take today's or this month's spending past the user's budget,
 * `over_budget` and a sentence for the agent. The request is made all the same – the user decides in the approval
 * dialog, which shows the same warning. {} within the budget, without one, or when the spending can't be read.
 */
export function overBudgetAnswer(priceUsd: number | undefined): Record<string, unknown> {
  let over: OverBudget | undefined
  try {
    over = overBudgetNow(priceUsd)
  } catch {
    return {}
  }
  if (!over) return {}
  const daily = over.period === 'day'
  const spent = `${usdText(over.spentUsd)} spent ${daily ? 'today' : 'this month'}${over.pendingUsd ? `, ${usdText(over.pendingUsd)} on its way` : ''}`
  const what = over.amountUsd ? `It costs ${usdText(over.amountUsd)} and would take` : 'Its price is unknown, and'
  const past = over.amountUsd ? 'past' : 'is already at'
  return {
    over_budget: {
      period: over.period,
      budget_usd: over.budgetUsd,
      spent_usd: over.spentUsd,
      ...(over.pendingUsd ? { on_its_way_usd: over.pendingUsd } : {}),
      price_usd: over.amountUsd || null
    },
    budget_note: `${what} ${daily ? 'today’s' : 'this month’s'} spending ${past} the user’s ${daily ? 'daily' : 'monthly'} budget of ${usdText(over.budgetUsd)} (${spent}). The request still only waits for their approval – Studio shows them the same warning –, so tell them it goes over the budget.`
  }
}

export function registerSpendingTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_spending',
    {
      title: 'Get what Studio has spent',
      description:
        "What Studio has spent at Venice, as Settings → Spending shows it: today_usd, this_month_usd and on_its_way_usd (work still rendering: not spent yet, but counted against the budget); the user's budget (daily_usd, monthly_usd; null = no cap) with the room it leaves today and this month (left_today_usd, left_this_month_usd); the last 30 days per day; and this month by kind (videos, images, Editor jobs, voices, transcripts), by place (Generate, each sequence, storyboard or edit, with its id) and by who asked (\"user\", or the agent whose approved request it was; is_you marks yours). Check it before asking for something expensive: a paid request that would go past a cap still only waits for the user's approval, and its answer says so (over_budget). Only the user sets the budget. Free; changes nothing.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'checked the spending'
    },
    async () => {
      const s = await callService<SpendingSummary>('spending:get')
      const daily = s.budget.dailyUsd
      const monthly = s.budget.monthlyUsd
      const me = ctx.clientName()
      return {
        data: {
          today_usd: s.todayUsd,
          this_month_usd: s.monthUsd,
          on_its_way_usd: s.pendingUsd,
          budget: { daily_usd: daily ?? null, monthly_usd: monthly ?? null },
          left_today_usd: roomLeft(daily, s.todayUsd, s.pendingUsd) ?? null,
          left_this_month_usd: roomLeft(monthly, s.monthUsd, s.pendingUsd) ?? null,
          last_30_days: s.days,
          last_30_days_usd: s.last30Usd,
          this_month: {
            by_kind: s.byKind,
            by_place: s.byPlace.map((p) => ({
              label: p.label,
              usd: p.usd,
              ...(p.sequenceId ? { sequence_id: p.sequenceId } : {}),
              ...(p.storyboardId ? { storyboard_id: p.storyboardId } : {}),
              ...(p.editId ? { edit_id: p.editId } : {})
            })),
            by_who: s.byWho.map((w) => ({ who: w.who, usd: w.usd, ...(w.who === me ? { is_you: true } : {}) }))
          },
          what_counts: COUNTS
        },
        summary: `checked the spending (${usdText(s.todayUsd)} today)`
      }
    }
  )
}
