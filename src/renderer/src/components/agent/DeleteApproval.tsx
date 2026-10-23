import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ApprovalDeleteItem, ApprovalDeleteRequest, ApprovalRequest, DeleteTargetKind } from '@shared/types'
import { verifyApproval } from '../../lib/agent'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import { TRASH } from '../../lib/platform'
import AssetIcon from '../assets/AssetIcon'
import { clipFileName, formatDuration } from '../assets/audioUtils'
import AudioPlayButton from '../pickers/AudioPlayButton'
import { KIND_TONE } from '../pickers/assetKinds'
import { noticeTones } from '../ui/Banner'
import { changedSinceText } from './agentText'

// The approval dialog's panel for a removal an agent asks for (request_delete): every item grouped by what it is,
// with a picture or an excerpt, its label and what else happens with it – and, once approved, what became of it.
// Nothing an agent asks to remove goes without the user's OK, and it is all or nothing: the dialog checks the request
// again every 2 seconds (and when the window comes back to the front), so a change since the agent asked is said –
// and blocks "Approve and delete" – before the click rather than after it.

/** The order of the groups in the dialog (main's group names, tools/delete.ts): the library first, then what is made with it. */
const GROUP_ORDER = [
  'Characters',
  'Environments',
  'Products',
  'Outfits',
  'Poses',
  'Photos',
  'Sound clips',
  'Prompts',
  'Learnings',
  'Reviews',
  'Sequences',
  'Clips',
  'Storyboards',
  'Boards',
  'Moves',
  'Videos',
  'Takes',
  'Still images',
  'Edits',
  'Versions',
  'Clean up versions'
]

const TRASH_NOTE =
  `The files go to ${TRASH} – whatever is used elsewhere is kept in “Reference images”. It can’t be undone in Studio.`

/** How often the open dialog checks the request again. */
const CHECK_MS = 2000

export interface DeleteCheck {
  /** Main has answered at least once since the request was shown. */
  checked: boolean
  /** Why it can't be approved as it stands (from main); undefined while it can. */
  problem?: string
}

/**
 * The live check of a pending removal while `active` (the dialog shows it for review): main runs the request's own
 * check without carrying anything out, right away, 2 s after each answer and whenever the window gets the focus back.
 */
export function useDeleteCheck(a: ApprovalRequest, active: boolean): DeleteCheck {
  const [state, setState] = useState<DeleteCheck & { id?: string }>({ checked: false })
  const run = active && a.kind === 'delete' && a.status === 'pending'
  useEffect(() => {
    if (!run) return
    let alive = true
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // The same answer again changes nothing on screen (and re-renders nothing).
    const settle = (problem: string | undefined): void => {
      if (!alive) return
      setState((s) => (s.id === a.id && s.checked && s.problem === problem ? s : { id: a.id, checked: true, problem }))
    }
    const check = (): void => {
      if (!alive || busy) return
      busy = true
      clearTimeout(timer)
      verifyApproval(a.id)
        .then(
          (problem) => settle(problem ?? undefined),
          (e: unknown) => settle(ipcErrorMessage(e))
        )
        .finally(() => {
          busy = false
          if (alive) timer = setTimeout(check, CHECK_MS)
        })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener('focus', check)
    }
  }, [a.id, run])
  return state.id === a.id ? { checked: state.checked, problem: state.problem } : { checked: false }
}

/** The items by group, in GROUP_ORDER (a group main names that isn't listed comes after, in its own order). */
function grouped(items: readonly ApprovalDeleteItem[]): { group: string; items: ApprovalDeleteItem[] }[] {
  const byGroup = new Map<string, ApprovalDeleteItem[]>()
  for (const item of items) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item])
  const rank = (group: string): number => {
    const i = GROUP_ORDER.indexOf(group)
    return i === -1 ? GROUP_ORDER.length : i
  }
  return [...byGroup.entries()]
    .map(([group, list]) => ({ group, items: list }))
    .sort((a, b) => rank(a.group) - rank(b.group))
}

