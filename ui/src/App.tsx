import { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DropZone } from 'react-aria-components'
import { baseName, cleanName, displayName, DownloadRow, type Item } from '@/components/DownloadRow'
import { Editor } from '@/components/Editor'
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
      return { ...item, phase: 'done', percent: 100, path: event.path, folder: event.folder, notice: undefined, trimOf: undefined }
    case 'error':
      return { ...item, phase: 'error', message: event.message }
    case 'renamed':
      return { ...item, path: event.path, name: undefined, notice: undefined }
    case 'renameFailed':
      return { ...item, name: undefined, notice: 'rename' }
    case 'trimProgress':
      return { ...item, phase: 'trimming', percent: Math.min(event.percent, 100) }
    default:
      return item
  }
}

export default function App() {
  const [format, setFormat] = useState<Format>(savedFormat)
  const [items, setItems] = useState<Item[]>([])
  const [folder, setFolder] = useState('@downloads')
  const [editing, setEditing] = useState<string | null>(null)
  // Nombres elegidos antes de que termine la descarga: se aplican al llegar «done».
  const pendingNames = useRef(new Map<string, string>())
  const lang = useLang()
  const t = useStrings()
  const field = useRef<LinkFieldHandle>(null)
  const [qualities, setQualities] = useState<Qualities>(savedQualities)
  const choice = useRef({ format, quality: qualities[format] })
  choice.current = { format, quality: qualities[format] }

  useEffect(() => {
    document.documentElement.classList.toggle('in-browser', !isNative)
    const clearNotice = (id: string) =>
      window.setTimeout(() => setItems((list) => list.map((item) => (item.id === id ? { ...item, notice: undefined } : item))), 5000)

    const off = onNativeEvent((event) => {
      if (event.type === 'folder') return setFolder(event.name)
      if (event.type === 'done') {
        const name = pendingNames.current.get(event.id)
        if (name !== undefined) {
          pendingNames.current.delete(event.id)
          send({ type: 'rename', id: event.id, path: event.path, name })
        }
      }
      if (event.type === 'renameFailed') clearNotice(event.id)
      if (event.type === 'trimFailed') {
        // Copia: se quita su fila y el aviso va a la original. Sustituir: la fila vuelve a como estaba.
        setItems((list) => {
          const target = list.find((item) => item.id === event.id)
          if (!target) return list
          const original = target.trimOf ?? target.id
          clearNotice(original)
          return list
            .filter((item) => !(item.id === event.id && target.trimOf))
            .map((item) => (item.id === original ? { ...item, phase: 'done', percent: 100, notice: 'trim' } : item))
        })
        return
      }
      setItems((list) => list.map((item) => (item.id === event.id ? reduce(item, event) : item)))
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
    pendingNames.current.delete(item.id)
    // Cancelar un recorte que iba a sustituir el archivo: el archivo sigue como estaba.
    if (item.phase === 'trimming' && !item.trimOf) {
      setItems((list) => list.map((other) => (other.id === item.id ? { ...other, phase: 'done', percent: 100 } : other)))
      return
    }
    setItems((list) => list.filter((other) => other.id !== item.id))
  }

  const rename = (item: Item, raw: string) => {
    const name = cleanName(raw)
    if (!name || name === displayName(item)) return
    setItems((list) => list.map((other) => (other.id === item.id ? { ...other, name, notice: undefined } : other)))
    if (item.phase === 'done' && item.path) send({ type: 'rename', id: item.id, path: item.path, name })
    else pendingNames.current.set(item.id, name)
  }

  const saveTrim = (item: Item, start: number, end: number, copy: boolean) => {
    setEditing(null)
    if (!item.path) return
    const range = { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 }
    if (!copy) {
      setItems((list) => list.map((other) => (other.id === item.id ? { ...other, phase: 'trimming', percent: 0, notice: undefined } : other)))
      send({ type: 'trim', id: item.id, path: item.path, ...range })
      return
    }
    const id = crypto.randomUUID()
    const copyName = `${baseName(item.path)} (${t.editor.copySuffix})`
    const fresh: Item = { ...item, id, phase: 'trimming', percent: 0, title: copyName, path: undefined, name: undefined, notice: undefined, trimOf: item.id }
    setItems((list) => {
      const index = list.findIndex((other) => other.id === item.id)
      return [...list.slice(0, index), fresh, ...list.slice(index)]
    })
    send({ type: 'trim', id, path: item.path, ...range, copyName })
  }

  const editingItem = items.find((item) => item.id === editing && item.phase === 'done' && item.path)

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
        className={editingItem ? 'app is-editing' : 'app'}
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
                      onRename={(name) => rename(item, name)}
                      onEdit={() => setEditing(item.id)}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </main>
        </LayoutGroup>

        <AnimatePresence>
          {editingItem && (
            <Editor
              key={editingItem.id}
              item={editingItem}
              onClose={() => setEditing(null)}
              onSave={(start, end, copy) => saveTrim(editingItem, start, end, copy)}
            />
          )}
        </AnimatePresence>

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
