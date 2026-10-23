import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import { refreshPromptLanguage } from '../prompt/usePromptLanguage'
import { SettingsItem } from './SettingsLayout'
import { SwitchRow } from './Switch'

type PromptLanguage = Settings['promptLanguage']

/** Settings → Generation: the prompt language and safe mode for images. */
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
      title="Prompt language"
      help="The words Studio inserts with a character, environment, product, outfit or pose."
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <select
          value={value}
          onChange={(e) => void change(e.target.value as PromptLanguage)}
          aria-label="Prompt language"
          className="rounded-md border border-line bg-raised px-2.5 py-1.5 outline-none focus:border-muted"
        >
          <option value="en">English (recommended)</option>
          <option value="sv">Swedish</option>
        </select>
        <span className="text-[11px] text-muted">
          For example:{' '}
          <span className="text-text/80">
            {value === 'en'
              ? 'Anna (@Image1, @Image2) wearing Red dress (@Image3)'
              : 'Anna (@Image1, @Image2) i Röd klänning (@Image3)'}
          </span>
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </SettingsItem>
  )
}

/**
 * "Safe mode for images": Venice's safe_mode for the stills Studio creates (keyframes and other storyboard
 * images). On by default, as in Venice; the image dialog shows the same setting. One switch row, no title of its own.
 */
function ImageSafeModeSetting({ on, onChanged }: { on: boolean; onChanged: () => void }) {
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
    <SettingsItem>
      <SwitchRow
        on={value}
        disabled={saving}
        onChange={(next) => void change(next)}
        label="Safe mode for images"
        description="Venice blurs adult content in the images you create – start, end and storyboard images. Videos aren’t affected."
      />
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </SettingsItem>
  )
}
