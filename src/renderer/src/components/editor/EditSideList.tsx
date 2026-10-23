import type { EditSummary } from '@shared/types'
import { useViewWork } from '../../lib/work'
import SideList, { SideListRow, SideListThumb, type SideRowControl } from '../library/SideList'
import { FilmIcon } from '../sequences/icons'
import MarkViewSeen from '../takes/MarkViewSeen'
import { menuRow, onMenuKeyDown } from '../ui/menu'
import { StatusMark } from '../work/StatusMark'
import { useEditStatus } from './EditList'
import { DELETE_EDIT_TEXT, originLabel, summaryLine } from './editorUtils'
import { CameraIcon } from './icons'

// The Editor's list on the left, always there: the edits, newest change first, in the shared side list. A click opens
// one on the right; "＋ New edit" offers the three ways to start one (the same names as in Sequences). With no edits
// the list stays quiet: the overview beside it explains.

interface Props {
  edits?: EditSummary[]
  /** The open edit. */
  selectedId?: string
  /** A film is being read, found or copied in: no new one meanwhile. */
  busy: boolean
  onSelect: (id: string) => void
  onOwnFilm: () => void
  onFromFeed: () => void
  onFromExport: () => void
  /** After the row's question; throws to show the error there. `next` is the row that takes its place. */
  onDelete: (edit: EditSummary, next: EditSummary | undefined) => Promise<void>
}

export default function EditSideList({
  edits,
  selectedId,
  busy,
  onSelect,
  onOwnFilm,
  onFromFeed,
  onFromExport,
  onDelete
}: Props) {
  const view = useViewWork('editor')
  const newCount = view.unseen + view.failed

  return (
    <SideList
      title="Edits"
      createLabel="New edit"
      createTitle="Edit your own film, a clip or an export"
      creating={busy}
      createPanel={{
        width: 240,
        popup: 'menu',
        render: (close) => (
          <div role="menu" aria-label="New edit" onKeyDown={onMenuKeyDown} className="p-1">
            {(
              [
                ['Own film from file…', onOwnFilm],
                ['From Media…', onFromFeed],
                ['From an export…', onFromExport]
              ] as const
            ).map(([label, action], i) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                data-menu-item
                autoFocus={i === 0}
                onClick={() => {
                  close()
                  action()
                }}
                className={menuRow}
              >
                {label}
              </button>
            ))}
          </div>
        )
      }}
      headerExtra={newCount > 0 && <MarkViewSeen view="editor" />}
      items={edits}
      selectedId={selectedId}
      onSelect={onSelect}
      searchText={(e) => originLabel(e.origin)}
      deleteNote={() => DELETE_EDIT_TEXT}
      onDelete={onDelete}
      renderRow={(e, control) => <EditRow edit={e} control={control} />}
    />
  )
}

/** One edit: its poster, name, versions and length (and spent), what runs there and what is new. */
function EditRow({ edit, control }: { edit: EditSummary; control: SideRowControl }) {
  const { counts, runningCount, title } = useEditStatus(edit)
  const origin = `${originLabel(edit.origin)}${edit.origin.missing ? ' (gone)' : ''}`
  return (
    <SideListRow
      control={control}
      visual={
        <SideListThumb
          path={edit.posterPath}
          fallback={
            edit.origin.kind === 'import' ? (
              <CameraIcon size={14} className="text-muted/60" />
            ) : (
              <FilmIcon size={16} className="text-muted/60" />
            )
          }
        />
      }
      name={edit.name}
      meta={summaryLine(edit)}
      status={<StatusMark variant="inline" running={runningCount} fresh={counts.unseen} failed={counts.failed} />}
      title={title ? `${origin} · ${title}` : origin}
      deleteTitle="Delete the edit"
    />
  )
}
