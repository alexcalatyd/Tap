import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { AnimatedCircularProgressBar } from '@/components/ui/animated-circular-progress-bar'
import { platform, type Format } from '@/lib/bridge'
import { folderName, useStrings } from '@/lib/i18n'
import { isVideo } from './FormatBar'

export type Item = {
  id: string
  url: string
  format: Format
  quality: string
  phase: 'starting' | 'preparing' | 'downloading' | 'processing' | 'done' | 'error'
  percent: number
  eta: string
  title?: string
  thumbnail?: string
  path?: string
  folder?: string
  message?: string
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const windows = platform === 'windows'

type Strings = ReturnType<typeof useStrings>

function friendlyError(t: Strings, message = '') {
  const m = message.toLowerCase()
  const e = t.errors
  const missing = (tool: string) => (windows ? e.toolsWindows(tool) : e.toolsMac(tool))
  if (m.includes('no-ytdlp')) return missing('yt-dlp')
  if (m.includes('no-ffmpeg')) return missing('ffmpeg')
  if (m.includes('unsupported url') || m.includes('is not a valid url')) return e.unsupported
  if (m.includes('sign in') || m.includes('login') || m.includes('private')) return e.login
  if (m.includes('unavailable') || m.includes('removed') || m.includes('404')) return e.unavailable
  if (m.includes('resolve') || m.includes('timed out') || m.includes('network') || m.includes('connection')) return e.offline
  if (m.includes('ffmpeg')) return windows ? e.ffmpegFailed : missing('ffmpeg')
  return e.generic
}

function status(item: Item, t: Strings) {
  const format = item.format.toUpperCase()
  switch (item.phase) {
    case 'starting':
      return t.searching
    case 'preparing':
      return t.preparing(Math.round(item.percent))
    case 'downloading': {
      const eta = /^\d+:\d+/.test(item.eta) ? item.eta.replace(/^0(\d:)/, '$1') : ''
      return t.progress(Math.round(item.percent), eta && eta !== '0:00' ? eta : '')
    }
    case 'processing':
      return t.converting(format)
    case 'done':
      return t.savedIn(format, folderName(item.folder, t))
    case 'error':
      return friendlyError(t, item.message)
  }
}

export function DownloadRow({
  item,
  onReveal,
  onRemove,
  onRetry,
}: {
  item: Item
  onReveal: () => void
  onRemove: () => void
  onRetry: () => void
}) {
  const t = useStrings()
  const [thumbFailed, setThumbFailed] = useState(false)
  const busy = item.phase === 'starting' || item.phase === 'processing'
  const active = busy || item.phase === 'preparing' || item.phase === 'downloading'
  const showThumb = item.thumbnail && !thumbFailed

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -14, scale: 0.96, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.94, filter: 'blur(6px)', transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className="row"
      data-phase={item.phase}
    >
      <button
        type="button"
        className="row-main"
        disabled={item.phase !== 'done'}
        onClick={onReveal}
        title={item.phase === 'done' ? (windows ? t.showInFolder : t.showInFinder) : undefined}
      >
        <span className="row-thumb">
          {showThumb ? (
            <motion.img
              src={item.thumbnail}
              alt=""
              draggable={false}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <Glyph video={isVideo(item.format)} />
          )}
        </span>
        <span className="row-text">
          <span className="row-title">{item.title ?? host(item.url)}</span>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={item.phase}
              className="row-status"
              title={item.phase === 'error' ? item.message : undefined}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
            >
              {status(item, t)}
            </motion.span>
          </AnimatePresence>
        </span>
      </button>

      <span className="row-side">
        {item.phase === 'error' && (
          <button type="button" className="row-action" onClick={onRetry} aria-label={t.retry} title={t.retry}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11a8 8 0 1 0-2.3 6.2" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="row-action row-remove"
          onClick={onRemove}
          aria-label={active ? t.cancel : t.removeFromList}
          title={active ? t.cancel : t.removeFromList}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>

        <span className="row-indicator">
          <AnimatePresence mode="wait" initial={false}>
            {item.phase === 'done' ? (
              <motion.span
                key="done"
                className="row-check"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 520, damping: 22 }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <motion.path
                    d="M6.5 12.5l3.8 3.8L17.5 8.5"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.28, delay: 0.08, ease: 'easeOut' }}
                  />
                </svg>
              </motion.span>
            ) : item.phase === 'error' ? (
              <motion.span key="error" className="row-warn" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                !
              </motion.span>
            ) : (
              <motion.span key="ring" exit={{ scale: 0.5, opacity: 0, transition: { duration: 0.12 } }} className={busy ? 'row-ring is-busy' : 'row-ring'}>
                <AnimatedCircularProgressBar
                  className="size-full"
                  value={busy ? 22 : item.percent}
                  transitionLength="0.35s"
                  gaugePrimaryColor="var(--accent)"
                  gaugeSecondaryColor="var(--track)"
                />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </span>
    </motion.li>
  )
}

function Glyph({ video }: { video: boolean }) {
  return video ? (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9 7.2v9.6a.8.8 0 0 0 1.2.7l8-4.8a.8.8 0 0 0 0-1.4l-8-4.8A.8.8 0 0 0 9 7.2Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M5 10v4M9.5 6v12M14.5 9v6M19 11v2" />
    </svg>
  )
}
