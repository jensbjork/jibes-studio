import { useEffect, useState } from 'react'
import type { FfmpegStatus, Settings } from '@shared/types'
import { ipcErrorMessage, useSeparationStatus } from '../lib/hooks'
import AgentSettingsSection from './agent/AgentSettingsSection'
import LibrarySection from './library/LibrarySection'
import { refreshPromptLanguage } from './prompt/usePromptLanguage'

const INSTALL_COMMAND = 'brew install ffmpeg'

export default function SettingsView({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
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
    <div className="drag h-full overflow-y-auto">
      <div className="no-drag mx-auto max-w-xl px-8 pb-16 pt-14">
        <h1 className="mb-8 text-xl font-semibold">Inställningar</h1>

        <section className="mb-8">
          <h2 className="mb-1 font-medium">Venice API-nyckel</h2>
          <p className="mb-3 text-muted">
            Skapa en nyckel under <span className="text-text">venice.ai → Settings → API</span>. Den sparas krypterad i
            macOS-nyckelringen och lämnar aldrig datorn annat än mot Venice.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key && save()}
              placeholder={settings.hasApiKey ? '•••••••• (sparad – klistra in för att byta)' : 'Klistra in nyckel'}
              className="flex-1 rounded-md border border-line bg-raised px-3 py-2 outline-none focus:border-muted"
            />
            <button
              onClick={save}
              disabled={!key || busy}
              className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              Spara
            </button>
            {settings.hasApiKey && (
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
            <p className={`mt-3 ${result.ok ? 'text-emerald-400' : 'text-accent'}`}>{result.message}</p>
          )}
        </section>

        <PromptLanguageSection language={settings.promptLanguage ?? 'en'} onChanged={onChanged} />

        <ImageSafeModeSection on={settings.imageSafeMode !== false} onChanged={onChanged} />

        <AgentSettingsSection />

        <LibrarySection />

        <FfmpegSection />

        <VoiceSeparationSection />
      </div>
    </div>
  )
}

type PromptLanguage = Settings['promptLanguage']

