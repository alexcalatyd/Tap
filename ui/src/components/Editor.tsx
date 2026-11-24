// Mini editor: vista previa y una línea de tiempo con dos asas para quedarse
// con un tramo. El corte lo hace ffmpeg en la parte nativa (mensaje «trim»).
// Atajos: espacio reproduce, I y O marcan inicio y final, Esc cierra.

import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaUrl } from '@/lib/bridge'
import { useLang, useStrings } from '@/lib/i18n'
import { displayName, type Item } from './DownloadRow'
import { isVideo } from './FormatBar'

/** El tramo más corto que se puede dejar, en segundos. */
const MIN = 0.2
/** Por encima de esto no se dibuja la onda (habría que leer el archivo entero). */
const WAVE_LIMIT = 45 * 60

function useTime() {
  const lang = useLang()
  return useCallback(
    (seconds: number) => {
      const tenths = Math.floor(Math.max(0, seconds) * 10 + 1e-6)
      const h = Math.floor(tenths / 36000)
      const m = Math.floor((tenths % 36000) / 600)
      const s = Math.floor((tenths % 600) / 10)
      const text = `${String(s).padStart(2, '0')}${lang === 'es' ? ',' : '.'}${tenths % 10}`
      return h ? `${h}:${String(m).padStart(2, '0')}:${text}` : `${m}:${text}`
    },
    [lang],
  )
}

type Drag = 'start' | 'end' | 'seek'

