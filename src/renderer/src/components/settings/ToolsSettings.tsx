import { useCallback, useEffect, useState } from 'react'
import type { FfmpegStatus } from '@shared/types'
import { NO_SEPARATION, ipcErrorMessage, useSeparationStatus } from '../../lib/hooks'
import { FILE_MANAGER, isMac } from '../../lib/platform'
import CopyButton from '../agent/CopyButton'
import { SettingsItem, StatusPill } from './SettingsLayout'

/** The quiet text buttons under a status ("Check again"). */
const textButton = 'text-[12px] text-muted transition hover:text-text disabled:opacity-40'

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

/**
 * The programs on this Mac (or PC) that Studio uses, ffmpeg and Apple's voice separation, as two settings of
 * Settings → About. Each shows one status; the boxed help only when something is missing.
 */
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
 * saved as stills, export) and thumbnails depend on it. Found, a muted line with its version and where it is
 * (data-ffmpeg="found": the release smoke test waits for it).
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
        <p data-ffmpeg="found" className="flex min-w-0 items-baseline gap-1.5 text-[12px] text-muted">
          {status.version && (
            <span className="max-w-40 shrink-0 truncate select-text" title={status.version}>
              {status.version}
            </span>
          )}
          {status.version && status.path && <span aria-hidden>·</span>}
          {status.path && (
            <button
              type="button"
              onClick={() => window.studio.revealFile(status.path!)}
              title={`Show in ${FILE_MANAGER}`}
              className="min-w-0 truncate font-mono text-[11px] transition hover:text-text"
            >
              {status.path}
            </button>
          )}
        </p>
      ) : (
        <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2.5">
          <p role="alert" className="flex items-start gap-2 text-danger">
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="select-text">{status.message ?? 'ffmpeg wasn’t found.'}</span>
          </p>
          {/* On Windows ffmpeg comes with Studio: the message says how to get it back. */}
          {isMac && (
            <>
              <p className="mt-3 text-muted">Install it with Homebrew in Terminal:</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] select-text">
                  {INSTALL_COMMAND}
                </code>
                <CopyButton text={INSTALL_COMMAND} />
              </div>
            </>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Without ffmpeg you can still generate, but not continue from the previous clip or export sequences.
            {isMac && ' If it isn’t found after installing, restart Studio.'}
          </p>
        </div>
      )}

      {status && !status.ok && (
        <button type="button" onClick={() => void check()} disabled={checking} className={`mt-2 ${textButton}`}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      )}
    </SettingsItem>
  )
}

/**
 * Voice separation: whether this Mac can tell the voice from the background (Apple's built-in sound isolation, used
 * by the Editor for Remove the voice, Only the voice and keeping the background under a new voice). Available, the
 * pill and one muted line; missing on a Mac, why, in a box; on Windows, where it never is, the pill alone.
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
          <StatusPill tone="neutral">{isMac ? 'Missing' : 'macOS only'}</StatusPill>
        ))
      }
      help="Used in the Editor to remove the voice, keep only the voice, or change the voice and keep music and effects."
    >
      {!status ? (
        <p className="text-muted">Checking…</p>
      ) : status.available ? (
        <p className="text-[12px] text-muted">
          Apple, {status.quality === 'standard' ? 'standard quality' : 'high quality'}
        </p>
      ) : (
        isMac && (
          <div className="rounded-md border border-line bg-raised px-3 py-2.5">
            <p className="select-text">{status.message ?? NO_SEPARATION}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Everything else in the Editor works anyway; where the voice changes, the original sound is lowered instead.
            </p>
          </div>
        )
      )}
    </SettingsItem>
  )
}
