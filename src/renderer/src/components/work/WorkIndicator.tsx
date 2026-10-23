import { useMemo } from 'react'
import { useWork } from '../../lib/work'
import { TrayIcon } from '../icons'
import { Spinner, StatusDot, StatusMark } from './StatusMark'
import StatusRow from './StatusRow'

interface Props {
  /** The sidebar is the icon rail: icon and badges only, the words in the tooltip. */
  collapsed: boolean
  /** The panel is open. */
  active: boolean
  onClick: () => void
}

function runningLine(n: number): string {
  return `${n} running`
}

function freshLine(n: number): string {
  return `${n} ready to look at`
}

function failedLine(n: number): string {
  return `${n} failed`
}

/**
 * The sidebar's status row of Activity. Idle it reads "Activity" beside the tray; while something runs
 * or waits to be looked at it says so in short – a spinner and "2 running · 3 new" – and a new failure stays visible
 * on the right as a red dot with its count. In the rail it is the tray with the usual badges. The tooltip spells the
 * counts out and names the newest item. A click opens or closes the panel.
 */
export default function WorkIndicator({ collapsed, active, onClick }: Props) {
  const work = useWork()
  const { running, unseen, failed } = work.total

  // The newest running item (latest start), else the newest finished one: the tooltip names it.
  const newest = useMemo(() => {
    const run = work.running.reduce<(typeof work.running)[number] | undefined>(
      (a, w) => (!a || w.startedAt > a.startedAt ? w : a),
      undefined
    )
    return run?.label ?? work.unseen.find((w) => w.status === 'completed')?.label
  }, [work.running, work.unseen])

  const status = [
    running > 0 ? runningLine(running) : undefined,
    unseen > 0 ? freshLine(unseen) : undefined,
    failed > 0 ? failedLine(failed) : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  // Short enough to fit beside a failure's count in the 208 px sidebar: "2 running · 3 new".
  const text =
    running > 0 || unseen > 0 ? (
      <>
        {running > 0 && `${running} running`}
        {running > 0 && unseen > 0 && <span className="text-muted"> · </span>}
        {unseen > 0 && <span className="text-success">{`${unseen} new`}</span>}
      </>
    ) : undefined

  return (
    <StatusRow
      collapsed={collapsed}
      active={active}
      onClick={onClick}
      dialog
      // Expanded, the spinner is the icon while something runs; the rail keeps the tray and shows it as a badge.
      icon={running > 0 && !collapsed ? <Spinner size={12} /> : <TrayIcon size={14} />}
      badge={<StatusMark variant="badge" running={running} fresh={unseen} failed={failed} />}
      label="Activity"
      text={text}
      lit={running + unseen + failed > 0}
      trailing={
        failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-danger">
            <StatusDot failed />
            {failed}
          </span>
        )
      }
      status={status || undefined}
      title={
        status
          ? `${status}${newest ? `. Latest: ${newest}` : ''}. Click to see everything.`
          : 'What’s running and what’s ready to look at'
      }
      live={status}
    />
  )
}
