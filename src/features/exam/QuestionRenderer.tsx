import { Component, useId, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { Button, Select } from '../../design-system/primitives'

export interface DisplayOption {
  readonly id: string
  readonly label: string
}

export interface DisplayTarget {
  readonly id: string
  readonly label: string
  readonly options: readonly DisplayOption[]
}

type ChoiceKind = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE'
type TargetKind = 'DROPDOWN' | 'DROPDOWN_HOTSPOT' | 'MATCHING' | 'DRAG_DROP' | 'STATEMENT'
export type DisplayInteraction =
  | { readonly kind: ChoiceKind; readonly options: readonly DisplayOption[]; readonly requiredSelections?: number }
  | { readonly kind: TargetKind; readonly targets: readonly DisplayTarget[] }
  | { readonly kind: 'ORDERING'; readonly items: readonly DisplayOption[]; readonly positions?: readonly DisplayOption[] }
  | { readonly kind: 'IMAGE_HOTSPOT' | 'DIAGRAM_DEPENDENT' }

// A display-side response deliberately excludes keys, scoring and source content.
export interface DisplayResponse {
  readonly selected?: readonly string[]
  readonly choiceChange?: { readonly id: string; readonly selected: boolean }
  readonly targets?: Readonly<Record<string, string>>
  readonly targetChange?: { readonly id: string; readonly value: string | null }
  readonly order?: readonly string[]
}

interface RendererProps<T extends DisplayInteraction> {
  readonly interaction: T
  readonly response: DisplayResponse
  readonly onChange: (response: DisplayResponse) => void
  readonly disabled?: boolean
}

function Choices({ interaction, response, onChange, disabled }: RendererProps<Extract<DisplayInteraction, { kind: ChoiceKind }>>) {
  const name = useId()
  const progress = useId()
  const multiple = interaction.kind === 'MULTIPLE_CHOICE'
  const required = multiple ? interaction.requiredSelections : undefined
  const selected = response.selected ?? []
  const limitReached = required !== undefined && selected.length >= required
  return (
    <fieldset className="choices" aria-describedby={required === undefined ? undefined : progress} disabled={disabled}>
      <legend>{required !== undefined ? `Select ${required} options` : multiple ? 'Select all options you want to choose' : 'Select one option'}</legend>
      {required !== undefined && <p id={progress} role="status">
        {selected.length} of {required} selected{limitReached ? '. To change your response, deselect an option first.' : '.'}
      </p>}
      {interaction.options.map((option) => {
        const checked = selected.includes(option.id)
        return (
          <label className="choice" key={option.id}>
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={name}
              value={option.id}
              checked={checked}
              disabled={limitReached && !checked}
              onChange={(event) => {
                const next = multiple
                  ? event.currentTarget.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id)
                  : [option.id]
                onChange(multiple
                  ? { selected: next, choiceChange: { id: option.id, selected: event.currentTarget.checked } }
                  : { selected: next })
              }}
            />
            <span>{option.label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function TargetField({ target, selected, disabled, onChange }: {
  readonly target: DisplayTarget
  readonly selected: string
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
}) {
  // Native selects do not wrap long labels on some phones. Keep native controls
  // for keyboard/AT interaction, and offer the same display text untruncated.
  const longOptions = target.options.some(({ label }) => label.length > 34)
  const current = target.options.find(({ id }) => id === selected)
  return (
    <div style={{ minInlineSize: 0, overflowWrap: 'anywhere' }}>
      <Select label={target.label} value={selected} onChange={(event) => onChange(event.currentTarget.value)} disabled={disabled}>
        <option value="">Select an option</option>
        {target.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </Select>
      {current && longOptions && current.label.length > 34 && <p>Selected: {current.label}</p>}
      {longOptions && <details>
        <summary aria-label={`Read options for ${target.label}`}>Read options</summary>
        <ul>{target.options.map(({ id, label }) => <li key={id}>{label}</li>)}</ul>
      </details>}
    </div>
  )
}

function Targets({ interaction, response, onChange, disabled }: RendererProps<Extract<DisplayInteraction, { kind: TargetKind }>>) {
  const help = useId()
  const matching = interaction.kind === 'MATCHING' || interaction.kind === 'DRAG_DROP'
  return (
    <fieldset className="choices target-fields" aria-describedby={help} disabled={disabled}>
      <legend>{matching ? 'Match the items' : 'Select a response for each field'}</legend>
      <p id={help}>{matching ? 'Choose a match for each item using the lists. No dragging is required.' : 'Each field has its own list of options.'}</p>
      {interaction.targets.map((target) => (
        <TargetField
          key={target.id}
          target={target}
          selected={response.targets?.[target.id] ?? ''}
          onChange={(value) => {
            const next = { ...response.targets }
            if (value === '') delete next[target.id]
            else next[target.id] = value
            onChange({ targets: next, targetChange: { id: target.id, value: value || null } })
          }}
          disabled={disabled}
        />
      ))}
    </fieldset>
  )
}

function Statements({ interaction, response, onChange, disabled }: RendererProps<Extract<DisplayInteraction, { kind: TargetKind }>>) {
  const name = useId()
  return (
    <div className="target-fields">
      {interaction.targets.map((target) => (
        <fieldset className="choices" key={target.id} disabled={disabled}>
          <legend>{target.label}</legend>
          {target.options.map((option) => (
            <label className="choice" key={option.id}>
              <input type="radio" name={name + target.id} value={option.id}
                checked={response.targets?.[target.id] === option.id}
                onChange={() => onChange({ targets: { ...response.targets, [target.id]: option.id }, targetChange: { id: target.id, value: option.id } })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  )
}

function Ordering({ interaction, response, onChange, disabled }: RendererProps<Extract<DisplayInteraction, { kind: 'ORDERING' }>>) {
  const help = useId()
  const [announcement, announce] = useState('')
  const original = interaction.items.map(({ id }) => id)
  const positions = interaction.positions
  const order = response.order ?? (positions ? [] : original)
  const available = positions ? interaction.items.filter(({ id }) => !order.includes(id)) : []
  const labelFor = (id: string) => interaction.items.find((item) => item.id === id)?.label ?? ''
  const change = (next: readonly string[], message: string) => {
    onChange({ order: next })
    announce(message)
  }
  const move = (index: number, offset: number) => {
    const next = [...order]
    const item = next[index]
    const other = next[index + offset]
    if (item === undefined || other === undefined) return
    next[index] = other
    next[index + offset] = item
    change(next, `${labelFor(item)} moved to position ${index + offset + 1}.`)
  }
  return (
    <fieldset className="target-fields choices" aria-describedby={help} disabled={disabled}>
      <legend>Order the items</legend>
      <p id={help}>{positions
        ? `Select ${positions.length} items for the response, then use the move buttons to change their order.`
        : 'Use the buttons to move items up or down. If the starting order is your response, use the confirmation button below.'}</p>
      {positions && <Select
        label={order.length < positions.length ? positions[order.length].label : 'All positions filled'}
        value=""
        disabled={disabled || order.length >= positions.length || !available.length}
        onChange={(event) => {
          const id = event.currentTarget.value
          if (id && available.some((item) => item.id === id)) change([...order, id], `${labelFor(id)} added at position ${order.length + 1}.`)
        }}
      >
        <option value="">{order.length < positions.length ? 'Select an item' : 'All positions filled'}</option>
        {available.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </Select>}
      <ol className="ordering" aria-label="Response order">
        {order.map((id, index) => {
          const label = labelFor(id)
          return (
            <li key={id}>
              <span>{positions ? `${positions[index]?.label ?? `Position ${index + 1}`}: ` : ''}{label}</span>{' '}
              <Button disabled={disabled || index === 0} aria-label={`Move ${label} up`} onClick={() => move(index, -1)}>Up</Button>{' '}
              <Button disabled={disabled || index === order.length - 1} aria-label={`Move ${label} down`} onClick={() => move(index, 1)}>Down</Button>
              {positions && <>{' '}<Button aria-label={`Remove ${label}`} onClick={() => change(order.filter((item) => item !== id), `${label} removed.`)}>Remove</Button></>}
            </li>
          )
        })}
      </ol>
      {!positions && !response.order?.length && <Button onClick={() => change(order, 'Starting order selected.')}>Use this order</Button>}
      <span role="status">{announcement}</span>
    </fieldset>
  )
}

function DeferredInteraction() {
  return <p className="information" role="alert">This interaction is unavailable. You can continue to another question. No new response has been recorded.</p>
}

class InteractionBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean; resetKey?: string }> {
  state = { failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError() { return { failed: true } }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { resetKey?: string }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null
  }

  render() {
    return this.state.failed ? <DeferredInteraction /> : this.props.children
  }
}

type Kind = DisplayInteraction['kind']
type RendererInput = RendererProps<DisplayInteraction>
const choiceView = (props: RendererInput) => props.interaction.kind === 'SINGLE_CHOICE' || props.interaction.kind === 'MULTIPLE_CHOICE'
  ? <Choices {...props} interaction={props.interaction} /> : null
const targetView = (props: RendererInput) => 'targets' in props.interaction ? <Targets {...props} interaction={props.interaction} /> : null

const renderers: Readonly<Record<Kind, ComponentType<RendererInput>>> = {
  SINGLE_CHOICE: choiceView,
  MULTIPLE_CHOICE: choiceView,
  DROPDOWN: targetView,
  DROPDOWN_HOTSPOT: targetView,
  MATCHING: targetView,
  DRAG_DROP: targetView,
  STATEMENT: (props) => 'targets' in props.interaction ? <Statements {...props} interaction={props.interaction} /> : null,
  ORDERING: (props) => props.interaction.kind === 'ORDERING' ? <Ordering {...props} interaction={props.interaction} /> : null,
  IMAGE_HOTSPOT: DeferredInteraction,
  DIAGRAM_DEPENDENT: DeferredInteraction,
}

export function QuestionRenderer(props: RendererInput & { readonly questionKey?: string }) {
  const kind = props.interaction?.kind
  const Renderer = kind && Object.hasOwn(renderers, kind) ? renderers[kind] : DeferredInteraction
  const stableKey = props.questionKey ?? kind
  return <InteractionBoundary resetKey={stableKey}><Renderer key={stableKey} {...props} /></InteractionBoundary>
}
