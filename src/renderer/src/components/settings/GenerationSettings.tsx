import { useEffect, useId, useState } from 'react'
import type { Settings } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { refreshPromptLanguage } from '../prompt/usePromptLanguage'
import { SettingsItem } from './SettingsLayout'
import Switch from './Switch'

type PromptLanguage = Settings['promptLanguage']

/** Inställningar → Generering: the prompt language and safe mode for pictures. */
export default function GenerationSettings({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  return (
    <>
      <PromptLanguageSetting language={settings.promptLanguage ?? 'en'} onChanged={onChanged} />
      <ImageSafeModeSetting on={settings.imageSafeMode !== false} onChanged={onChanged} />
    </>
  )
}

/** The language of the text Studio writes into prompts when a character, outfit or place is inserted. */
function PromptLanguageSetting({ language, onChanged }: { language: PromptLanguage; onChanged: () => void }) {
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
    <SettingsItem
      title="Promptspråk"
      help="Texten Studio skriver in när du infogar en karaktär, miljö, produkt, klädsel eller pose. Videomodellerna förstår engelska bäst, så skriv gärna hela prompten på engelska."
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <select
          value={value}
          onChange={(e) => void change(e.target.value as PromptLanguage)}
          aria-label="Promptspråk"
          className="rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
        >
          <option value="en">Engelska (rekommenderas)</option>
          <option value="sv">Svenska</option>
        </select>
        <span className="text-[11px] text-muted">
          Till exempel:{' '}
          <span className="text-text/80">
            {value === 'en'
              ? 'Anna (@Image1, @Image2) wearing Röd klänning (@Image3)'
              : 'Anna (@Image1, @Image2) i Röd klänning (@Image3)'}
          </span>
        </span>
      </div>
      {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}
    </SettingsItem>
  )
}

/**
 * "Säkert läge för bilder": Venice's safe_mode for the stills Studio creates (keyframes and other storyboard
 * images). On by default, as in Venice; the image dialog shows the same setting.
 */
function ImageSafeModeSetting({ on, onChanged }: { on: boolean; onChanged: () => void }) {
  const [value, setValue] = useState(on)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const labelId = useId()
  const stateId = useId()
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
    <SettingsItem
      title="Bilder"
      help={
        <>
          Gäller bilderna du skapar med <span className="text-text">Skapa bild</span> – start- och slutbilder och
          andra bilder till dina storyboards. Videorna påverkas inte.
        </>
      }
    >
      <div className="flex items-start gap-3">
        <Switch
          on={value}
          disabled={saving}
          onChange={(next) => void change(next)}
          labelledBy={labelId}
          describedBy={stateId}
        />
        <span className="min-w-0">
          <span id={labelId} className="block">
            Säkert läge för bilder
          </span>
          <span id={stateId} className="mt-0.5 block text-[12px] leading-relaxed text-muted">
            {value
              ? 'På: Venice suddar ut vuxet innehåll i bilderna. Stäng av det om bilder blir suddiga utan anledning.'
              : 'Av: Venice suddar inte ut vuxet innehåll i bilderna.'}
          </span>
        </span>
      </div>
      {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}
    </SettingsItem>
  )
}
