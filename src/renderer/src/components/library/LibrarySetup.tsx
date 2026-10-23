import { useEffect, useState } from 'react'
import type { ArchiveProgress, LibraryStatus } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { displayPath, folderName } from '../../lib/library'
import { ARCHIVE_UNAVAILABLE, FILE_MANAGER } from '../../lib/platform'
import DevBadge, { VariantBadge } from '../DevBadge'
import { noticeTones } from '../ui/Banner'
import { buttonClass } from '../ui/button'
import FolderDecision from './FolderDecision'
import FolderTree from './FolderTree'
import SwitchingOverlay from './SwitchingOverlay'
import { useFolderChoice, useLibrarySwitch } from './useLibrarySwitch'

interface Props {
  status: LibraryStatus
  /** Asks main again; resolves with the new status (the app leaves this screen once it is ready). */
  onRetry: () => Promise<LibraryStatus | undefined>
  /** Running as "Studio Dev" with its own settings and library. */
  devProfile?: boolean
  /** The variant this is ("Test"), with its own settings and library. */
  variant?: string
}

const link = 'text-[12px] text-muted transition hover:text-text disabled:opacity-40'

/**
 * Full-window screen shown instead of the app until a reachable library folder is chosen: one question, the folder
 * once (the tree's root, what goes in it folded away), one row of actions, and importing an exported library as a
 * link under them.
 */
export default function LibrarySetup({ status, onRetry, devProfile = false, variant }: Props) {
  const choice = useFolderChoice()
  const switcher = useLibrarySwitch(status)
  const [retrying, setRetrying] = useState(false)
  const [stillMissing, setStillMissing] = useState(false)

  const missing = status.state === 'missing'
  const legacy = status.state === 'unconfigured' && status.legacy?.hasContent ? status.legacy : undefined
  const busy = switcher.phase.kind !== 'idle'
  const { inspection } = choice
  const treeRoot = inspection?.path ?? (missing ? status.root : undefined) ?? status.suggested

  const retry = async () => {
    setRetrying(true)
    setStillMissing(false)
    try {
      const next = await onRetry()
      setStillMissing(next?.state === 'missing')
    } finally {
      setRetrying(false)
    }
  }

  const chooseOther = () => {
    switcher.clearError()
    setStillMissing(false)
    void choice.choose()
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="drag h-12 shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl px-8 pb-16 pt-4">
          <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            JIBES Studio
            {variant && <VariantBadge name={variant} />}
            {devProfile && <DevBadge />}
          </div>

          {missing && status.error ? (
            <>
              <h1 className="text-xl font-semibold">The library couldn't be opened</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Studio finds the folder{' '}
                <span className="break-all font-mono text-[12px] text-text select-text">
                  {status.root ? displayPath(status.root) : '–'}
                </span>{' '}
                but couldn't open the library in it:
              </p>
              <p
                role="alert"
                className={`mt-2 rounded-md border px-3 py-2 text-[12px] leading-relaxed select-text ${noticeTones.error}`}
              >
                {status.error}
              </p>
              <p className="mt-2 leading-relaxed text-muted">
                Nothing has been deleted. Try again, or choose another folder for now.
              </p>
            </>
          ) : missing ? (
            <>
              <h1 className="text-xl font-semibold">The library folder can't be found</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Studio looked in{' '}
                <span className="break-all font-mono text-[12px] text-text select-text">
                  {status.root ? displayPath(status.root) : '–'}
                </span>
              </p>
              <p className="mt-2 leading-relaxed text-muted">
                If it's on an external disk, connect the disk and try again. If you moved or renamed the folder in{' '}
                {FILE_MANAGER}, you can choose it where it is now.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">Where should Studio save everything?</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Choose a folder for your library. Studio keeps everything there in clearly named folders you can open
                in {FILE_MANAGER}.
              </p>
              {legacy && (
                <p className={`mt-3 rounded-md border px-3 py-2 text-[12px] leading-relaxed ${noticeTones.info}`}>
                  {legacy.oldLayout ? 'Studio found your library from an earlier version in' : 'Studio found your library in'}{' '}
                  <span className="font-mono text-text">{displayPath(legacy.path)}</span>.{' '}
                  {legacy.oldLayout
                    ? 'It comes along to the folder you choose and is sorted into the new folders.'
                    : 'It comes along to the folder you choose.'}
                </p>
              )}
            </>
          )}

          <div className="mt-6 rounded-lg border border-line bg-panel p-3">
            <FolderTree
              rootName={folderName(treeRoot)}
              rootDetail={displayPath(treeRoot)}
              detail="example"
              collapsible="What goes in the folder?"
            />
          </div>

          <div className="mt-6">
            {inspection ? (
              <>
                <FolderDecision
                  inspection={inspection}
                  status={status}
                  busy={busy || choice.checking}
                  error={switcher.error}
                  onConfirm={(mode) => void switcher.start(inspection.path, mode)}
                />
                <div className="mt-4 flex items-center gap-4">
                  <button onClick={chooseOther} disabled={busy || choice.checking} className={link}>
                    Choose another folder…
                  </button>
                  {missing && (
                    <button onClick={() => void retry()} disabled={busy || retrying} className={link}>
                      {retrying ? 'Looking…' : 'Look for the old folder again'}
                    </button>
                  )}
                </div>
              </>
            ) : missing ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void retry()}
                  disabled={retrying || choice.checking}
                  className={buttonClass('primary', 'lg')}
                >
                  {retrying ? 'Looking…' : 'Try again'}
                </button>
                <button
                  type="button"
                  onClick={chooseOther}
                  disabled={retrying || choice.checking}
                  className={buttonClass('secondary', 'lg')}
                >
                  Choose another folder…
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {/* The path is in the tree's root row above; the button names it only in its tooltip. */}
                <button
                  type="button"
                  onClick={() => void choice.inspect(status.suggested)}
                  disabled={choice.checking}
                  title={status.suggested}
                  className={buttonClass('primary', 'lg')}
                >
                  Use this folder
                </button>
                <button
                  type="button"
                  onClick={chooseOther}
                  disabled={choice.checking}
                  className={buttonClass('secondary', 'lg')}
                >
                  Choose folder…
                </button>
              </div>
            )}

            {/* Off a Mac main can't unpack an exported library (ARCHIVE_UNAVAILABLE): not offered. */}
            {!ARCHIVE_UNAVAILABLE && <ImportArchive disabled={busy || choice.checking} />}

            {choice.checking && <p className="mt-3 text-[12px] text-muted">Checking the folder…</p>}
            {stillMissing && !retrying && (
              <p role="status" className="mt-3 text-[12px] text-warning">
                {status.error ? "The library still can't be opened." : "The folder still can't be reached."}
              </p>
            )}
            {choice.error && (
              <p role="alert" className="mt-3 text-[12px] text-danger select-text">
                {choice.error}
              </p>
            )}
          </div>

          <p className="mt-8 text-[11px] leading-relaxed text-muted">You can change the folder later in Settings.</p>
        </div>
      </div>
      <SwitchingOverlay phase={switcher.phase} />
    </div>
  )
}

