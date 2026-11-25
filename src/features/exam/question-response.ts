import type { CandidateAnswer } from '../../domain'
import type { DisplayInteraction, DisplayResponse } from './QuestionRenderer'

const asRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exact = (record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))

function validList(value: unknown, options: ReadonlySet<string>, limit: number): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= limit && new Set(value).size === value.length &&
    Array.from(value).every((id) => typeof id === 'string' && options.has(id))
}

const orderLength = (interaction: Extract<DisplayInteraction, { readonly kind: 'ORDERING' }>) =>
  interaction.positions?.length ?? interaction.items.length

export function isCandidateAnswerFor(interaction: DisplayInteraction, answer: unknown): answer is CandidateAnswer {
  if (!asRecord(answer) || answer.kind !== interaction.kind || !Object.hasOwn(answer, 'kind')) return false
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
    return selections.length > 0 && selections.every(([targetId, optionId]) =>
      interaction.targets.some((target) => target.id === targetId && target.options.some(({ id }) => id === optionId)))
  }
  // Phase 5 has no validated coordinate geometry or diagram-wrapped answers to render.
  return false
}

export function readDisplayResponse(interaction: DisplayInteraction, answer?: CandidateAnswer): DisplayResponse | undefined {
  if (!isCandidateAnswerFor(interaction, answer)) return undefined
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

/** Nothing in this adapter scores or compares an answer to any other record. */
export function toCandidateAnswer(
  interaction: DisplayInteraction,
  response: DisplayResponse,
  previous?: CandidateAnswer,
): CandidateAnswer | null {
  const kind = interaction.kind
  let candidate: CandidateAnswer | undefined
  if (kind === 'SINGLE_CHOICE') {
    if (response.selected?.length === 1) candidate = { kind, optionId: response.selected[0] }
  } else if (kind === 'MULTIPLE_CHOICE') {
    const change = response.choiceChange
    if (change) {
      const prior = new Set(readDisplayResponse(interaction, previous)?.selected ?? [])
      if (!interaction.options.some(({ id }) => id === change.id)) return previous && isCandidateAnswerFor(interaction, previous) ? previous : null
      if (change.selected) {
        if (!prior.has(change.id) && interaction.requiredSelections !== undefined && prior.size >= interaction.requiredSelections) {
          return previous && isCandidateAnswerFor(interaction, previous) ? previous : null
        }
        prior.add(change.id)
      } else prior.delete(change.id)
      // Serialize in the pinned presentation order, independent of click order.
      candidate = { kind, optionIds: interaction.options.map(({ id }) => id).filter((id) => prior.has(id)) }
    } else {
      candidate = { kind, optionIds: [...(response.selected ?? [])] }
    }
  } else if (kind === 'ORDERING') {
    candidate = { kind, optionIds: [...(response.order ?? [])] }
  } else if ('targets' in interaction) {
    const change = response.targetChange
    if (change) {
      const target = interaction.targets.find(({ id }) => id === change.id)
      if (!target || (change.value !== null && !target.options.some(({ id }) => id === change.value))) {
        return previous && isCandidateAnswerFor(interaction, previous) ? previous : null
      }
      const selections = new Map(Object.entries(readDisplayResponse(interaction, previous)?.targets ?? {}))
      if (change.value === null) selections.delete(change.id)
      else selections.set(change.id, change.value)
      candidate = { kind: interaction.kind, selections: Object.fromEntries(selections) }
    } else {
      candidate = { kind: interaction.kind, selections: { ...response.targets } }
    }
  }
  return isCandidateAnswerFor(interaction, candidate) ? candidate : null
}

export type ResponseState = 'UNANSWERED' | 'INCOMPLETE' | 'ANSWERED'

export function responseState(interaction: DisplayInteraction, response?: DisplayResponse): ResponseState {
  if (!response) return 'UNANSWERED'
  // Completion reads the snapshot, never a transport delta or a default display order.
  const candidate = toCandidateAnswer(interaction, { selected: response.selected, targets: response.targets, order: response.order })
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
