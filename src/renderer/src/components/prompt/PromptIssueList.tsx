import type { FixAction, IssueView } from './quickFixes'
import type { TextRange } from './promptText'

interface Props {
  id: string
  issues: IssueView[]
  onFix: (action: FixAction) => void
  /** Selects the stretch of the prompt an issue is about. */
  onReveal: (range: TextRange) => void
}

const fixButton =
  'shrink-0 rounded border border-line px-1.5 py-px text-[11px] text-text transition hover:border-muted hover:bg-raised'

/** Problems with the prompt's references, errors first, each with the fixes that are obvious. */
export default function PromptIssueList({ id, issues, onFix, onReveal }: Props) {
  if (!issues.length) return null
  return (
    <ul id={id} aria-live="polite" className="mt-2 space-y-1.5">
      {issues.map((issue) => {
        const error = issue.severity === 'error'
        const first = issue.ranges[0]
        return (
          <li key={issue.key} className="flex items-start gap-2 text-[12px] leading-snug">
            <span
              aria-label={error ? 'Error' : 'Warning'}
              className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${error ? 'bg-accent' : 'bg-amber-400'}`}
            />
            <div className="min-w-0 flex-1">
              {first ? (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onReveal(first)}
                  title="Show in the prompt"
                  className={`text-left hover:underline ${error ? 'text-danger' : 'text-warning'}`}
                >
                  {issue.message}
                </button>
              ) : (
                <p className={error ? 'text-danger' : 'text-warning'}>{issue.message}</p>
              )}
              {issue.detail && <p className="mt-0.5 text-[11px] text-muted">{issue.detail}</p>}
              {issue.fixes.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {issue.fixes.map((fix) => (
                    <button
                      key={fix.label}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onFix(fix.action)}
                      title={fix.title}
                      className={fixButton}
                    >
                      {fix.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
