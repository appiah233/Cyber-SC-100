import type { CandidateAnswer, CandidateInteractionAnswer } from '../../domain'
import type { AnswerableDisplayInteraction, DisplayInteraction, DisplayResponse, OrderingChange, OrderingDisplayInteraction } from './interaction-types'

const asRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const exact = (record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): boolean =>
  Reflect.ownKeys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))

function validList(value: unknown, options: ReadonlySet<string>, limit: number): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= limit &&
    Reflect.ownKeys(value).length === value.length + 1 && new Set(value).size === value.length &&
    Array.from(value).every((id) => typeof id === 'string' && options.has(id))
}

const orderLength = (interaction: OrderingDisplayInteraction) =>
  interaction.positions?.length ?? interaction.items.length

const requiresUniqueOptions = (interaction: AnswerableDisplayInteraction) =>
  (interaction.kind === 'MATCHING' || interaction.kind === 'DRAG_DROP') && interaction.selectionPolicy === 'UNIQUE'

type Diagram = Extract<DisplayInteraction, { readonly kind: 'DIAGRAM_DEPENDENT' }>
export function isSupportedDiagram(interaction: Diagram): interaction is Diagram & {
  readonly assetId: string
  readonly interaction: AnswerableDisplayInteraction
} {
  const inner = interaction.interaction
  if (typeof interaction.assetId !== 'string' || !interaction.assetId.trim() || !asRecord(inner)) return false
  // A malformed projection must not recurse into another wrapper or expose
  // response controls for an unsupported coordinate image type.
  switch (inner.kind) {
    case 'SINGLE_CHOICE':
    case 'MULTIPLE_CHOICE': return Array.isArray(inner.options)
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
    case 'STATEMENT':
    case 'MATCHING':
    case 'DRAG_DROP': return Array.isArray(inner.targets)
    case 'ORDERING': return Array.isArray(inner.items)
    default: return false
  }
}

function isInnerAnswer(interaction: AnswerableDisplayInteraction, answer: unknown): answer is CandidateInteractionAnswer {
  if (!asRecord(answer) || !Object.hasOwn(answer, 'kind') || answer.kind !== interaction.kind) return false
  if (interaction.kind === 'SINGLE_CHOICE') {
    return exact(answer, 'kind', 'optionId') && interaction.options.some(({ id }) => id === answer.optionId)
  }
  if (interaction.kind === 'MULTIPLE_CHOICE') {
    return exact(answer, 'kind', 'optionIds') &&
      validList(answer.optionIds, new Set(interaction.options.map(({ id }) => id)), interaction.requiredSelections ?? interaction.options.length)
  }
  if (interaction.kind === 'ORDERING') {
    return exact(answer, 'kind', 'optionIds') &&
      validList(answer.optionIds, new Set(interaction.items.map(({ id }) => id)), orderLength(interaction))
  }
  if ('targets' in interaction && exact(answer, 'kind', 'selections') && asRecord(answer.selections)) {
    const selections = Object.entries(answer.selections)
    return Reflect.ownKeys(answer.selections).length === selections.length && selections.length > 0 &&
      (!requiresUniqueOptions(interaction) || new Set(selections.map(([, optionId]) => optionId)).size === selections.length) &&
      selections.every(([targetId, optionId]) =>
        interaction.targets.some((target) => target.id === targetId && target.options.some(({ id }) => id === optionId)))
  }
  return false
}

export function isCandidateAnswerFor(interaction: DisplayInteraction, answer: unknown): answer is CandidateAnswer {
  if (interaction.kind === 'IMAGE_HOTSPOT') return false
  if (interaction.kind === 'DIAGRAM_DEPENDENT') {
    return isSupportedDiagram(interaction) && asRecord(answer) && exact(answer, 'kind', 'response') &&
      answer.kind === 'DIAGRAM_DEPENDENT' && isInnerAnswer(interaction.interaction, answer.response)
  }
  return isInnerAnswer(interaction, answer)
}

