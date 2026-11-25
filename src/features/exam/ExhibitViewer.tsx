import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { Button } from '../../design-system/primitives'
import './exhibit-viewer.css'

const rasterMime = /^data:image\/(png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/]+={0,2})$/u
const rasterSuffix = /\.(?:png|jpe?g|gif|webp|avif)$/iu
const maxEncodedImage = 6 * 1024 * 1024

function hasRasterSignature(kind: string, encoded: string) {
  if (encoded.length < 16 || encoded.length % 4 !== 0) return false
  const bytes = atob(encoded.slice(0, 24))
  switch (kind) {
    case 'png': return bytes.startsWith('\x89PNG\r\n\x1a\n')
    case 'jpeg': return bytes.startsWith('\xff\xd8\xff')
    case 'gif': return bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a')
    case 'webp': return bytes.startsWith('RIFF') && bytes.startsWith('WEBP', 8)
    case 'avif': return bytes.startsWith('ftyp', 4) && /^(?:avif|avis)$/u.test(bytes.slice(8, 12))
    default: return false
  }
}

/** HTML, SVG, blob and remote URLs are not images authorized by this viewer.
 * Same-origin paths must live under the application's dedicated asset prefix. */
export function exhibitImageUrl(src: string | undefined): string | undefined {
  if (!src || typeof src !== 'string' || src.length > maxEncodedImage || typeof window === 'undefined') return undefined
  try {
    const inline = src.match(rasterMime)
    if (inline) return hasRasterSignature(inline[1], inline[2]) ? src : undefined
    if (src.startsWith('//') || /[%\\\s?#]/u.test(src) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(src)) return undefined
    const origin = window.location.origin
    const base = new URL(import.meta.env.BASE_URL, window.location.href)
    const url = new URL(src, base)
    const assets = new URL('assets/exhibits/', base).pathname
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin ||
      url.username || url.password || url.search || url.hash || !url.pathname.startsWith(assets)) return undefined
    const filename = url.pathname.slice(assets.length)
    return /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/u.test(filename) && rasterSuffix.test(filename) ? url.href : undefined
  } catch {
    return undefined
  }
}

export interface ExhibitAsset {
  readonly id: string
  readonly label: string
  readonly alt?: string
  readonly src?: string
  readonly description?: string
}

export function ExhibitViewer({ asset, onAvailabilityChange, onUnavailable }: {
  readonly asset: ExhibitAsset
  readonly onAvailabilityChange?: (id: string, available: boolean) => void
  readonly onUnavailable?: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const source = exhibitImageUrl(asset.src)
  const [failedSource, setFailedSource] = useState<string>()
  const [zoom, setZoom] = useState(100)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const description = asset.description?.trim()
  const alt = asset.alt?.trim() || asset.label
  const available = Boolean(source && source !== failedSource)
  const unavailable = useEffectEvent(() => {
    onAvailabilityChange?.(asset.id, false)
    onUnavailable?.()
  })
  useEffect(() => {
    if (!available) unavailable()
  }, [available, source, asset.id])

  function fail() {
    dialogRef.current?.close()
    setFailedSource(source)
  }

  return (
    <figure className="exhibit exhibit-viewer">
      <figcaption>{asset.label}</figcaption>
      {available ? <>
        <img
          src={source}
          alt={alt}
          referrerPolicy="no-referrer"
          onLoad={() => onAvailabilityChange?.(asset.id, true)}
          onError={fail}
        />
        <button type="button" ref={expandRef} className="button button--neutral"
          aria-label={`Expand exhibit: ${asset.label}`} aria-haspopup="dialog"
          onClick={() => {
            if (!dialogRef.current?.open) dialogRef.current?.showModal()
            setZoom(100)
            viewportRef.current?.scrollTo(0, 0)
            closeRef.current?.focus()
          }}>Expand exhibit <span aria-hidden="true">↗</span></button>
      </> : <p className="exhibit-unavailable" role="status">This exhibit image is unavailable.</p>}
      {description && <p>{description}</p>}
      <dialog ref={dialogRef} className="exhibit-modal" aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onClose={() => {
          if (expandRef.current?.isConnected) expandRef.current.focus()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const first = closeRef.current
          const last = viewportRef.current
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}>
        <header className="exhibit-modal-header">
          <h2 id={titleId}>{asset.label}</h2>
          <button type="button" ref={closeRef} className="button button--neutral"
            onClick={() => dialogRef.current?.close()}>Close exhibit</button>
        </header>
        <div className="exhibit-toolbar" role="group" aria-label="Exhibit magnification">
          <Button aria-disabled={zoom <= 100} onClick={() => setZoom((value) => Math.max(100, value - 25))}>Zoom out</Button>
          <Button aria-disabled={zoom === 100} onClick={() => {
            setZoom(100)
            viewportRef.current?.scrollTo(0, 0)
          }}>Fit to window</Button>
          <Button aria-disabled={zoom >= 300} onClick={() => setZoom((value) => Math.min(300, value + 25))}>Zoom in</Button>
          <span role="status">{zoom}%</span>
        </div>
        {zoom > 100 && <p className="exhibit-pan-help">Scroll to inspect the enlarged image.</p>}
        {description && <p className="exhibit-modal-description" id={descriptionId}>{description}</p>}
        <div className="exhibit-viewport" ref={viewportRef} role="region" aria-label="Exhibit image. Scroll when zoomed." tabIndex={0}>
          {available && <img
            src={source}
            alt={alt}
            referrerPolicy="no-referrer"
            data-fit={zoom === 100}
            style={{ width: zoom + '%' }}
            onError={fail}
          />}
        </div>
      </dialog>
    </figure>
  )
}
