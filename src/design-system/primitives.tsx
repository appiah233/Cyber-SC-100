import { useEffect, useId, useRef } from 'react'
import type {
  ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes,
} from 'react'

export function Button({ tone = 'neutral', className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'neutral' | 'primary' | 'quiet'
}) {
  return <button type={type} className={['button', 'button--' + tone, className].filter(Boolean).join(' ')} {...props} />
}

export function Panel({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return <section aria-label={label} className={['panel', className].filter(Boolean).join(' ')}>{children}</section>
}

export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'error' }) {
  return <span className={`status status--${tone}`}><span className="status-dot" aria-hidden="true" />{children}</span>
}

export function Progress({ current, total, label }: { current: number; total: number; label: string }) {
  return <progress className="progress" aria-label={label} value={current} max={total}>{current} of {total}</progress>
}

export function Select({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="select-field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id}>{children}</select>
    </div>
  )
}

export function ConfirmDialog({
  open, title, description, confirmLabel, onCancel, onConfirm, cancelLabel = 'Keep reviewing',
}: {
  open: boolean; title: string; description: string; confirmLabel: string
  onCancel: () => void; onConfirm: () => void; cancelLabel?: string
}) {
  const titleId = useId()
  const descriptionId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      cancelRef.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onCancel() }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const first = cancelRef.current
        const last = confirmRef.current
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      <div className="dialog-actions">
        <button ref={cancelRef} className="button button--neutral" type="button" onClick={onCancel}>{cancelLabel}</button>
        <button ref={confirmRef} className="button button--primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  )
}
