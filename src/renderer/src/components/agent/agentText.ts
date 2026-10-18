// Wording for the agent connection: the sidebar indicator, the activity drawer and the approval dialog.
// An agent is named by agentDisplayName (shared/agent-name.ts): a generic MCP client name ("mcp", "mcp-remote")
// reads "The agent", a real one ("OpenClaw") is kept. MCP is how the agent connects, not who it is.

import { agentDisplayName, isGenericAgentName } from '@shared/agent-name'
import type { AgentActivity, AgentClientInfo, AgentStatus, ApprovalRequest, SegmentImageSlot } from '@shared/types'
import { englishList } from '../../lib/assets'

/** The agent's name inside a sentence: "the agent" for a generic or missing name ("Ask the agent again"), else it. */
export function agentInSentence(name: string | undefined): string {
  return isGenericAgentName(name) ? 'the agent' : (name ?? '').trim()
}

/**
 * The technical side of a connected client, for small muted text: "client: mcp 1.2 · 127.0.0.1" when the name
 * shown is "The agent", else "1.2 · 192.0.2.7" (the name already says it).
 */
export function clientDetail(c: AgentClientInfo): string {
  const generic = isGenericAgentName(c.name)
  const client = generic ? `client: ${c.name.trim() || 'unknown'}${c.version ? ` ${c.version}` : ''}` : c.version
  return ['via MCP', client, c.address].filter(Boolean).join(' · ')
}

