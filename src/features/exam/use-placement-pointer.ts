import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/** Native pointer capture gives mouse, pen and touch the same gesture. Only
 * explicit handles opt out of scrolling. Keyboard controls do not depend on it. */
export function usePlacementPointer<T>(
  locate: (x: number, y: number, payload: T) => string | null,
  drop: (payload: T, destination: string) => void,
  disabled?: boolean,
  onCancel?: () => void,
) {
  type Gesture = {
    pointer: number; element: HTMLElement; payload: T; label: string
    x0: number; y0: number; x: number; y: number; active: boolean
  }
  const gesture = useRef<Gesture | null>(null)
  const frame = useRef(0)
  const swallow = useRef(false)
  const [moving, setMoving] = useState<{ label: string; destination: string | null } | null>(null)

  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  function stop(suppress: boolean) {
    const current = gesture.current
    gesture.current = null
    if (suppress) swallow.current = true
    cancelAnimationFrame(frame.current)
    frame.current = 0
    if (current?.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer)
    setMoving(null)
  }
  useEffect(() => {
    if (disabled && gesture.current) {
      const previous = gesture.current
      gesture.current = null
      swallow.current = previous.active
      cancelAnimationFrame(frame.current)
      frame.current = 0
      if (previous.element.hasPointerCapture?.(previous.pointer)) previous.element.releasePointerCapture(previous.pointer)
      frame.current = requestAnimationFrame(() => setMoving(null))
    }
  }, [disabled])

  function tick() {
    const current = gesture.current
    if (!current?.active) { frame.current = 0; return }
    const edge = Math.min(80, window.innerHeight / 8)
    const inside = current.x >= 0 && current.x <= window.innerWidth && current.y >= 0 && current.y <= window.innerHeight
    if (inside && current.y < edge) window.scrollBy(0, -Math.max(2, Math.ceil((edge - current.y) / 4)))
    else if (inside && current.y > window.innerHeight - edge)
      window.scrollBy(0, Math.max(2, Math.ceil((current.y - (window.innerHeight - edge)) / 4)))
    const destination = locate(current.x, current.y, current.payload)
    setMoving((previous) => previous?.label === current.label && previous.destination === destination
      ? previous : { label: current.label, destination })
    frame.current = requestAnimationFrame(tick)
  }

  function start(event: ReactPointerEvent<HTMLElement>, payload: T, label: string) {
    if (disabled || !event.isPrimary || event.button !== 0 || gesture.current) return
    swallow.current = false
    const element = event.currentTarget
    element.setPointerCapture?.(event.pointerId)
    gesture.current = {
      pointer: event.pointerId, element, payload, label,
      x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, active: false,
    }
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    if (!current.active && Math.hypot(current.x - current.x0, current.y - current.y0) >= 6) {
      current.active = true
      tick()
    }
  }
  function finish(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    const destination = current.active && !disabled ? locate(event.clientX, event.clientY, current.payload) : null
    stop(current.active)
    if (destination !== null) drop(current.payload, destination)
    else if (current.active) onCancel?.()
  }
  function cancel(event: ReactPointerEvent<HTMLElement>) {
    if (gesture.current?.pointer !== event.pointerId) return
    const active = gesture.current.active
    stop(active)
    if (active) onCancel?.()
  }
  function cancelGesture() {
    const current = gesture.current
    if (!current) return false
    stop(current.active)
    if (current.active) onCancel?.()
    return true
  }
  function consumeClick(detail: number) {
    if (detail === 0 || !swallow.current) return false
    swallow.current = false
    return true
  }
  return {
    moving: disabled ? null : moving, start, cancelGesture, consumeClick,
    handlers: { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel },
  }
}

export function placementElement(scope: HTMLElement | null, x: number, y: number): HTMLElement | undefined {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-placement-index]')
  return hit && scope?.contains(hit) ? hit : undefined
}
