import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 14, children, ...rest }: IconProps) {
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
      {children}
    </svg>
  )
}

export function GridIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </Icon>
  )
}

export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" strokeWidth={2} />
    </Icon>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2l3.3 3.3" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  )
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 10l4-4 4 4" />
    </Icon>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4l-4 4 4 4" />
    </Icon>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4l4 4-4 4" />
    </Icon>
  )
}

export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
    </Icon>
  )
}

/** A speech bubble: reviews. */
export function ReviewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3.5h10a1 1 0 011 1v6a1 1 0 01-1 1H7.5L4.5 14v-2.5H3a1 1 0 01-1-1v-6a1 1 0 011-1z" />
    </Icon>
  )
}

export function PinIcon({ filled, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...props}>
      <path
        d="M6 2.5h4l-.6 3.8 2.6 2.2v1H4v-1l2.6-2.2L6 2.5zM8 9.5v4"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Icon>
  )
}

/** A light bulb: learnings. */
export function BulbIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 10.5a4.25 4.25 0 115 0c-.6.5-.9 1-.9 1.7v.3H6.4v-.3c0-.7-.3-1.2-.9-1.7z" />
      <path d="M6.5 14.5h3" />
    </Icon>
  )
}

export function SoundIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5z" />
      <path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4" />
    </Icon>
  )
}

/** An own clip (the user's own film, not made by AI). */
export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.75" y="4.25" width="9" height="7.5" rx="1.5" />
      <path d="M10.75 7l3.5-2v6l-3.5-2" />
    </Icon>
  )
}

/** Redigera: changing a finished film. */
export function ScissorsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.25" cy="4.5" r="2" />
      <circle cx="4.25" cy="11.5" r="2" />
      <path d="M5.9 5.6L13.5 12M5.9 10.4L13.5 4" />
    </Icon>
  )
}

/** Bringing a file in ("Importera"). */
export function ImportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v7.5M5 7l3 3 3-3" />
      <path d="M2.75 10.5v1.75a1.25 1.25 0 001.25 1.25h8a1.25 1.25 0 001.25-1.25V10.5" />
    </Icon>
  )
}
