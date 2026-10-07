import type { SVGProps } from 'react'

/**
 * The Storyboards symbol: two milestone pictures with an arc from the first to the second – the clip generated
 * between them. Filled and sized in em like the sidebar's other glyphs, so it follows the surrounding font size.
 */
export function StoryboardIcon({ className = '', ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1.05em"
      height="1.05em"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={`shrink-0 ${className}`}
      {...rest}
    >
      <rect x="0.5" y="7" width="6.2" height="6.5" rx="1.3" />
      <rect x="9.3" y="7" width="6.2" height="6.5" rx="1.3" />
      <path
        d="M3.6 5.2C5 2.6 10.6 2.4 12.3 4.9M12.6 2.6l-.1 2.6-2.5-.3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
