import { useEffect, useMemo, useState } from 'react'
import type { Settings, UpdateInfo } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { INSTALLED_APP } from '../../lib/platform'
import { updateNow } from '../../lib/updates'
import { buttonClass } from '../ui/button'
import { SettingsItem } from './SettingsLayout'
import { SwitchRow } from './Switch'
import ToolsSettings, { type FfmpegCheck } from './ToolsSettings'

interface Versions {
  studio?: string
  electron?: string
  chrome?: string
}

/**
 * Studio's own version and the Electron and Chromium it runs on, read from the window's user agent (Electron puts
 * "<app>/<version> Chrome/<version> Electron/<version>" there), so no extra call to main is needed.
 */
function readVersions(userAgent: string): Versions {
  const chrome = /\bChrome\/([\d.]+)/.exec(userAgent)?.[1]
  const electron = /\bElectron\/([\d.]+[\w.-]*)/.exec(userAgent)?.[1]
  // The token right before "Chrome/": the app's name and version ("Studio/0.1.0", "Studio Dev/0.1.0").
  const studio = /\/(\d+\.\d+\.\d+[\w.-]*)\s+Chrome\//.exec(userAgent)?.[1]
  return { studio, electron, chrome }
}

/**
 * Settings → About: the version (and which profile this is) as plain text, updates, then the programs Studio uses
 * (ToolsSettings). `ffmpeg` is SettingsView's check, which also puts the dot on the pane's tab.
 */
export default function AboutSettings({
  settings,
  onChanged,
  ffmpeg
}: {
  settings: Settings
  onChanged: () => void
  ffmpeg: FfmpegCheck
}) {
  const { devProfile, variant } = settings
  const versions = useMemo(() => readVersions(navigator.userAgent), [])
  const engine = [
    versions.electron ? `Electron ${versions.electron}` : '',
    versions.chrome ? `Chromium ${versions.chrome.split('.')[0]}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <div>
        <p className="select-text">
          <span className="font-medium">JIBES Studio{variant && ` ${variant}`}</span>
          {versions.studio && <span className="tabular-nums"> {versions.studio}</span>}
          {devProfile && <span className="text-muted"> · development version (Studio Dev)</span>}
        </p>
        {engine && <p className="mt-0.5 text-[12px] text-muted select-text tabular-nums">{engine}</p>}
        {(devProfile || variant) && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            Has its own settings and its own library, separate from {INSTALLED_APP}.
          </p>
        )}
      </div>
      <UpdateSettings settings={settings} onChanged={onChanged} />
      <ToolsSettings ffmpeg={ffmpeg} />
    </>
  )
}

/** "21 Oct 2026, 14:02". */
function checkedText(iso: string | undefined): string {
  const date = iso ? new Date(iso) : undefined
  if (!date || !Number.isFinite(date.getTime())) return 'Not checked yet.'
  const when = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
  return `Last checked ${when}.`
}

/**
 * Updates: Check for updates (an update found also shows the notice), the daily check on or off, and when Studio
 * last asked. A development build says where its updates come from instead.
 */
function UpdateSettings({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const [checking, setChecking] = useState(false)
  const [answer, setAnswer] = useState<UpdateInfo>()
  const [error, setError] = useState<string>()
  const [auto, setAuto] = useState(settings.autoUpdateCheck)
  const [saving, setSaving] = useState(false)
  useEffect(() => setAuto(settings.autoUpdateCheck), [settings.autoUpdateCheck])

  if (settings.developmentBuild) {
    return (
      <SettingsItem title="Updates">
        <p className="leading-relaxed text-muted">
          {settings.variant
            ? `Studio ${settings.variant} is built from the source – updates come from git, never from GitHub, ` +
              'where a release would replace it with Studio.'
            : 'Development build – updates come from git.'}
        </p>
      </SettingsItem>
    )
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    setError(undefined)
    setAnswer(undefined)
    try {
      setAnswer(await window.studio.checkForUpdates())
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  const changeAuto = async (next: boolean): Promise<void> => {
    const before = auto
    setAuto(next)
    setSaving(true)
    setError(undefined)
    try {
      await window.studio.setAutoUpdateCheck(next)
      onChanged()
    } catch (e) {
      setAuto(before)
      setError(ipcErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsItem
      title="Updates"
      help="Studio asks GitHub whether a newer version is out. Nothing is downloaded until you choose Update now."
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={() => void check()} disabled={checking} className={buttonClass()}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <span className="text-[12px] text-muted" role="status">
          {checking ? '' : checkedText(settings.lastUpdateCheck)}
        </span>
      </div>
      {answer && <AnswerLine info={answer} />}
      {error && (
        <p role="alert" className="mt-2.5 text-[12px] text-danger select-text">
          {error}
        </p>
      )}
      <div className="mt-5">
        <SwitchRow
          on={auto}
          disabled={saving}
          onChange={(next) => void changeAuto(next)}
          label="Check for updates automatically"
          description="Once a day, when Studio starts."
        />
      </div>
    </SettingsItem>
  )
}

/** What Check for updates found. */
function AnswerLine({ info }: { info: UpdateInfo }) {
  if (!info.available) {
    return (
      <p role="status" className="mt-2.5 text-[12px] text-success">
        Studio is up to date ({info.current} is the newest version).
      </p>
    )
  }
  return (
    <div className="mt-2.5 text-[12px] leading-relaxed">
      <p>
        <span className="font-medium">Studio {info.latest} is available</span>
        <span className="text-muted"> – you have {info.current}.</span>
      </p>
      {info.installBlocked ? (
        <p className="mt-0.5 text-muted select-text">{info.installBlocked}</p>
      ) : (
        <button type="button" onClick={() => void updateNow()} className={`mt-2 ${buttonClass('primary')}`}>
          Update now
        </button>
      )}
    </div>
  )
}
