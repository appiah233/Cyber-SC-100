// Original synthetic candidate display only. Authoritative synthetic test definitions
// are intentionally in a separate lazy test module; no protected source is used.
import type { FoundationQuestion } from '../../src/app/App'
import type { BatchQuestion, GeneratedBatch } from '../../src/domain/batch-engine'
import { generateCycleBatch } from '../../src/domain/cycle-plan'
import type { DisplayInteraction, DisplayOption } from '../../src/features/exam/QuestionRenderer'
import { adaptivePool, choiceOptionIds } from './adaptive-pool'

declare const __QA_PHASE7_PROFILE__: string

const name = __QA_PHASE7_PROFILE__
const labels = ['Example Alpha', 'Example Beta', 'Example Gamma'] as const
const options = choiceOptionIds.map((id, i): DisplayOption => ({ id, label: labels[i] }))
const targets = ['North destination', 'South destination'].map((label, i) => ({
  id: i ? 'qa-south' : 'qa-north', label, options,
}))
const planInput = name === 'normal' ? { families: [3, 3], standard: 49, interactive: 4 }
  : name === 'adaptive' || name === 'remainder-41' ? { standard: 100 }
  : name === 'mixed-23' ? { families: [2], standard: 20, interactive: 1 }
  : name === 'threshold' ? { standard: 4 } : { standard: 1 }
const bank = adaptivePool(planInput)

const mixedKinds: Readonly<Record<string, BatchQuestion['interactionKind']>> = {
  'qa-standard-1': 'MULTIPLE_CHOICE', 'qa-standard-2': 'DROPDOWN', 'qa-standard-3': 'ORDERING',
  'qa-standard-4': 'STATEMENT', 'qa-standard-5': 'MATCHING', 'qa-standard-6': 'DRAG_DROP',
}
const fixtureBank = name === 'mixed-23' ? {
  ...bank,
  questions: bank.questions.map((item): BatchQuestion => {
    const kind = mixedKinds[item.sourceId]
    if (!kind) return item
    return kind === 'MULTIPLE_CHOICE' ? { ...item, interactionKind: kind }
      : { ...item, interactionKind: kind, optionGroups: undefined }
  }),
} : bank

function plan(consumedSourceIds: readonly string[] = []): GeneratedBatch {
  const result = generateCycleBatch({
    bank: fixtureBank, eligibilityPolicy: 'DEVELOPMENT', seed: 'qa-phase7-display-order',
    cycleState: {
      cycleId: 'qa-phase7-cycle-' + name, bankVersion: fixtureBank.version, consumedSourceIds, reservedSourceIds: [],
    },
  })
  if (!result.ok) throw new Error('Invalid synthetic Phase 7 plan')
  return result.batch
}
const first = plan()
const batch = name === 'remainder-41' ? plan(first.sourceIds) : first

const questionTitle = (source: BatchQuestion) => source.interactionKind === 'SINGLE_CHOICE'
  ? 'Synthetic choice question'
  : 'Synthetic ' + source.interactionKind.toLowerCase().replaceAll('_', ' ') + ' question'

function display(id: string, optionOrder: readonly string[] | undefined): FoundationQuestion {
  const source = fixtureBank.questions.find(q => q.sourceId === id)
  if (!source) throw new Error('Unknown question in the test fixture')
  const order = optionOrder?.map(id => options.find(option => option.id === id)!) ?? options
  const kind = source.interactionKind
  let interaction: DisplayInteraction
  if (kind === 'SINGLE_CHOICE' || kind === 'MULTIPLE_CHOICE') {
    interaction = kind === 'SINGLE_CHOICE' ? { kind, options: order }
      : { kind, options: order, requiredSelections: 2 }
  } else if (kind === 'ORDERING') {
    interaction = { kind, items: [
      { id: 'qa-step-a', label: 'Collect inputs' }, { id: 'qa-step-b', label: 'Process inputs' }, { id: 'qa-step-c', label: 'Publish output' },
    ] }
  } else if (kind === 'STATEMENT') {
    interaction = {
      kind,
      targets: ['qa-statement-first', 'qa-statement-second'].map((id, i) => ({
        id, label: i ? 'Second sample statement' : 'First sample statement',
        options: [{ id: 'qa-yes', label: 'Yes' }, { id: 'qa-no', label: 'No' }],
      })),
    }
  } else if (kind === 'DROPDOWN' || kind === 'DROPDOWN_HOTSPOT' || kind === 'MATCHING' || kind === 'DRAG_DROP') {
    interaction = { kind, targets }
  } else throw new Error('Unsupported synthetic test interaction')
  return { id, title: questionTitle(source), prompt: 'This is an original synthetic candidate fixture.', interaction }
}

export const phase7Fixture = {
  attemptId: 'qa-phase7-attempt-' + name,
  idbName: 'qa-phase7-database-' + name,
  batch,
  question: display,
  context: () => ({ title: 'Synthetic case context', paragraphs: ['This original scenario is for browser testing only.'] }),
  synthetic: true,
  eligibleSourceIds: fixtureBank.questions.map(x => x.sourceId),
  examDurationMinutes: 4,
  timerWarningMinutes: [2, 1],
  scoring: {
    policy: { scoringVersion: 'qa-phase7-policy-v1', passingPercentage: 75, postExamReviewPolicy: 'NONE' as const },
    loadBank: async () => {
      const counts = globalThis as typeof globalThis & { __qaPhase7LoadCalls?: number }
      counts.__qaPhase7LoadCalls = (counts.__qaPhase7LoadCalls ?? 0) + 1
      return (await import('./phase7-browser-bank')).makeSyntheticBank(batch)
    },
  },
}
export const phase7Positions = Object.fromEntries(batch.sections.flatMap((section, index) =>
  section.questionIds.map((id, i) => [id, { sectionIndex: index, position: i + 1 }])))
