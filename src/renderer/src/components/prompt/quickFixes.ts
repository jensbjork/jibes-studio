// The problems listed under the prompt editor, each with the fixes that are obvious enough to offer as a
// button. Errors come from the shared rules in prompt-refs (the same ones the main process enforces before
// anything is sent to Venice); the "not mentioned" warning is built here so it can name the assets.

import type { Kind } from '@shared/models'
import {
  findAudioTokens,
  findImageTokens,
  findMalformedTokens,
  type PromptIssue,
  type ReferenceKind,
  type ValidateOptions
} from '@shared/prompt-refs'
import type { Asset, PromptLanguage } from '@shared/types'
import { audioInsertText, possessive, type FormAudio } from '../pickers/audioRefs'
import { audioWord, promptList } from '../pickers/text'
import {
  allTokenRanges,
  audioIntoReference,
  audioTokenRanges,
  groupInsertText,
  groupText,
  unusedAudios,
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
  /** Open the "@" menu over a token to pick the picture (or clip) it should name. */
  | { type: 'choose'; range: TextRange; ref?: ReferenceKind }
  /** Insert text at the caret. */
  | { type: 'insert'; text: string }
  /** Add a library asset to the references and name it in place of `range`. */
  | { type: 'add-asset'; asset: Asset; range: TextRange }
  | { type: 'switch-to-reference' }
  | { type: 'add-references' }
  /** Take these audio clips (1-based @AudioN numbers) out of the form; their tokens follow. */
  | { type: 'remove-audio'; indices: number[] }
  /** Switch to a reference model that takes audio. */
  | { type: 'use-audio-model' }

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
  /** The form's reference audio as @AudioN references. */
  audios?: readonly FormAudio[]
  groups: readonly AssetGroup[]
  kind: Kind
  language: PromptLanguage
  /** The form offers reference mode (not a continuation clip). */
  canSwitchToReference: boolean
  /** The form can open the reference picker. */
  canAddReferences: boolean
  /** The form can take audio clips out (fixes for clips that are too long, or not sent). */
  canRemoveAudio?: boolean
  /** A reference model that takes audio, offered when the current one doesn't ("Switch to Seedance 2.5 …"). */
  audioModelName?: string
  /** Library assets that "@Name" may have meant; omit when assets can't be added from here. */
  library?: readonly Asset[]
  /** List the pictures and clips the text never mentions (the main prompt; not the negative one). */
  adviseUnused: boolean
  /**
   * The @ImageN / @AudioN numbers the References legend explains (ValidateOptions.explained): left out of that list,
   * since the model is told what they are.
   */
  explained?: ValidateOptions['explained']
}

const MAX_INSERT_FIXES = 3

const lower = (s: string): string => s.trim().toLocaleLowerCase('en')

/** The asset "@Name" most likely meant: same name, else the only one whose first word it is. */
function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const wanted = lower(name)
  if (!wanted) return undefined
  const exact = items.find((i) => lower(i.name) === wanted)
  if (exact) return exact
  const first = items.filter((i) => lower(i.name).split(/\s+/)[0] === wanted)
  return first.length === 1 ? first[0] : undefined
}

/** The @AudioN numbers a message names ("@Audio2 is 18 s – …"). */
function audioNumbersIn(message: string): number[] {
  return [...new Set([...message.matchAll(/@Audio(\d+)/g)].map((m) => Number(m[1])))]
}

