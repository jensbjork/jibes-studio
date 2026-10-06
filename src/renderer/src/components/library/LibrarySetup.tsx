import { useState } from 'react'
import type { LibraryStatus } from '@shared/types'
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
              <h1 className="text-xl font-semibold">Biblioteket kunde inte öppnas</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Studio hittar mappen{' '}
                <span className="break-all font-mono text-[12px] text-text select-text">
                  {status.root ? displayPath(status.root) : '–'}
                </span>{' '}
                men kunde inte öppna biblioteket i den:
              </p>
              <p className="mt-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] leading-relaxed text-[#ffb3b5] select-text">
                {status.error}
              </p>
              <p className="mt-2 leading-relaxed text-muted">
                Inget har raderats. Försök igen, eller välj en annan mapp så länge.
              </p>
            </>
          ) : missing ? (
            <>
              <h1 className="text-xl font-semibold">Biblioteksmappen hittas inte</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Biblioteksmappen hittas inte:{' '}
                <span className="break-all font-mono text-[12px] text-text select-text">
                  {status.root ? displayPath(status.root) : '–'}
                </span>
              </p>
              <p className="mt-2 leading-relaxed text-muted">
                Ligger den på en extern disk, anslut disken och försök igen. Har du flyttat eller döpt om mappen i
                Finder kan du välja den där den ligger nu.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">Var ska Studio spara allt?</h1>
              <p className="mt-2 leading-relaxed text-muted">
                Välj en grundmapp på datorn. Där samlar Studio karaktärer, miljöer, kläder, referensbilder,
                genererade videor och sekvenser i tydligt namngivna mappar, så att du kan gå in och titta i Finder
                när du vill.
              </p>
              {legacy && (
                <p className="mt-3 rounded-md border border-line bg-panel px-3 py-2 text-[12px] leading-relaxed text-muted">
                  {legacy.oldLayout ? 'Studio hittade ditt bibliotek från en tidigare version i' : 'Studio hittade ditt bibliotek i'}{' '}
                  <span className="font-mono text-text">{displayPath(legacy.path)}</span>.{' '}
                  {legacy.oldLayout
                    ? 'Det följer med till mappen du väljer och sorteras in i de nya mapparna.'
                    : 'Det följer med till mappen du väljer.'}
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
                    Välj en annan mapp…
                  </button>
                  {missing && (
                    <button onClick={() => void retry()} disabled={busy || retrying} className={link}>
                      {retrying ? 'Letar…' : 'Leta efter den gamla mappen igen'}
                    </button>
                  )}
                </div>
              </>
            ) : missing ? (
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => void retry()} disabled={retrying || choice.checking} className={primary}>
                  {retrying ? 'Letar…' : 'Försök igen'}
                </button>
                <button onClick={chooseOther} disabled={retrying || choice.checking} className={secondary}>
                  Välj en annan mapp…
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
                  Använd {displayPath(status.suggested)}
                </button>
                <button onClick={chooseOther} disabled={choice.checking} className={secondary}>
                  Välj mapp…
                </button>
              </div>
            )}

            {choice.checking && <p className="mt-3 text-[12px] text-muted">Kontrollerar mappen…</p>}
            {stillMissing && !retrying && (
              <p className="mt-3 text-[12px] text-amber-200">
                {status.error ? 'Biblioteket går fortfarande inte att öppna.' : 'Mappen går fortfarande inte att nå.'}
              </p>
            )}
            {choice.error && <p className="mt-3 text-[12px] text-accent select-text">{choice.error}</p>}
          </div>

          <p className="mt-8 text-[11px] leading-relaxed text-muted">
            Du kan byta mapp senare under Inställningar. Allt du gör sparas i grundmappen, så den går att
            säkerhetskopiera eller flytta i ett stycke.
          </p>
        </div>
      </div>
      <SwitchingOverlay phase={switcher.phase} />
    </div>
  )
}
