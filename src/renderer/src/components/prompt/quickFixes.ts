// The problems listed under the prompt editor, each with the fixes that are obvious enough to offer as a
// button. Errors come from the shared rules in prompt-refs (the same ones the main process enforces before
// anything is sent to Venice); the "not mentioned" warning is built here so it can name the assets.

import type { Kind } from '@shared/models'
import { findImageTokens, findMalformedTokens, type PromptIssue } from '@shared/prompt-refs'
import type { Asset, PromptLanguage } from '@shared/types'
import { promptList } from '../pickers/text'
import {
  allTokenRanges,
  groupInsertText,
  groupText,
  unusedReferences,
  type AssetGroup,
  type PromptReference,
  type TextEdit,
  type TextRange
} from './promptText'

export type FixAction =
  /** Replace stretches of the prompt. */
  | { type: 'edit'; edits: TextEdit[] }
  /** Remove tokens, tidying brackets and spaces. */
  | { type: 'remove'; ranges: TextRange[] }
  /** Open the "@" menu over a token to pick the picture it should name. */
  | { type: 'choose'; range: TextRange }
  /** Insert text at the caret. */
  | { type: 'insert'; text: string }
  /** Add a library asset to the references and name it in place of `range`. */
  | { type: 'add-asset'; asset: Asset; range: TextRange }
  | { type: 'switch-to-reference' }
  | { type: 'add-references' }

export interface QuickFix {
  label: string
  title?: string
  action: FixAction
}

export interface IssueView {
  key: string
  severity: 'error' | 'warning'
  message: string
  /** A second, quieter line. */
  detail?: string
  /** Where in the prompt; clicking the message selects the first one. */
  ranges: TextRange[]
  fixes: QuickFix[]
}

interface Options {
  prompt: string
  /** From validatePromptReferences (or validateNegativePrompt), for this text. */
  issues: readonly PromptIssue[]
  references: readonly PromptReference[]
  groups: readonly AssetGroup[]
  kind: Kind
  language: PromptLanguage
  /** The form offers reference mode (not a continuation clip). */
  canSwitchToReference: boolean
  /** The form can open the reference picker. */
  canAddReferences: boolean
  /** Library assets that "@Name" may have meant; omit when assets can't be added from here. */
  library?: readonly Asset[]
  /** List the reference images the text never mentions (the main prompt; not the negative one). */
  adviseUnused: boolean
}

const MAX_INSERT_FIXES = 3

const lower = (s: string): string => s.trim().toLocaleLowerCase('sv')

/** The asset "@Name" most likely meant: same name, else the only one whose first word it is. */
function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const wanted = lower(name)
  if (!wanted) return undefined
  const exact = items.find((i) => lower(i.name) === wanted)
  if (exact) return exact
  const first = items.filter((i) => lower(i.name).split(/\s+/)[0] === wanted)
  return first.length === 1 ? first[0] : undefined
}

export function issueViews(o: Options): IssueView[] {
  const { prompt, references } = o
  const views: IssueView[] = []
  const hasReferenceAttempts = findImageTokens(prompt).length > 0 || findMalformedTokens(prompt).length > 0

  // Errors with the same wording (the same wrong token written twice) are listed once and fixed together.
  const grouped = new Map<string, { issue: PromptIssue; ranges: TextRange[] }>()
  for (const issue of o.issues) {
    if (issue.severity !== 'error') continue
    // "Add a reference image" is already what the generate button says; here only when the text names some.
    if (issue.code === 'no-references' && !hasReferenceAttempts) continue
    const key = `${issue.code}:${issue.message}`
    const entry = grouped.get(key) ?? { issue, ranges: [] }
    if (issue.start !== undefined && issue.end !== undefined && issue.end > issue.start) {
      entry.ranges.push({ start: issue.start, end: issue.end })
    }
    grouped.set(key, entry)
  }

  const sentUnused = unusedReferences(prompt, references)
  const canChoose = o.kind === 'reference-to-video' && references.some((r) => r.sent)
  const malformed = new Map(findMalformedTokens(prompt).map((m) => [m.start, m]))

  for (const [key, { issue, ranges }] of grouped) {
    const fixes: QuickFix[] = []
    const written = ranges.length ? prompt.slice(ranges[0].start, ranges[0].end) : ''
    const remove = (label: string): void => {
      if (ranges.length) fixes.push({ label, action: { type: 'remove', ranges } })
    }
    switch (issue.code) {
      case 'malformed': {
        const suggestions = ranges.map((r) => malformed.get(r.start)?.suggestion)
        if (ranges.length && suggestions.every((s): s is string => !!s)) {
          const same = suggestions.every((s) => s === suggestions[0])
          fixes.push({
            label: same ? `Byt till ${suggestions[0]}` : 'Rätta stavningen',
            action: { type: 'edit', edits: ranges.map((r, i) => ({ ...r, text: suggestions[i] })) }
          })
        } else if (ranges.length === 1 && canChoose) {
          fixes.push({ label: 'Välj bild…', action: { type: 'choose', range: ranges[0] } })
        }
        remove('Ta bort')
        break
      }
      case 'out-of-range':
      case 'over-model-limit': {
        // One picture that the prompt doesn't mention yet is the obvious candidate for a wrong number.
        if (issue.code === 'out-of-range' && sentUnused.length === 1 && ranges.length) {
          const target = sentUnused[0]
          fixes.push({
            label: `Byt till @Image${target.index}`,
            title: target.asset ? `${target.asset.name}, foto ${target.photo ?? 1}` : 'Den egna bilden',
            action: { type: 'edit', edits: ranges.map((r) => ({ ...r, text: `@Image${target.index}` })) }
          })
        }
        if (ranges.length === 1 && canChoose) {
          fixes.push({ label: 'Välj bild…', action: { type: 'choose', range: ranges[0] } })
        }
        remove(written ? `Ta bort ${written}` : 'Ta bort')
        break
      }
      case 'not-reference-mode': {
        if (o.canSwitchToReference) {
          fixes.push({ label: 'Byt till läget Referens', action: { type: 'switch-to-reference' } })
        }
        const all = allTokenRanges(prompt)
        if (all.length) fixes.push({ label: 'Ta bort hänvisningarna', action: { type: 'remove', ranges: all } })
        break
      }
      case 'no-references': {
        if (o.canAddReferences) fixes.push({ label: 'Lägg till bilder', action: { type: 'add-references' } })
        const all = allTokenRanges(prompt)
        if (all.length) fixes.push({ label: 'Ta bort hänvisningarna', action: { type: 'remove', ranges: all } })
        break
      }
      default:
        remove(written ? `Ta bort ${written}` : 'Ta bort')
    }
    views.push({ key, severity: 'error', message: issue.message, ranges, fixes })
  }
  views.sort((a, b) => (a.ranges[0]?.start ?? -1) - (b.ranges[0]?.start ?? -1))

  // Pictures that are sent but never mentioned still steer the result, without the model knowing what they
  // are for. Listed per asset, so a whole character reads as one item.
  if (o.adviseUnused && o.kind === 'reference-to-video' && prompt.trim() && sentUnused.length) {
    views.push(unusedView(sentUnused, o))
  }

  // Other advice from the shared rules: "@Anna" that is plain text rather than a reference, pictures past
  // the model's limit. (The "not mentioned" advice is replaced by the one above.)
  for (const issue of o.issues) {
    if (issue.severity !== 'warning' || issue.code === 'unused-reference') continue
    const ranges =
      issue.start !== undefined && issue.end !== undefined && issue.end > issue.start
        ? [{ start: issue.start, end: issue.end }]
        : []
    views.push({
      key: `${issue.code}:${issue.message}:${ranges[0]?.start ?? ''}`,
      severity: 'warning',
      message: issue.message,
      ranges,
      fixes: ranges.length && issue.code === 'malformed' ? mentionFixes(ranges[0], o) : []
    })
  }
  return views
}

