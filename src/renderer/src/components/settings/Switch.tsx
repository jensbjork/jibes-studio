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
