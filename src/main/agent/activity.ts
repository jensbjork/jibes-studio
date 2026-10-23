import { randomUUID } from 'node:crypto'
import type { AgentActivity } from '@shared/types'

/** How many tool calls the log keeps (the Agent panel shows the latest ones). */
const CAPACITY = 200

/**
 * The same call repeated within this time (an agent polling get_approval, say) updates the time of the entry
 * it repeats instead of pushing everything else out of the log.
 */
const REPEAT_WINDOW_MS = 10 * 60 * 1000

/** The activity log: every tool call an agent makes, newest last, in a fixed-size ring. */
export class ActivityLog {
  private readonly entries: AgentActivity[] = []

  constructor(private readonly onRecord: (entry: AgentActivity) => void) {}

  /**
   * `readOnly`: the call changed nothing (get_approval, get_sequence …). Agents poll such calls in turn, so an
   * identical one anywhere in the repeat window is folded into this one and moved to the end; a change is only
   * folded into the entry right before it.
   */
  record(entry: Omit<AgentActivity, 'id' | 'at'>, readOnly = false): AgentActivity {
    const now = Date.now()
    const same = (e: AgentActivity): boolean =>
      now - e.at < REPEAT_WINDOW_MS &&
      e.client === entry.client &&
      e.tool === entry.tool &&
      e.summary === entry.summary &&
      e.ok === entry.ok &&
      e.approvalId === entry.approvalId
    let at = -1
    if (readOnly) {
      for (let i = this.entries.length - 1; i >= 0 && now - this.entries[i].at < REPEAT_WINDOW_MS; i--) {
        if (same(this.entries[i])) {
          at = i
          break
        }
      }
    } else if (this.entries.length && same(this.entries[this.entries.length - 1])) {
      at = this.entries.length - 1
    }
    let full: AgentActivity
    if (at >= 0) {
      // Same id, so the window replaces the entry it already has (and sorts it by its new time).
      full = { ...this.entries[at], at: now }
      this.entries.splice(at, 1)
      this.entries.push(full)
    } else {
      full = { id: randomUUID(), at: now, ...entry }
      this.entries.push(full)
      if (this.entries.length > CAPACITY) this.entries.splice(0, this.entries.length - CAPACITY)
    }
    try {
      this.onRecord(full)
    } catch (err) {
      console.warn('Could not broadcast agent activity:', err)
    }
    return full
  }

  /** Newest first. */
  list(): AgentActivity[] {
    return [...this.entries].reverse()
  }
}
