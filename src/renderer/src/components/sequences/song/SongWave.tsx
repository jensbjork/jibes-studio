import { useMemo } from 'react'

/** Peaks as mirrored bars, stretched over the box; `className` sets the colour (currentColor). */
export default function SongWave({ peaks, className = '' }: { peaks: readonly number[]; className?: string }) {
  const path = useMemo(() => {
    let d = ''
    peaks.forEach((p, i) => {
      const h = Math.max(0.5, Math.min(1, Number.isFinite(p) ? p : 0) * 46)
      d += `M${i + 0.5} ${50 - h}V${50 + h}`
    })
    return d
  }, [peaks])
  if (!peaks.length) return null
  return (
    <svg
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      aria-hidden
    >
      <path d={path} stroke="currentColor" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
