import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { agentDisplayName } from '@shared/agent-name'
import type { AgentActivity, AgentStatus, ApprovalRequest } from '@shared/types'
import { ipcErrorMessage } from './hooks'

// Live state of the agent connection (the MCP server in main): its status, the activity log and the approval
// requests (paid generations, and removals an agent asks for). One subscription for the whole window, shared by the
// sidebar indicator, the activity drawer, the approval dialog and Settings.

/** Main keeps the same number of entries in its ring buffer. */
const MAX_ACTIVITY = 200

export interface AgentState {
  status?: AgentStatus
  /** Why the status couldn't be read. */
  statusError?: string
  /** Newest first. */
  activity: AgentActivity[]
  /** Oldest first. */
  approvals: ApprovalRequest[]
  /** Pending approvals put off with "Senare": the dialog leaves them until they're opened again. */
  deferred: string[]
  /** The approval to show before any other (opened from the drawer). */
  focused?: string
}

let state: AgentState = { activity: [], approvals: [], deferred: [] }
const listeners = new Set<() => void>()

function update(fn: (s: AgentState) => AgentState): void {
  const next = fn(state)
  if (next === state) return
  state = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAgentState(): AgentState {
  return useSyncExternalStore(subscribe, () => state)
}

export function getAgentState(): AgentState {
  return state
}

/** How long after its latest tool call an agent counts as working. */
export const AGENT_WORKING_MS = 12_000

const NOT_WORKING: AgentActivity[] = []

/**
 * While an agent is working (a tool call in the last few seconds): its recent calls, newest first, the ones close
 * together. Empty otherwise. Re-renders by itself when the agent goes quiet. The same array until the activity
 * changes or the agent goes quiet, so it can be an effect's dependency.
 */
export function useAgentWorking(): AgentActivity[] {
  const { activity } = useAgentState()
  const latest = activity[0]
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!latest) return
    const left = latest.at + AGENT_WORKING_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), left + 50)
    return () => clearTimeout(timer)
  }, [latest])
  return useMemo(() => {
    if (!latest || Date.now() - latest.at >= AGENT_WORKING_MS) return NOT_WORKING
    // One burst of work: calls no more than the working window apart.
    const burst: AgentActivity[] = []
    for (const a of activity) {
      const previous = burst[burst.length - 1] ?? latest
      if (previous.at - a.at > AGENT_WORKING_MS) break
      burst.push(a)
    }
    return burst
    // `tick` makes it look again once the working window has passed.
  }, [activity, latest, tick])
}

// ── Merging what main sends ─────────────────────────────────────────────────

function mergeActivity(list: AgentActivity[], incoming: readonly AgentActivity[]): AgentActivity[] {
  const byId = new Map(list.map((a) => [a.id, a]))
  for (const a of incoming) byId.set(a.id, a)
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY)
}

/** A request that has been decided (or expired) never goes back to pending, whatever order replies arrive in. */
function newer(old: ApprovalRequest | undefined, incoming: ApprovalRequest): ApprovalRequest {
  if (old && old.status !== 'pending' && incoming.status === 'pending') return old
  return incoming
}

