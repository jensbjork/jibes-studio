import { ChevronLeftIcon, ChevronRightIcon } from '../feed/icons'

/**
 * The ‹ › over a full-screen viewer (images, films, an asset's pictures), at the left or right edge, for the same as
 * ← and →. Hidden at the first or the last.
 */
export default function ViewerNavButton({
  side,
  label,
  onClick,
  disabled
}: {
  side: 'prev' | 'next'
  /** What it goes to, for screen readers: "Previous image". */
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  const prev = side === 'prev'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={prev ? 'Previous (←)' : 'Next (→)'}
      className={`absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/80 outline-none transition hover:bg-black/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-0 ${
        prev ? 'left-3' : 'right-3'
      }`}
    >
      {prev ? <ChevronLeftIcon size={18} /> : <ChevronRightIcon size={18} />}
    </button>
  )
}

export { ViewerNavButton }
