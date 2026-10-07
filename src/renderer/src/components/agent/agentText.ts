// Swedish wording for the agent connection: the sidebar indicator, the activity drawer and the approval dialog.

import type { AgentActivity, AgentStatus, ApprovalRequest, SegmentImageSlot } from '@shared/types'
import { swedishList } from '../../lib/assets'

/** "startbild" / "slutbild". */
export function slotName(slot: SegmentImageSlot): string {
  return slot === 'end' ? 'slutbild' : 'startbild'
}

export type AgentTone = 'off' | 'waiting' | 'connected' | 'error'

export interface AgentSummary {
  tone: AgentTone
  /** Short, for the sidebar: "Agent: av", "Agent: på – väntar", "OpenClaw ansluten". */
  label: string
  /** A sentence for the drawer and tooltips. */
  detail: string
}

/** Client names without duplicates (one agent may hold several sessions). */
export function clientNames(status: AgentStatus): string[] {
  return [...new Set(status.clients.map((c) => c.name.trim() || 'Okänd agent'))]
}

export function agentSummary(status: AgentStatus | undefined): AgentSummary {
  if (!status) return { tone: 'off', label: 'Agent', detail: 'Läser av agentanslutningen…' }
  if (!status.enabled) {
    return { tone: 'off', label: 'Agent: av', detail: 'Agentanslutningen är avstängd. Ingen agent kan nå Studio.' }
  }
  if (!status.running) {
    return status.error
      ? { tone: 'error', label: 'Agent: fel', detail: `Anslutningen kunde inte starta: ${status.error}` }
      : { tone: 'waiting', label: 'Agent: startar…', detail: 'Anslutningen startar.' }
  }
  const names = clientNames(status)
  if (!names.length) {
    return { tone: 'waiting', label: 'Agent: på – väntar', detail: 'Anslutningen är på och väntar på en agent.' }
  }
  const who = swedishList(names)
  const verb = names.length === 1 ? 'ansluten' : 'anslutna'
  return { tone: 'connected', label: `${who} ${verb}`, detail: `${who} är ${verb} till Studio.` }
}

export const TONE_DOT: Record<AgentTone, string> = {
  off: 'border border-muted/70',
  waiting: 'bg-amber-400',
  connected: 'bg-emerald-400',
  error: 'bg-accent'
}

/** "19:42" today, "6 okt 19:42" on other days. */
export function formatTime(at: number): string {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "OpenClaw satte prompten": the summary from main, prefixed with the client unless it already names it. */
export function activityText(a: AgentActivity): string {
  const summary = a.summary.trim()
  const client = a.client.trim()
  if (!client || summary.toLocaleLowerCase('sv').startsWith(client.toLocaleLowerCase('sv'))) return summary
  return `${client} ${summary}`
}

/** What an approval would generate, in a few words. */
export function approvalTitle(a: ApprovalRequest, sequenceName?: string): string {
  const inSequence = sequenceName ? ` i ”${sequenceName}”` : ''
  switch (a.kind) {
    case 'image': {
      const target = a.image?.assignTo
      if (target) return `En ${slotName(target.slot)} till klipp ${target.clipNumber}${inSequence}`
      // Without a sequence the picture is a still of none, in Referensbilder.
      return a.sequenceId ? `En bild till storyboarden${inSequence}` : 'En bild till Referensbilder'
    }
    case 'generation':
      return 'En video från Generera'
    case 'segment':
      return `En ny tagning av ett klipp${inSequence}`
    case 'generate-all': {
      const n = a.segmentIds?.length ?? 0
      return n ? `${n === 1 ? 'Ett saknat klipp' : `${n} saknade klipp`}${inSequence}` : `Alla saknade klipp${inSequence}`
    }
  }
}

/** "går ut om 12 min" / "går ut om under en minut" / "har gått ut". */
export function expiresText(expiresAt: number, now: number): string {
  const left = expiresAt - now
  if (left <= 0) return 'har gått ut'
  const minutes = Math.floor(left / 60_000)
  return minutes < 1 ? 'går ut om under en minut' : `går ut om ${minutes} min`
}

/** The verb for what the agent asks: "vill generera" a video, "vill skapa en bild". */
export function approvalVerb(a: ApprovalRequest): string {
  return a.kind === 'image' ? 'vill skapa' : 'vill generera'
}

/** Why an approval didn't lead to a generation, when main gave no message. */
export function approvalOutcome(a: ApprovalRequest): string {
  switch (a.status) {
    case 'approved': {
      if (a.kind !== 'image') return 'Godkänd – genereringen är skickad.'
      if (a.notice) return a.notice
      const target = a.image?.assignTo
      if (target) {
        return `Godkänd – bilden är skapad, sparad och blev ${slotName(target.slot)} för klipp ${target.clipNumber}.`
      }
      return a.sequenceId
        ? 'Godkänd – bilden är skapad och sparad bland sekvensens bilder.'
        : 'Godkänd – bilden är skapad och sparad i Referensbilder.'
    }
    case 'declined':
      return 'Begäran avböjdes.'
    case 'expired':
      // Main says why when it wasn't the 30 minutes (replaced by a newer request, the connection switched off…).
      return a.error ?? 'Begäran hann gå ut (efter 30 minuter). Be agenten skicka den igen.'
    case 'failed':
      return a.error ?? (a.kind === 'image' ? 'Bilden kunde inte skapas.' : 'Genereringen kunde inte skickas.')
    case 'pending':
      return 'Väntar på ditt OK.'
  }
}
