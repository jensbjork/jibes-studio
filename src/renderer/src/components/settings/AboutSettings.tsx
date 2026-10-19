import { useMemo } from 'react'
import { INSTALLED_APP } from '../../lib/platform'

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

/** Settings → About Studio: the version, and which profile this is. */
export default function AboutSettings({ devProfile }: { devProfile: boolean }) {
  const versions = useMemo(() => readVersions(navigator.userAgent), [])
  const engine = [
    versions.electron ? `Electron ${versions.electron}` : '',
    versions.chrome ? `Chromium ${versions.chrome.split('.')[0]}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="rounded-md border border-line bg-raised/40 px-3 py-2.5">
      <p className="select-text">
        <span className="font-medium">Studio</span>
        {versions.studio && <span className="tabular-nums"> {versions.studio}</span>}
        {devProfile && <span className="text-muted"> · development version (Studio Dev)</span>}
      </p>
      {engine && <p className="mt-0.5 text-[12px] text-muted select-text tabular-nums">{engine}</p>}
      {devProfile && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          Has its own settings and its own library, separate from {INSTALLED_APP}.
        </p>
      )}
    </div>
  )
}