/**
 * "Import a library…", a link under the actions: on a new Mac the zip from Settings → Library → Export library… is
 * opened from here, since the rest of the app (and Settings) waits for a library. Main unpacks it into a folder the
 * user chooses and opens it; the window reloads into the library. Progress and errors on the line below.
 */
function ImportArchive({ disabled }: { disabled: boolean }) {
  const [progress, setProgress] = useState<ArchiveProgress>()
  const [error, setError] = useState<string>()
  const running = !!progress && !['done', 'failed', 'cancelled'].includes(progress.phase)

  useEffect(() => window.studio.onArchiveProgress((p) => p.kind === 'import' && setProgress(p)), [])

  const start = async () => {
    setError(undefined)
    try {
      await window.studio.importLibraryArchive()
    } catch (e) {
      setError(ipcErrorMessage(e))
      setProgress(undefined)
    }
  }

  const percent =
    progress?.total && progress.done !== undefined ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : undefined

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => void start()}
        disabled={disabled || running}
        title="Open a library exported from Studio on another computer (a zip file)"
        className="text-[12px] text-text underline-offset-2 transition hover:underline disabled:opacity-40"
      >
        Import a library…
      </button>
      {running && (
        <div role="status" className="mt-1.5 flex items-center gap-3 text-[12px]">
          <span className="min-w-0 flex-1 truncate text-muted">
            {progress?.message ?? 'Importing…'}
            {percent !== undefined && ` · ${percent}%`}
          </span>
          <button type="button" onClick={() => void window.studio.cancelLibraryArchive()} className={link}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger select-text">
          {error}
        </p>
      )}
    </div>
  )
}
