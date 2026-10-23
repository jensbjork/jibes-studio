import { useId } from 'react'

/** An on/off switch for Settings. Name it with `label` or with `labelledBy` (the id of its visible text). */
export default function Switch({
  on,
  disabled,
  onChange,
  label,
  labelledBy,
  describedBy
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  label?: string
  labelledBy?: string
  describedBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-60 ${on ? 'bg-accent' : 'bg-line'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${on ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  )
}

/**
 * The one layout of an on/off setting: the switch, its name and one line on what it does. The line doesn't change
 * with the value – the switch shows that.
 */
export function SwitchRow({
  on,
  disabled,
  onChange,
  label,
  description
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  label: string
  description: string
}) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div className="flex items-start gap-3">
      <Switch on={on} disabled={disabled} onChange={onChange} labelledBy={labelId} describedBy={descriptionId} />
      <span className="min-w-0">
        <span id={labelId} className="block">
          {label}
        </span>
        <span id={descriptionId} className="mt-0.5 block text-[12px] leading-relaxed text-muted">
          {description}
        </span>
      </span>
    </div>
  )
}