function readInner(answer: CandidateInteractionAnswer): DisplayResponse | undefined {
  if (answer.kind === 'SINGLE_CHOICE') return { selected: [answer.optionId] }
  if (answer.kind === 'MULTIPLE_CHOICE') return { selected: [...answer.optionIds] }
  if (answer.kind === 'ORDERING') return { order: [...answer.optionIds] }
  if ('selections' in answer) return {
    targets: Object.fromEntries(
      Object.entries(answer.selections).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  }
  return undefined
}

export function readDisplayResponse(interaction: DisplayInteraction, answer?: CandidateAnswer): DisplayResponse | undefined {
  if (!isCandidateAnswerFor(interaction, answer)) return undefined
  return readInner(answer.kind === 'DIAGRAM_DEPENDENT' ? answer.response : answer)
}

/** Applies an operation to the latest order; never relies on a rendered index.
 * The same operation interpreter may be used for immediate UI display. */
export function applyOrderingChange(
  interaction: OrderingDisplayInteraction,
  previous: readonly string[] | undefined,
  change: OrderingChange,
): readonly string[] | undefined {
  const initial = interaction.positions ? [] : interaction.items.map(({ id }) => id)
  const order = [...(previous ?? initial)]
  if (change.type === 'CONFIRM') return order
  if (!interaction.items.some(({ id }) => id === change.id)) return undefined
  const current = order.indexOf(change.id)
  if (change.type === 'REMOVE') {
    // Item removal is for source-defined subset/slot interactions.
    if (!interaction.positions || current < 0) return undefined
    order.splice(current, 1)
    return order
  }
  if (change.type === 'MOVE') {
    if (current < 0 || (change.direction !== 'DOWN' && change.direction !== 'UP')) return undefined
    const neighbor = current + (change.direction === 'DOWN' ? 1 : -1)
    if (neighbor < 0 || neighbor >= order.length) return undefined
    const item = order[current]
    order[current] = order[neighbor]
    order[neighbor] = item
    return order
  }
  if (change.type !== 'PLACE') return undefined
  if (change.beforeId === change.id) return current < 0 ? undefined : order
  if (change.beforeId !== null && !order.includes(change.beforeId)) return undefined
  if (current >= 0) order.splice(current, 1)
  else if (order.length >= orderLength(interaction)) return undefined
  const index = change.beforeId === null ? order.length : order.indexOf(change.beforeId)
  order.splice(index, 0, change.id)
  return order
}

type TargetInteraction = Extract<AnswerableDisplayInteraction, { readonly targets: readonly unknown[] }>

export function applyTargetChange(
  interaction: TargetInteraction,
  previous: DisplayResponse['targets'],
  change: NonNullable<DisplayResponse['targetChange']>,
): Readonly<Record<string, string>> | undefined {
  const target = interaction.targets.find(({ id }) => id === change.id)
  if (!target || (change.value !== null && !target.options.some(({ id }) => id === change.value))) return undefined
  const selections = new Map(Object.entries(previous ?? {}))
  if (change.fromId !== undefined) {
    const movable = interaction.kind === 'MATCHING' || interaction.kind === 'DRAG_DROP'
    if (!movable || change.value === null || selections.get(change.fromId) !== change.value) return undefined
    if (change.fromId !== change.id) selections.delete(change.fromId)
  }
  if (change.value === null) {
    selections.delete(change.id)
  } else {
    if (requiresUniqueOptions(interaction)) {
      for (const [existingTarget, choice] of selections) {
        if (existingTarget !== change.id && choice === change.value) selections.delete(existingTarget)
      }
    }
    selections.set(change.id, change.value)
  }
  return Object.fromEntries(selections)
}

function innerCandidateAnswer(interaction: AnswerableDisplayInteraction, response: DisplayResponse, previous?: CandidateInteractionAnswer): CandidateInteractionAnswer | null {
  const prior = isInnerAnswer(interaction, previous) ? previous : undefined
  const snapshot = prior && readInner(prior)
  const kind = interaction.kind
  let candidate: CandidateInteractionAnswer | undefined
  if (kind === 'SINGLE_CHOICE') {
    if (response.selected?.length === 1) candidate = { kind, optionId: response.selected[0] }
    else if (!response.selected?.length) return null
  } else if (kind === 'MULTIPLE_CHOICE') {
    const change = response.choiceChange
    if (change) {
      const selected = new Set(snapshot?.selected ?? [])
      if (typeof change.selected !== 'boolean' || !interaction.options.some(({ id }) => id === change.id)) return prior ?? null
      if (change.selected) {
        if (!selected.has(change.id) && interaction.requiredSelections !== undefined && selected.size >= interaction.requiredSelections) return prior ?? null
        selected.add(change.id)
      } else selected.delete(change.id)
      if (!selected.size) return null
      // Serialize in the pinned presentation order, independent of click order.
      candidate = { kind, optionIds: interaction.options.map(({ id }) => id).filter((id) => selected.has(id)) }
    } else {
      if (!response.selected?.length) return null
      candidate = { kind, optionIds: [...response.selected] }
    }
  } else if (kind === 'ORDERING') {
    const order = response.orderChange ? applyOrderingChange(interaction, snapshot?.order, response.orderChange) : response.order
    if (!order) return response.orderChange ? prior ?? null : null
    if (!order.length) return null
    candidate = { kind, optionIds: [...order] }
  } else if ('targets' in interaction) {
    const selections = response.targetChange ? applyTargetChange(interaction, snapshot?.targets, response.targetChange) : response.targets
    if (!selections) return response.targetChange ? prior ?? null : null
    if (!Object.keys(selections).length) return null
    candidate = { kind: interaction.kind, selections: { ...selections } }
  }
  return isInnerAnswer(interaction, candidate) ? candidate : prior ?? null
}

/** Serialize candidate-owned IDs only. No correctness data enters this adapter. */
export function toCandidateAnswer(
  interaction: DisplayInteraction,
  response: DisplayResponse,
  previous?: CandidateAnswer,
): CandidateAnswer | null {
  if (interaction.kind === 'IMAGE_HOTSPOT') return null
  if (interaction.kind === 'DIAGRAM_DEPENDENT') {
    if (!isSupportedDiagram(interaction)) return null
    const mapped = innerCandidateAnswer(interaction.interaction, response, previous?.kind === 'DIAGRAM_DEPENDENT' ? previous.response : undefined)
    return mapped ? { kind: 'DIAGRAM_DEPENDENT', response: mapped } : null
  }
  return innerCandidateAnswer(interaction, response, previous?.kind === 'DIAGRAM_DEPENDENT' ? undefined : previous)
}

export type ResponseState = 'UNANSWERED' | 'INCOMPLETE' | 'ANSWERED'

export function responseState(interaction: DisplayInteraction, response?: DisplayResponse): ResponseState {
  if (!response || interaction.kind === 'IMAGE_HOTSPOT') return 'UNANSWERED'
  if (interaction.kind === 'DIAGRAM_DEPENDENT') {
    return isSupportedDiagram(interaction) ? responseState(interaction.interaction, response) : 'UNANSWERED'
  }
  // Completion reads the snapshot, never a transport delta or a default display order.
  const candidate = innerCandidateAnswer(interaction, { selected: response.selected, targets: response.targets, order: response.order })
  if (!candidate) return 'UNANSWERED'
  if (candidate.kind === 'MULTIPLE_CHOICE' && interaction.kind === 'MULTIPLE_CHOICE' && interaction.requiredSelections !== undefined) {
    return candidate.optionIds.length === interaction.requiredSelections ? 'ANSWERED' : 'INCOMPLETE'
  }
  if (candidate.kind === 'ORDERING' && interaction.kind === 'ORDERING') {
    return candidate.optionIds.length === orderLength(interaction) ? 'ANSWERED' : 'INCOMPLETE'
  }
  if ('selections' in candidate && 'targets' in interaction) {
    return Object.keys(candidate.selections).length === interaction.targets.length ? 'ANSWERED' : 'INCOMPLETE'
  }
  return 'ANSWERED'
}
