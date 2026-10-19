import { INSTALLED_APP } from '../lib/platform'

/** Marks the development version ("Studio Dev") so it can't be mistaken for Studio.app. */
export default function DevBadge() {
  return (
    <span
      className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-amber-300"
      title={`The development version – its own settings and library, separate from ${INSTALLED_APP}`}
    >
      Dev
    </span>
  )
}
