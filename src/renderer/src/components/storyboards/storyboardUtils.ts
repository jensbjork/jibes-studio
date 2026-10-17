// Pure helpers for the Storyboards view: what a transition's state is, what "Generera saknade" and "Exportera"
// would do, local copies of main's edits for instant feedback, and the wording around boards and transitions.
// No React and no window.studio here, so they can be tested on their own.

import { durationSeconds } from '@shared/models'
import type { Generation, Sequence, Storyboard, StoryboardBoard, StoryboardTransition } from '@shared/types'
import { freshestTake, isPending, takeProgress } from '../sequences/sequenceUtils'

export {
  fileName,
  formatLength,
  formatTakeTime,
  freshestTake,
  isPending,
  parseConsent,
  takeProgress
} from '../sequences/sequenceUtils'

/** The aspect ratios a storyboard can have: the default image-to-video model's practical set. */
export const STORYBOARD_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const

export const DEFAULT_STORYBOARD_ASPECT = '16:9'

/** Anything with takes and a selected one: a transition, or a sequence clip. */
type WithTakes = Pick<StoryboardTransition, 'takes' | 'selectedGenerationId'>

export function selectedTake(t: WithTakes): Generation | undefined {
  const id = t.selectedGenerationId
  return id ? t.takes.find((g) => g.id === id) : undefined
}

/** The selected take, if it is finished and its file is on disk (it can be previewed and exported). */
export function readyTake(t: WithTakes): Generation | undefined {
  const take = selectedTake(t)
  return take?.status === 'completed' && take.filePath && !take.fileMissing ? take : undefined
}

/** The newest take still queued or rendering (takes come newest first). */
export function pendingTake(t: WithTakes): Generation | undefined {
  return t.takes.find(isPending)
}

/** A take that can be played: finished, with its file on disk. */
export function playable(g: Generation): boolean {
  return g.status === 'completed' && !!g.filePath && !g.fileMissing
}

/** Real length when ffprobe measured it, else the requested duration. */
export function takeSeconds(g: Generation): number {
  return g.videoDuration ?? durationSeconds(g.params.duration)
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return !a && !b
  return trimSlash(a) === trimSlash(b)
}

/**
 * The take was made from other pictures than the transition's boards hold now (a board's image was swapped
 * since). Main reports this for the selected take (StoryboardTransition.staleTake); the takes list uses the same
 * rule for the others.
 */
export function madeFromOtherImages(take: Generation, t: Pick<StoryboardTransition, 'params'>): boolean {
  return !samePath(take.params.startImage, t.params.startImage) || !samePath(take.params.endImage, t.params.endImage)
}

/** 1-based number of a board, as the view shows it ("Ruta 2"). */
export function boardNumber(storyboard: Pick<Storyboard, 'boards'>, boardId: string): number {
  return storyboard.boards.findIndex((b) => b.id === boardId) + 1
}

/** The transition from one board to the next, if main has made it (it may lag behind an optimistic move). */
export function transitionBetween(
  storyboard: Pick<Storyboard, 'transitions'>,
  fromBoardId: string,
  toBoardId: string
): StoryboardTransition | undefined {
  return storyboard.transitions.find((t) => t.fromBoardId === fromBoardId && t.toBoardId === toBoardId)
}

/** "2 → 3": the boards a transition goes between, by their numbers now. */
export function transitionRange(
  storyboard: Pick<Storyboard, 'boards'>,
  t: Pick<StoryboardTransition, 'fromBoardId' | 'toBoardId'>
): string {
  const from = boardNumber(storyboard, t.fromBoardId)
  const to = boardNumber(storyboard, t.toBoardId)
  return from && to ? `${from} → ${to}` : '…'
}

/**
 * 1-based number of a transition, as main names it in its messages ("Övergång 2: …"): transition N goes from
 * board N to board N + 1, so it follows the board it starts on (also while a moved board awaits main's answer).
 */
export function transitionNumber(
  storyboard: Pick<Storyboard, 'boards'>,
  t: Pick<StoryboardTransition, 'fromBoardId' | 'position'>
): number {
  return boardNumber(storyboard, t.fromBoardId) || t.position + 1
}