export function issueViews(o: Options): IssueView[] {
  const { prompt, references } = o
  const audios = o.audios ?? []
  const views: IssueView[] = []
  const hasReferenceAttempts =
    findImageTokens(prompt).length > 0 || findAudioTokens(prompt).length > 0 || findMalformedTokens(prompt).length > 0

  // Errors with the same wording (the same wrong token written twice) are listed once and fixed together.
  const grouped = new Map<string, { issue: PromptIssue; ranges: TextRange[] }>()
  for (const issue of o.issues) {
    if (issue.severity !== 'error') continue
    // "Add a reference image" is already what the generate button says; here only when the text names some,
    // or when audio is all there is (it explains why the clips need a picture).
    if (issue.code === 'no-references' && !hasReferenceAttempts && issue.ref !== 'audio') continue
    const key = `${issue.code}:${issue.message}`
    const entry = grouped.get(key) ?? { issue, ranges: [] }
    if (issue.start !== undefined && issue.end !== undefined && issue.end > issue.start) {
      entry.ranges.push({ start: issue.start, end: issue.end })
    }
    grouped.set(key, entry)
  }

  const sentUnused = unusedReferences(prompt, references)
  const audioUnused = unusedAudios(prompt, audios)
  const canChoose = o.kind === 'reference-to-video' && references.some((r) => r.sent)
  const canChooseAudio = o.kind === 'reference-to-video' && audios.some((a) => a.sent)
  const malformed = new Map(findMalformedTokens(prompt).map((m) => [m.start, m]))
  const allAudio = audios.map((a) => a.index)

  for (const [key, { issue, ranges }] of grouped) {
    const fixes: QuickFix[] = []
    let detail: string | undefined
    const written = ranges.length ? prompt.slice(ranges[0].start, ranges[0].end) : ''
    const remove = (label: string): void => {
      if (ranges.length) fixes.push({ label, action: { type: 'remove', ranges } })
    }
    switch (issue.code) {
      case 'malformed': {
        const suggestions = ranges.map((r) => malformed.get(r.start)?.suggestion)
        const audio = issue.ref === 'audio'
        if (ranges.length && suggestions.every((s): s is string => !!s)) {
          const same = suggestions.every((s) => s === suggestions[0])
          fixes.push({
            label: same ? `Change to ${suggestions[0]}` : 'Fix the spelling',
            action: { type: 'edit', edits: ranges.map((r, i) => ({ ...r, text: suggestions[i] })) }
          })
        } else if (ranges.length === 1 && (audio ? canChooseAudio : canChoose)) {
          fixes.push({
            label: audio ? 'Choose a sound…' : 'Choose an image…',
            action: { type: 'choose', range: ranges[0], ref: audio ? 'audio' : 'image' }
          })
        }
        remove('Remove')
        break
      }
      case 'out-of-range':
      case 'over-model-limit': {
        // One picture that the prompt doesn't mention yet is the obvious candidate for a wrong number.
        if (issue.code === 'out-of-range' && sentUnused.length === 1 && ranges.length) {
          const target = sentUnused[0]
          fixes.push({
            label: `Change to @Image${target.index}`,
            title: target.asset ? `${target.asset.name}, photo ${target.photo ?? 1}` : 'Your own image',
            action: { type: 'edit', edits: ranges.map((r) => ({ ...r, text: `@Image${target.index}` })) }
          })
        }
        if (ranges.length === 1 && canChoose) {
          fixes.push({ label: 'Choose an image…', action: { type: 'choose', range: ranges[0], ref: 'image' } })
        }
        remove(written ? `Remove ${written}` : 'Remove')
        break
      }
      case 'audio-out-of-range':
      case 'audio-over-limit': {
        // The same for clips: the one clip the prompt doesn't mention yet is the likely meaning.
        if (issue.code === 'audio-out-of-range' && audioUnused.length === 1 && ranges.length) {
          const target = audioUnused[0]
          fixes.push({
            label: `Change to @Audio${target.index}`,
            title: target.source ? `${possessive(target.source.asset.name, 'en')} sound clip` : 'Your own sound',
            action: { type: 'edit', edits: ranges.map((r) => ({ ...r, text: `@Audio${target.index}` })) }
          })
        }
        if (ranges.length === 1 && canChooseAudio) {
          fixes.push({ label: 'Choose a sound…', action: { type: 'choose', range: ranges[0], ref: 'audio' } })
        }
        remove(written ? `Remove ${written}` : 'Remove')
        break
      }
      case 'not-reference-mode': {
        if (o.canSwitchToReference) {
          fixes.push({ label: 'Switch to the References mode', action: { type: 'switch-to-reference' } })
        }
        const all = allTokenRanges(prompt)
        if (all.length) fixes.push({ label: 'Remove the references', action: { type: 'remove', ranges: all } })
        break
      }
      case 'audio-not-supported': {
        if (o.kind !== 'reference-to-video') {
          if (o.canSwitchToReference) {
            fixes.push({ label: 'Switch to the References mode', action: { type: 'switch-to-reference' } })
          }
        } else if (o.audioModelName) {
          fixes.push({ label: `Switch to ${o.audioModelName}`, action: { type: 'use-audio-model' } })
        }
        const all = audioTokenRanges(prompt)
        if (all.length) fixes.push({ label: 'Remove the sound references', action: { type: 'remove', ranges: all } })
        break
      }
      case 'no-references': {
        if (o.canAddReferences) fixes.push({ label: 'Add images', action: { type: 'add-references' } })
        const all = allTokenRanges(prompt)
        if (all.length) fixes.push({ label: 'Remove the references', action: { type: 'remove', ranges: all } })
        break
      }
      case 'audio-length': {
        // About a clip's window, not about the text: shorten it in the library, or leave the clip out.
        detail = 'The excerpt is chosen where the sound clip was saved (Voice or Soundscape in the library).'
        const numbers = audioNumbersIn(issue.message).filter((n) => allAudio.includes(n))
        if (o.canRemoveAudio && numbers.length) {
          fixes.push({
            label: `Remove ${numbers.map((n) => `@Audio${n}`).join(', ')}`,
            title: 'Removes the sound clip from the form',
            action: { type: 'remove-audio', indices: numbers }
          })
        }
        break
      }
      case 'audio-too-long': {
        detail = 'Shorten the excerpts in the library, or send fewer sound clips.'
        const lastSent = [...audios].reverse().find((a) => a.sent)
        if (o.canRemoveAudio && lastSent) {
          fixes.push({
            label: `Remove @Audio${lastSent.index}`,
            title: 'Removes the last sound clip from the form',
            action: { type: 'remove-audio', indices: [lastSent.index] }
          })
        }
        break
      }
      default:
        remove(written ? `Remove ${written}` : 'Remove')
    }
    views.push({ key, severity: 'error', message: issue.message, ...(detail ? { detail } : {}), ranges, fixes })
  }
  views.sort((a, b) => (a.ranges[0]?.start ?? -1) - (b.ranges[0]?.start ?? -1))

  // Pictures and clips that are sent but never mentioned still steer the result, without the model knowing what
  // they are for – unless the References legend says it. Listed per asset, so a whole character (with its voice)
  // reads as one item.
  const explainedImages = new Set(o.explained?.images ?? [])
  const explainedAudios = new Set(o.explained?.audios ?? [])
  const unexplained = sentUnused.filter((r) => !explainedImages.has(r.index))
  const audioUnexplained = audioUnused.filter((a) => !explainedAudios.has(a.index))
  if (
    o.adviseUnused &&
    o.kind === 'reference-to-video' &&
    prompt.trim() &&
    (unexplained.length || audioUnexplained.length)
  ) {
    views.push(unusedView(unexplained, audioUnexplained, o))
  }

  // Other advice from the shared rules: "@Anna" that is plain text rather than a reference, pictures or clips
  // past the model's limit, clips this model doesn't take. (The "not mentioned" advice is replaced by the one above.)
  for (const issue of o.issues) {
    if (issue.severity !== 'warning' || issue.code === 'unused-reference' || issue.code === 'unused-audio') continue
    const ranges =
      issue.start !== undefined && issue.end !== undefined && issue.end > issue.start
        ? [{ start: issue.start, end: issue.end }]
        : []
    const fixes: QuickFix[] =
      ranges.length && issue.code === 'malformed'
        ? mentionFixes(ranges[0], issue.ref === 'audio', o)
        : issue.code === 'audio-not-supported'
          ? [
              ...(o.audioModelName && o.kind === 'reference-to-video'
                ? [{ label: `Switch to ${o.audioModelName}`, action: { type: 'use-audio-model' } } as QuickFix]
                : []),
              ...(o.canRemoveAudio && allAudio.length
                ? [{ label: 'Remove the sound', action: { type: 'remove-audio', indices: allAudio } } as QuickFix]
                : [])
            ]
          : []
    views.push({
      key: `${issue.code}:${issue.message}:${ranges[0]?.start ?? ''}`,
      severity: 'warning',
      message: issue.message,
      ranges,
      fixes
    })
  }
  return views
}

