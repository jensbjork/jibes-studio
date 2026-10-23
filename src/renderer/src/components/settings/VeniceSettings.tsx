import { useState } from 'react'
import { ipcErrorMessage } from '../../lib/hooks'
import { isMac, isWindows } from '../../lib/platform'
import { buttonClass } from '../ui/button'
import { SaveActions, SettingsItem, StatusPill } from './SettingsLayout'

/** Where the key is kept: Electron's safeStorage, which uses the keychain on a Mac and the user account on Windows. */
const KEY_STORE = isMac ? 'in the macOS keychain' : isWindows ? 'for your Windows user account' : 'on this computer'

/** Venice's page for API keys (main opens target=_blank links in the browser). */
const KEY_PAGE = 'https://venice.ai/settings/api'

/**
 * Settings → Venice: the API key, saved encrypted, and a test of it. Without a key the field has the focus and Save is
 * the page's one main button (the first thing a new library asks for); with one, the field only replaces it, and
 * saves the way every typed setting does (SaveActions; Esc empties it).
 */
export default function VeniceSettings({ hasApiKey, onChanged }: { hasApiKey: boolean; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const save = async () => {
    if (!key || busy) return
    setBusy(true)
    setResult(null)
    try {
      await window.studio.setApiKey(key)
      // Only after it was saved: a failed save keeps the pasted key in the field.
      setKey('')
      onChanged()
      setResult(await window.studio.testApiKey())
    } catch (e) {
      setResult({ ok: false, message: ipcErrorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    try {
      setResult(await window.studio.testApiKey())
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsItem
      title="API key"
      status={hasApiKey ? <StatusPill tone="ok">Saved</StatusPill> : <StatusPill tone="missing">Missing</StatusPill>}
      help={
        <>
          <a
            href={KEY_PAGE}
            target="_blank"
            rel="noreferrer"
            className="text-text underline underline-offset-2 hover:text-white"
          >
            Get a key at venice.ai
          </a>
          . It’s stored encrypted {KEY_STORE} and only sent to Venice.
        </>
      }
    >
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key && !busy) void save()
            if (e.key === 'Escape' && hasApiKey && key) {
              e.preventDefault()
              setKey('')
            }
          }}
          // Only when the page opens without a key (React applies it on mount): the key is pasted straight in.
          autoFocus={!hasApiKey}
          placeholder={hasApiKey ? '•••••••• (saved – paste to replace)' : 'Paste key'}
          aria-label="Venice API key"
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-raised px-3 outline-none focus:border-muted"
        />
        {hasApiKey ? (
          <>
            <SaveActions dirty={!!key} saving={busy} onSave={() => void save()} onRevert={() => setKey('')} />
            <button type="button" onClick={() => void test()} disabled={busy} className={buttonClass()}>
              Test
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void save()} disabled={!key || busy} className={buttonClass('primary')}>
            Save
          </button>
        )}
      </div>
      {result && (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={`mt-2.5 text-[12px] select-text ${result.ok ? 'text-success' : 'text-danger'}`}
        >
          {result.message}
        </p>
      )}
    </SettingsItem>
  )
}