export function Editor({
  item,
  onClose,
  onSave,
}: {
  item: Item
  onClose: () => void
  onSave: (start: number, end: number, copy: boolean) => void
}) {
  const t = useStrings()
  const time = useTime()
  const video = isVideo(item.format)
  const src = mediaUrl(item.path!)
  const media = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [duration, setDuration] = useState(0)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const [now, setNow] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const latest = useRef({ range, duration })
  latest.current = { range, duration }

  const ready = duration > 0 && !failed
  const changed = ready && (range.start > 0.05 || range.end < duration - 0.05)

  const seek = useCallback((seconds: number) => {
    const element = media.current
    if (!element) return
    element.currentTime = seconds
    setNow(seconds)
  }, [])

  const toggle = useCallback(() => {
    const element = media.current
    if (!element || !latest.current.duration) return
    if (!element.paused) return element.pause()
    const { start, end } = latest.current.range
    if (element.currentTime < start || element.currentTime >= end - 0.05) element.currentTime = start
    void element.play().catch(() => {})
  }, [])

  // Mientras suena, el cabezal se mueve suave y se para al final del tramo.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const element = media.current
      if (!element) return
      const { end } = latest.current.range
      if (element.currentTime >= end) {
        element.pause()
        element.currentTime = end
      }
      setNow(element.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // El archivo se carga aquí (y no con la prop src) para poder soltarlo al cerrar:
  // en Windows, si sigue abierto no se puede sustituir.
  useEffect(() => {
    const element = media.current
    if (element) element.src = src
    return () => {
      if (!element) return
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [src])

  const setStart = useCallback(
    (value: number) => {
      const { range: r } = latest.current
      const start = Math.min(Math.max(0, value), r.end - MIN)
      setRange({ start, end: r.end })
      seek(start)
    },
    [seek],
  )
  const setEnd = useCallback(
    (value: number) => {
      const { range: r, duration: d } = latest.current
      const end = Math.max(Math.min(d, value), r.start + MIN)
      setRange({ start: r.start, end })
      seek(end)
    },
    [seek],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input')) return
      if (e.key === 'Escape') return onClose()
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ' && !target?.closest('button')) {
        e.preventDefault()
        toggle()
      } else if (e.key === 'i' || e.key === 'I') setStart(media.current?.currentTime ?? 0)
      else if (e.key === 'o' || e.key === 'O') setEnd(media.current?.currentTime ?? 0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, toggle, setStart, setEnd])

  // ── Línea de tiempo ──
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect()
    return Math.min(Math.max(0, (clientX - box.left) / box.width), 1) * latest.current.duration
  }
  const move = (clientX: number) => {
    const value = at(clientX)
    if (drag.current === 'start') setStart(value)
    else if (drag.current === 'end') setEnd(value)
    else seek(value)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (!ready || e.button !== 0) return
    media.current?.pause()
    drag.current = ((e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle as Drag) ?? 'seek'
    e.currentTarget.setPointerCapture(e.pointerId)
    if (drag.current === 'seek') move(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) move(e.clientX)
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const handleKeys = (which: 'start' | 'end') => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0
    if (!delta) return
    e.preventDefault()
    if (which === 'start') setStart(range.start + delta)
    else setEnd(range.end + delta)
  }

  const pct = (seconds: number) => (duration ? (seconds / duration) * 100 : 0)

  return (
    <motion.div
      className="editor"
      initial={{ opacity: 0, scale: 0.97, filter: 'blur(6px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.97, filter: 'blur(6px)', transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
    >
      <p className="editor-name" title={displayName(item)}>
        {displayName(item)}
      </p>

      <div className="editor-preview" data-video={video} onClick={toggle}>
        <video
          ref={media}
          preload="auto"
          playsInline
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            if (!Number.isFinite(d) || d <= 0) return setFailed(true)
            setDuration(d)
            setRange({ start: 0, end: d })
          }}
          onError={() => setFailed(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeeked={(e) => !playing && setNow(e.currentTarget.currentTime)}
        />
        {!video && (
          <span className="editor-cover">
            {item.thumbnail ? (
              <img src={item.thumbnail} alt="" draggable={false} />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M5 10v4M9.5 6v12M14.5 9v6M19 11v2" />
              </svg>
            )}
          </span>
        )}
        {failed && <p className="editor-error">{t.editor.cantOpen}</p>}
      </div>

      <div className="editor-transport">
        <button
          type="button"
          className="editor-play"
          onClick={toggle}
          disabled={!ready}
          aria-label={playing ? t.editor.pause : t.editor.play}
          title={playing ? t.editor.pause : t.editor.play}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6.5" y="5.5" width="3.8" height="13" rx="1.2" />
              <rect x="13.7" y="5.5" width="3.8" height="13" rx="1.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 6.2v11.6a1 1 0 0 0 1.5.86l9.3-5.8a1 1 0 0 0 0-1.72l-9.3-5.8A1 1 0 0 0 8 6.2Z" />
            </svg>
          )}
        </button>
        <span className="editor-clock">
          {time(now)}
          <span> / {time(duration)}</span>
        </span>
        <span className="editor-length" data-changed={changed}>
          {time(range.end - range.start)}
        </span>
      </div>

      <div className="trim">
        <div
          ref={track}
          className="trim-track"
          data-ready={ready}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="trim-strip">
            {ready && (video ? <Filmstrip src={src} duration={duration} /> : <Waveform src={src} duration={duration} />)}
          </div>
          <span className="trim-shade" style={{ left: 0, width: `${pct(range.start)}%` }} />
          <span className="trim-shade" style={{ left: `${pct(range.end)}%`, right: 0 }} />
          <span className="trim-frame" style={{ left: `${pct(range.start)}%`, right: `${100 - pct(range.end)}%` }}>
            <span
              className="trim-handle is-start"
              data-handle="start"
              role="slider"
              tabIndex={ready ? 0 : -1}
              aria-label={t.editor.start}
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={range.start}
              aria-valuetext={time(range.start)}
              onKeyDown={handleKeys('start')}
            />
            <span
              className="trim-handle is-end"
              data-handle="end"
              role="slider"
              tabIndex={ready ? 0 : -1}
              aria-label={t.editor.end}
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={range.end}
              aria-valuetext={time(range.end)}
              onKeyDown={handleKeys('end')}
            />
          </span>
          {ready && <span className="trim-playhead" style={{ left: `${pct(now)}%` }} />}
        </div>
        <div className="trim-marks">
          <span>{time(range.start)}</span>
          <span className="trim-hint">{changed ? '' : t.editor.hint}</span>
          <span>{time(range.end)}</span>
        </div>
      </div>

      <div className="editor-actions">
        <button type="button" className="editor-button is-plain" onClick={onClose}>
          {t.editor.cancel}
        </button>
        <span className="editor-spacer" />
        <button
          type="button"
          className="editor-button"
          disabled={!changed}
          title={t.editor.saveCopyHint}
          onClick={() => onSave(range.start, range.end, true)}
        >
          {t.editor.saveCopy}
        </button>
        <button
          type="button"
          className="editor-button is-primary"
          disabled={!changed}
          title={t.editor.saveHint}
          onClick={() => onSave(range.start, range.end, false)}
        >
          {t.editor.save}
        </button>
      </div>
    </motion.div>
  )
}

// Fotogramas repartidos a lo largo del vídeo, sacados con un <video> aparte.
function Filmstrip({ src, duration }: { src: string; duration: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const target = canvas.current
    if (!target) return
    let stopped = false
    const probe = document.createElement('video')
    probe.muted = true
    probe.preload = 'auto'
    probe.playsInline = true
    probe.src = src

    const once = (event: string, ms = 4000) =>
      new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => {
          probe.removeEventListener(event, onEvent)
          clearTimeout(timer)
          resolve(ok)
        }
        const onEvent = () => done(true)
        const timer = window.setTimeout(() => done(false), ms)
        probe.addEventListener(event, onEvent)
      })

    void (async () => {
      if (probe.readyState < 2 && !(await once('loadeddata', 8000))) return
      const dpr = window.devicePixelRatio || 1
      const width = target.clientWidth
      const height = target.clientHeight
      target.width = Math.round(width * dpr)
      target.height = Math.round(height * dpr)
      const ctx = target.getContext('2d')
      if (!ctx || !probe.videoWidth) return
      ctx.scale(dpr, dpr)
      const aspect = probe.videoWidth / probe.videoHeight
      const count = Math.min(16, Math.max(1, Math.ceil(width / (height * aspect))))
      const slot = width / count
      for (let i = 0; i < count && !stopped; i++) {
        probe.currentTime = Math.min(duration - 0.05, ((i + 0.5) / count) * duration)
        if (!(await once('seeked')) || stopped) continue
        // Tras «seeked», WebKit tarda un instante en tener el fotograma listo para pintarlo.
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 450)
          probe.requestVideoFrameCallback?.(() => {
            clearTimeout(timer)
            resolve()
          })
        })
        if (stopped) return
        // Cada hueco se rellena como «cover», recortando lo que sobra.
        const scale = Math.max(slot / probe.videoWidth, height / probe.videoHeight)
        const w = probe.videoWidth * scale
        const h = probe.videoHeight * scale
        ctx.save()
        ctx.beginPath()
        ctx.rect(i * slot, 0, slot + 0.5, height)
        ctx.clip()
        ctx.drawImage(probe, i * slot + (slot - w) / 2, (height - h) / 2, w, h)
        ctx.restore()
      }
    })()

    return () => {
      stopped = true
      probe.removeAttribute('src')
      probe.load()
    }
  }, [src, duration])

  return <canvas ref={canvas} className="trim-canvas" />
}

