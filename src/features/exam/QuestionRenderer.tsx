import { Component, useId } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { Button, Select } from '../../design-system/primitives'

import { MatchingInteraction, OrderingInteraction } from './PlacementInteractions'
import { getTargetSelection } from './interaction-types'
import type { DisplayInteraction, DisplayTarget, RendererProps } from './interaction-types'
import { applyTargetChange, isSupportedDiagram } from './question-response'

export type {
  AnswerableDisplayInteraction, DisplayInteraction, DisplayOption, DisplayResponse, DisplayTarget,
} from './interaction-types'

type ChoicesType = Extract<DisplayInteraction, { readonly kind: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' }>
type DropdownType = Extract<DisplayInteraction, { readonly kind: 'DROPDOWN' | 'DROPDOWN_HOTSPOT' }>
type StatementType = Extract<DisplayInteraction, { readonly kind: 'STATEMENT' }>

function Choices({ interaction, response, onChange, disabled }: RendererProps<ChoicesType>) {
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

function Targets({ interaction, response, onChange, disabled }: RendererProps<DropdownType>) {
  const help = useId()
  return (
    <fieldset className="choices target-fields" aria-describedby={help} disabled={disabled}>
      <legend>Select a response for each field</legend>
      <p id={help}>{interaction.kind === 'DROPDOWN_HOTSPOT'
        ? 'Select a response for each location in the answer area. Each location has its own list of options.'
        : 'Each field has its own list of options.'}</p>
      {interaction.targets.map((target) => (
        <TargetField
          key={target.id}
          target={target}
          selected={getTargetSelection(response.targets, target.id) ?? ''}
          onChange={(value) => {
            const change = { id: target.id, value: value || null }
            const next = applyTargetChange(interaction, response.targets, change)
            if (next) onChange({ targets: next, targetChange: change })
          }}
          disabled={disabled}
        />
      ))}
    </fieldset>
  )
}

function Statements({ interaction, response, onChange, disabled }: RendererProps<StatementType>) {
  const name = useId()
  const update = (id: string, value: string | null) => {
    const change = { id, value }
    const next = applyTargetChange(interaction, response.targets, change)
    if (next) onChange({ targets: next, targetChange: change })
  }
  return (
    <div className="target-fields">
      <p>Respond to each statement separately.</p>
      {interaction.targets.map((target) => {
        const selected = getTargetSelection(response.targets, target.id)
        return (
          <fieldset className="choices" key={target.id} disabled={disabled}>
            <legend>{target.label}</legend>
            {target.options.map((option) => (
              <label className="choice" key={option.id}>
                <input type="radio" name={name + target.id} value={option.id}
                  checked={selected === option.id}
                  onChange={() => update(target.id, option.id)}
                />
                <span>{option.label}</span>
              </label>
            ))}
            {selected && <Button aria-label={`Clear response for ${target.label}`} onClick={() => update(target.id, null)}>Clear response</Button>}
          </fieldset>
        )
      })}
    </div>
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
type InteractionOf<K extends Kind> = Extract<DisplayInteraction, { readonly kind: K }>

function DiagramInteraction(props: RendererProps<InteractionOf<'DIAGRAM_DEPENDENT'>>) {
  if (!isSupportedDiagram(props.interaction) || !props.availableExhibitIds?.includes(props.interaction.assetId)) {
    return <p role="alert" className="information">The required exhibit is unavailable. You can continue to another question. No new response has been recorded.</p>
  }
  return <RegisteredInteraction {...props} interaction={props.interaction.interaction} />
}

function register<K extends Kind>(kind: K, Renderer: ComponentType<RendererProps<InteractionOf<K>>>): ComponentType<RendererInput> {
  return function RegisteredKind(props) {
    if (props.interaction.kind !== kind) return <DeferredInteraction />
    // The runtime discriminant check guarantees this generic relationship.
    return <Renderer {...props} interaction={props.interaction as InteractionOf<K>} />
  }
}

const renderers = {
  SINGLE_CHOICE: register('SINGLE_CHOICE', Choices),
  MULTIPLE_CHOICE: register('MULTIPLE_CHOICE', Choices),
  DROPDOWN: register('DROPDOWN', Targets),
  DROPDOWN_HOTSPOT: register('DROPDOWN_HOTSPOT', Targets),
  MATCHING: register('MATCHING', MatchingInteraction),
  DRAG_DROP: register('DRAG_DROP', MatchingInteraction),
  STATEMENT: register('STATEMENT', Statements),
  ORDERING: register('ORDERING', OrderingInteraction),
  IMAGE_HOTSPOT: register('IMAGE_HOTSPOT', DeferredInteraction),
  DIAGRAM_DEPENDENT: register('DIAGRAM_DEPENDENT', DiagramInteraction),
} satisfies Readonly<Record<Kind, ComponentType<RendererInput>>>

function RegisteredInteraction(props: RendererInput) {
  const kind = props.interaction?.kind
  const Renderer = kind && Object.hasOwn(renderers, kind) ? renderers[kind] : DeferredInteraction
  return <Renderer {...props} />
}

export function QuestionRenderer(props: RendererInput & { readonly questionKey?: string }) {
  const stableKey = props.questionKey ?? props.interaction?.kind
  // Defense in depth: read-only/disabled interactions cannot emit even through a
  // synthetic event or an in-flight pointer operation finishing after a lock.
  const disabled = Boolean(props.disabled || props.readOnly)
  const onChange: RendererInput['onChange'] = (response) => { if (!disabled) props.onChange(response) }
  return <InteractionBoundary resetKey={stableKey}>
    <RegisteredInteraction key={stableKey} {...props} disabled={disabled} onChange={onChange} />
  </InteractionBoundary>
}