/** The removal panel: the checks' result, the items by group and what removing them means. */
export function DeleteSummary({
  approval,
  request,
  check
}: {
  approval: ApprovalRequest
  request: ApprovalDeleteRequest
  check: DeleteCheck
}) {
  const groups = useMemo(() => grouped(request.items), [request.items])
  const pending = approval.status === 'pending'
  return (
    <section className="space-y-4" aria-label="What gets deleted">
      {pending && check.problem && (
        <p
          role="alert"
          className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed select-text ${noticeTones.error}`}
        >
          {changedSinceText(check.problem)}
        </p>
      )}
      {groups.map(({ group, items }) => (
        <div key={group}>
          <p className="mb-1.5 text-[11px] text-muted">
            {group}
            {items.length > 1 && <span className="tabular-nums"> · {items.length}</span>}
          </p>
          <ul className="space-y-1.5" aria-label={group}>
            {items.map((item) => (
              <ItemRow key={`${item.kind}:${item.id}:${item.segmentId ?? ''}`} item={item} />
            ))}
          </ul>
        </div>
      ))}
      {!request.items.length && <p className="text-danger">The request doesn’t say what should be deleted.</p>}
      <p className="border-t border-line pt-4 text-[12px] leading-relaxed text-muted">{TRASH_NOTE}</p>
    </section>
  )
}

function ItemRow({ item }: { item: ApprovalDeleteItem }) {
  const failed = item.outcome?.status === 'failed'
  return (
    <li
      className={`flex gap-3 rounded-md border bg-raised/40 p-2 ${failed ? 'border-accent/40' : 'border-line'} ${
        item.outcome?.status === 'deleted' ? 'opacity-70' : ''
      }`}
    >
      <Thumb item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 break-words font-medium leading-snug select-text">{item.label}</p>
          {item.outcome && <OutcomeChip status={item.outcome.status} />}
        </div>
        {item.sound && (
          // Which recording it is: its file and length, and a way to listen before it goes.
          <p className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-muted">
            <AudioPlayButton
              path={item.sound.path}
              start={0}
              length={Math.max(0.1, item.sound.duration)}
              label={clipFileName(item.sound.path)}
            />
            <span className="min-w-0 truncate select-text" title={clipFileName(item.sound.path)}>
              {clipFileName(item.sound.path)}
            </span>
            {item.sound.duration > 0 && (
              <span className="shrink-0 tabular-nums">{formatDuration(item.sound.duration)}</span>
            )}
          </p>
        )}
        {item.text && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-snug text-muted select-text">
            “{item.text}”
          </p>
        )}
        {item.effects.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[12px] leading-snug text-muted">
            {item.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        )}
        {failed && item.outcome?.error && (
          <p className="mt-1 text-[12px] leading-snug text-danger select-text">{item.outcome.error}</p>
        )}
      </div>
    </li>
  )
}

const OUTCOME: Record<NonNullable<ApprovalDeleteItem['outcome']>['status'], { text: string; tone: string }> = {
  deleted: { text: 'Deleted', tone: 'bg-emerald-500/15 text-success' },
  gone: { text: 'Already gone', tone: 'bg-raised text-muted' },
  failed: { text: 'Failed', tone: 'bg-accent/15 text-danger' }
}

function OutcomeChip({ status }: { status: keyof typeof OUTCOME }) {
  const { text, tone } = OUTCOME[status]
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{text}</span>
}

/** The item's picture (an asset's cover ringed in its kind's colour, the photo, a poster, the still, the board), or a symbol. */
function Thumb({ item }: { item: ApprovalDeleteItem }) {
  const [missing, setMissing] = useState(false)
  const tone = item.assetKind ? KIND_TONE[item.assetKind] : undefined
  const ring = tone && (item.kind === 'asset' || item.kind === 'asset-image') ? `ring-2 ${tone.ring}` : ''
  if (item.preview && !missing) {
    return (
      <span className={`relative h-10 w-14 shrink-0 overflow-hidden rounded bg-raised ${ring}`}>
        <img
          src={mediaUrl(item.preview)}
          alt=""
          draggable={false}
          onError={() => setMissing(true)}
          className="h-full w-full object-cover"
        />
        {item.kind === 'board-move' && item.toIndex !== undefined && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] tabular-nums">
            → {item.toIndex + 1}
          </span>
        )}
      </span>
    )
  }
  const assetSymbol =
    item.assetKind && (item.kind === 'asset' || item.kind === 'asset-image') ? (
      <AssetIcon kind={item.assetKind} size={16} />
    ) : undefined
  return (
    <span
      aria-hidden
      className={`flex h-10 w-14 shrink-0 items-center justify-center rounded bg-raised ${tone ? tone.text : 'text-muted'} ${ring}`}
    >
      {assetSymbol ?? <KindGlyph kind={item.kind} />}
    </span>
  )
}

/** A 16 px symbol for an item without a picture, on the same grid as the window's other icons. */
function KindGlyph({ kind }: { kind: DeleteTargetKind }) {
  let body: ReactNode
  switch (kind) {
    case 'prompt':
      body = (
        <path d="M2.5 9.6C2.5 6.9 4 5 6.6 4.4l.5 1.2C5.6 6.2 4.9 7.1 4.8 8.4h2v4.1H2.5zm6.6 0c0-2.7 1.5-4.6 4.1-5.2l.5 1.2c-1.5.6-2.2 1.5-2.3 2.8h2v4.1H9.1z" />
      )
      break
    case 'learning':
      body = (
        <path d="M8 1.5a4.6 4.6 0 0 0-2.7 8.3c.4.3.7.8.7 1.3v.6h4v-.6c0-.5.3-1 .7-1.3A4.6 4.6 0 0 0 8 1.5zM6 12.9h4v1.6H6z" />
      )
      break
    case 'review':
      body = <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.3l-3.9 2.2.9-4.4-3.3-3 4.4-.5z" />
      break
    case 'asset-audio':
      body = (
        <>
          <path d="M2 6h2.6L8.5 3v10L4.6 10H2z" />
          <path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
        </>
      )
      break
    case 'storyboard':
    case 'board':
    case 'board-move':
      body = (
        <>
          <rect x="1.5" y="2.5" width="5.5" height="4.5" rx="1" />
          <rect x="9" y="2.5" width="5.5" height="4.5" rx="1" />
          <rect x="1.5" y="9" width="5.5" height="4.5" rx="1" />
          <rect x="9" y="9" width="5.5" height="4.5" rx="1" />
        </>
      )
      break
    case 'still':
    case 'asset':
    case 'asset-image':
      body = (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
          <path d="M3.5 11.6l3-3.6 2.2 2.4 1.6-1.8 2.2 3z" />
        </>
      )
      break
    default:
      // Videos, takes, clips, sequences, versions and edits: a strip of film.
      body = (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
          <path d="M5 3v10M11 3v10" fill="none" stroke="currentColor" strokeWidth={1.2} />
        </>
      )
  }
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden className="shrink-0">
      {body}
    </svg>
  )
}