/**
 * "@Anna" → "Anna (@Image1, @Image2)" when Anna is among the references, or add Anna from the library; "@Voice"
 * → the clip it most likely meant. Only in reference mode: other modes send no references (they may still sit in
 * the form, unsent), so the fix would write tokens that block generating.
 */
function mentionFixes(range: TextRange, audio: boolean, o: Options): QuickFix[] {
  if (o.kind !== 'reference-to-video') return []
  if (audio) {
    const sent = (o.audios ?? []).filter((a) => a.sent)
    if (sent.length === 1) {
      return [
        {
          label: `Change to @Audio${sent[0].index}`,
          action: { type: 'edit', edits: [{ ...range, text: `@Audio${sent[0].index}` }] }
        }
      ]
    }
    return sent.length ? [{ label: 'Choose a sound…', action: { type: 'choose', range, ref: 'audio' } }] : []
  }
  const name = o.prompt.slice(range.start, range.end).replace(/^[@＠]+/, '')
  const group = findByName(o.groups, name)
  if (group) {
    const text = groupInsertText(group, o.language, o.prompt.slice(0, range.start))
    return [
      {
        label: `Refer to ${group.name}`,
        title: `Change to “${text}”`,
        action: { type: 'edit', edits: [{ ...range, text }] }
      }
    ]
  }
  const asset = o.library && findByName(o.library.filter((a) => a.images.length), name)
  if (asset) {
    return [
      {
        label: `Add ${asset.name} as a reference`,
        title: `Adds the images and writes “${asset.name} (@Image…)” instead`,
        action: { type: 'add-asset', asset, range }
      }
    ]
  }
  return []
}

