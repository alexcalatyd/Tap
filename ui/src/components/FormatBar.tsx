// Barra de formato: ToggleButtonGroup + SelectionIndicator de React Aria.
// El indicador es un único elemento que se desliza de una opción a otra.

import { Fragment } from 'react'
import { SelectionIndicator, ToggleButton, ToggleButtonGroup } from 'react-aria-components'
import type { Format } from '@/lib/bridge'
import { useStrings } from '@/lib/i18n'

const GROUPS: { label: 'video' | 'audio'; formats: Format[] }[] = [
  { label: 'video', formats: ['mp4', 'mov'] },
  { label: 'audio', formats: ['mp3', 'm4a', 'wav'] },
]

export const isVideo = (format: Format) => GROUPS[0].formats.includes(format)

export function FormatBar({ value, onChange }: { value: Format; onChange: (format: Format) => void }) {
  const t = useStrings()
  return (
    <ToggleButtonGroup
      aria-label={t.format}
      className="format-bar"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [next] = [...keys]
        if (next) onChange(next as Format)
      }}
    >
      {GROUPS.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 && <span className="format-bar-gap" aria-hidden />}
          {group.formats.map((format) => (
            <ToggleButton key={format} id={format} className="format-bar-item" aria-label={`${t[group.label]} ${format.toUpperCase()}`}>
              <SelectionIndicator className="format-bar-indicator" />
              <span>{format.toUpperCase()}</span>
            </ToggleButton>
          ))}
        </Fragment>
      ))}
    </ToggleButtonGroup>
  )
}