// Onda del audio. Se decodifica a una frecuencia baja para no gastar memoria.
function Waveform({ src, duration }: { src: string; duration: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [peaks, setPeaks] = useState<number[]>([])

  useEffect(() => {
    if (duration > WAVE_LIMIT) return
    let stopped = false
    const bars = Math.max(20, Math.floor((box.current?.clientWidth ?? 360) / 3))
    void (async () => {
      try {
        const data = await (await fetch(src)).arrayBuffer()
        let audio: AudioBuffer | null = null
        for (const rate of [3000, 8000, 22050]) {
          try {
            audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data.slice(0))
            break
          } catch {
            /* esa frecuencia no la admite: se prueba la siguiente */
          }
        }
        if (!audio || stopped) return
        const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c))
        const size = Math.max(1, Math.floor(audio.length / bars))
        const values: number[] = []
        for (let b = 0; b < bars; b++) {
          let peak = 0
          for (const channel of channels) {
            for (let i = b * size, end = Math.min(channel.length, i + size); i < end; i++) {
              const v = Math.abs(channel[i])
              if (v > peak) peak = v
            }
          }
          values.push(peak)
        }
        const top = Math.max(...values, 0.001)
        if (!stopped) setPeaks(values.map((v) => Math.sqrt(v / top)))
      } catch {
        /* sin onda: la línea de tiempo funciona igual */
      }
    })()
    return () => {
      stopped = true
    }
  }, [src, duration])

  const step = 100 / Math.max(1, peaks.length)
  return (
    <div ref={box} className="trim-wave">
      {peaks.length > 0 && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {peaks.map((p, i) => {
            const h = Math.max(4, p * 76)
            return <rect key={i} x={i * step + step * 0.2} width={step * 0.6} y={50 - h / 2} height={h} rx={0.6} />
          })}
        </svg>
      )}
    </div>
  )
}
