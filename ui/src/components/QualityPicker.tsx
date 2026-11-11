// Calidad del formato elegido: un botón discreto que despliega un deslizador
// (Slider de React Aria) con las paradas de ese formato.

import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Slider, SliderThumb, SliderTrack } from 'react-aria-components'
import { useStrings } from '@/lib/i18n'
import type { Stop } from '@/lib/quality'

type Strings = ReturnType<typeof useStrings>

const stopLabel = (label: string, t: Strings) =>
  label === '@max' ? t.max : label === '@original' ? t.original : label === '@khz441' ? t.khz441 : label

export function QualityPicker({ stops, value, onChange }: { stops: Stop[]; value: string; onChange: (key: string) => void }) {
  const t = useStrings()
  const [open, setOpen] = useState(false)
  const index = Math.max(0, stops.findIndex((stop) => stop.key === value))
  const last = stops.length - 1

  return (
    <div className="quality">
      <button type="button" className="quality-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{t.quality}</span>
        <span className="quality-value">{stopLabel(stops[index].label, t)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 10l5 5 5-5" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="quality-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            <div className="quality-inner">
              <Slider
                aria-label={t.quality}
                className="quality-slider"
                minValue={0}
                maxValue={last}
                step={1}
                value={index}
                onChange={(next) => onChange(stops[next as number].key)}
              >
                <SliderTrack className="quality-track">
                  <span className="quality-fill" style={{ width: `${(index / last) * 100}%` }} />
                  {stops.map((stop, i) => (
                    <span key={stop.key} className="quality-tick" data-on={i <= index} style={{ left: `${(i / last) * 100}%` }} />
                  ))}
                  <SliderThumb className="quality-thumb" />
                </SliderTrack>
              </Slider>
              <div className="quality-labels" aria-hidden>
                {stops.map((stop, i) => (
                  <span key={stop.key} data-on={i === index} style={{ left: `${(i / last) * 100}%` }} onClick={() => onChange(stop.key)}>
                    {stopLabel(stop.label, t)}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
