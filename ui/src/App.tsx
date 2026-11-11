import { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DropZone } from 'react-aria-components'
import { DownloadRow, type Item } from '@/components/DownloadRow'
import { FormatBar, isVideo } from '@/components/FormatBar'
import { QualityPicker } from '@/components/QualityPicker'
import { LinkField, type LinkFieldHandle } from '@/components/LinkField'
import { isNative, onNativeEvent, platform, send, type Format, type NativeEvent } from '@/lib/bridge'
import { folderName, setLang, useLang, useStrings } from '@/lib/i18n'
import { defaultQualities, QUALITY, type Qualities } from '@/lib/quality'

const FORMATS: Format[] = ['mp4', 'mov', 'mp3', 'm4a', 'wav']

function savedFormat(): Format {
  try {
    const stored = localStorage.getItem('format') as Format | null
    if (stored && FORMATS.includes(stored)) return stored
  } catch {
    /* sin almacenamiento: se usa el valor por defecto */
  }
  return 'mp4'
}

function savedQualities(): Qualities {
  const qualities = defaultQualities()
  try {
    const stored = JSON.parse(localStorage.getItem('qualities') ?? '{}') as Partial<Qualities>
    for (const format of FORMATS) {
      const key = stored[format]
      if (key && QUALITY[format].some((stop) => stop.key === key)) qualities[format] = key
    }
  } catch {
    /* sin almacenamiento: se usan los valores por defecto */
  }
  return qualities
}

// Windows: la ventana no tiene marco, así que los botones se dibujan aquí
// con los glifos del sistema (Segoe Fluent Icons).
function WindowControls() {
  const t = useStrings()
  return (
    <span className="window-controls">
      <button type="button" onClick={() => send({ type: 'minimize' })} aria-label={t.minimize} title={t.minimize}>
        {'\uE921'}
      </button>
      <button type="button" onClick={() => send({ type: 'zoom' })} aria-label={t.zoom} title={t.zoom}>
        {'\uE922'}
      </button>
      <button type="button" className="close" onClick={() => send({ type: 'close' })} aria-label={t.close} title={t.close}>
        {'\uE8BB'}
      </button>
    </span>
  )
}

function extractUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const raw of text.split(/\s+/)) {
    const token = raw.trim()
    if (!token) continue
    const candidate = /^https?:\/\//i.test(token) ? token : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(token) ? `https://${token}` : ''
    if (!candidate) continue
    try {
      urls.add(new URL(candidate).href)
    } catch {
      /* no es un enlace */
    }
  }
  return [...urls]
}

function reduce(item: Item, event: NativeEvent): Item {
  switch (event.type) {
    case 'meta':
      return { ...item, title: event.title || item.title, thumbnail: event.thumbnail || item.thumbnail }
    case 'progress': {
      // Un vídeo suele bajar en dos partes (imagen y luego sonido).
      const overall = !isVideo(item.format) ? event.percent : event.part === 0 ? event.percent * 0.9 : 90 + event.percent * 0.1
      return { ...item, phase: 'downloading', percent: Math.max(item.percent, Math.min(overall, 100)), eta: event.eta }
    }
    case 'tools':
      return { ...item, phase: 'preparing', percent: event.percent }
    case 'part':
      return { ...item, phase: 'processing' }
    case 'done':
      return { ...item, phase: 'done', percent: 100, path: event.path, folder: event.folder }
    case 'error':
      return { ...item, phase: 'error', message: event.message }
    default:
      return item
  }
}