/** "Övergång 2". */
export function transitionLabel(
  storyboard: Pick<Storyboard, 'boards'>,
  t: Pick<StoryboardTransition, 'fromBoardId' | 'position'>
): string {
  return `Övergång ${transitionNumber(storyboard, t)}`
}

/** The transitions in cut order (main keeps positions 0..n-2, but a snapshot is never trusted to be sorted). */
export function orderedTransitions(storyboard: Pick<Storyboard, 'transitions'>): StoryboardTransition[] {
  return [...storyboard.transitions].sort((a, b) => a.position - b.position)
}

/** "Övergång 2", "Övergång 1 och 3", "Övergång 1, 2 och 4". */
export function transitionList(storyboard: Pick<Storyboard, 'boards'>, list: readonly StoryboardTransition[]): string {
  const numbers = list.map((t) => transitionNumber(storyboard, t))
  if (numbers.length <= 1) return `Övergång ${numbers[0] ?? ''}`.trim()
  return `Övergång ${numbers.slice(0, -1).join(', ')} och ${numbers[numbers.length - 1]}`
}

/** The transition a message from main is about ("Övergång 2: …"), if it names one that exists. */
export function transitionInMessage(
  storyboard: Storyboard,
  message: string | undefined
): StoryboardTransition | undefined {
  const n = Number(/^Övergång (\d+)/.exec(message ?? '')?.[1])
  if (!n) return undefined
  return storyboard.transitions.find((t) => transitionNumber(storyboard, t) === n)
}

// ── "Föreslå": a plain prompt template from the two notes ───────────────────

/** A note as a sentence part: whitespace collapsed, trailing full stops dropped (the template adds its own). */
function clause(note: string): string {
  return note.replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').trim()
}

/**
 * "Continuous shot. Start: <note A>. End: <note B>. Smooth, natural motion between them." – no AI, just the two
 * notes in a template the image-to-video models follow well. A missing note leaves its part out; undefined when
 * neither board has a note (there is nothing to suggest from).
 */
export function suggestPrompt(noteA: string | undefined, noteB: string | undefined): string | undefined {
  const a = clause(noteA ?? '')
  const b = clause(noteB ?? '')
  if (!a && !b) return undefined
  const parts = ['Continuous shot.']
  if (a) parts.push(`Start: ${a}.`)
  if (b) parts.push(`End: ${b}.`)
  parts.push('Smooth, natural motion between them.')
  return parts.join(' ')
}

/** A short single-line excerpt of a prompt for the connector cards. */
export function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

// ── What a transition shows ──────────────────────────────────────────────────

export type TransitionStatus =
  /** One of its boards has no picture yet: nothing can be generated. */
  | { kind: 'waiting' }
  /** A take is queued or rendering. */
  | { kind: 'generating'; take: Generation; progress?: number }
  /** The selected take is finished; `stale` when it was made from earlier pictures. */
  | { kind: 'done'; take: Generation; stale: boolean }
  /** The newest take failed and none is in use. */
  | { kind: 'failed'; take: Generation }
  /** Nothing generated yet (or nothing usable selected). */
  | { kind: 'empty' }

export function transitionStatus(t: StoryboardTransition): TransitionStatus {
  const pending = pendingTake(t)
  if (pending) return { kind: 'generating', take: pending, progress: takeProgress(pending) }
  const ready = readyTake(t)
  if (ready) return { kind: 'done', take: ready, stale: !!t.staleTake }
  if (!t.ready) return { kind: 'waiting' }
  const newest = t.takes[0]
  if (newest?.status === 'failed') return { kind: 'failed', take: newest }
  return { kind: 'empty' }
}

/** main's "write what happens" problem, which typing in the editor may have answered before main has the text. */
const PROMPT_PROBLEM = /^Skriv vad som händer/

/**
 * Why the transition can't be generated as it stands (Swedish, without full stops, most important first): main's
 * problems (StoryboardTransition.problems), with the prompt judged by what is typed now (`prompt`, default the
 * saved one). Boards without a picture are named from the boards themselves, in main's words, so they show
 * the same also when main's list is older than the boards.
 */
