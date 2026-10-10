// Swedish wording for the agent connection: the sidebar indicator, the activity drawer and the approval dialog.
// An agent is named by agentDisplayName (shared/agent-name.ts): a generic MCP client name ("mcp", "mcp-remote")
// reads "Agenten", a real one ("OpenClaw") is kept. MCP is how the agent connects, not who it is.

import { agentDisplayName, isGenericAgentName } from '@shared/agent-name'
import type { AgentActivity, AgentClientInfo, AgentStatus, ApprovalRequest, SegmentImageSlot } from '@shared/types'
import { swedishList } from '../../lib/assets'

/** The agent's name inside a sentence: "agenten" for a generic or missing name ("Be agenten fråga igen"), else it. */
export function agentInSentence(name: string | undefined): string {
  return isGenericAgentName(name) ? 'agenten' : (name ?? '').trim()
}

/**
 * The technical side of a connected client, for small muted text: "klient: mcp 1.2 · 127.0.0.1" when the name
 * shown is "Agenten", else "1.2 · 192.0.2.7" (the name already says it).
 */
export function clientDetail(c: AgentClientInfo): string {
  const generic = isGenericAgentName(c.name)
  const client = generic ? `klient: ${c.name.trim() || 'okänd'}${c.version ? ` ${c.version}` : ''}` : c.version
  return ['via MCP', client, c.address].filter(Boolean).join(' · ')
}

/** "1 sak", "3 saker": how many things a 'delete' request removes. */
export function thingsText(n: number): string {
  return `${n} ${n === 1 ? 'sak' : 'saker'}`
}

/** "startbild" / "slutbild". */
export function slotName(slot: SegmentImageSlot): string {
  return slot === 'end' ? 'slutbild' : 'startbild'
}

export type AgentTone = 'off' | 'waiting' | 'connected' | 'error'

export interface AgentSummary {
  tone: AgentTone
  /** Short, for the sidebar: "Agent: av", "Agent: på – väntar", "Agent ansluten". */
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
  // The sidebar says what is there, an agent, whatever its client calls itself ("mcp", "OpenClaw"…); a real name is
  // in the detail and the drawer, a generic one reads "en agent".
  const label = names.length === 1 ? 'Agent ansluten' : `${names.length} agenter anslutna`
  return { tone: 'connected', label, detail: connectedDetail(names) }
}

/**
 * The drawer's line on who is connected: "OpenClaw är ansluten via MCP.", "En agent är ansluten via MCP.",
 * "OpenClaw och en agent till är anslutna via MCP."
 */
function connectedDetail(names: string[]): string {
  const named = names.filter((n) => !isGenericAgentName(n))
  const unnamed = names.length - named.length
  const others = named.length
    ? unnamed === 1
      ? ['en agent till']
      : unnamed > 1
        ? [`${unnamed} agenter till`]
        : []
    : [unnamed === 1 ? 'En agent' : `${unnamed} agenter`]
  const verb = names.length === 1 ? 'är ansluten' : 'är anslutna'
  return `${swedishList([...named, ...others])} ${verb} via MCP.`
}

/** "Agenten arbetar", "OpenClaw arbetar": who is working right now. */
export function workingLabel(a: AgentActivity): string {
  return `${agentDisplayName(a.client)} arbetar`
}

/** The summary without the agent's name in front, when main (or an older entry) put it there. */
function ownSummary(a: AgentActivity): string {
  const summary = a.summary.trim()
  const client = a.client.trim()
  return client && summary.toLocaleLowerCase('sv').startsWith(client.toLocaleLowerCase('sv'))
    ? summary.slice(client.length).trim()
    : summary
}

