import { useMemo, type RefObject } from 'react'
import type { Kind } from '@shared/models'
import { validateNegativePrompt, type PromptIssue, type ValidateOptions } from '@shared/prompt-refs'
import PromptIssueList from './PromptIssueList'
import { applyEdits, diffEdit, removeRanges, type TextRange } from './promptText'
import { issueViews, type FixAction } from './quickFixes'
import { replaceRange } from './textareaDom'

/** What the text is checked against: prompt-refs validationContext of the form's params. */
export interface PromptChecks {
  referenceCount: number
  options: ValidateOptions
}

interface Props {
  id: string
  value: string
  onChange: (value: string) => void
  /** The negative prompt's textarea, so fixes can be undone with ⌘Z and problems can be selected. */
  textareaRef: RefObject<HTMLTextAreaElement | null>
  kind: Kind
  checks: PromptChecks
  onSwitchToReference?: () => void
  /** Switches to a reference model that takes audio (named `audioModelName`). */
  onUseAudioModel?: () => void
  audioModelName?: string
}

/** The errors in the negative prompt's @ImageN and @AudioN references (they block generating too). */
export function negativePromptIssues(value: string, checks: PromptChecks): PromptIssue[] {
  return value ? validateNegativePrompt(value, checks.referenceCount, checks.options) : []
}

/** Problems with @ImageN and @AudioN in the negative prompt, under its field. Same rules and fixes as the prompt. */
export default function NegativePromptIssues({
  id,
  value,
  onChange,
  textareaRef,
  kind,
  checks,
  onSwitchToReference,
  onUseAudioModel,
  audioModelName
}: Props) {
  const checksKey = JSON.stringify(checks)
  const views = useMemo(
    () =>
      issueViews({
        prompt: value,
        issues: negativePromptIssues(value, checks),
        references: [],
        groups: [],
        kind,
        language: 'en',
        canSwitchToReference: !!onSwitchToReference,
        canAddReferences: false,
        audioModelName: onUseAudioModel ? audioModelName : undefined,
        adviseUnused: false
      }),
    [value, checksKey, kind, !!onSwitchToReference, onUseAudioModel ? audioModelName : undefined]
  )

  const setValue = (next: string): void => {
    const el = textareaRef.current
    const change = diffEdit(value, next)
    if (!change) return
    if (el && el.value === value && replaceRange(el, change.start, change.end, change.text)) return
    onChange(next)
  }

  const reveal = (range: TextRange): void => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(range.start, range.end)
  }

  const fix = (action: FixAction): void => {
    if (action.type === 'edit') setValue(applyEdits(value, action.edits))
    else if (action.type === 'remove') setValue(removeRanges(value, action.ranges))
    else if (action.type === 'choose') reveal(action.range)
    else if (action.type === 'switch-to-reference') onSwitchToReference?.()
    else if (action.type === 'use-audio-model') onUseAudioModel?.()
  }

  return <PromptIssueList id={id} issues={views} onFix={fix} onReveal={reveal} />
}
