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

/** Whether ffmpeg was found, checked when Settings opens and again on "Check again". */
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

/** Settings → Tools: the programs on this Mac that Studio uses, ffmpeg and Apple's voice separation. */
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
        status && (status.ok ? <StatusPill tone="ok">Found</StatusPill> : <StatusPill tone="missing">Missing</StatusPill>)
      }
      help="Used for thumbnails, for start and end images from the neighbouring clips and for exporting sequences to a film."
    >
      {!status ? (
        <p className="text-muted">Checking…</p>
      ) : status.ok ? (
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="shrink-0">ffmpeg was found</span>
            {status.version && (
              <span className="min-w-0 truncate text-muted" title={status.version}>
                · {status.version}
              </span>
            )}
          </p>
          {status.path && (
            <button
              onClick={() => window.studio.revealFile(status.path!)}
              title="Show in Finder"
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
            <span className="select-text">{status.message ?? 'ffmpeg wasn’t found.'}</span>
          </p>
          <p className="mt-3 text-muted">Install it with Homebrew in Terminal:</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs select-text">
              {INSTALL_COMMAND}
            </code>
            <CopyButton text={INSTALL_COMMAND} className="rounded-md border border-line px-3 py-2 hover:bg-raised" />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Without ffmpeg you can still generate, but not continue from the previous clip or export sequences. If it
            isn’t found after installing, restart Studio.
          </p>
        </div>
      )}

      {status && (
        <button
          onClick={() => void check()}
          disabled={checking}
          className="mt-2 text-[11px] text-muted hover:text-text disabled:opacity-40"
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      )}
    </SettingsItem>
  )
}

/**
 * Voice separation: whether this Mac can tell the voice from the background (Apple's built-in sound isolation, used
 * by the Editor for Remove the voice, Only the voice and keeping the background under a new voice).
 */
function VoiceSeparationSetting() {
  const status = useSeparationStatus()
  return (
    <SettingsItem
      title="Voice separation"
      status={
        status &&
        (status.available ? (
          <StatusPill tone="ok">Available</StatusPill>
        ) : (
          <StatusPill tone="neutral">Missing</StatusPill>
        ))
      }
      help="Used in the Editor to remove the voice, keep only the voice, or change the voice and keep music and effects."
    >
      {!status ? (
        <p className="text-muted">Checking…</p>
      ) : (
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="flex items-start gap-2">
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${status.available ? 'bg-emerald-400' : 'bg-muted'}`}
            />
            <span className="select-text">
              {status.available
                ? `Apple (built in, ${status.quality === 'standard' ? 'standard quality' : 'high quality'})`
                : (status.message ?? "Voice separation isn't available on this Mac.")}
            </span>
          </p>
          {!status.available && (
            <p className="mt-1.5 pl-4 text-[11px] leading-relaxed text-muted">
              Everything else in the Editor works anyway; where the voice changes, the original sound is lowered instead.
            </p>
          )}
        </div>
      )}
    </SettingsItem>
  )
}
