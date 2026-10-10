import { useCallback, useEffect, useState } from 'react'
import type { FfmpegStatus } from '@shared/types'
import { ipcErrorMessage, useSeparationStatus } from '../../lib/hooks'
import CopyButton from '../agent/CopyButton'
import { SettingsItem, StatusPill } from './SettingsLayout'

const INSTALL_COMMAND = 'brew install ffmpeg'

export interface FfmpegCheck {
  /** Undefined until the first check is done. */
  status?: FfmpegStatus
  checking: boolean
  check: () => Promise<void>
}

/** Whether ffmpeg was found, checked when Inställningar opens and again on "Kontrollera igen". */
export function useFfmpegStatus(): FfmpegCheck {
  const [status, setStatus] = useState<FfmpegStatus>()
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await window.studio.ffmpegStatus())
    } catch (e) {
      setStatus({ ok: false, message: ipcErrorMessage(e) })
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  return { status, checking, check }
}

/** Inställningar → Verktyg: the programs on this Mac that Studio uses, ffmpeg and Apple's voice separation. */
export default function ToolsSettings({ ffmpeg }: { ffmpeg: FfmpegCheck }) {
  return (
    <>
      <FfmpegSetting {...ffmpeg} />
      <VoiceSeparationSetting />
    </>
  )
}

/**
 * Shows whether ffmpeg was found; sequences (the start and end frames clips take from their neighbours, frames
 * saved as stills, export) and thumbnails depend on it.
 */
function FfmpegSetting({ status, checking, check }: FfmpegCheck) {
  return (
    <SettingsItem
      title="ffmpeg"
      status={
        status && (status.ok ? <StatusPill tone="ok">Hittad</StatusPill> : <StatusPill tone="missing">Saknas</StatusPill>)
      }
      help="Används för miniatyrbilder, för start- och slutbilder från grannklippen och för att exportera sekvenser till en film."
    >
      {!status ? (
        <p className="text-muted">Kontrollerar…</p>
      ) : status.ok ? (
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="shrink-0">ffmpeg hittades</span>
            {status.version && (
              <span className="min-w-0 truncate text-muted" title={status.version}>
                · {status.version}
              </span>
            )}
          </p>
          {status.path && (
            <button
              onClick={() => window.studio.revealFile(status.path!)}
              title="Visa i Finder"
              className="mt-1.5 block max-w-full truncate pl-4 font-mono text-xs text-muted hover:text-text"
            >
              {status.path}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2.5">
          <p className="flex items-start gap-2 text-accent">
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="select-text">{status.message ?? 'ffmpeg hittades inte.'}</span>
          </p>
          <p className="mt-3 text-muted">Installera med Homebrew i Terminal:</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs select-text">
              {INSTALL_COMMAND}
            </code>
            <CopyButton text={INSTALL_COMMAND} className="rounded-md border border-line px-3 py-2 hover:bg-raised" />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Utan ffmpeg kan du fortfarande generera, men inte fortsätta från föregående klipp eller exportera
            sekvenser. Hittas den inte efter installationen, starta om Studio.
          </p>
        </div>
      )}

      {status && (
        <button
          onClick={() => void check()}
          disabled={checking}
          className="mt-2 text-[11px] text-muted hover:text-text disabled:opacity-40"
        >
          {checking ? 'Kontrollerar…' : 'Kontrollera igen'}
        </button>
      )}
    </SettingsItem>
  )
}

/**
 * Röstseparering: whether this Mac can tell the voice from the background (Apple's built-in sound isolation, used
 * by Redigera for Ta bort rösten, Bara rösten and keeping the background under a new voice).
 */
function VoiceSeparationSetting() {
  const status = useSeparationStatus()
  return (
    <SettingsItem
      title="Röstseparering"
      status={
        status &&
        (status.available ? (
          <StatusPill tone="ok">Finns</StatusPill>
        ) : (
          <StatusPill tone="neutral">Saknas</StatusPill>
        ))
      }
      help="Används i Redigera för att ta bort rösten, behålla bara rösten, eller byta röst och behålla musik och effekter."
    >
      {!status ? (
        <p className="text-muted">Kontrollerar…</p>
      ) : (
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="flex items-start gap-2">
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${status.available ? 'bg-emerald-400' : 'bg-muted'}`}
            />
            <span className="select-text">
              {status.available
                ? `Apple (inbyggd, ${status.quality === 'standard' ? 'standardkvalitet' : 'hög kvalitet'})`
                : (status.message ?? 'Röstseparering saknas på den här datorn.')}
            </span>
          </p>
          {!status.available && (
            <p className="mt-1.5 pl-4 text-[11px] leading-relaxed text-muted">
              Allt annat i Redigera fungerar ändå; där rösten byts sänks originalljudet i stället.
            </p>
          )}
        </div>
      )}
    </SettingsItem>
  )
}
