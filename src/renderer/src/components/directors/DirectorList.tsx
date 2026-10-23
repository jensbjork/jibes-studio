import { ASSET_COPY } from '../../lib/assets'
import { directorSummary, type DirectorEntry } from '../../lib/directors'
import SideList, { SideListRow } from '../library/SideList'
import DirectorAvatar from './DirectorAvatar'
import { DELETE_DIRECTOR_NOTE } from './DirectorEditor'

interface Props {
  /** The user's own (by name), then the ready-made ones; undefined until the library has loaded. */
  entries?: DirectorEntry[]
  selectedId?: string
  onSelect: (id: string) => void
  onCreate: () => void
  creating: boolean
  /** After the row's question (with the row that takes its place); throws to show the error there. */
  onDelete: (id: string, nextId: string | undefined) => Promise<void>
}

/** Directors: the shared side list, the user's own under "Yours" and the ready-made ones under "Ready-made". */
export default function DirectorList({ entries, selectedId, onSelect, onCreate, creating, onDelete }: Props) {
  return (
    <SideList
      title="Directors"
      createLabel="New director"
      onCreate={onCreate}
      creating={creating}
      items={entries}
      selectedId={selectedId}
      onSelect={onSelect}
      searchPlaceholder="Search name or direction"
      searchText={(e) =>
        [e.description, e.direction.editing, e.direction.look, e.direction.camera, e.direction.light]
          .filter(Boolean)
          .join(' ')
      }
      groupOf={(e) => (e.preset ? 'Ready-made' : 'Yours')}
      emptyText={ASSET_COPY.director.listHint}
      deleteQuestion={(e) => `Delete “${e.name}”?`}
      deleteNote={() => DELETE_DIRECTOR_NOTE}
      onDelete={(e, next) => onDelete(e.id, next?.id)}
      renderRow={(e, control) => (
        <SideListRow
          control={control}
          visual={<DirectorAvatar entry={e} className="h-10 w-10 rounded-md" />}
          name={e.name}
          meta={directorSummary(e)}
          title={e.preset ? 'ready-made: copy it to edit' : undefined}
          deleteTitle={e.preset ? undefined : 'Delete the director'}
        />
      )}
    />
  )
}
