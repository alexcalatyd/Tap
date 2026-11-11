// Campo del enlace, escrito para Tap. Al enviar, el texto se deshace en polvo
// que se lleva el texto de derecha a izquierda. Nada se envía solo: la descarga empieza
// con el botón (o con Intro). `fill()` deja un enlace pegado o soltado desde
// fuera del campo, sin enviarlo.

import { AnimatePresence, motion, useAnimationControls } from 'motion/react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useStrings } from '@/lib/i18n'

export type LinkFieldHandle = {
  /** Escribe el texto en el campo, sin enviarlo. */
  fill: (text: string) => void
  focus: () => void
}

// ── El polvo ────────────────────────────────────────────────────────────────

type Mote = { x: number; y: number; vx: number; vy: number; delay: number; size: number }

const SWEEP = 520 // ms que tarda el barrido, del final del texto al principio
const LIFE = 1000 // ms que vive cada mota desde que se suelta
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Dibuja el texto tal cual se ve en el campo y lo convierte en motas. */
function motesFrom(input: HTMLInputElement, text: string, dpr: number): Mote[] {
  const { width, height } = input.getBoundingClientRect()
  const style = getComputedStyle(input)
  const probe = document.createElement('canvas')
  probe.width = Math.ceil(width * dpr)
  probe.height = Math.ceil(height * dpr)
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  ctx.scale(dpr, dpr)
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#000'
  ctx.fillText(text, parseFloat(style.paddingLeft) - input.scrollLeft, height / 2)

  // Solo lo que se ve: el texto no pasa por debajo de la flecha.
  const visible = width - parseFloat(style.paddingRight)
  const { data } = ctx.getImageData(0, 0, probe.width, probe.height)
  const step = Math.max(1, Math.round(dpr))
  const motes: Mote[] = []
  for (let py = 0; py < probe.height; py += step) {
    for (let px = 0; px < probe.width; px += step) {
      if (data[(py * probe.width + px) * 4 + 3] < 110) continue
      const x = px / dpr
      if (x > visible) continue
      const y = py / dpr
      motes.push({
        x,
        y,
        // Hacia la izquierda y un poco hacia arriba.
        vx: -(40 + Math.random() * 110),
        vy: (Math.random() - 0.65) * 50,
        delay: 0,
        size: (step / dpr) * (0.8 + Math.random() * 0.5),
      })
    }
  }
  // El barrido empieza por la última letra y acaba en la primera.
  const end = motes.reduce((max, mote) => Math.max(max, mote.x), 0) || 1
  for (const mote of motes) mote.delay = ((end - mote.x) / end) * SWEEP + Math.random() * 60
  return motes
}

function dissolve(canvas: HTMLCanvasElement, input: HTMLInputElement, text: string, color: string): Promise<void> {
  const dpr = window.devicePixelRatio || 1
  const motes = motesFrom(input, text, dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx || motes.length === 0) return Promise.resolve()

  const { width, height } = input.getBoundingClientRect()
  canvas.width = Math.ceil(width * dpr)
  canvas.height = Math.ceil(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = color

  return new Promise((resolve) => {
    const start = performance.now()
    const frame = (now: number) => {
      const elapsed = now - start
      ctx.clearRect(0, 0, width, height)
      for (const mote of motes) {
        const t = Math.min(1, Math.max(0, (elapsed - mote.delay) / LIFE))
        if (t >= 1) continue
        const s = t / 1000 * LIFE // segundos desde que se soltó
        const ease = 1 - (1 - t) * (1 - t)
        ctx.globalAlpha = 1 - ease
        const size = mote.size * (1 - 0.6 * t)
        ctx.fillRect(mote.x + mote.vx * s * ease, mote.y + mote.vy * s * ease, size, size)
      }
      ctx.globalAlpha = 1
      if (elapsed < SWEEP + 60 + LIFE) requestAnimationFrame(frame)
      else {
        ctx.clearRect(0, 0, width, height)
        resolve()
      }
    }
    requestAnimationFrame(frame)
  })
}

// ── El campo ────────────────────────────────────────────────────────────────

export function LinkField({
  placeholders,
  onSubmit,
  ref,
}: {
  placeholders: string[]
  /** Devuelve false si el texto no vale: el campo se sacude y no se envía. */
  onSubmit: (value: string) => boolean
  ref?: Ref<LinkFieldHandle>
}) {
  const t = useStrings()
  const input = useRef<HTMLInputElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState(0)
  const shake = useAnimationControls()

  // Las sugerencias rotan cada 3 s, y se paran con la ventana oculta.
  useEffect(() => {
    let timer = 0
    const run = () => {
      window.clearInterval(timer)
      if (document.visibilityState === 'visible') {
        timer = window.setInterval(() => setHint((i) => (i + 1) % placeholders.length), 3000)
      }
    }
    run()
    document.addEventListener('visibilitychange', run)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', run)
    }
  }, [placeholders.length])

  const submit = async () => {
    const field = input.current
    const text = value.trim()
    if (busy || !field || !text) return
    if (!onSubmit(text)) {
      shake.start({ x: [0, -7, 7, -4, 4, 0], transition: { duration: 0.36, ease: 'easeOut' } })
      return
    }
    if (reducedMotion() || !canvas.current) {
      setValue('')
      return
    }
    const color = getComputedStyle(field).color
    setBusy(true)
    const done = dissolve(canvas.current, field, value, color)
    setValue('')
    await done
    setBusy(false)
  }

  useImperativeHandle(ref, () => ({
    fill: (text: string) => {
      if (busy) return
      setValue(text)
      input.current?.focus()
    },
    focus: () => input.current?.focus(),
  }))

  return (
    <motion.form
      animate={shake}
      className="link-field"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        ref={input}
        className="link-field-input"
        type="text"
        value={value}
        onChange={(e) => !busy && setValue(e.target.value)}
        aria-label={t.link}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
      />
      <canvas ref={canvas} className="link-field-dust" aria-hidden />

      <button type="submit" disabled={!value} aria-label={t.download} title={t.download} className="link-field-go">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 4.5v14.5" />
          <path d="M5.5 12.5l6.5 6.5 6.5-6.5" />
        </svg>
      </button>

      <div className="link-field-hint" aria-hidden>
        <AnimatePresence mode="wait">
          {!value && !busy && (
            <motion.p
              key={`${hint}-${placeholders[hint % placeholders.length]}`}
              className="link-field-placeholder"
              initial={{ y: 6, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -10, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.25, 0.1, 0.25, 1] }}
            >
              {placeholders[hint % placeholders.length]}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </motion.form>
  )
}
