import { useId } from 'react'
import type { ComponentType } from 'react'
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
  | { readonly kind: ChoiceKind; readonly options: readonly DisplayOption[] }
  | { readonly kind: TargetKind; readonly targets: readonly DisplayTarget[] }
  | { readonly kind: 'ORDERING'; readonly items: readonly DisplayOption[] }
  | { readonly kind: 'IMAGE_HOTSPOT' | 'DIAGRAM_DEPENDENT' }

// A display-side response deliberately excludes keys, scoring and source content.
export interface DisplayResponse {
  readonly selected?: readonly string[]
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
  const multiple = interaction.kind === 'MULTIPLE_CHOICE'
  return (
    <fieldset className="choices" disabled={disabled}>
      <legend>{multiple ? 'Select all options you want to choose' : 'Select one option'}</legend>
      {interaction.options.map((option) => {
        const selected = response.selected ?? []
        const checked = selected.includes(option.id)
        return (
          <label className="choice" key={option.id}>
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={name}
              value={option.id}
              checked={checked}
              onChange={(event) => {
                const next = multiple
                  ? event.currentTarget.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id)
                  : [option.id]
                onChange({ selected: next })
              }}
            />
            <span>{option.label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function Targets({ interaction, response, onChange, disabled }: RendererProps<Extract<DisplayInteraction, { kind: TargetKind }>>) {
  const help = interaction.kind === 'MATCHING' || interaction.kind === 'DRAG_DROP'
    ? 'Choose a match for each item. You can complete the task without dragging.'
    : 'Choose a response for each field.'
  return (
    <div className="target-fields">
      <p>{help}</p>
      {interaction.targets.map((target) => (
        <Select
          key={target.id}
          label={target.label}
          value={response.targets?.[target.id] ?? ''}
          onChange={(event) => {
            const next = { ...response.targets }
            if (event.currentTarget.value === '') delete next[target.id]
            else next[target.id] = event.currentTarget.value
            onChange({ targets: next, targetChange: { id: target.id, value: event.currentTarget.value || null } })
          }}
          disabled={disabled}
        >
          <option value="">Select an option</option>
          {target.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      ))}
    </div>
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
  const order = response.order ?? interaction.items.map((item) => item.id)
  const move = (index: number, offset: number) => {
    const next = [...order]
    const item = next[index]
    const other = next[index + offset]
    if (item === undefined || other === undefined) return
    next[index] = other
    next[index + offset] = item
    onChange({ order: next })
  }
  return (
    <div className="target-fields">
      <p>Use the move buttons to arrange the items.</p>
      <ol className="ordering">
        {order.map((id, index) => {
          const label = interaction.items.find((item) => item.id === id)?.label ?? id
          return (
            <li key={id}>
              <span>{label}</span>
              <Button disabled={disabled || index === 0} aria-label={`Move ${label} up`} onClick={() => move(index, -1)}>Up</Button>
              <Button disabled={disabled || index === order.length - 1} aria-label={`Move ${label} down`} onClick={() => move(index, 1)}>Down</Button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function DeferredInteraction() {
  return <p className="information">This interaction is not available in the foundation preview. No response has been recorded.</p>
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

export function QuestionRenderer(props: RendererInput) {
  const Renderer = renderers[props.interaction.kind]
  return <Renderer {...props} />
}
