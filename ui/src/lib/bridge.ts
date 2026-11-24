// Puente con la parte nativa: Swift en Mac (WKWebView) y Rust en Windows
// (Tauri). Los dos hablan el mismo protocolo. En el navegador, sin app, se
// simula la descarga para poder trabajar la interfaz con `npm run dev`.

export type Format = 'mp4' | 'mov' | 'mp3' | 'm4a' | 'wav'

export type NativeEvent =
  | { id: string; type: 'meta'; title?: string; thumbnail?: string }
  | { id: string; type: 'progress'; percent: number; eta: string; part: number }
  | { id: string; type: 'part' }
  | { id: string; type: 'tools'; percent: number }
  | { id: string; type: 'done'; path: string; folder?: string }
  | { id: string; type: 'error'; message: string }
  | { id: string; type: 'renamed'; path: string; name: string }
  | { id: string; type: 'renameFailed' }
  | { id: string; type: 'trimProgress'; percent: number }
  | { id: string; type: 'trimFailed' }
  | { type: 'folder'; name: string }

type Outgoing =
  | { type: 'download'; id: string; url: string; format: Format; quality: string }
  | { type: 'cancel'; id: string }
  | { type: 'reveal'; path: string }
  // Cambia el nombre del archivo (sin extensión); la parte nativa responde «renamed».
  | { type: 'rename'; id: string; path: string; name: string }
  // Recorta [start, end] (segundos). Sin copyName sustituye el archivo; con él guarda una copia.
  | { type: 'trim'; id: string; path: string; start: number; end: number; copyName?: string }
  | { type: 'drag' }
  | { type: 'getFolder' }
  | { type: 'chooseFolder' }
  | { type: 'language'; lang: 'es' | 'en' }
  | { type: 'minimize' }
  | { type: 'zoom' }
  | { type: 'close' }

declare global {
  interface Window {
    webkit?: { messageHandlers?: { ytdlp?: { postMessage(m: Outgoing): void } } }
    __native?: (e: NativeEvent) => void
    __paste?: (text: string) => void
    __TAURI__?: {
      core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown>; convertFileSrc(path: string, protocol?: string): string }
    }
    __TAP__?: { accent?: string; material?: boolean }
  }
}

const handler = window.webkit?.messageHandlers?.ytdlp
const tauri = window.__TAURI__?.core
export const platform: 'mac' | 'windows' | 'browser' = handler ? 'mac' : tauri ? 'windows' : 'browser'
export const isNative = platform !== 'browser'

// En Windows, Rust deja el color de acento del sistema y si hay Mica en window.__TAP__.
if (platform === 'windows') {
  const root = document.documentElement
  root.classList.add('windows')
  if (window.__TAP__?.material === false) root.classList.add('no-material')
  if (window.__TAP__?.accent) root.style.setProperty('--accent', window.__TAP__.accent)
}

// Dirección con la que la interfaz puede reproducir un archivo descargado (editor).
// Mac: el esquema app:// sirve el archivo (con rangos). Windows: el protocolo asset
// de Tauri. Navegador: una muestra en ui/public (sample.mp4, sample.mp3…; no se sube).
export function mediaUrl(path: string): string {
  if (platform === 'mac') return `app://local/__media__?p=${encodeURIComponent(path)}`
  if (platform === 'windows' && tauri) return tauri.convertFileSrc(path, 'asset')
  return `/sample.${path.split('.').pop() ?? 'mp4'}`
}

const listeners = new Set<(e: NativeEvent) => void>()
window.__native = (e) => listeners.forEach((l) => l(e))

export function onNativeEvent(listener: (e: NativeEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function send(message: Outgoing) {
  if (handler) handler.postMessage(message)
  else if (tauri) tauri.invoke('bridge', { message }).catch(() => {})
  else simulate(message)
}

// ── Simulación para el navegador ────────────────────────────────────────────
const timers = new Map<string, number[]>()

function simulate(message: Outgoing) {
  if (message.type === 'cancel') {
    timers.get(message.id)?.forEach(clearTimeout)
    return
  }
  if (message.type === 'getFolder' || message.type === 'chooseFolder') {
    window.__native?.({ type: 'folder', name: message.type === 'getFolder' ? '@downloads' : '@desktop' })
    return
  }
  const emit = (e: NativeEvent) => window.__native?.(e)
  if (message.type === 'rename') {
    const { id, path, name } = message
    const folder = path.slice(0, path.lastIndexOf('/') + 1)
    window.setTimeout(() => emit({ id, type: 'renamed', name, path: `${folder}${name}.${path.split('.').pop()}` }), 150)
    return
  }
  if (message.type === 'trim') {
    const { id, path, copyName } = message
    const queue: number[] = []
    timers.set(id, queue)
    for (let i = 1; i <= 10; i++) queue.push(window.setTimeout(() => emit({ id, type: 'trimProgress', percent: i * 10 }), i * 150))
    const target = copyName ? `${path.slice(0, path.lastIndexOf('/') + 1)}${copyName}.${path.split('.').pop()}` : path
    queue.push(window.setTimeout(() => emit({ id, type: 'done', path: target, folder: '@downloads' }), 1700))
    return
  }
  if (message.type !== 'download') return
  const { id, url, format } = message
  const queue: number[] = []
  const at = (ms: number, fn: () => void) => queue.push(window.setTimeout(fn, ms))
  timers.set(id, queue)

  if (url.includes('error')) {
    at(900, () => emit({ id, type: 'error', message: 'ERROR: Unsupported URL' }))
    return
  }
  at(700, () => emit({ id, type: 'meta', title: 'Me at the zoo', thumbnail: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg' }))
  for (let i = 1; i <= 20; i++) {
    at(700 + i * 180, () => emit({ id, type: 'progress', percent: i * 5, eta: `00:${String(20 - i).padStart(2, '0')}`, part: 0 }))
  }
  at(4400, () => emit({ id, type: 'part' }))
  at(5600, () => emit({ id, type: 'done', path: `/tmp/Me at the zoo.${format}`, folder: '@downloads' }))
}
