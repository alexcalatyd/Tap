// Licencia MIT, Copyright (c) Magic UI: ver THIRD_PARTY_NOTICES.md.
// "Animated Circular Progress Bar" de Magic UI
// (npx shadcn@latest add @magicui/animated-circular-progress-bar).
// Adaptado: sin número en el centro y con la duración de la transición
// configurable, porque aquí el valor cambia varias veces por segundo.

import { cn } from '@/lib/utils'

interface AnimatedCircularProgressBarProps {
  max?: number
  min?: number
  value?: number
  gaugePrimaryColor: string
  gaugeSecondaryColor: string
  transitionLength?: string
  className?: string
}

export function AnimatedCircularProgressBar({
  max = 100,
  min = 0,
  value = 0,
  gaugePrimaryColor,
  gaugeSecondaryColor,
  transitionLength = '1s',
  className,
}: AnimatedCircularProgressBarProps) {
  const circumference = 2 * Math.PI * 45
  const percentPx = circumference / 100
  const currentPercent = Math.round(((value - min) / (max - min)) * 100)

  return (
    <div
      role="progressbar"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('relative size-40', className)}
      style={
        {
          '--circle-size': '100px',
          '--circumference': circumference,
          '--percent-to-px': `${percentPx}px`,
          '--gap-percent': '5',
          '--offset-factor': '0',
          '--transition-length': transitionLength,
          '--transition-step': '200ms',
          '--delay': '0s',
          '--percent-to-deg': '3.6deg',
          transform: 'translateZ(0)',
        } as React.CSSProperties
      }
    >
      <svg fill="none" className="size-full" strokeWidth="2" viewBox="0 0 100 100">
        {currentPercent <= 90 && currentPercent >= 0 && (
          <circle
            cx="50"
            cy="50"
            r="45"
            strokeWidth="10"
            strokeDashoffset="0"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-100"
            style={
              {
                stroke: gaugeSecondaryColor,
                '--stroke-percent': 90 - currentPercent,
                '--offset-factor-secondary': 'calc(1 - var(--offset-factor))',
                strokeDasharray: 'calc(var(--stroke-percent) * var(--percent-to-px)) var(--circumference)',
                transform:
                  'rotate(calc(1turn - 90deg - (var(--gap-percent) * var(--percent-to-deg) * var(--offset-factor-secondary)))) scaleY(-1)',
                transition: 'all var(--transition-length) ease var(--delay)',
                transformOrigin: 'calc(var(--circle-size) / 2) calc(var(--circle-size) / 2)',
              } as React.CSSProperties
            }
          />
        )}
        <circle
          cx="50"
          cy="50"
          r="45"
          strokeWidth="10"
          strokeDashoffset="0"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-100"
          style={
            {
              stroke: gaugePrimaryColor,
              '--stroke-percent': currentPercent,
              strokeDasharray: 'calc(var(--stroke-percent) * var(--percent-to-px)) var(--circumference)',
              transition:
                'var(--transition-length) ease var(--delay),stroke var(--transition-length) ease var(--delay)',
              transitionProperty: 'stroke-dasharray,transform',
              transform: 'rotate(calc(-90deg + var(--gap-percent) * var(--offset-factor) * var(--percent-to-deg)))',
              transformOrigin: 'calc(var(--circle-size) / 2) calc(var(--circle-size) / 2)',
            } as React.CSSProperties
          }
        />
      </svg>
    </div>
  )
}
