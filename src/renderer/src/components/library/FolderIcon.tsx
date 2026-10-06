import type { SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement> & { size?: number }

/** Outline folder, drawn like the icons in sequences/icons.tsx. */
export default function FolderIcon({ size = 14, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2.7l1.6 1.6h4.7A1.5 1.5 0 0114 6.1v5.4a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />
    </svg>
  )
}