export function transitionProblems(
  storyboard: Pick<Storyboard, 'boards'>,
  t: StoryboardTransition,
  prompt = t.params.prompt
): string[] {
  const out: string[] = []
  const add = (problem: string) => {
    const text = problem.trim().replace(/\.$/, '')
    if (text && !out.includes(text)) out.push(text)
  }
  if (!t.ready) {
    for (const id of [t.fromBoardId, t.toBoardId]) {
      const n = boardNumber(storyboard, id)
      if (n && !storyboard.boards[n - 1].imagePath) add(`Ruta ${n} saknar bild`)
    }
    if (!out.length) add('Båda rutorna behöver en bild')
  }
  if (!prompt.trim()) add('Skriv vad som händer')
  for (const problem of t.problems) if (!PROMPT_PROBLEM.test(problem)) add(problem)
  return out
}

/** The first reason the transition can't be generated as it stands, or undefined when it can. */
export function generateBlocked(
  storyboard: Pick<Storyboard, 'boards'>,
  t: StoryboardTransition,
  prompt = t.params.prompt
): string | undefined {
  return transitionProblems(storyboard, t, prompt)[0]
}

// ── "Generera saknade" and "Exportera" ───────────────────────────────────────

/** The transition is not part of the cut until its selected take is finished and on disk. Mirrors main. */
export function needsTake(t: StoryboardTransition): boolean {
  return !readyTake(t)
}

export interface RunPlan {
  /** Transitions "Generera saknade" would send now, in cut order. */
  toGenerate: StoryboardTransition[]
  /** Transitions still missing a take that are already rendering one. */
  generating: number
  /** The first of toGenerate that can't be generated, with why (shown instead of starting a run). */
  blocked?: { transitionId: string; message: string }
}

