import { useEffect, useState } from 'react'
import type { LibraryStatus, ReorganizeReport } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { displayPath, folderName } from '../../lib/library'
import { FILE_MANAGER } from '../../lib/platform'
import Modal from '../pickers/Modal'
import FolderDecision from './FolderDecision'
import FolderTree from './FolderTree'
import type { RevealTarget } from './OpenFolderButton'
import SwitchingOverlay from './SwitchingOverlay'
import { useFolderChoice, useLibrarySwitch } from './useLibrarySwitch'

const secondary = 'rounded-md border border-line px-4 py-2 transition hover:bg-raised disabled:opacity-40'

/** Settings → Library: where everything is stored, switching folders and tidying up. */
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

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-medium">Library</h2>
      <p className="mb-3 text-muted">
        Everything Studio saves is in the library folder below, sorted into folders you can browse right in {FILE_MANAGER}.
        Click a folder to open it.
      </p>

      {root ? (
        <div className="rounded-md border border-line bg-raised/40 p-1.5">
          <FolderTree
            rootName={folderName(root)}
            rootDetail={displayPath(root)}
            detail="explain"
            onOpen={(target) => void reveal(target)}
          />
        </div>
      ) : (
        status && <p className="text-muted">No library folder is chosen.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => void changeFolder()} disabled={!status || choice.checking} className={secondary}>
          Change folder…
        </button>
        {choice.checking && !dialogOpen && <span className="text-[12px] text-muted">Checking the folder…</span>}
      </div>
      {(error ?? (!dialogOpen && choice.error)) && (
        <p className="mt-2 text-[12px] text-accent select-text">{error ?? choice.error}</p>
      )}

      {root && <Cleanup />}

      {dialogOpen && status && (
        <ChangeFolderDialog status={status} choice={choice} onClose={() => setDialogOpen(false)} />
      )}
    </section>
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
            <button onClick={close} disabled={busy} className={secondary}>
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
        {choice.error && <p className="mt-3 text-[12px] text-accent select-text">{choice.error}</p>}
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
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="mb-1 font-medium">Tidy up</h3>
      <p className="mb-3 text-muted">
        Moves misplaced files to the right folder and gives them descriptive names, for example after a character,
        environment, product, outfit, pose, sequence or storyboard was renamed. Nothing is deleted and no files are
        overwritten.
      </p>
      <button onClick={() => void run()} disabled={running} className={secondary}>
        {running ? 'Tidying up…' : 'Tidy up the folder structure'}
      </button>

      {error && <p className="mt-3 text-[12px] text-accent select-text">{error}</p>}
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
              <p className="mt-1.5 text-amber-200">
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
    </div>
  )
}
