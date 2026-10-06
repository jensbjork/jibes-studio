import { useEffect, useState } from 'react'
import type { LibraryStatus, ReorganizeReport } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { displayPath, folderName } from '../../lib/library'
import Modal from '../pickers/Modal'
import FolderDecision from './FolderDecision'
import FolderTree from './FolderTree'
import type { RevealTarget } from './OpenFolderButton'
import SwitchingOverlay from './SwitchingOverlay'
import { useFolderChoice, useLibrarySwitch } from './useLibrarySwitch'

const secondary = 'rounded-md border border-line px-4 py-2 transition hover:bg-raised disabled:opacity-40'

/** Settings → Bibliotek: where everything is stored, switching folders and tidying up. */
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
      <h2 className="mb-1 font-medium">Bibliotek</h2>
      <p className="mb-3 text-muted">
        Allt Studio sparar ligger i grundmappen nedan, ordnat i mappar du kan bläddra i direkt i Finder. Klicka på en
        mapp för att öppna den.
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
        status && <p className="text-muted">Ingen biblioteksmapp är vald.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => void changeFolder()} disabled={!status || choice.checking} className={secondary}>
          Byt mapp…
        </button>
        {choice.checking && !dialogOpen && <span className="text-[12px] text-muted">Kontrollerar mappen…</span>}
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
        title="Byt biblioteksmapp"
        subtitle={status.root ? `Nu: ${displayPath(status.root)}` : undefined}
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
              Välj en annan mapp…
            </button>
            <button onClick={close} disabled={busy} className={secondary}>
              Avbryt
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
          choice.checking && <p className="text-muted">Kontrollerar mappen…</p>
        )}
        {choice.error && <p className="mt-3 text-[12px] text-accent select-text">{choice.error}</p>}
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          Byte av mapp går inte medan något genereras eller exporteras. Studio laddar om när bytet är klart.
        </p>
      </Modal>
      <SwitchingOverlay phase={switcher.phase} />
    </>
  )
}

/** "1 fil", "3 filer" */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function summary(r: ReorganizeReport): string {
  const parts = [
    r.moved ? `${count(r.moved, 'fil', 'filer')} flyttades` : '',
    r.foldersCreated ? `${count(r.foldersCreated, 'mapp', 'mappar')} skapades` : ''
  ].filter(Boolean)
  if (!parts.length) return r.errors.length ? 'Inget kunde flyttas.' : 'Allt låg redan på rätt plats.'
  return `Klart – ${parts.join(' och ')}.`
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
      <h3 className="mb-1 font-medium">Städa upp</h3>
      <p className="mb-3 text-muted">
        Flyttar filer som hamnat fel till rätt mapp och ger dem beskrivande namn, till exempel efter att en
        karaktär, miljö, klädsel eller sekvens bytt namn. Inget raderas och inga filer skrivs över.
      </p>
      <button onClick={() => void run()} disabled={running} className={secondary}>
        {running ? 'Städar upp…' : 'Städa upp mappstrukturen'}
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
              {count(report.missing, 'fil', 'filer')} som Studio känner till finns inte längre på disken (till exempel
              borttagna i Finder) och hoppades över.
            </p>
          )}
          {report.errors.length > 0 && (
            <>
              <p className="mt-1.5 text-amber-200">
                {report.errors.length === 1 ? 'Det här gick inte att flytta:' : 'De här gick inte att flytta:'}
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