/** "1 item", "3 items": how many things a 'delete' request removes. */
export function thingsText(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`
}

/** "start image" / "end image". */
export function slotName(slot: SegmentImageSlot): string {
  return slot === 'end' ? 'end image' : 'start image'
}

export type AgentTone = 'off' | 'waiting' | 'connected' | 'error'

export interface AgentSummary {
  tone: AgentTone
  /** Short, for the sidebar: "Agent: off", "Agent: on – waiting", "Agent connected". */
  label: string
  /** A sentence for the drawer and tooltips. */
  detail: string
}

/** Client names without duplicates (one agent may hold several sessions). */
export function clientNames(status: AgentStatus): string[] {
  return [...new Set(status.clients.map((c) => c.name.trim() || 'Unknown agent'))]
}

export function agentSummary(status: AgentStatus | undefined): AgentSummary {
  if (!status) return { tone: 'off', label: 'Agent', detail: 'Checking the agent connection…' }
  if (!status.enabled) {
    return { tone: 'off', label: 'Agent: off', detail: 'The agent connection is off. No agent can reach Studio.' }
  }
  if (!status.running) {
    return status.error
      ? { tone: 'error', label: 'Agent: error', detail: `The connection couldn’t start: ${status.error}` }
      : { tone: 'waiting', label: 'Agent: starting…', detail: 'The connection is starting.' }
  }
  const names = clientNames(status)
  if (!names.length) {
    return { tone: 'waiting', label: 'Agent: on – waiting', detail: 'The connection is on and waiting for an agent.' }
  }
  // The sidebar says what is there, an agent, whatever its client calls itself ("mcp", "OpenClaw"…); a real name is
  // in the detail and the drawer, a generic one reads "an agent".
  const label = names.length === 1 ? 'Agent connected' : `${names.length} agents connected`
  return { tone: 'connected', label, detail: connectedDetail(names) }
}

/**
 * The drawer's line on who is connected: "OpenClaw is connected via MCP.", "An agent is connected via MCP.",
 * "OpenClaw and one more agent are connected via MCP."
 */
function connectedDetail(names: string[]): string {
  const named = names.filter((n) => !isGenericAgentName(n))
  const unnamed = names.length - named.length
  const others = named.length
    ? unnamed === 1
      ? ['one more agent']
      : unnamed > 1
        ? [`${unnamed} more agents`]
        : []
    : [unnamed === 1 ? 'An agent' : `${unnamed} agents`]
  const verb = names.length === 1 ? 'is connected' : 'are connected'
  return `${englishList([...named, ...others])} ${verb} via MCP.`
}

/** "The agent is working", "OpenClaw is working": who is working right now. */
export function workingLabel(a: AgentActivity): string {
  return `${agentDisplayName(a.client)} is working`
}

/** The summary without the agent's name in front, when main (or an older entry) put it there. */
function ownSummary(a: AgentActivity): string {
  const summary = a.summary.trim()
  const client = a.client.trim()
  return client && summary.toLocaleLowerCase('en').startsWith(client.toLocaleLowerCase('en'))
    ? summary.slice(client.length).trim()
    : summary
}

/** "Set the prompt": what the agent just did, for the working indicator (without its name, capitalised). */
export function presenceText(a: AgentActivity): string {
  const own = ownSummary(a)
  return own ? own.charAt(0).toLocaleUpperCase('en') + own.slice(1) : 'Working in Studio'
}

export const TONE_DOT: Record<AgentTone, string> = {
  off: 'border border-muted/70',
  waiting: 'bg-amber-400',
  connected: 'bg-emerald-400',
  error: 'bg-accent'
}

/** "19:42" today, "6 Oct, 19:42" on other days. */
export function formatTime(at: number): string {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * "The agent set the prompt", "OpenClaw set the prompt": the summary from main after the agent's name as the user
 * knows it (never the MCP client's technical name, which is in the drawer's connection details).
 */
export function activityText(a: AgentActivity): string {
  const own = ownSummary(a)
  return own ? `${agentDisplayName(a.client)} ${own}` : agentDisplayName(a.client)
}

/** What an approval would generate (or remove), in a few words. `sequenceName`: the sequence's or storyboard's name. */
export function approvalTitle(a: ApprovalRequest, sequenceName?: string): string {
  const inSequence = sequenceName ? ` in “${sequenceName}”` : ''
  // A storyboard's transitions are segments to main; the user knows them as transitions.
  const storyboard = a.sequenceKind === 'storyboard'
  switch (a.kind) {
    case 'delete':
      return `Delete ${thingsText(a.delete?.items.length ?? 0)}`
    case 'edit': {
      // "“Beach scene” v3": the edit and the version the operation works on.
      const name = a.edit?.editName ? `“${a.edit.editName}”` : 'An edit'
      return a.edit?.baseNumber ? `${name} v${a.edit.baseNumber}` : name
    }
    case 'voice-design':
      return a.edit?.assetName ? `A new voice for ${a.edit.assetName}` : 'A new voice for a character'
    case 'image': {
      const board = a.image?.assignToBoard
      if (board) return `The image for board ${board.boardNumber}${inSequence}`
      const target = a.image?.assignTo
      if (target) return `A ${slotName(target.slot)} for clip ${target.clipNumber}${inSequence}`
      // Without a sequence or storyboard the picture is a still of none, in Referensbilder.
      if (!a.sequenceId) return 'An image for “Referensbilder”'
      const named = sequenceName ? ` “${sequenceName}”` : ''
      return storyboard ? `An image for the storyboard${named}` : `An image for the sequence${named}`
    }
    case 'generation':
      return 'A video from Generate'
    case 'segment': {
      if (!storyboard) return `A new take of a clip${inSequence}`
      const n = a.clipNumbers?.[0]
      return `A new take of ${n ? `transition ${n}` : 'a transition'}${inSequence}`
    }
    case 'generate-all': {
      const n = a.segmentIds?.length ?? 0
      if (storyboard) {
        return n
          ? `${n === 1 ? 'One missing transition' : `${n} missing transitions`}${inSequence}`
          : `All missing transitions${inSequence}`
      }
      return n ? `${n === 1 ? 'One missing clip' : `${n} missing clips`}${inSequence}` : `All missing clips${inSequence}`
    }
  }
}

/** "expires in 12 min" / "expires in under a minute" / "has expired". */
export function expiresText(expiresAt: number, now: number): string {
  const left = expiresAt - now
  if (left <= 0) return 'has expired'
  const minutes = Math.floor(left / 60_000)
  return minutes < 1 ? 'expires in under a minute' : `expires in ${minutes} min`
}

/**
 * The verb for what the agent asks: "wants to generate" a video, "wants to create" a picture or a voice, "wants to
 * edit" a film, "wants to delete" things.
 */
export function approvalVerb(a: ApprovalRequest): string {
  if (a.kind === 'delete') return 'wants to delete'
  if (a.kind === 'edit') return 'wants to edit'
  return a.kind === 'image' || a.kind === 'voice-design' ? 'wants to create' : 'wants to generate'
}

/**
 * The dialog's heading after the agent's name (agentDisplayName): "wants to generate", "wants to create an image",
 * "wants to edit a film".
 */
export function approvalHeading(a: ApprovalRequest): string {
  switch (a.kind) {
    case 'image':
      return 'wants to create an image'
    case 'edit':
      return 'wants to edit a film'
    case 'voice-design':
      return 'wants to create a voice'
    case 'delete':
      return 'wants to delete'
    default:
      return 'wants to generate'
  }
}

/**
 * The approve button: "Approve and generate", "… and create" for a picture or a voice, "… and run" for an edit,
 * "… and delete" for a removal.
 */
export function approveLabel(a: ApprovalRequest): string {
  if (a.kind === 'delete') return 'Approve and delete'
  if (a.kind === 'edit') return 'Approve and run'
  return a.kind === 'image' || a.kind === 'voice-design' ? 'Approve and create' : 'Approve and generate'
}

/** "Deleted: 3 of 3", "Deleted: 2 of 3 – 1 failed: …": what an approved removal led to. */
export function deleteOutcome(a: ApprovalRequest): string {
  const items = a.delete?.items ?? []
  const deleted = items.filter((i) => i.outcome?.status === 'deleted').length
  const failed = items.filter((i) => i.outcome?.status === 'failed')
  const gone = items.filter((i) => i.outcome?.status === 'gone').length
  return [
    `Deleted: ${deleted} of ${items.length}`,
    failed.length ? `${failed.length} failed: ${failed[0].outcome?.error ?? 'unknown error'}` : '',
    gone ? `${gone} ${gone === 1 ? 'was' : 'were'} already gone` : ''
  ]
    .filter(Boolean)
    .join(' – ')
}

/**
 * The delete dialog's live check, said for the user: "Changed since the agent asked – can’t be approved: …". Main's
 * "changed since" message names the item in parentheses; its other reasons (a run that started meanwhile …) are
 * passed on as they are, without the advice meant for the agent.
 */
export function changedSinceText(reason: string): string {
  const text = reason.trim()
  const named = CHANGED_ITEM.exec(text)
  const why = named ? `${named[1]} has been changed or removed` : text.replace(ASK_AGAIN, '')
  return `Changed since the agent asked – can’t be approved: ${why.replace(/\.$/, '')}.`
}

/** Main's "changed since" message (tools/delete.ts), with the item's label in parentheses. */
const CHANGED_ITEM = /^Something to be deleted has changed since the agent asked \((.+)\)\.\s*Ask the agent to ask again\.?$/s
/** The advice main gives the agent, which the user doesn't need. */
const ASK_AGAIN = /\s*Ask the agent (?:to ask )?again\.?$/

/** What failed, by kind, when main gave no message. */
const FAILED: Record<ApprovalRequest['kind'], string> = {
  generation: 'The generation couldn’t be sent.',
  segment: 'The generation couldn’t be sent.',
  'generate-all': 'The generation couldn’t be sent.',
  image: 'The image couldn’t be created.',
  edit: 'The change couldn’t be started.',
  'voice-design': 'The voice couldn’t be created.',
  delete: 'Nothing could be deleted.'
}

/** Why an approval didn't lead to a generation, when main gave no message. */
export function approvalOutcome(a: ApprovalRequest): string {
  switch (a.status) {
    case 'approved': {
      if (a.kind === 'delete') return deleteOutcome(a)
      if (a.kind === 'edit' && a.edit?.resumeJobId) {
        return 'Approved – the job continues. The result appears in the Editor when it’s done.'
      }
      if (a.kind === 'edit') {
        return a.edit?.operation?.op === 'transcribe'
          ? 'Approved – the transcription has started. The text appears in the Editor when it’s done.'
          : 'Approved – the change has started. The new version appears in the Editor when it’s done.'
      }
      if (a.kind === 'voice-design') {
        return `Approved – the voice is being created and will be added under Voice${a.edit?.assetName ? ` for ${a.edit.assetName}` : ''} when it’s done.`
      }
      if (a.kind !== 'image') return 'Approved – the generation has been sent.'
      if (a.notice) return a.notice
      const board = a.image?.assignToBoard
      if (board) return `Approved – the image was created, saved and became the image of board ${board.boardNumber}.`
      const target = a.image?.assignTo
      if (target) {
        return `Approved – the image was created, saved and became the ${slotName(target.slot)} of clip ${target.clipNumber}.`
      }
      if (!a.sequenceId) return 'Approved – the image was created and saved in “Referensbilder”.'
      return a.sequenceKind === 'storyboard'
        ? 'Approved – the image was created and saved among the storyboard’s images.'
        : 'Approved – the image was created and saved among the sequence’s images.'
    }
    case 'declined':
      return 'The request was declined.'
    case 'expired':
      // Main says why when it wasn't the 30 minutes (replaced by a newer request, the connection switched off…).
      return a.error ?? 'The request expired (after 30 minutes). Ask the agent to send it again.'
    case 'failed':
      return a.error ?? FAILED[a.kind]
    case 'pending':
      return 'Waiting for your OK.'
  }
}
