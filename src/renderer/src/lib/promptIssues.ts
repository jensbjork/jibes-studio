import {
  blockingPromptError,
  validateGenerationParams,
  type PromptIssue,
  type ValidateOptions
} from '@shared/prompt-refs'
import type { GenerationParams } from '@shared/types'

// The @ImageN checks for a set of params, with exactly the rules main applies before anything is sent to
// Venice (JobManager.submit refuses params with blocking issues). Used for the generate buttons, the agent
// bridge and the approval dialog; the prompt editor shows the same issues as you type.

/**
 * Every problem with the @ImageN tokens of the prompt and the negative prompt, errors and warnings. `explained`:
 * the numbers the References legend explains (explainedReferences of the composed prompt), not reported as
 * unmentioned.
 */
export function promptIssuesOf(params: GenerationParams, explained?: ValidateOptions['explained']): PromptIssue[] {
  const { prompt, negativePrompt } = validateGenerationParams(params, explained ? { explained } : {})
  return [...prompt, ...negativePrompt]
}

/**
 * Why main would refuse these params, as a short Swedish reason for a disabled button ("@Image7 finns inte –
 * bara 5 bilder är valda"); undefined when nothing blocks.
 */
export function blockingPromptIssue(params: GenerationParams): string | undefined {
  return blockingPromptError(params)?.replace(/\.\s*$/, '')
}