export function runPlan(storyboard: Storyboard): RunPlan {
  const toGenerate: StoryboardTransition[] = []
  let generating = 0
  let blocked: RunPlan['blocked']
  for (const t of orderedTransitions(storyboard)) {
    if (!needsTake(t)) continue
    if (pendingTake(t)) {
      generating++
      continue
    }
    toGenerate.push(t)
    const reason = blocked ? undefined : generateBlocked(storyboard, t)
    if (reason) {
      const sentence = `${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
      blocked = { transitionId: t.id, message: `${transitionLabel(storyboard, t)}: ${sentence}` }
    }
  }
  return { toGenerate, generating, blocked }
}

/**
 * What a new take of the transition would be made from, as one comparable string: its params (with both board
 * pictures, which main keeps in params.startImage / endImage). Compared after Venice's terms were shown, so
 * accepting them can never pay for something other than what the user looked at.
 */
export function transitionKey(t: StoryboardTransition): string {
  const p = t.params
  return JSON.stringify([
    t.id,
    p.model,
    p.prompt,
    p.negativePrompt ?? '',
    p.duration,
    p.resolution ?? '',
    p.aspectRatio ?? '',
    p.audio ?? null,
    p.startImage ?? '',
    p.endImage ?? ''
  ])
}

/** One key per transition "Generera saknade" would pay for (see transitionKey). */
export function runKeys(storyboard: Storyboard): string[] {
  return runPlan(storyboard).toGenerate.map(transitionKey)
}

/** Why the storyboard can't be exported now (Swedish), or undefined. */
export function exportBlocked(storyboard: Storyboard, ffmpegOk: boolean): string | undefined {
  if (!ffmpegOk) return 'ffmpeg saknas – installera med brew install ffmpeg'
  const transitions = orderedTransitions(storyboard)
  if (!transitions.length) return 'Lägg till minst två rutor med bilder och generera klippen mellan dem'
  const missing = transitions.filter((t) => !readyTake(t))
  if (!missing.length) return undefined
  return `${transitionList(storyboard, missing)} saknar ${missing.length === 1 ? 'ett färdigt klipp' : 'färdiga klipp'}`
}

/**
 * Seconds of the exported film: the selected takes back to back, each after the first one frame shorter (it
 * starts on the picture the previous one ended on, which the export shows once). The frame is left out of the
 * estimate; it is too small to show.
 */
export function totalSeconds(storyboard: Storyboard): number {
  return storyboard.transitions.reduce((sum, t) => {
    const take = readyTake(t)
    return sum + (take ? takeSeconds(take) : 0)
  }, 0)
}

// ── Changes to the boards' order that remove transitions ────────────────────

/** The boards' order once a new board is put in, as main places it (StoryboardService.addBoard); `id`: its id. */
export function orderWithNewBoard(
  storyboard: Pick<Storyboard, 'boards'>,
  init: { afterBoardId?: string; beforeBoardId?: string },
  id: string
): string[] {
  const order = storyboard.boards.map((b) => b.id)
  const anchor = init.afterBoardId ?? init.beforeBoardId
  const at = anchor ? order.indexOf(anchor) : -1
  order.splice(at === -1 ? order.length : init.afterBoardId ? at + 1 : at, 0, id)
  return order
}

/**
 * The transitions the boards in this order would lose that have something in them – a prompt or takes. main keeps
 * one transition per two neighbouring boards and removes the rest (syncTransitions); a pair that becomes neighbours
 * again later gets a new, empty one.
 */
export function transitionsLost(
  storyboard: Pick<Storyboard, 'transitions'>,
  order: readonly string[]
): StoryboardTransition[] {
  const pairs = new Set(order.slice(1).map((id, i) => `${order[i]}→${id}`))
  return orderedTransitions(storyboard).filter(
    (t) => !pairs.has(`${t.fromBoardId}→${t.toBoardId}`) && (!!t.params.prompt.trim() || t.takes.length > 0)
  )
}

/** "en prompt och 3 tagningar". */
function workOf(t: StoryboardTransition): string {
  const parts: string[] = []
  if (t.params.prompt.trim()) parts.push('en prompt')
  if (t.takes.length) parts.push(`${t.takes.length} ${t.takes.length === 1 ? 'tagning' : 'tagningar'}`)
  return parts.join(' och ')
}

/** What the user is asked before a change that loses these transitions (see transitionsLost). */
export function lostTransitionsText(storyboard: Pick<Storyboard, 'boards'>, lost: readonly StoryboardTransition[]): string {
  const items = lost.map((t) => `${transitionLabel(storyboard, t).toLowerCase()} (${workOf(t)})`)
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
  const one = lost.length === 1
  const prompts = lost.filter((t) => t.params.prompt.trim()).length
  const sentences = [
    `${list.charAt(0).toUpperCase()}${list.slice(1)} tas bort: ${one ? 'dess' : 'deras'} rutor ligger inte längre bredvid varandra.`,
    `${prompts ? `${prompts === 1 ? 'Prompten' : 'Prompterna'} försvinner, och de` : 'De'} nya övergångarna börjar tomma – också om rutorna sedan läggs tillbaka som de var.`
  ]
  const takes = lost.reduce((n, t) => n + t.takes.length, 0)
  if (takes) {
    sentences.push(
      `${takes === 1 ? 'Tagningen' : 'Tagningarna'} finns kvar i Mediabanken, men hör inte längre till storyboarden.`
    )
  }
  return sentences.join(' ')
}

// ── Local copies of main's changes ───────────────────────────────────────────

/** The board moved locally the way main moves it; transitions follow when main's answer arrives. */
export function moveBoardLocally(storyboard: Storyboard, boardId: string, toIndex: number): Storyboard {
  const boards = storyboard.boards.slice()
  const from = boards.findIndex((b) => b.id === boardId)
  if (from === -1) return storyboard
  const [moved] = boards.splice(from, 1)
  boards.splice(Math.max(0, Math.min(toIndex, boards.length)), 0, moved)
  return { ...storyboard, boards: boards.map((b, i) => ({ ...b, position: i })) }
}

/** A board's note changed locally (the note field saves it). */
export function patchBoardLocally(
  storyboard: Storyboard,
  boardId: string,
  patch: Partial<StoryboardBoard>
): Storyboard {
  return { ...storyboard, boards: storyboard.boards.map((b) => (b.id === boardId ? { ...b, ...patch } : b)) }
}

export function patchTransitionLocally(
  storyboard: Storyboard,
  transitionId: string,
  patch: Partial<Pick<StoryboardTransition, 'selectedGenerationId' | 'takes'>>
): Storyboard {
  return {
    ...storyboard,
    transitions: storyboard.transitions.map((t) => (t.id === transitionId ? { ...t, ...patch } : t))
  }
}

/** The take gone from every transition (deleted), and no longer selected anywhere. */
export function withoutTake(storyboard: Storyboard, takeId: string): Storyboard {
  return {
    ...storyboard,
    transitions: storyboard.transitions.map((t) =>
      t.takes.some((g) => g.id === takeId) || t.selectedGenerationId === takeId
        ? {
            ...t,
            takes: t.takes.filter((g) => g.id !== takeId),
            selectedGenerationId: t.selectedGenerationId === takeId ? undefined : t.selectedGenerationId
          }
        : t
    )
  }
}

/**
 * Merges a live generation update into the transition that shows it (or owns it: a take of a transition is a
 * generation whose segmentId is the transition's id). The same storyboard object when nothing changed, so
 * updates for other storyboards (or the Generate feed) re-render nothing.
 */
export function applyGenerationUpdate(storyboard: Storyboard, g: Generation): Storyboard {
  let changed = false
  const transitions = storyboard.transitions.map((t) => {
    const i = t.takes.findIndex((take) => take.id === g.id)
    if (i !== -1) {
      const fresh = freshestTake(t.takes[i], g)
      if (fresh === t.takes[i]) return t
      changed = true
      const takes = t.takes.slice()
      takes[i] = fresh
      return { ...t, takes }
    }
    if (g.segmentId === t.id) {
      changed = true
      return { ...t, takes: [g, ...t.takes] }
    }
    return t
  })
  return changed ? { ...storyboard, transitions } : storyboard
}

/**
 * The storyboard as a sequence of its transitions, for the shared preview player: one clip per transition in cut
 * order, untrimmed (the export's one-frame overlap is too short to matter in a preview).
 */
export function asPreviewSequence(storyboard: Storyboard): Sequence {
  return {
    id: storyboard.id,
    name: storyboard.name,
    defaults: {},
    running: storyboard.running,
    createdAt: storyboard.createdAt,
    updatedAt: storyboard.updatedAt,
    segments: orderedTransitions(storyboard).map((t, i) => ({
      id: t.id,
      sequenceId: storyboard.id,
      position: i,
      params: t.params,
      continueFromPrevious: false,
      // Transitions go from one board's picture to the next one's (image-to-video with both); they never continue.
      continueMode: 'exact',
      endFromNext: false,
      notes: '',
      selectedGenerationId: t.selectedGenerationId,
      trimStart: 0,
      trimEnd: 0,
      takes: t.takes,
      createdAt: storyboard.createdAt
    }))
  }
}

// ── Sizes and wording ────────────────────────────────────────────────────────

/** Width over height from "16:9"; 16:9 when missing or unreadable. */
export function aspectValue(aspect: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '')
  const w = m ? Number(m[1]) : 16
  const h = m ? Number(m[2]) : 9
  return w > 0 && h > 0 ? w / h : 16 / 9
}

/** A picture box of the aspect ratio fitted inside maxWidth × maxHeight, in whole pixels. */
export function fitBox(
  aspect: string | undefined,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const ratio = aspectValue(aspect)
  const width = Math.max(1, Math.min(maxWidth, maxHeight * ratio))
  return { width: Math.round(width), height: Math.round(width / ratio) }
}

/** "16:9 – liggande", "9:16 – stående", "1:1 – kvadrat". */
export function aspectLabel(aspect: string): string {
  const ratio = aspectValue(aspect)
  const shape = Math.abs(ratio - 1) < 0.01 ? 'kvadrat' : ratio > 1 ? (ratio > 2 ? 'bred' : 'liggande') : 'stående'
  return `${aspect} – ${shape}`
}

/** "5 s" from "5s". */
export function durationLabel(duration: string): string {
  return /^\d+(\.\d+)?s$/.test(duration) ? `${duration.slice(0, -1)} s` : duration
}

/** "3 rutor", "1 ruta". */
export function boardCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'ruta' : 'rutor'}`
}
