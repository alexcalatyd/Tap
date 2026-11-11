import type { Format } from './bridge'

// Las etiquetas con «@» se traducen (ver `stopLabel` en QualityPicker).
export type Stop = { key: string; label: string }

// Las paradas del deslizador de calidad de cada formato, de menos a más.
export const QUALITY: Record<Format, Stop[]> = {
  mp4: [
    { key: '480', label: '480p' },
    { key: '720', label: '720p' },
    { key: '1080', label: '1080p' },
    { key: 'max', label: '@max' },
  ],
  mov: [
    { key: '480', label: '480p' },
    { key: '720', label: '720p' },
    { key: '1080', label: '1080p' },
    { key: 'max', label: '@max' },
  ],
  mp3: [
    { key: '128', label: '128 kbps' },
    { key: '192', label: '192 kbps' },
    { key: '320', label: '320 kbps' },
  ],
  m4a: [
    { key: '64', label: '64 kbps' },
    { key: '96', label: '96 kbps' },
    { key: 'max', label: '@original' },
  ],
  wav: [
    { key: '44100', label: '@khz441' },
    { key: '48000', label: '48 kHz' },
  ],
}

export type Qualities = Record<Format, string>

export const defaultQualities = (): Qualities => ({
  mp4: 'max',
  mov: 'max',
  mp3: '320',
  m4a: 'max',
  wav: '44100',
})