/** The language of the text Studio writes into prompts when a character, outfit or place is inserted. */
function PromptLanguageSection({ language, onChanged }: { language: PromptLanguage; onChanged: () => void }) {
  const [value, setValue] = useState<PromptLanguage>(language)
  const [error, setError] = useState<string>()
  useEffect(() => setValue(language), [language])

  const change = async (next: PromptLanguage) => {
    const before = value
    setValue(next)
    setError(undefined)
    try {
      await window.studio.setPromptLanguage(next)
      // Prompt editors that stay mounted pick up the new connective ("wearing" / "i") at once.
      refreshPromptLanguage()
      onChanged()
    } catch (e) {
      setValue(before)
      setError(ipcErrorMessage(e))
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-medium">Promptspråk</h2>
      <p className="mb-3 text-muted">
        Språket i texten Studio skriver in när du infogar karaktärer, miljöer, produkter, kläder och poser i prompten.
        Videomodellerna förstår engelska bäst, så skriv gärna hela prompten på engelska.
      </p>
      <select
        value={value}
        onChange={(e) => void change(e.target.value as PromptLanguage)}
        aria-label="Promptspråk"
        className="rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
      >
        <option value="en">Engelska (rekommenderas)</option>
        <option value="sv">Svenska</option>
      </select>
      <p className="mt-2 text-[11px] text-muted">
        {value === 'en'
          ? 'Till exempel: Anna (@Image1, @Image2) wearing Röd klänning (@Image3)'
          : 'Till exempel: Anna (@Image1, @Image2) i Röd klänning (@Image3)'}
      </p>
      {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}
    </section>
  )
}

/**
 * "Säkert läge för bilder": Venice's safe_mode for the stills Studio creates (keyframes and other storyboard
 * images). On by default, as in Venice; the image dialog shows the same setting.
 */
function ImageSafeModeSection({ on, onChanged }: { on: boolean; onChanged: () => void }) {
  const [value, setValue] = useState(on)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => setValue(on), [on])

  const change = async (next: boolean) => {
    const before = value
    setValue(next)
    setSaving(true)
    setError(undefined)
    try {
      await window.studio.setImageSafeMode(next)
      onChanged()
    } catch (e) {
      setValue(before)
      setError(ipcErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-medium">Bilder</h2>
      <p className="mb-3 text-muted">
        Gäller bilderna du skapar med <span className="text-text">Skapa bild</span> – start- och slutbilder och andra
        bilder till dina storyboards. Videorna påverkas inte.
      </p>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={value}
          disabled={saving}
          onChange={(e) => void change(e.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span>
          <span className="block">Säkert läge för bilder</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
            {value
              ? 'På: Venice suddar ut vuxet innehåll i bilderna. Stäng av det om bilder blir suddiga utan anledning.'
              : 'Av: Venice suddar inte ut vuxet innehåll i bilderna.'}
          </span>
        </span>
      </label>
      {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}
    </section>
  )
}

/**
 * Shows whether ffmpeg was found; sequences (the start and end frames clips take from their neighbours, frames
 * saved as stills, export) and thumbnails depend on it.
 */
function FfmpegSection() {
  const [status, setStatus] = useState<FfmpegStatus>()
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      setStatus(await window.studio.ffmpegStatus())
    } catch (e) {
      setStatus({ ok: false, message: ipcErrorMessage(e) })
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; the command is selectable text anyway.
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-medium">ffmpeg</h2>
      <p className="mb-3 text-muted">
        Används för miniatyrbilder, för att fortsätta ett klipp från föregående klipps sista bildruta och för att
        exportera sekvenser till en film.
      </p>

      {!status ? (
        <p className="text-muted">Kontrollerar…</p>
      ) : status.ok ? (
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span>ffmpeg hittades</span>
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
              className="mt-1.5 block max-w-full truncate font-mono text-xs text-muted hover:text-text"
            >
              {status.path}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2.5">
          <p className="flex items-start gap-2 text-accent">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="select-text">{status.message ?? 'ffmpeg hittades inte.'}</span>
          </p>
          <p className="mt-3 text-muted">Installera med Homebrew i Terminal:</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs select-text">
              {INSTALL_COMMAND}
            </code>
            <button onClick={copy} className="rounded-md border border-line px-3 py-2 hover:bg-raised">
              {copied ? 'Kopierat' : 'Kopiera'}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Utan ffmpeg kan du fortfarande generera, men inte fortsätta från föregående klipp eller exportera
            sekvenser. Hittas den inte efter installationen, starta om Studio.
          </p>
        </div>
      )}

      {status && (
        <button
          onClick={check}
          disabled={checking}
          className="mt-2 text-[11px] text-muted hover:text-text disabled:opacity-40"
        >
          {checking ? 'Kontrollerar…' : 'Kontrollera igen'}
        </button>
      )}
    </section>
  )
}

/**
 * Röstseparering: whether this Mac can tell the voice from the background (Apple's built-in sound isolation, used
 * by Redigera for Ta bort rösten, Bara rösten and keeping the background under a new voice).
 */
function VoiceSeparationSection() {
  const status = useSeparationStatus()
  return (
    <section className="mb-8">
      <h2 className="mb-1 font-medium">Röstseparering</h2>
      <p className="mb-3 text-muted">
        Används i Redigera för att ta bort rösten, behålla bara rösten, eller byta röst och behålla musik och effekter.
      </p>
      {!status ? (
        <p className="text-muted">Kontrollerar…</p>
      ) : (
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <p className="flex items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${status.available ? 'bg-emerald-400' : 'bg-muted'}`} />
            <span className="select-text">
              {status.available
                ? `Röstseparering: Apple (inbyggd, ${status.quality === 'standard' ? 'standardkvalitet' : 'hög kvalitet'})`
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
    </section>
  )
}
