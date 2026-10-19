import { useState } from 'react'
import { isMac, isWindows } from '../../lib/platform'
import { SettingsItem, StatusPill } from './SettingsLayout'

/** Where the key is kept: Electron's safeStorage, which uses the keychain on a Mac and the user account on Windows. */
const KEY_STORE = isMac ? 'in the macOS keychain' : isWindows ? 'for your Windows user account' : 'on this computer'

/** Settings → Venice: the API key, saved in the macOS keychain, and a test of it. */
export default function VeniceSettings({ hasApiKey, onChanged }: { hasApiKey: boolean; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const save = async () => {
    setBusy(true)
    setResult(null)
    await window.studio.setApiKey(key)
    setKey('')
    onChanged()
    setResult(await window.studio.testApiKey())
    setBusy(false)
  }

  const test = async () => {
    setBusy(true)
    setResult(await window.studio.testApiKey())
    setBusy(false)
  }

  return (
    <SettingsItem
      title="API key"
      status={hasApiKey ? <StatusPill tone="ok">Saved</StatusPill> : <StatusPill tone="missing">Missing</StatusPill>}
      help={
        <>
          Create one under <span className="text-text">venice.ai → Settings → API</span>. It’s stored encrypted{' '}
          {KEY_STORE} and only sent to Venice.
        </>
      }
    >
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key && save()}
          placeholder={hasApiKey ? '•••••••• (saved – paste to replace)' : 'Paste key'}
          aria-label="Venice API key"
          className="min-w-0 flex-1 rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted"
        />
        <button
          onClick={save}
          disabled={!key || busy}
          className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          Save
        </button>
        {hasApiKey && (
          <button
            onClick={test}
            disabled={busy}
            className="rounded-md border border-line px-4 py-2 hover:bg-raised disabled:opacity-40"
          >
            Test
          </button>
        )}
      </div>
      {result && (
        <p className={`mt-2.5 text-[12px] ${result.ok ? 'text-emerald-400' : 'text-accent'}`} role="status">
          {result.message}
        </p>
      )}
    </SettingsItem>
  )
}
