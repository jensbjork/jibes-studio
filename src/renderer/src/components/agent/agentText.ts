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

/** What an approval would generate, in a few words. `sequenceName`: the sequence's or storyboard's name. */
export function approvalTitle(a: ApprovalRequest, sequenceName?: string): string {
  const inSequence = sequenceName ? ` i ”${sequenceName}”` : ''
  // A storyboard's transitions are segments to main; the user knows them as transitions ("övergångar").
  const storyboard = a.sequenceKind === 'storyboard'
  switch (a.kind) {
    case 'edit': {
      // "”Strandscen” v3": the edit and the version the operation works on.
      const name = a.edit?.editName ? `”${a.edit.editName}”` : 'En redigering'
      return a.edit?.baseNumber ? `${name} v${a.edit.baseNumber}` : name
    }
    case 'voice-design':
      return a.edit?.assetName ? `En ny röst till ${a.edit.assetName}` : 'En ny röst till en karaktär'
    case 'image': {
      const board = a.image?.assignToBoard
      if (board) return `Bilden till ruta ${board.boardNumber}${inSequence}`
      const target = a.image?.assignTo
      if (target) return `En ${slotName(target.slot)} till klipp ${target.clipNumber}${inSequence}`
      // Without a sequence or storyboard the picture is a still of none, in Referensbilder.
      if (!a.sequenceId) return 'En bild till Referensbilder'
      const named = sequenceName ? ` ”${sequenceName}”` : ''
      return storyboard ? `En bild till storyboarden${named}` : `En bild till sekvensen${named}`
    }
    case 'generation':
      return 'En video från Generera'
    case 'segment': {
      if (!storyboard) return `En ny tagning av ett klipp${inSequence}`
      const n = a.clipNumbers?.[0]
      return `En ny tagning av ${n ? `övergång ${n}` : 'en övergång'}${inSequence}`
    }
    case 'generate-all': {
      const n = a.segmentIds?.length ?? 0
      if (storyboard) {
        return n
          ? `${n === 1 ? 'En saknad övergång' : `${n} saknade övergångar`}${inSequence}`
          : `Alla saknade övergångar${inSequence}`
      }
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

/** The verb for what the agent asks: "vill generera" a video, "vill skapa" a picture or a voice, "vill redigera" a film. */
export function approvalVerb(a: ApprovalRequest): string {
  if (a.kind === 'edit') return 'vill redigera'
  return a.kind === 'image' || a.kind === 'voice-design' ? 'vill skapa' : 'vill generera'
}

/** The dialog's heading after the agent's name: "vill generera", "vill skapa en bild", "vill redigera en film". */
export function approvalHeading(a: ApprovalRequest): string {
  switch (a.kind) {
    case 'image':
      return 'vill skapa en bild'
    case 'edit':
      return 'vill redigera en film'
    case 'voice-design':
      return 'vill skapa en röst'
    default:
      return 'vill generera'
  }
}

/** The approve button: "Godkänn och generera", "… och skapa" for a picture or a voice, "… och kör" for an edit. */
export function approveLabel(a: ApprovalRequest): string {
  if (a.kind === 'edit') return 'Godkänn och kör'
  return a.kind === 'image' || a.kind === 'voice-design' ? 'Godkänn och skapa' : 'Godkänn och generera'
}

/** Why an approval didn't lead to a generation, when main gave no message. */
export function approvalOutcome(a: ApprovalRequest): string {
  switch (a.status) {
    case 'approved': {
      if (a.kind === 'edit') {
        return a.edit?.operation?.op === 'transcribe'
          ? 'Godkänd – transkriberingen är startad. Texten visas i Redigera när den är klar.'
          : 'Godkänd – ändringen är startad. Den nya versionen visas i Redigera när den är klar.'
      }
      if (a.kind === 'voice-design') {
        return `Godkänd – rösten skapas och läggs till under Röst${a.edit?.assetName ? ` hos ${a.edit.assetName}` : ''} när den är klar.`
      }
      if (a.kind !== 'image') return 'Godkänd – genereringen är skickad.'
      if (a.notice) return a.notice
      const board = a.image?.assignToBoard
      if (board) return `Godkänd – bilden är skapad, sparad och blev bilden i ruta ${board.boardNumber}.`
      const target = a.image?.assignTo
      if (target) {
        return `Godkänd – bilden är skapad, sparad och blev ${slotName(target.slot)} för klipp ${target.clipNumber}.`
      }
      if (!a.sequenceId) return 'Godkänd – bilden är skapad och sparad i Referensbilder.'
      return a.sequenceKind === 'storyboard'
        ? 'Godkänd – bilden är skapad och sparad bland storyboardens bilder.'
        : 'Godkänd – bilden är skapad och sparad bland sekvensens bilder.'
    }
    case 'declined':
      return 'Begäran avböjdes.'
    case 'expired':
      // Main says why when it wasn't the 30 minutes (replaced by a newer request, the connection switched off…).
      return a.error ?? 'Begäran hann gå ut (efter 30 minuter). Be agenten skicka den igen.'
    case 'failed':
      return (
        a.error ??
        (a.kind === 'image'
          ? 'Bilden kunde inte skapas.'
          : a.kind === 'edit'
            ? 'Ändringen kunde inte startas.'
            : a.kind === 'voice-design'
              ? 'Rösten kunde inte skapas.'
              : 'Genereringen kunde inte skickas.')
      )
    case 'pending':
      return 'Väntar på ditt OK.'
  }
}
