// Idioma de la interfaz: español o inglés. Por defecto, el del sistema; si el
// usuario lo cambia (el botón pequeño del pie), se recuerda en localStorage.

import { useSyncExternalStore } from 'react'

export type Lang = 'es' | 'en'
export const LANGS: Lang[] = ['es', 'en']

const es = {
  placeholders: [
    'Pega un enlace de YouTube',
    'Pega un enlace de Instagram',
    'Pega un enlace de TikTok',
    'Pega un enlace de X',
    'O de casi cualquier otra web',
  ],
  link: 'Enlace',
  download: 'Descargar',
  minimize: 'Minimizar',
  zoom: 'Alargar',
  close: 'Cerrar',
  format: 'Formato',
  video: 'Vídeo',
  audio: 'Audio',
  quality: 'Calidad',
  max: 'Máxima',
  original: 'Original',
  khz441: '44,1 kHz',
  changeFolder: 'Cambiar la carpeta de destino',
  language: 'Idioma: español. Cambiar a inglés',
  dropLink: 'Suelta el enlace',
  showInFinder: 'Mostrar en Finder',
  showInFolder: 'Mostrar en la carpeta',
  retry: 'Reintentar',
  cancel: 'Cancelar',
  removeFromList: 'Quitar de la lista',
  searching: 'Buscando…',
  preparing: (percent: number) => `Preparando la primera vez… ${percent} %`,
  progress: (percent: number, eta: string) => `${percent} %${eta ? `, quedan ${eta}` : ''}`,
  converting: (format: string) => `Convirtiendo a ${format}…`,
  savedIn: (format: string, folder: string) => `${format} en ${folder}`,
  errors: {
    toolsMac: (tool: string) => `Falta ${tool}. Instálalo con «brew install ${tool}».`,
    toolsWindows: (tool: string) => `No se pudo preparar ${tool}. Revisa la conexión.`,
    ffmpegFailed: 'Falló ffmpeg al convertir.',
    unsupported: 'Este enlace no es compatible.',
    login: 'Hace falta iniciar sesión para verlo.',
    unavailable: 'El vídeo ya no está disponible.',
    offline: 'No hay conexión.',
    generic: 'No se pudo descargar.',
  },
  folders: {
    downloads: 'Descargas',
    desktop: 'Escritorio',
    documents: 'Documentos',
    movies: 'Películas',
    videos: 'Vídeos',
    music: 'Música',
    pictures: 'Imágenes',
  } as Record<string, string>,
}

type Strings = typeof es

const en: Strings = {
  placeholders: [
    'Paste a YouTube link',
    'Paste an Instagram link',
    'Paste a TikTok link',
    'Paste an X link',
    'Or from almost any other site',
  ],
  link: 'Link',
  download: 'Download',
  minimize: 'Minimize',
  zoom: 'Zoom',
  close: 'Close',
  format: 'Format',
  video: 'Video',
  audio: 'Audio',
  quality: 'Quality',
  max: 'Maximum',
  original: 'Original',
  khz441: '44.1 kHz',
  changeFolder: 'Change the destination folder',
  language: 'Language: English. Switch to Spanish',
  dropLink: 'Drop the link',
  showInFinder: 'Show in Finder',
  showInFolder: 'Show in folder',
  retry: 'Retry',
  cancel: 'Cancel',
  removeFromList: 'Remove from list',
  searching: 'Looking it up…',
  preparing: (percent: number) => `Setting up for the first time… ${percent}%`,
  progress: (percent: number, eta: string) => `${percent}%${eta ? `, ${eta} left` : ''}`,
  converting: (format: string) => `Converting to ${format}…`,
  savedIn: (format: string, folder: string) => `${format} in ${folder}`,
  errors: {
    toolsMac: (tool: string) => `${tool} is missing. Install it with “brew install ${tool}”.`,
    toolsWindows: (tool: string) => `Couldn't set up ${tool}. Check your connection.`,
    ffmpegFailed: 'ffmpeg failed while converting.',
    unsupported: "This link isn't supported.",
    login: 'You need to be signed in to see it.',
    unavailable: 'The video is no longer available.',
    offline: 'No connection.',
    generic: "Couldn't download it.",
  },
  folders: {
    downloads: 'Downloads',
    desktop: 'Desktop',
    documents: 'Documents',
    movies: 'Movies',
    videos: 'Videos',
    music: 'Music',
    pictures: 'Pictures',
  },
}

const STRINGS: Record<Lang, Strings> = { es, en }

function initial(): Lang {
  try {
    const stored = localStorage.getItem('lang')
    if (stored === 'es' || stored === 'en') return stored
  } catch {
    /* sin almacenamiento: el del sistema */
  }
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en'
}

let current: Lang = initial()
const listeners = new Set<() => void>()
document.documentElement.lang = current

export function setLang(next: Lang) {
  if (next === current) return
  current = next
  document.documentElement.lang = next
  try {
    localStorage.setItem('lang', next)
  } catch {
    /* da igual si no se puede guardar */
  }
  listeners.forEach((listener) => listener())
}

export const getLang = () => current

export function useLang(): Lang {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}

export const strings = (lang: Lang = current) => STRINGS[lang]

export function useStrings(): Strings {
  return STRINGS[useLang()]
}

// La parte nativa manda las carpetas conocidas como «@downloads», «@desktop»…
// para que el nombre salga en el idioma elegido aquí, no en el del sistema.
export function folderName(name: string | undefined, t: Strings): string {
  if (!name) return t.folders.downloads
  return name.startsWith('@') ? (t.folders[name.slice(1)] ?? name.slice(1)) : name
}
