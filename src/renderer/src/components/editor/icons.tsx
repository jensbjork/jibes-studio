import type { SVGProps } from 'react'

// Icons for the Editor, drawn like the ones in sequences/icons.tsx (16-unit grid, 1.5 stroke).

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

/** The Editor in the sidebar. */
export function ScissorsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.2" cy="4.5" r="2" />
      <circle cx="4.2" cy="11.5" r="2" />
      <path d="M5.9 5.6L13.5 12M5.9 10.4L13.5 4" />
    </Icon>
  )
}

/** Compare ⇄: switch between two versions. */
export function CompareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8" />
      <path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />
    </Icon>
  )
}

/** One frame back / forward. */
export function FrameBackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3.5L5.5 8l4.5 4.5" />
    </Icon>
  )
}

export function FrameForwardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </Icon>
  )
}

/** Loop the selection (plays the marked range over and over). */
export function LoopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5V7a2.5 2.5 0 012.5-2.5h7M10.5 2.5l2 2-2 2" />
      <path d="M13 7.5V9a2.5 2.5 0 01-2.5 2.5h-7M5.5 13.5l-2-2 2-2" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5l4 4 4-4" />
    </Icon>
  )
}

/** An own film (Egen film): a camera. */
export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.8" y="4.5" width="9" height="7" rx="1.5" />
      <path d="M10.8 7.2l3.4-1.9v5.4l-3.4-1.9" />
    </Icon>
  )
}

export function UndoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 3.5L2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a3.5 3.5 0 010 7H7" />
    </Icon>
  )
}

export function RedoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.5 3.5l3 3-3 3" />
      <path d="M13.5 6.5h-7a3.5 3.5 0 000 7H9" />
    </Icon>
  )
}

export function ZoomInIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3L14 14M5 7h4M7 5v4" />
    </Icon>
  )
}

export function ZoomOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3L14 14M5 7h4" />
    </Icon>
  )
}
