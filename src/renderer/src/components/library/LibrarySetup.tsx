import { useEffect, useState } from 'react'
import type { ArchiveProgress, LibraryStatus } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { displayPath, folderName } from '../../lib/library'
import DevBadge from '../DevBadge'
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
}

const primary =
  'rounded-md bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-hover disabled:opacity-40'
const secondary = 'rounded-md border border-line px-4 py-2 transition hover:bg-raised disabled:opacity-40'
const link = 'text-[12px] text-muted transition hover:text-text disabled:opacity-40'

/** Full-window screen shown instead of the app until a reachable library folder is chosen. */
export default function LibrarySetup({ status, onRetry, devProfile = false }: Props) {
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
            Studio
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
              <p className="mt-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] leading-relaxed text-[#ffb3b5] select-text">
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
                The library folder can't be found:{' '}
                <span className="break-all font-mono text-[12px] text-text select-text">
                  {status.root ? displayPath(status.root) : '–'}
                </span>
              </p>
              <p className="mt-2 leading-relaxed text-muted">
                If it's on an external disk, connect the disk and try again. If you moved or renamed the folder in
                Finder, you can choose it where it is now.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">Where should Studio save everything?</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Choose a library folder on your computer. Studio keeps characters, environments, products, outfits,
                poses, reference images, generated videos, own clips, sequences, storyboards and edits there in
                clearly named folders, so you can look around in Finder whenever you like.
              </p>
              {legacy && (
                <p className="mt-3 rounded-md border border-line bg-panel px-3 py-2 text-[12px] leading-relaxed text-muted">
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
            <FolderTree rootName={folderName(treeRoot)} rootDetail={displayPath(treeRoot)} detail="example" />
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
                <button onClick={() => void retry()} disabled={retrying || choice.checking} className={primary}>
                  {retrying ? 'Looking…' : 'Try again'}
                </button>
                <button onClick={chooseOther} disabled={retrying || choice.checking} className={secondary}>
                  Choose another folder…
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void choice.inspect(status.suggested)}
                  disabled={choice.checking}
                  title={status.suggested}
                  className={primary}
                >
                  Use {displayPath(status.suggested)}
                </button>
                <button onClick={chooseOther} disabled={choice.checking} className={secondary}>
                  Choose folder…
                </button>
              </div>
            )}

            {choice.checking && <p className="mt-3 text-[12px] text-muted">Checking the folder…</p>}
            {stillMissing && !retrying && (
              <p className="mt-3 text-[12px] text-amber-200">
                {status.error ? "The library still can't be opened." : "The folder still can't be reached."}
              </p>
            )}
            {choice.error && <p className="mt-3 text-[12px] text-accent select-text">{choice.error}</p>}
          </div>

          <ImportArchive disabled={busy || choice.checking} />

          <p className="mt-8 text-[11px] leading-relaxed text-muted">
            You can change the folder later in Settings. Everything you do is saved in the library folder, so it can
            be backed up or moved in one piece.
          </p>
        </div>
      </div>
      <SwitchingOverlay phase={switcher.phase} />
    </div>
  )
}

/**
 * "Have an exported library?": on a new Mac the zip from Settings → Export & import is opened from here,
 * since the rest of the app (and Settings) waits for a library. Main unpacks it into a folder the user chooses
 * and opens it; the window reloads into the library.
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
    <div className="mt-6 rounded-lg border border-line px-4 py-3">
      <p className="text-[12px] leading-relaxed text-muted">
        Do you have a library you exported from Studio on another computer (a zip file)? Open it here instead.
      </p>
      {running ? (
        <div className="mt-2 flex items-center gap-3 text-[12px]">
          <span className="min-w-0 flex-1 truncate text-muted">
            {progress?.message ?? 'Importing…'}
            {percent !== undefined && ` · ${percent}%`}
          </span>
          <button onClick={() => void window.studio.cancelLibraryArchive()} className={link}>
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={() => void start()} disabled={disabled} className={`mt-2 ${link} text-text underline-offset-2 hover:underline`}>
          Import a library…
        </button>
      )}
      {error && <p className="mt-2 text-[12px] text-accent select-text">{error}</p>}
    </div>
  )
}
