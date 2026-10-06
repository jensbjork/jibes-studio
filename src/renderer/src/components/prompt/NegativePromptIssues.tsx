import { useMemo, type RefObject } from 'react'
import type { Kind } from '@shared/models'
import { validateNegativePrompt, type PromptIssue } from '@shared/prompt-refs'
import PromptIssueList from './PromptIssueList'
import { applyEdits, diffEdit, removeRanges, type TextRange } from './promptText'
import { issueViews, type FixAction } from './quickFixes'
import { replaceRange } from './textareaDom'

interface Props {
  id: string
  value: string
  onChange: (value: string) => void
  /** The negative prompt's textarea, so fixes can be undone with ⌘Z and problems can be selected. */
  textareaRef: RefObject<HTMLTextAreaElement | null>
  kind: Kind
  /** Reference images in the form (0 outside reference mode). */
  referenceCount: number
  maxImages: number
  /** A sequence clip continuing from the previous one (see ValidateOptions.continuing). */
  continuing?: boolean
  onSwitchToReference?: () => void
}

/** The errors in the negative prompt's @ImageN references (they block generating too), with fixes. */
export function negativePromptIssues(
  value: string,
  referenceCount: number,
  kind: Kind,
  maxImages: number,
  continuing = false
): PromptIssue[] {
  return value ? validateNegativePrompt(value, referenceCount, { kind, maxImages, continuing }) : []
}

/** Problems with @ImageN in the negative prompt, under its field. Same rules and fixes as the prompt. */
export default function NegativePromptIssues({
  id,
  value,
  onChange,
  textareaRef,
  kind,
  referenceCount,
  maxImages,
  continuing = false,
  onSwitchToReference
}: Props) {
  const views = useMemo(
    () =>
      issueViews({
        prompt: value,
        issues: negativePromptIssues(value, referenceCount, kind, maxImages, continuing),
        references: [],
        groups: [],
        kind,
        language: 'en',
        canSwitchToReference: !!onSwitchToReference,
        canAddReferences: false,
        adviseUnused: false
      }),
    [value, referenceCount, kind, maxImages, continuing, !!onSwitchToReference]
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
  }

  return <PromptIssueList id={id} issues={views} onFix={fix} onReveal={reveal} />
}