function unusedView(sentUnused: PromptReference[], audioUnused: FormAudio[], o: Options): IssueView {
  const unused = new Set(sentUnused.map((r) => r.index))
  const unusedAudio = new Set(audioUnused.map((a) => a.index))
  const names: string[] = []
  const fixes: QuickFix[] = []
  const covered = new Set<number>()
  const coveredAudio = new Set<number>()
  // Characters first: their reference brings their voice and clothes along.
  const ordered = [...o.groups].sort(
    (a, b) => Number(a.asset.kind !== 'character') - Number(b.asset.kind !== 'character')
  )
  for (const group of ordered) {
    const missing = group.indices.filter((i) => unused.has(i))
    const missingAudio = (group.audios ?? []).filter((i) => unusedAudio.has(i))
    if (!missing.length && !missingAudio.length) continue
    if (missing.length && missing.length === group.indices.length) {
      names.push(groupText({ name: group.name, indices: group.indices, kind: group.kind, audios: missingAudio }, 'en'))
      for (const i of missingAudio) coveredAudio.add(i)
      if (group.indices.every((i) => covered.has(i))) continue
      const text = groupText(group, o.language)
      fixes.push({ label: `Insert ${group.name}`, title: `Insert “${text}” at the cursor`, action: { type: 'insert', text } })
      for (const i of [...group.indices, ...(group.outfits ?? []).flatMap((w) => w.indices)]) {
        if (unused.has(i)) covered.add(i)
      }
      continue
    }
    for (const i of missing) {
      names.push(`@Image${i} (${group.name})`)
      if (covered.has(i)) continue
      fixes.push({ label: `Insert @Image${i}`, action: { type: 'insert', text: `@Image${i}` } })
      covered.add(i)
    }
    for (const i of missingAudio) {
      if (coveredAudio.has(i)) continue
      coveredAudio.add(i)
      names.push(`@Audio${i} (${possessive(group.name, 'en')} ${group.kind === 'character' ? 'voice' : 'sound'})`)
      // The asset is named already: its clip goes into that reference ("Anna (@Image1, voice @Audio1)").
      const edit = audioIntoReference(o.prompt, group.indices, i, audioWord(group.kind, o.language))
      if (edit) {
        fixes.push({
          label: `Add @Audio${i} to ${group.name}`,
          title: `Writes “${edit.text.replace(/^,\s*/, '')}” into the reference to ${group.name}`,
          action: { type: 'edit', edits: [edit] }
        })
      } else {
        const audio = audioUnused.find((a) => a.index === i)
        const text = audio ? audioInsertText(audio, o.language) : `@Audio${i}`
        fixes.push({ label: `Insert @Audio${i}`, title: `Insert “${text}” at the cursor`, action: { type: 'insert', text } })
      }
    }
  }
  for (const r of sentUnused) {
    if (r.asset) continue
    names.push(`@Image${r.index} (own image)`)
    fixes.push({ label: `Insert @Image${r.index}`, action: { type: 'insert', text: `@Image${r.index}` } })
  }
  for (const a of audioUnused) {
    if (coveredAudio.has(a.index)) continue
    // A clip whose asset has no pictures among the references, or a file of its own.
    const text = audioInsertText(a, o.language)
    names.push(a.source ? `@Audio${a.index} (${possessive(a.source.asset.name, 'en')} sound)` : `@Audio${a.index} (own sound)`)
    fixes.push({ label: `Insert @Audio${a.index}`, title: `Insert “${text}” at the cursor`, action: { type: 'insert', text } })
  }
  const pictures = sentUnused.length
  const clips = audioUnused.length
  return {
    key: 'unused',
    severity: 'warning',
    message:
      names.length === 1 ? `${names[0]} isn’t mentioned in the prompt.` : `Not mentioned in the prompt: ${promptList(names, 'en')}.`,
    detail:
      pictures && clips
        ? 'They are sent anyway – mention them so the model knows what they are for, or remove them.'
        : clips
          ? clips === 1
            ? 'The sound clip is sent anyway – mention it so the model knows whose voice or what sound it is, or remove it.'
            : 'The sound clips are sent anyway – mention them so the model knows whose voice or what sound they are, or remove them.'
          : pictures === 1
            ? 'The image is sent anyway – mention it so the model knows what it is for, or remove it.'
            : 'The images are sent anyway – mention them so the model knows what they are for, or remove them.',
    ranges: [],
    fixes: fixes.slice(0, MAX_INSERT_FIXES)
  }
}