export default function App() {
  const [format, setFormat] = useState<Format>(savedFormat)
  const [items, setItems] = useState<Item[]>([])
  const [folder, setFolder] = useState('@downloads')
  const lang = useLang()
  const t = useStrings()
  const field = useRef<LinkFieldHandle>(null)
  const [qualities, setQualities] = useState<Qualities>(savedQualities)
  const choice = useRef({ format, quality: qualities[format] })
  choice.current = { format, quality: qualities[format] }

  useEffect(() => {
    document.documentElement.classList.toggle('in-browser', !isNative)
    const off = onNativeEvent((event) => {
      if (event.type === 'folder') setFolder(event.name)
      else setItems((list) => list.map((item) => (item.id === event.id ? reduce(item, event) : item)))
    })
    send({ type: 'getFolder' })
    return off
  }, [])

  // La parte nativa traduce lo suyo (menús, el panel de carpeta).
  useEffect(() => {
    send({ type: 'language', lang })
  }, [lang])

  const chooseFormat = (next: Format) => {
    setFormat(next)
    try {
      localStorage.setItem('format', next)
    } catch {
      /* da igual si no se puede guardar */
    }
  }

  const chooseQuality = (key: string) => {
    const next = { ...qualities, [format]: key }
    setQualities(next)
    try {
      localStorage.setItem('qualities', JSON.stringify(next))
    } catch {
      /* da igual si no se puede guardar */
    }
  }

  const start = useCallback((text: string) => {
    const urls = extractUrls(text)
    if (urls.length === 0) return false
    const fresh: Item[] = urls.map((url) => ({
      id: crypto.randomUUID(),
      url,
      ...choice.current,
      phase: 'starting',
      percent: 0,
      eta: '',
    }))
    setItems((list) => [...fresh.reverse(), ...list])
    fresh.forEach(({ id, url, format, quality }) => send({ type: 'download', id, url, format, quality }))
    return true
  }, [])

  // Pegar con ⌘V en cualquier parte de la ventana deja el enlace en el campo.
  useEffect(() => {
    const push = (text: string) => {
      if (extractUrls(text).length) field.current?.fill(text.trim())
    }
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input')) return
      const text = e.clipboardData?.getData('text') ?? ''
      if (text) {
        e.preventDefault()
        push(text)
      }
    }
    window.__paste = push
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  const remove = (item: Item) => {
    if (item.phase !== 'done' && item.phase !== 'error') send({ type: 'cancel', id: item.id })
    setItems((list) => list.filter((other) => other.id !== item.id))
  }

  const retry = (item: Item) => {
    setItems((list) =>
      list.map((other) => (other.id === item.id ? { ...other, phase: 'starting', percent: 0, eta: '', message: undefined } : other)),
    )
    send({ type: 'download', id: item.id, url: item.url, format: item.format, quality: item.quality })
  }

  const empty = items.length === 0

  // Arrastrar la ventana desde cualquier zona vacía, además de la franja superior.
  const dragWindow = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input, li, .quality-panel')) return
    send({ type: 'drag' })
  }

  return (
    <MotionConfig reducedMotion="user">
      <DropZone
        className="app"
        getDropOperation={(types) => (types.has('text/uri-list') || types.has('text/plain') ? 'copy' : 'cancel')}
        onDrop={async (event) => {
          for (const item of event.items) {
            if (item.kind !== 'text') continue
            const type = item.types.has('text/uri-list') ? 'text/uri-list' : 'text/plain'
            const text = (await item.getText(type)).replace(/^#.*$/gm, '')
            if (extractUrls(text).length) {
              field.current?.fill(extractUrls(text).join(' '))
              return
            }
          }
        }}
      >
        <header
          className="titlebar"
          onMouseDown={(e) => {
            // En Mac la franja la cubre Swift; esto solo llega en Windows.
            if (platform !== 'windows' || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
            send({ type: e.detail === 2 ? 'zoom' : 'drag' })
          }}
        >
          Tap
          {platform === 'windows' && <WindowControls />}
        </header>

        <LayoutGroup>
          <main className="stage" data-empty={empty} onMouseDown={dragWindow}>
            <motion.section layout transition={{ type: 'spring', stiffness: 300, damping: 32 }} className="composer">
              <LinkField ref={field} placeholders={t.placeholders} onSubmit={start} />
              <FormatBar value={format} onChange={chooseFormat} />
              <QualityPicker stops={QUALITY[format]} value={qualities[format]} onChange={chooseQuality} />
            </motion.section>

            {!empty && (
              <ul className="list">
                <AnimatePresence initial={false} mode="popLayout">
                  {items.map((item) => (
                    <DownloadRow
                      key={item.id}
                      item={item}
                      onReveal={() => item.path && send({ type: 'reveal', path: item.path })}
                      onRemove={() => remove(item)}
                      onRetry={() => retry(item)}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </main>
        </LayoutGroup>

        <footer className="footer" onMouseDown={dragWindow}>
          <button type="button" className="folder" onClick={() => send({ type: 'chooseFolder' })} title={t.changeFolder}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
            </svg>
            <span>{folderName(folder, t)}</span>
          </button>
          <button
            type="button"
            className="lang"
            onClick={() => setLang(lang === 'es' ? 'en' : 'es')}
            aria-label={t.language}
            title={t.language}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={lang}
                initial={{ opacity: 0, y: 5, filter: 'blur(3px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -5, filter: 'blur(3px)' }}
                transition={{ type: 'spring', stiffness: 500, damping: 34 }}
              >
                {lang.toUpperCase()}
              </motion.span>
            </AnimatePresence>
          </button>
        </footer>

        <div className="drop-veil" aria-hidden>
          <span>{t.dropLink}</span>
        </div>
      </DropZone>
    </MotionConfig>
  )
}