function mergeApprovals(list: ApprovalRequest[], incoming: readonly ApprovalRequest[]): ApprovalRequest[] {
  const byId = new Map(list.map((a) => [a.id, a]))
  for (const a of incoming) byId.set(a.id, newer(byId.get(a.id), a))
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** Forgets put-off and focus marks of requests that are no longer pending. */
function tidy(s: AgentState): AgentState {
  const pending = new Set(s.approvals.filter((a) => a.status === 'pending').map((a) => a.id))
  const deferred = s.deferred.filter((id) => pending.has(id))
  const focused = s.focused && pending.has(s.focused) ? s.focused : undefined
  if (deferred.length === s.deferred.length && focused === s.focused) return s
  return { ...s, deferred, focused }
}

function applyApprovals(incoming: readonly ApprovalRequest[]): void {
  update((s) => tidy({ ...s, approvals: mergeApprovals(s.approvals, incoming) }))
}

function applyStatus(status: AgentStatus): void {
  update((s) => ({ ...s, status, statusError: undefined }))
}

// ── Subscription ────────────────────────────────────────────────────────────

let users = 0
let stopFeed: (() => void) | undefined

/** A heads-up outside the window when an agent asks for something that needs the user's OK and Studio isn't in front. */
function notifyNewApproval(a: ApprovalRequest): void {
  if (document.hasFocus() || typeof Notification === 'undefined') return
  try {
    // An image request makes a still, an edit changes a film in Redigera, a voice design makes a voice, a removal
    // removes things; the rest generates video.
    const what =
      a.kind === 'image'
        ? 'vill skapa en bild'
        : a.kind === 'edit'
          ? 'vill redigera en film'
          : a.kind === 'voice-design'
            ? 'vill skapa en röst'
            : a.kind === 'delete'
              ? 'vill ta bort något'
              : 'vill generera'
    // "Agenten vill generera" for a generic MCP client name, "OpenClaw vill generera" for a real one.
    const note = new Notification(`${agentDisplayName(a.client)} ${what}`, {
      body: 'Öppna Studio för att godkänna eller avböja.',
      silent: false
    })
    note.onclick = () => window.focus()
  } catch {
    // Notifications are only a convenience; the dialog is waiting in the window.
  }
}

/**
 * Starts following the agent connection (status, activity, approvals) and returns a function that stops it.
 * Callers share one subscription; it ends when the last one stops.
 */
export function startAgentFeed(): () => void {
  users++
  if (users === 1) {
    const offs = [
      window.studio.onAgentStatus(applyStatus),
      window.studio.onAgentActivity((a) => update((s) => ({ ...s, activity: mergeActivity(s.activity, [a]) }))),
      window.studio.onApproval((a) => {
        const known = state.approvals.some((x) => x.id === a.id)
        applyApprovals([a])
        if (!known && a.status === 'pending') notifyNewApproval(a)
      })
    ]
    stopFeed = () => offs.forEach((off) => off())
    void refreshAgentStatus()
    window.studio.listAgentActivity().then(
      (list) => update((s) => ({ ...s, activity: mergeActivity(s.activity, list) })),
      () => {}
    )
    window.studio.listApprovals().then(applyApprovals, () => {})
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    users--
    if (users === 0) {
      stopFeed?.()
      stopFeed = undefined
    }
  }
}

/**
 * Fetches the requests again. Main lists a pending request with its params following files moved since it was
 * made, so a view that saw the library change (e.g. "Städa upp") gets the paths as they are now.
 */
export function refreshApprovals(): Promise<void> {
  return window.studio.listApprovals().then(applyApprovals, () => {})
}

export async function refreshAgentStatus(): Promise<void> {
  try {
    applyStatus(await window.studio.getAgentStatus())
  } catch (e) {
    update((s) => ({ ...s, statusError: ipcErrorMessage(e) }))
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Switches the server on or off; rejects with main's Swedish message (e.g. the port is taken). */
export async function setAgentEnabled(enabled: boolean): Promise<AgentStatus> {
  const status = await window.studio.setAgentEnabled(enabled)
  applyStatus(status)
  return status
}

export async function setAgentPort(port: number): Promise<AgentStatus> {
  const status = await window.studio.setAgentPort(port)
  applyStatus(status)
  return status
}

/** "Sök igen" / "Försök igen": looks for Tailscale again, or retries starting; pending requests stay. */
export async function restartAgent(): Promise<AgentStatus> {
  const status = await window.studio.restartAgent()
  applyStatus(status)
  return status
}

/** Approves or declines; the request comes back updated (approved, declined or failed). */
export async function resolveApproval(id: string, approve: boolean, reason?: string): Promise<ApprovalRequest> {
  const result = await window.studio.resolveApproval(id, approve, reason)
  applyApprovals([result])
  return result
}

/**
 * The delete dialog's live check: main runs the request's own check again without carrying anything out. Resolves
 * null while it can still be approved, else why not (Swedish).
 */
export function verifyApproval(id: string): Promise<string | null> {
  return window.studio.verifyApproval(id)
}

/** "Senare": keeps the request pending but stops the dialog from showing it until it's opened again. */
export function deferApproval(id: string): void {
  update((s) => ({
    ...s,
    deferred: s.deferred.includes(id) ? s.deferred : [...s.deferred, id],
    focused: s.focused === id ? undefined : s.focused
  }))
}

/** Brings a pending request to the front of the dialog. */
export function showApproval(id: string): void {
  update((s) => ({ ...s, deferred: s.deferred.filter((d) => d !== id), focused: id }))
}

// ── Derived ─────────────────────────────────────────────────────────────────

export function pendingApprovals(s: AgentState): ApprovalRequest[] {
  return s.approvals.filter((a) => a.status === 'pending')
}

/** What the approval dialog works through: the focused request first, then the others oldest first. */
export function approvalQueue(s: AgentState): ApprovalRequest[] {
  const queue = pendingApprovals(s).filter((a) => !s.deferred.includes(a.id))
  const i = s.focused ? queue.findIndex((a) => a.id === s.focused) : -1
  return i > 0 ? [queue[i], ...queue.slice(0, i), ...queue.slice(i + 1)] : queue
}

/** Approvals expire in main after this long. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000
