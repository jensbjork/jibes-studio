import { useState } from 'react'
import { PROVIDERS, providerKeyPage, providerName, type Provider } from '@shared/provider'
import type { Settings } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { returnToSettingsAfterReload } from '../../lib/initProvider'
import { isMac, isWindows } from '../../lib/platform'
import { buttonClass } from '../ui/button'
import Segmented from '../ui/Segmented'
import { SaveActions, SettingsItem, StatusPill } from './SettingsLayout'

/** Where the key is kept: Electron's safeStorage, which uses the keychain on a Mac and the user account on Windows. */
const KEY_STORE = isMac ? 'in the macOS keychain' : isWindows ? 'for your Windows user account' : 'on this computer'

/** What each service is, in a line. */
const ABOUT: Record<Provider, string> = {
  venice: 'Private, uncensored models: Seedance, Kling, Wan and more, priced by Venice before you generate.',
  fal: 'Seedance 2.5 and 2.0, Kling 4.0 and 3, Veo 3.1, plus lip sync in the Editor. Studio works out the price.'
}

/**
 * Settings → Service: which service Studio generates with (Venice or fal.ai), and its API key, saved encrypted, with a
 * test. Switching starts the window over with the new service's models and prices; the other key stays saved.
 * Without a key the field has the focus and Save is the page's main button (the first thing a new library asks for).
 */
export default function ServiceSettings({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const provider = settings.provider
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string>()

  const choose = async (next: Provider) => {
    if (next === provider || switching) return
    setSwitching(true)
    setError(undefined)
    try {
      // Main reloads the window with the new service; it opens on Settings again.
      returnToSettingsAfterReload()
      await window.studio.setProvider(next)
    } catch (e) {
      setError(ipcErrorMessage(e))
      setSwitching(false)
    }
  }

  return (
    <>
      <SettingsItem
        title="Service"
        help={<>{ABOUT[provider]} What you made with the other service stays, and work already sent finishes there.</>}
      >
        <Segmented<Provider>
          ariaLabel="Service"
          value={provider}
          options={PROVIDERS.map((p) => ({ value: p, label: providerName(p), disabled: switching && p !== provider }))}
          onChange={(p) => void choose(p)}
        />
        {error && (
          <p role="alert" className="mt-2.5 text-[12px] text-danger select-text">
            {error}
          </p>
        )}
      </SettingsItem>
      <KeySetting
        key={provider}
        provider={provider}
        hasKey={settings.keys?.[provider] ?? settings.hasApiKey}
        onChanged={onChanged}
      />
    </>
  )
}

/** One service's API key: saved encrypted, tested. */
function KeySetting({ provider, hasKey, onChanged }: { provider: Provider; hasKey: boolean; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const name = providerName(provider)

  const save = async () => {
    if (!key || busy) return
    setBusy(true)
    setResult(null)
    try {
      await window.studio.setApiKey(key, provider)
      // Only after it was saved: a failed save keeps the pasted key in the field.
      setKey('')
      onChanged()
      setResult(await window.studio.testApiKey(provider))
    } catch (e) {
      setResult({ ok: false, message: ipcErrorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    try {
      setResult(await window.studio.testApiKey(provider))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsItem
      title={`${name} API key`}
      status={hasKey ? <StatusPill tone="ok">Saved</StatusPill> : <StatusPill tone="missing">Missing</StatusPill>}
      help={
        <>
          <a
            href={providerKeyPage(provider)}
            target="_blank"
            rel="noreferrer"
            className="text-text underline underline-offset-2 hover:text-white"
          >
            Get a key at {provider === 'fal' ? 'fal.ai' : 'venice.ai'}
          </a>
          . It’s stored encrypted {KEY_STORE} and only sent to {name}.
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
            if (e.key === 'Escape' && hasKey && key) {
              e.preventDefault()
              setKey('')
            }
          }}
          // Only when the page opens without a key (React applies it on mount): the key is pasted straight in.
          autoFocus={!hasKey}
          placeholder={hasKey ? '•••••••• (saved – paste to replace)' : 'Paste key'}
          aria-label={`${name} API key`}
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-raised px-3 outline-none focus:border-muted"
        />
        {hasKey ? (
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