/**
 * "@Anna" → "Anna (@Image1, @Image2)" when Anna is among the references, or add Anna from the library. Only
 * in reference mode: other modes send no reference images (they may still sit in the form, unsent), so the
 * fix would write tokens that block generating.
 */
function mentionFixes(range: TextRange, o: Options): QuickFix[] {
  if (o.kind !== 'reference-to-video') return []
  const name = o.prompt.slice(range.start, range.end).replace(/^[@\uFF20]+/, '')
  const group = findByName(o.groups, name)
  if (group) {
    const text = groupInsertText(group, o.language, o.prompt.slice(0, range.start))
    return [
      {
        label: `Hänvisa till ${group.name}`,
        title: `Byt till ”${text}”`,
        action: { type: 'edit', edits: [{ ...range, text }] }
      }
    ]
  }
  const asset = o.library && findByName(o.library.filter((a) => a.images.length), name)
  if (asset) {
    return [
      {
        label: `Lägg till ${asset.name} som referens`,
        title: `Lägger till bilderna och skriver ”${asset.name} (@Image…)” i stället`,
        action: { type: 'add-asset', asset, range }
      }
    ]
  }
  return []
}

function unusedView(sentUnused: PromptReference[], o: Options): IssueView {
  const unused = new Set(sentUnused.map((r) => r.index))
  const names: string[] = []
  const fixes: QuickFix[] = []
  const covered = new Set<number>()
  // Characters first: their reference brings their clothes along.
  const ordered = [...o.groups].sort(
    (a, b) => Number(a.asset.kind !== 'character') - Number(b.asset.kind !== 'character')
  )
  for (const group of ordered) {
    const missing = group.indices.filter((i) => unused.has(i))
    if (!missing.length) continue
    if (missing.length === group.indices.length) {
      names.push(groupText({ name: group.name, indices: group.indices }, 'sv'))
      if (group.indices.every((i) => covered.has(i))) continue
      const text = groupText(group, o.language)
      fixes.push({ label: `Infoga ${group.name}`, title: `Infoga ”${text}” vid markören`, action: { type: 'insert', text } })
      for (const i of [...group.indices, ...(group.outfits ?? []).flatMap((w) => w.indices)]) {
        if (unused.has(i)) covered.add(i)
      }
    } else {
      for (const i of missing) {
        names.push(`@Image${i} (${group.name})`)
        if (covered.has(i)) continue
        fixes.push({ label: `Infoga @Image${i}`, action: { type: 'insert', text: `@Image${i}` } })
        covered.add(i)
      }
    }
  }
  for (const r of sentUnused) {
    if (r.asset) continue
    names.push(`@Image${r.index} (egen bild)`)
    fixes.push({ label: `Infoga @Image${r.index}`, action: { type: 'insert', text: `@Image${r.index}` } })
  }
  return {
    key: 'unused',
    severity: 'warning',
    message:
      names.length === 1 ? `${names[0]} nämns inte i prompten.` : `Nämns inte i prompten: ${promptList(names, 'sv')}.`,
    detail:
      sentUnused.length === 1
        ? 'Bilden skickas ändå – nämn den så att modellen vet vad den är till för, eller ta bort den.'
        : 'Bilderna skickas ändå – nämn dem så att modellen vet vad de är till för, eller ta bort dem.',
    ranges: [],
    fixes: fixes.slice(0, MAX_INSERT_FIXES)
  }
}
