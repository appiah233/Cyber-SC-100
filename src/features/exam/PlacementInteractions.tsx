import { useId, useRef, useState } from 'react'
import { Button, Select } from '../../design-system/primitives'
import type { DisplayOption, DisplayResponse, DisplayTarget, OrderingChange, OrderingDisplayInteraction, PlacementInteraction, RendererProps } from './interaction-types'
import { applyOrderingChange, applyTargetChange } from './question-response'
import { placementElement, usePlacementPointer } from './use-placement-pointer'
import './placement.css'

interface MatchToken extends DisplayOption { readonly fromId?: string }

export function MatchingInteraction({ interaction, response, onChange, disabled }: RendererProps<PlacementInteraction>) {
  const help = useId()
  const scope = useRef<HTMLFieldSetElement>(null)
  const [selected, select] = useState<MatchToken | null>(null)
  const [message, setMessage] = useState('')
  const assigned = new Map(Object.entries(response.targets ?? {}))
  const targets = interaction.targets
  // Some contracts use different immutable ids even where the printed labels
  // are identical. Do not merge two such options or substitute another id.
  const tokens = new Map<string, MatchToken>()
  for (const target of targets) {
    for (const option of target.options) tokens.set(JSON.stringify([option.id, option.label]), option)
  }
  const canPlace = (token: MatchToken | null, target: DisplayTarget) =>
    token !== null && token.fromId !== target.id && target.options.some(({ id, label }) => id === token.id && label === token.label)

  function change(target: DisplayTarget, value: string | null, fromId?: string) {
    if (disabled) return
    const option = value === null ? undefined : target.options.find(({ id }) => id === value)
    if (value && !option) return
    const targetChange = { id: target.id, value, ...(fromId ? { fromId } : {}) }
    const after = applyTargetChange(interaction, response.targets, targetChange)
    if (!after) {
      setMessage('This item is no longer available to move. No response changed.')
      return
    }
    onChange({ targets: after, targetChange })
    setMessage(option ? `${option.label} placed in ${target.label}.` : `${target.label} cleared.`)
    select(null)
  }
  function place(token: MatchToken, index: number) {
    const destination = targets[index]
    if (!destination || !canPlace(token, destination)) {
      setMessage('This item cannot be placed there. No response changed.')
      return
    }
    change(destination, token.id, token.fromId)
    scope.current?.querySelector<HTMLSelectElement>(`[data-placement-index="${index}"] select`)?.focus({ preventScroll: true })
  }
  const pointer = usePlacementPointer<MatchToken>(
    (x, y, token) => {
      const index = placementElement(scope.current, x, y)?.dataset.placementIndex
      return index !== undefined && canPlace(token, targets[Number(index)]) ? index : null
    },
    (token, destination) => place(token, Number(destination)),
    disabled, () => setMessage('Move cancelled. No response changed.'),
  )

  function choose(token: MatchToken) {
    const toggled = selected?.id === token.id && selected.label === token.label && selected.fromId === token.fromId
    select(toggled ? null : token)
    setMessage(toggled ? 'Selection cleared.' : `${token.label} selected. Choose a destination.`)
  }
  return (
    <fieldset ref={scope} className="choices target-fields placement" aria-describedby={help} disabled={disabled}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (pointer.cancelGesture() || selected) {
          event.preventDefault()
          select(null)
          setMessage('Selection cleared. No response changed.')
        }
      }}>
      <legend>{interaction.kind === 'MATCHING' ? 'Match the items' : 'Place the items'}</legend>
      <p id={help}>Use the lists to choose a response. No dragging is required. You can also drag an item or pick it and then choose where to place it.</p>
      <div className="placement-bank" role="group" aria-label="Available items">
        {[...tokens].map(([key, token]) => (
          <Button key={key} className="placement-handle" aria-label={`Pick ${token.label}`}
            aria-pressed={selected?.id === token.id && selected.label === token.label && !selected.fromId}
            {...pointer.handlers}
            onPointerDown={(event) => pointer.start(event, token, token.label)}
            onClick={(event) => { if (!pointer.consumeClick(event.detail)) choose(token) }}
          ><span aria-hidden="true">⋮⋮</span>{token.label}</Button>
        ))}
      </div>
      <div className="placement-targets">
        {targets.map((target, index) => {
          const current = target.options.find(({ id }) => id === assigned.get(target.id))
          const token: MatchToken | null = current ? { ...current, fromId: target.id } : null
          const longOptions = target.options.some(({ label }) => label.length > 34)
          const allowed = canPlace(selected, target)
          return (
            <div key={target.id} className="placement-target" data-placement-index={index}
              data-drop-active={pointer.moving?.destination === String(index) || undefined}
              data-placeable={allowed || undefined}>
              <Select label={target.label} value={current?.id ?? ''}
                onChange={(event) => change(target, event.currentTarget.value || null)}>
                <option value="">Select an option</option>
                {target.options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
              </Select>
              {longOptions && <details className="placement-options">
                <summary aria-label={`Read options for ${target.label}`}>Read options</summary>
                <ul>{target.options.map(({ id, label }) => <li key={id}>{label}</li>)}</ul>
              </details>}
              <div className="placement-target-actions">
                {token
                  ? <Button className="placement-handle placement-assigned" tone="quiet"
                      aria-label={`Move ${token.label} from ${target.label}`}
                      aria-pressed={selected?.fromId === target.id && selected?.id === token.id}
                      {...pointer.handlers} onPointerDown={(event) => pointer.start(event, token, token.label)}
                      onClick={(event) => { if (!pointer.consumeClick(event.detail)) choose(token) }}
                    ><span aria-hidden="true">⋮⋮</span>{token.label}</Button>
                  : <span className="placement-unassigned">Unassigned</span>}
                <Button tone={allowed ? 'primary' : 'quiet'} disabled={!allowed}
                  onClick={() => { if (selected) place(selected, index) }}>Place in {target.label}</Button>
              </div>
            </div>
          )
        })}
      </div>
      {pointer.moving && <p className="placement-drag" aria-hidden="true">Moving {pointer.moving.label}</p>}
      <p className="placement-feedback" role="status">{message}</p>
    </fieldset>
  )
}

