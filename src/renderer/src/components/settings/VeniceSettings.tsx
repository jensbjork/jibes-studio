import { useState } from 'react'
import { SettingsItem, StatusPill } from './SettingsLayout'

/** Inställningar → Venice: the API key, saved in the macOS keychain, and a test of it. */
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
      title="API-nyckel"
      status={hasApiKey ? <StatusPill tone="ok">Sparad</StatusPill> : <StatusPill tone="missing">Saknas</StatusPill>}
      help={
        <>
          Skapa en under <span className="text-text">venice.ai → Settings → API</span>. Den sparas krypterad i
          macOS-nyckelringen och skickas bara till Venice.
        </>
      }
    >
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key && save()}
          placeholder={hasApiKey ? '•••••••• (sparad – klistra in för att byta)' : 'Klistra in nyckel'}
          aria-label="Venice API-nyckel"
          className="min-w-0 flex-1 rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted"
        />
        <button
          onClick={save}
          disabled={!key || busy}
          className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          Spara
        </button>
        {hasApiKey && (
          <button
            onClick={test}
            disabled={busy}
            className="rounded-md border border-line px-4 py-2 hover:bg-raised disabled:opacity-40"
          >
            Testa
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
