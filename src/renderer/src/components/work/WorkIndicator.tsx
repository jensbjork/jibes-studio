import { useMemo } from 'react'
import { useWork } from '../../lib/work'
import { TrayIcon } from '../icons'
import { fade, IconBox, rowClass, useRailTooltip } from '../RailTooltip'
import { Spinner, StatusDot, StatusMark } from './StatusMark'

interface Props {
  /** The sidebar is the icon rail: icon and badges only, the words in the tooltip. */
  collapsed: boolean
  /** The panel is open. */
  active: boolean
  onClick: () => void
}

function runningLine(n: number): string {
  return `${n} pågår`
}

function freshLine(n: number): string {
  return n === 1 ? '1 klar att titta på' : `${n} klara att titta på`
}

function failedLine(n: number): string {
  return `${n} misslyckades`
}

/**
 * The sidebar row of Pågår och klart, styled like the agent's row: "Pågår och klart" while idle; "2 pågår" with
 * the newest running label (or "● 3 klara att titta på") while something runs; "3 klara att titta på" with the
 * newest finished label when work is waiting to be looked at; a new failure takes the second line in red.
 * A click opens or closes the panel.
 */
export default function WorkIndicator({ collapsed, active, onClick }: Props) {
  const work = useWork()
  const { running, unseen, failed } = work.total

  // The newest running item (latest start) and the newest finished one: the second line names them.
  const newestRunning = useMemo(
    () => work.running.reduce<(typeof work.running)[number] | undefined>((a, w) => (!a || w.startedAt > a.startedAt ? w : a), undefined),
    [work.running]
  )
  const newestFresh = useMemo(() => work.unseen.find((w) => w.status === 'completed'), [work.unseen])

  let line1 = 'Pågår och klart'
  if (running > 0) line1 = runningLine(running)
  else if (unseen > 0) line1 = freshLine(unseen)

  let line2: { text: string; tone: 'muted' | 'fresh' | 'failed' } | undefined
  if (failed > 0) line2 = { text: failedLine(failed), tone: 'failed' }
  else if (running > 0 && unseen > 0) line2 = { text: freshLine(unseen), tone: 'fresh' }
  else if (running > 0 && newestRunning) line2 = { text: newestRunning.label, tone: 'muted' }
  else if (unseen > 0 && newestFresh) line2 = { text: newestFresh.label, tone: 'muted' }

  const status = [
    running > 0 ? runningLine(running) : undefined,
    unseen > 0 ? freshLine(unseen) : undefined,
    failed > 0 ? failedLine(failed) : undefined
  ]
    .filter(Boolean)
    .join(' · ')
  const label = 'Pågår och klart'
  const { trigger, tooltip } = useRailTooltip(collapsed, label, status || undefined)

  const icon =
    running > 0 ? (
      <Spinner size={14} />
    ) : unseen > 0 || failed > 0 ? (
      // A failure outranks what is new, as in every other status mark (the rail shows only this icon).
      <StatusDot failed={failed > 0} large />
    ) : (
      <TrayIcon />
    )

  return (
    <>
      <button
        onClick={onClick}
        aria-haspopup="dialog"
        aria-expanded={active}
        aria-label={collapsed ? (status ? `${label}: ${status}` : label) : undefined}
        title={collapsed ? undefined : status ? `${status}. Klicka för att se allt.` : 'Det som pågår och det som är klart att titta på'}
        className={rowClass(active, collapsed, !collapsed && !!line2)}
      >
        <IconBox>
          {icon}
          {/* In the rail the spinner is the icon; a dot on its corner says something is also new or failed. */}
          {collapsed && running > 0 && <StatusMark variant="badge" fresh={unseen} failed={failed} />}
        </IconBox>
        <span className={`min-w-0 flex-1 ${fade(collapsed)}`}>
          <span className={`block truncate ${running > 0 || unseen > 0 ? 'text-text' : ''}`}>{line1}</span>
          {line2 && (
            <span
              aria-live={collapsed ? undefined : 'polite'}
              className={`flex items-center gap-1.5 truncate text-xs ${
                line2.tone === 'failed' ? 'text-[#ffb3b5]' : 'text-muted'
              }`}
            >
              {line2.tone === 'fresh' && <StatusDot />}
              <span className="truncate">{line2.text}</span>
            </span>
          )}
        </span>
      </button>
      {tooltip}
    </>
  )
}