/** "Satte prompten": what the agent just did, for the working indicator (without its name, capitalised). */
export function presenceText(a: AgentActivity): string {
  const own = ownSummary(a)
  return own ? own.charAt(0).toLocaleUpperCase('sv') + own.slice(1) : 'Arbetar i Studio'
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

/**
 * "Agenten satte prompten", "OpenClaw satte prompten": the summary from main after the agent's name as the user
 * knows it (never the MCP client's technical name, which is in the drawer's connection details).
 */
export function activityText(a: AgentActivity): string {
  const own = ownSummary(a)
  return own ? `${agentDisplayName(a.client)} ${own}` : agentDisplayName(a.client)
}

/** What an approval would generate (or remove), in a few words. `sequenceName`: the sequence's or storyboard's name. */
export function approvalTitle(a: ApprovalRequest, sequenceName?: string): string {
  const inSequence = sequenceName ? ` i ”${sequenceName}”` : ''
  // A storyboard's transitions are segments to main; the user knows them as transitions ("övergångar").
  const storyboard = a.sequenceKind === 'storyboard'
  switch (a.kind) {
    case 'delete':
      return `Ta bort ${thingsText(a.delete?.items.length ?? 0)}`
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

/**
 * The verb for what the agent asks: "vill generera" a video, "vill skapa" a picture or a voice, "vill redigera" a
 * film, "vill ta bort" things.
 */
export function approvalVerb(a: ApprovalRequest): string {
  if (a.kind === 'delete') return 'vill ta bort'
  if (a.kind === 'edit') return 'vill redigera'
  return a.kind === 'image' || a.kind === 'voice-design' ? 'vill skapa' : 'vill generera'
}

/**
 * The dialog's heading after the agent's name (agentDisplayName): "vill generera", "vill skapa en bild", "vill
 * redigera en film".
 */
export function approvalHeading(a: ApprovalRequest): string {
  switch (a.kind) {
    case 'image':
      return 'vill skapa en bild'
    case 'edit':
      return 'vill redigera en film'
    case 'voice-design':
      return 'vill skapa en röst'
    case 'delete':
      return 'vill ta bort'
    default:
      return 'vill generera'
  }
}

/**
 * The approve button: "Godkänn och generera", "… och skapa" for a picture or a voice, "… och kör" for an edit,
 * "… och ta bort" for a removal.
 */
export function approveLabel(a: ApprovalRequest): string {
  if (a.kind === 'delete') return 'Godkänn och ta bort'
  if (a.kind === 'edit') return 'Godkänn och kör'
  return a.kind === 'image' || a.kind === 'voice-design' ? 'Godkänn och skapa' : 'Godkänn och generera'
}

/** "Borttaget: 3 av 3", "Borttaget: 2 av 3 – 1 gick inte: …": what an approved removal led to. */
export function deleteOutcome(a: ApprovalRequest): string {
  const items = a.delete?.items ?? []
  const deleted = items.filter((i) => i.outcome?.status === 'deleted').length
  const failed = items.filter((i) => i.outcome?.status === 'failed')
  const gone = items.filter((i) => i.outcome?.status === 'gone').length
  return [
    `Borttaget: ${deleted} av ${items.length}`,
    failed.length ? `${failed.length} gick inte: ${failed[0].outcome?.error ?? 'okänt fel'}` : '',
    gone ? `${gone} fanns redan inte` : ''
  ]
    .filter(Boolean)
    .join(' – ')
}

/**
 * The delete dialog's live check, said for the user: "Ändrats sedan agenten frågade – kan inte godkännas: …". Main's
 * "changed since" message names the item in parentheses; its other reasons (a run that started meanwhile …) are
 * passed on as they are, without the advice meant for the agent.
 */
export function changedSinceText(reason: string): string {
  const text = reason.trim()
  const named = CHANGED_ITEM.exec(text)
  const why = named ? `${named[1]} har ändrats eller tagits bort` : text.replace(ASK_AGAIN, '')
  return `Ändrats sedan agenten frågade – kan inte godkännas: ${why.replace(/\.$/, '')}.`
}

/** Main's "changed since" message (tools/delete.ts), with the item's label in parentheses. */
const CHANGED_ITEM = /^Något av det som skulle tas bort har ändrats sedan agenten frågade \((.+)\)\.\s*Be agenten fråga igen\.?$/s
/** The advice main gives the agent, which the user doesn't need. */
const ASK_AGAIN = /\s*Be agenten fråga igen\.?$/

/** What failed, by kind, when main gave no message. */
const FAILED: Record<ApprovalRequest['kind'], string> = {
  generation: 'Genereringen kunde inte skickas.',
  segment: 'Genereringen kunde inte skickas.',
  'generate-all': 'Genereringen kunde inte skickas.',
  image: 'Bilden kunde inte skapas.',
  edit: 'Ändringen kunde inte startas.',
  'voice-design': 'Rösten kunde inte skapas.',
  delete: 'Inget kunde tas bort.'
}

/** Why an approval didn't lead to a generation, when main gave no message. */
export function approvalOutcome(a: ApprovalRequest): string {
  switch (a.status) {
    case 'approved': {
      if (a.kind === 'delete') return deleteOutcome(a)
      if (a.kind === 'edit' && a.edit?.resumeJobId) {
        return 'Godkänd – jobbet fortsätter. Resultatet visas i Redigera när det är klart.'
      }
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
      return a.error ?? FAILED[a.kind]
    case 'pending':
      return 'Väntar på ditt OK.'
  }
}
