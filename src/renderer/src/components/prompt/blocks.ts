// What the building-block menu offers in a prompt field: the ready-made phrases for the field's kind, the
// prompts saved in Prompter and the learnings, filtered by what the user typed after "/" (or in the search box).

import { useEffect, useState } from 'react'
import { promptBlockGroups, type PromptBlockContext } from '@shared/prompt-blocks'
import type { Learning, SavedPrompt } from '@shared/types'

export interface BlockItem {
  key: string
  /** Swedish: what the user sees. */
  label: string
  /** What goes into the field. */
  text: string
  /** A second line: the English phrase, or the start of a saved prompt. */
  detail?: string
}

export interface BlockSection {
  /** A block group's id, or 'prompts' / 'learnings'. */
  key: string
  title: string
  items: BlockItem[]
}

/** How many saved prompts and learnings show without a search; a search shows every match. */
const LIBRARY_PREVIEW = 6

/** Lower-cased, accents kept apart from base letters, so "närbild" is found by "narbild" too. */
function fold(text: string): string {
  return text.toLocaleLowerCase('sv').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true
  const words = fold(query).split(/\s+/).filter(Boolean)
  const hay = fold(fields.filter(Boolean).join(' '))
  return words.every((w) => hay.includes(w))
}

function excerpt(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export interface BlockSources {
  context: PromptBlockContext
  query: string
  /** Only this group (a chip under the field was clicked). */
  group?: string
  prompts?: readonly SavedPrompt[]
  learnings?: readonly Learning[]
}

/** The menu's sections, in order: the block groups, then Mina prompter and Lärdomar for visual prompts. */
export function blockSections({ context, query, group, prompts = [], learnings = [] }: BlockSources): BlockSection[] {
  const q = query.trim()
  const named: BlockSection[] = []
  const sections: BlockSection[] = []
  for (const g of promptBlockGroups(context)) {
    if (group && group !== g.id) continue
    // A search also finds a group by its name ("/kamera" shows all camera blocks) – and those groups come first.
    const whole = !!q && matches(q, g.label)
    const items = g.blocks
      .filter((b) => whole || matches(q, b.label, b.text))
      .map((b, i) => ({ key: `${g.id}:${i}`, label: b.label, text: b.text, detail: b.text }))
    if (items.length) (whole ? named : sections).push({ key: g.id, title: g.label, items })
  }
  sections.unshift(...named)
  const visual = context === 'video' || context === 'image'
  if (visual && (!group || group === 'prompts')) {
    const found = prompts
      .filter((p) => p.body.trim() && matches(q, p.title, p.body, p.tags.join(' ')))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    const items = (q || group ? found : found.slice(0, LIBRARY_PREVIEW)).map((p) => ({
      key: `prompt:${p.id}`,
      label: p.title || excerpt(p.body, 40),
      text: p.body,
      detail: excerpt(p.body)
    }))
    if (items.length) sections.push({ key: 'prompts', title: 'Mina prompter', items })
  }
  if (visual && (!group || group === 'learnings')) {
    const found = learnings
      .filter((l) => l.insight.trim() && matches(q, l.title, l.insight, l.tags.join(' ')))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    const items = (q || group ? found : found.slice(0, LIBRARY_PREVIEW)).map((l) => ({
      key: `learning:${l.id}`,
      label: l.title,
      text: l.insight,
      detail: excerpt(l.insight)
    }))
    if (items.length) sections.push({ key: 'learnings', title: 'Lärdomar', items })
  }
  return sections
}

/** The chips under a field: its block groups, then Mina prompter / Lärdomar when there are any. */
export function blockChips(
  context: PromptBlockContext,
  hasPrompts: boolean,
  hasLearnings: boolean
): { id: string; label: string }[] {
  const chips = promptBlockGroups(context).map((g) => ({ id: g.id, label: g.label }))
  const visual = context === 'video' || context === 'image'
  if (visual && hasPrompts) chips.push({ id: 'prompts', label: 'Mina prompter' })
  if (visual && hasLearnings) chips.push({ id: 'learnings', label: 'Lärdomar' })
  return chips
}

/** The learnings, read once per field when its menu first needs them (they change rarely while writing). */
export function useLearnings(wanted: boolean): Learning[] {
  const [learnings, setLearnings] = useState<Learning[]>([])
  useEffect(() => {
    if (!wanted) return
    let live = true
    window.studio.listLearnings().then(
      (list) => live && setLearnings(list),
      () => {}
    )
    return () => {
      live = false
    }
  }, [wanted])
  return learnings
}

/**
 * The "/word" being typed at the caret: a "/" at the start of the text or after whitespace, followed by letters
 * (no spaces). Undefined anywhere else, so "1/2" or a URL never opens the menu.
 */
export function slashQueryAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const m = /(^|\s)\/([\p{L}\p{N}-]{0,30})$/u.exec(before)
  if (!m) return undefined
  return { start: caret - m[2].length - 1, query: m[2] }
}

/**
 * Where a block goes and what goes in: [start, end) of the text replaced (the "/word", or the selection) and the
 * inserted text. A phrase after a word is joined with ", " (a space just typed after that word is taken in), one
 * after a full stop or at the start of a line starts with a capital, and a multi-line template starts on its own line.
 */
export function blockInsertion(
  value: string,
  start: number,
  end: number,
  text: string
): { start: number; end: number; text: string } {
  // "the beach |" → "the beach, slow dolly in": the space before the caret becomes part of the separator.
  if (value[start - 1] === ' ' && /[\p{L}\p{N})"'”]/u.test(value[start - 2] ?? '')) start -= 1
  const before = value.slice(0, start)
  const after = value.slice(end)
  const sentenceStart = !before.trim() || /[.!?]\s*$/.test(before) || /\n\s*$/.test(before)
  let block = sentenceStart ? text.charAt(0).toLocaleUpperCase('en') + text.slice(1) : text
  let lead = ''
  if (before && !/[\s([{"]$/.test(before)) lead = /[.!?]$/.test(before) ? ' ' : ', '
  if (block.includes('\n') && before && !before.endsWith('\n')) {
    block = `\n${block}`
    lead = ''
  }
  const trail = after && !/^[\s,.;:!?)\]]/.test(after) ? ' ' : ''
  return { start, end, text: lead + block + trail }
}
