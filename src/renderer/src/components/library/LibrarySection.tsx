import { useEffect, useState } from 'react'
import type { LibraryStatus, ReorganizeReport } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { displayPath, folderName } from '../../lib/library'
import { ARCHIVE_UNAVAILABLE, FILE_MANAGER } from '../../lib/platform'
import Modal from '../pickers/Modal'
import LibraryArchiveSection from '../settings/LibraryArchiveSection'
import { MoreAbout, SettingsItem } from '../settings/SettingsLayout'
import { buttonClass } from '../ui/button'
import FolderDecision from './FolderDecision'
import FolderTree from './FolderTree'
import type { RevealTarget } from './OpenFolderButton'
import SwitchingOverlay from './SwitchingOverlay'
import { useFolderChoice, useLibrarySwitch } from './useLibrarySwitch'

/**
 * Settings → Library, as three settings: the folder (where it is, open it, change it, and what is in it), moving the
 * library to another computer (Export & import) and tidying up.
 */
export default function LibrarySection() {
  const [status, setStatus] = useState<LibraryStatus>()
  const [error, setError] = useState<string>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const choice = useFolderChoice()

  useEffect(() => {
    window.studio.libraryStatus().then(setStatus, (e: unknown) => setError(ipcErrorMessage(e)))
  }, [])

  const reveal = async (target: RevealTarget) => {
    setError(undefined)
    try {
      await window.studio.revealLibraryFolder(target)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  const changeFolder = async () => {
    setError(undefined)
    choice.reset()
    if (await choice.choose()) setDialogOpen(true)
  }

  const root = status?.root
  const shownError = error ?? (!dialogOpen ? choice.error : undefined)

  return (
    <>
      <SettingsItem
        title="Folder"
        help={
          root ? (
            <span className="break-all font-mono text-[11px] select-text">{displayPath(root)}</span>
          ) : (
            status && 'No library folder is chosen.'
          )
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {root && (
            <button type="button" onClick={() => void reveal('root')} className={buttonClass()}>
              Show in {FILE_MANAGER}
            </button>
          )}
          <button
            type="button"
            onClick={() => void changeFolder()}
            disabled={!status || choice.checking}
            className={buttonClass()}
          >
            Change folder…
          </button>
          {choice.checking && !dialogOpen && <span className="text-[12px] text-muted">Checking the folder…</span>}
        </div>
        {shownError && (
          <p role="alert" className="mt-2 text-[12px] text-danger select-text">
            {shownError}
          </p>
        )}
        {root && (
          <div className="mt-3">
            {/* The folders, each opening in the file manager on a click. */}
            <MoreAbout summary="What’s in the folder" plain>
              <FolderTree rootName={folderName(root)} detail="explain" onOpen={(target) => void reveal(target)} />
            </MoreAbout>
          </div>
        )}
      </SettingsItem>

      <SettingsItem
        title="Move to another computer"
        help={
          ARCHIVE_UNAVAILABLE
            ? undefined
            : 'Pack the whole library – the database and every file – into one zip, or open such a zip as a new ' +
              'library. The API key and the agent’s token aren’t included.'
        }
      >
        <LibraryArchiveSection />
      </SettingsItem>

      {root && <Cleanup />}

      {dialogOpen && status && (
        <ChangeFolderDialog status={status} choice={choice} onClose={() => setDialogOpen(false)} />
      )}
    </>
  )
}

function ChangeFolderDialog({
  status,
  choice,
  onClose
}: {
  status: LibraryStatus
  choice: ReturnType<typeof useFolderChoice>
  onClose: () => void
}) {
  const switcher = useLibrarySwitch(status)
  const busy = switcher.phase.kind !== 'idle'
  const close = () => {
    if (!busy) onClose()
  }

  return (
    <>
      <Modal
        title="Change library folder"
        subtitle={status.root ? `Current: ${displayPath(status.root)}` : undefined}
        onClose={close}
        maxWidth={540}
        footer={
          <>
            <button
              onClick={() => {
                switcher.clearError()
                void choice.choose()
              }}
              disabled={busy || choice.checking}
              className="mr-auto text-[12px] text-muted transition hover:text-text disabled:opacity-40"
            >
              Choose another folder…
            </button>
            <button type="button" onClick={close} disabled={busy} className={buttonClass()}>
              Cancel
            </button>
          </>
        }
      >
        {choice.inspection ? (
          <FolderDecision
            inspection={choice.inspection}
            status={status}
            busy={busy || choice.checking}
            error={switcher.error}
            onConfirm={(mode) => void switcher.start(choice.inspection!.path, mode)}
          />
        ) : (
          choice.checking && <p className="text-muted">Checking the folder…</p>
        )}
        {choice.error && (
          <p role="alert" className="mt-3 text-[12px] text-danger select-text">
            {choice.error}
          </p>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          The folder can't be changed while something is generating or exporting. Studio reloads when the change is done.
        </p>
      </Modal>
      <SwitchingOverlay phase={switcher.phase} />
    </>
  )
}

/** "1 file", "3 files" */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function summary(r: ReorganizeReport): string {
  const parts = [
    r.moved ? `${count(r.moved, 'file', 'files')} moved` : '',
    r.foldersCreated ? `${count(r.foldersCreated, 'folder', 'folders')} created` : ''
  ].filter(Boolean)
  if (!parts.length) return r.errors.length ? 'Nothing could be moved.' : 'Everything was already in the right place.'
  return `Done – ${parts.join(' and ')}.`
}

/** Moves every file Studio keeps track of to where it belongs, and reports what happened. */
function Cleanup() {
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ReorganizeReport>()
  const [error, setError] = useState<string>()

  const run = async () => {
    setRunning(true)
    setError(undefined)
    setReport(undefined)
    try {
      setReport(await window.studio.reorganizeLibrary())
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingsItem
      title="Tidy up"
      help="Puts misplaced files back in the right folder with descriptive names, for example after a rename. Nothing is deleted or overwritten."
    >
      <button type="button" onClick={() => void run()} disabled={running} className={buttonClass()}>
        {running ? 'Tidying up…' : 'Tidy up the folder structure'}
      </button>

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger select-text">
          {error}
        </p>
      )}
      {report && (
        <div className="mt-3 rounded-md border border-line bg-raised px-3 py-2.5 text-[12px] leading-relaxed">
          <p className="flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${report.errors.length ? 'bg-amber-400' : 'bg-emerald-400'}`}
            />
            <span>{summary(report)}</span>
          </p>
          {report.missing > 0 && (
            <p className="mt-1.5 text-muted">
              {count(report.missing, 'file', 'files')} that Studio knows about {report.missing === 1 ? 'is' : 'are'} no
              longer on disk (for example deleted in {FILE_MANAGER}) and {report.missing === 1 ? 'was' : 'were'} skipped.
            </p>
          )}
          {report.errors.length > 0 && (
            <>
              <p className="mt-1.5 text-warning">
                {report.errors.length === 1 ? "This couldn't be moved:" : "These couldn't be moved:"}
              </p>
              <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-muted select-text">
                {report.errors.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </SettingsItem>
  )
}