export function OrderingInteraction({ interaction, response, onChange, disabled }: RendererProps<OrderingDisplayInteraction>) {
  const help = useId()
  const scope = useRef<HTMLFieldSetElement>(null)
  const [message, setMessage] = useState('')
  const original = interaction.items.map(({ id }) => id)
  const positions = interaction.positions
  const order = response.order ?? (positions ? [] : original)
  const available = positions ? interaction.items.filter(({ id }) => !order.includes(id)) : []
  const label = (id: string) => interaction.items.find((item) => item.id === id)?.label ?? id

  function change(orderChange: OrderingChange, announce: (next: readonly string[]) => string) {
    if (disabled) return
    const next = applyOrderingChange(interaction, response.order, orderChange)
    if (!next) return
    const snapshot: DisplayResponse = { order: next, orderChange }
    onChange(snapshot)
    setMessage(announce(next))
  }
  function place(id: string, beforeId: string | null) {
    if (beforeId === id) return
    change({ type: 'PLACE', id, beforeId }, (next) => `${label(id)} placed at position ${next.indexOf(id) + 1}.`)
  }
  function move(id: string, direction: 'UP' | 'DOWN') {
    change({ type: 'MOVE', id, direction }, () => `${label(id)} moved ${direction === 'UP' ? 'up' : 'down'}.`)
  }

  const pointer = usePlacementPointer<string>((x, y) => {
    const node = placementElement(scope.current, x, y)
    const index = node?.dataset.placementIndex
    if (!node || index === undefined) return null
    if (index === 'end') return index
    const box = node.getBoundingClientRect()
    return `${index}:${y < box.top + box.height / 2 ? 'before' : 'after'}`
  }, (id, destination) => {
    if (destination === 'end') { place(id, null); return }
    const [indexText, side] = destination.split(':')
    const index = Number(indexText)
    if (order[index] === id) return
    place(id, side === 'before' ? (order[index] ?? null) : order[index + 1] ?? null)
  }, disabled, () => setMessage('Move cancelled. No response changed.'))

  const inRow = (index: number) => pointer.moving?.destination?.startsWith(`${index}:`)
  return (
    <fieldset ref={scope} className="target-fields choices placement" aria-describedby={help} disabled={disabled}
      onKeyDown={(event) => { if (event.key === 'Escape' && pointer.cancelGesture()) event.preventDefault() }}>
      <legend>Order the items</legend>
      <p id={help}>{positions
        ? `Select ${positions.length} items for the response. Use the move buttons, arrow keys on a handle, or drag an item to change its position.`
        : 'Use the move buttons, arrow keys on a handle, or drag items to arrange them. To keep the starting order, select Use this order.'}</p>
      {positions && order.length < positions.length && Boolean(available.length) && <>
        <Select label={positions[order.length].label} value=""
          onChange={(event) => { if (event.currentTarget.value) place(event.currentTarget.value, null) }}>
          <option value="">Select an item</option>
          {available.map(({ id, label: text }) => <option key={id} value={id}>{text}</option>)}
        </Select>
        <div className="placement-bank" role="group" aria-label="Available items">
          {available.map(({ id, label: text }) => <Button key={id} className="placement-handle"
            aria-label={`Add ${text} to the order`} {...pointer.handlers}
            onPointerDown={(event) => pointer.start(event, id, text)}
            onClick={(event) => { if (!pointer.consumeClick(event.detail)) place(id, null) }}
          ><span aria-hidden="true">⋮⋮</span>{text}</Button>)}
        </div>
      </>}
      <ol className="placement-order" aria-label="Response order">
        {order.map((id, index) => {
          const text = label(id)
          const edge = inRow(index) ? pointer.moving?.destination?.split(':')[1] : undefined
          return (
            <li key={id} className="placement-row" data-placement-index={index} data-drop-edge={edge}>
              <div className="placement-row-inner">
              <div className="placement-order-name">
                <Button className="placement-handle placement-grip" tone="quiet" aria-label={`Reorder ${text}`}
                  {...pointer.handlers} onPointerDown={(event) => pointer.start(event, id, text)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                    event.preventDefault()
                    move(id, event.key === 'ArrowUp' ? 'UP' : 'DOWN')
                  }}
                ><span aria-hidden="true">⋮⋮</span></Button>
                <span>{positions ? <><span className="placement-position">{positions[index]?.label}</span> {text}</> : text}</span>
              </div>
              <div className="placement-row-actions">
                <Button aria-disabled={index === 0} aria-label={`Move ${text} up`} onClick={() => move(id, 'UP')}>Up</Button>
                <Button aria-disabled={index === order.length - 1} aria-label={`Move ${text} down`} onClick={() => move(id, 'DOWN')}>Down</Button>
                {positions && <Button aria-label={`Remove ${text}`} onClick={() => {
                  change({ type: 'REMOVE', id }, () => `${text} removed.`)
                }}>Remove</Button>}
              </div>
              </div>
            </li>
          )
        })}
      </ol>
      {Boolean(positions && order.length < positions.length) && (
        <div className="placement-end" data-placement-index="end" data-drop-active={pointer.moving?.destination === 'end' || undefined}>
          Drop here to fill the next position
        </div>
      )}
      {!positions && !response.order?.length && <Button onClick={() => {
        change({ type: 'CONFIRM' }, () => 'Starting order selected.')
      }}>Use this order</Button>}
      {pointer.moving && <p className="placement-drag" aria-hidden="true">Moving {pointer.moving.label}</p>}
      <p className="placement-feedback" role="status">{message}</p>
    </fieldset>
  )
}
