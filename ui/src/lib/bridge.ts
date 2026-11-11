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
  | { type: 'folder'; name: string }

type Outgoing =
  | { type: 'download'; id: string; url: string; format: Format; quality: string }
  | { type: 'cancel'; id: string }
  | { type: 'reveal'; path: string }
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
    __TAURI__?: { core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> } }
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
  if (message.type !== 'download') return
  const { id, url } = message
  const emit = (e: NativeEvent) => window.__native?.(e)
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
  at(5600, () => emit({ id, type: 'done', path: '/tmp/Me at the zoo.mp4', folder: '@downloads' }))
}
