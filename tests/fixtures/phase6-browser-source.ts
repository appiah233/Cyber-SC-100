// Original synthetic interaction data only. Vite injects it into the real Phase 6 app in Playwright.
import type { FoundationContext, FoundationQuestion } from '../../src/app/App'
import type { BatchBank, BatchQuestion } from '../../src/domain/batch-engine'
import { generateCycleBatch } from '../../src/domain/cycle-plan'
import type { DisplayInteraction } from '../../src/features/exam/QuestionRenderer'
import { adaptivePool, choiceOptionIds } from './adaptive-pool'

declare const __QA_PHASE6_PROFILE__: string
declare const __QA_PHASE6_ASSET_ROOT__: string

export const phase6AttemptId = 'qa-phase6-attempt-' + __QA_PHASE6_PROFILE__
export const phase6Database = 'qa-phase6-database-' + __QA_PHASE6_PROFILE__

const nameForId: Record<string, string> = {
  'qa-single': 'Single choice fixture',
  'qa-multiple': 'Multiple choice fixture',
  'qa-dropdown': 'Dropdown fixture',
  'qa-statements': 'Statements fixture',
  'qa-matching': 'Matching fixture',
  'qa-ordering': 'Ordering fixture',
  'qa-position-order': 'Explicit ordering positions fixture',
  'qa-drag': 'Drag and drop fixture',
  'qa-hotspot-dropdown': 'Dropdown HOTSPOT fixture',
  'qa-exhibit': 'Exhibit fixture',
  'qa-missing-exhibit': 'Missing exhibit fixture',
  'qa-image-deferred': 'Image interaction safely unavailable',
}
const options = [
  { id: 'qa-option-a', label: 'Example Alpha' },
  { id: 'qa-option-b', label: 'Example Beta' },
  { id: 'qa-option-c', label: 'Example Gamma with intentionally long text to test wrapping, label readability, and operation in narrow layouts.' },
]
const targets = [
  { id: 'qa-target-north', label: 'North destination', options },
  { id: 'qa-target-south', label: 'South destination', options },
]
const statements = [{ id: 'qa-yes', label: 'Yes' }, { id: 'qa-no', label: 'No' }]
const items = [
  { id: 'qa-step-a', label: 'Collect inputs' },
  { id: 'qa-step-b', label: 'Process inputs' },
  { id: 'qa-step-c', label: 'Publish output' },
]
const questions = new Map<string, DisplayInteraction>([
  ['qa-single', { kind: 'SINGLE_CHOICE', options }],
  ['qa-multiple', { kind: 'MULTIPLE_CHOICE', options, requiredSelections: 2 }],
  ['qa-dropdown', { kind: 'DROPDOWN', targets }],
  ['qa-statements', { kind: 'STATEMENT', targets: [
    { id: 'qa-statement-a', label: 'The example map has a North destination', options: statements },
    { id: 'qa-statement-b', label: 'The example map has a South destination', options: statements },
  ] }],
  ['qa-matching', { kind: 'MATCHING', targets }],
  ['qa-ordering', { kind: 'ORDERING', items }],
  ['qa-position-order', { kind: 'ORDERING', items, positions: [
    { id: 'qa-position-first', label: 'First assigned position' },
    { id: 'qa-position-next', label: 'Second assigned position' },
  ] }],
  ['qa-drag', { kind: 'DRAG_DROP', targets }],
  ['qa-hotspot-dropdown', { kind: 'DROPDOWN_HOTSPOT', targets }],
  ['qa-exhibit', { kind: 'DIAGRAM_DEPENDENT', assetId: 'qa-demo-exhibit', interaction: { kind: 'SINGLE_CHOICE', options } }],
  ['qa-missing-exhibit', { kind: 'SINGLE_CHOICE', options }],
  ['qa-image-deferred', { kind: 'IMAGE_HOTSPOT' }],
])
const special = new Set<DisplayInteraction['kind']>(['MATCHING', 'ORDERING', 'DRAG_DROP', 'DROPDOWN_HOTSPOT', 'STATEMENT', 'IMAGE_HOTSPOT', 'DIAGRAM_DEPENDENT'])
const matrixBank: BatchBank = {
  version: 'qa-phase6-matrix-v1',
  caseStudies: [],
  questions: Array.from(questions, ([sourceId, display]): BatchQuestion => ({
    sourceId,
    interactionKind: display.kind,
    developmentValidated: true,
    productionEligible: false,
    standardEligible: !special.has(display.kind),
    interactiveEligible: special.has(display.kind),
    ...('options' in display ? { optionGroups: [{ id: 'qa-option-group', optionIds: options.map(x => x.id), shuffle: true }] } : {}),
  })),
}
const profile = __QA_PHASE6_PROFILE__
const bank = profile === 'matrix' ? matrixBank
  : profile === 'normal-timed' ? adaptivePool({ families: [3, 3], standard: 49, interactive: 4 })
  : profile === 'one-timed' ? adaptivePool({ standard: 1 })
  : adaptivePool({ standard: 59 })
const cycleId = 'qa-phase6-cycle-' + profile
const result = generateCycleBatch({
  bank, seed: 'qa-phase6-seed', eligibilityPolicy: 'DEVELOPMENT',
  cycleState: { cycleId, bankVersion: bank.version, consumedSourceIds: [], reservedSourceIds: [] },
})
if (!result.ok) throw new Error('Invalid Phase 6 synthetic fixture plan')

const syntheticOptionLabels = new Map([
  [choiceOptionIds[0], 'Example Alpha'], [choiceOptionIds[1], 'Example Beta'], [choiceOptionIds[2], 'Example Gamma'],
])
function display(id: string, optionOrder: readonly string[] | undefined): FoundationQuestion {
  const source = bank.questions.find(x => x.sourceId === id)
  if (!source) throw new Error('Unknown synthetic Phase 6 question')
  const targetDisplay: DisplayInteraction = source.interactionKind === 'MATCHING' || source.interactionKind === 'DROPDOWN_HOTSPOT'
    ? { kind: source.interactionKind, targets }
    : { kind: 'SINGLE_CHOICE', options: (optionOrder ?? choiceOptionIds).map(id => ({
      id, label: syntheticOptionLabels.get(id as typeof choiceOptionIds[number]) ?? 'Unknown synthetic option',
    })) }
  const original = questions.get(id)
  const interaction = original && 'options' in original && optionOrder
    ? { ...original, options: optionOrder.map(id => original.options.find(option => option.id === id)!) }
    : original ?? targetDisplay
  return {
    id, title: nameForId[id] ?? 'Timed sample question',
    prompt: 'This original fixture tests candidate controls and contains no scored or private examination material.',
    interaction,
    ...(id === 'qa-exhibit' ? { assets: [{
      id: 'qa-demo-exhibit', label: 'Synthetic flow diagram', alt: 'Three example nodes joined by arrows',
      description: 'The sample diagram shows three boxes joined by arrows from left to right.',
      src: __QA_PHASE6_ASSET_ROOT__ + 'assets/exhibits/example-exhibit.png',
    }] } : {}),
    ...(id === 'qa-missing-exhibit' ? { assets: [
      { id: 'qa-missing-asset', label: 'Unavailable original exhibit', src: __QA_PHASE6_ASSET_ROOT__ + 'assets/exhibits/nonexistent-exhibit.png' },
      { id: 'qa-nonapproved-asset', label: 'Unsafe exhibit example', src: 'javascript:void(0)' },
    ] } : {}),
  }
}

export const phase6Fixture = {
  attemptId: phase6AttemptId,
  idbName: phase6Database,
  batch: result.batch,
  question: display,
  context: (id: string): FoundationContext => ({
    title: id === 'qa-family-1' ? 'Synthetic case context A' : 'Synthetic case context B',
    paragraphs: ['The synthetic case material is never supplied to the protected bank.'],
  }),
  synthetic: true,
  eligibleSourceIds: [...result.batch.sourceIds],
  ...(profile === 'matrix' ? {} : { examDurationMinutes: 4, timerWarningMinutes: [2, 1] }),
}

// Allows browser tests to address the real generated navigator by position without assuming seed order.
// Never included in the public runtime build.
export const phase6MatrixPositions = Object.fromEntries(result.batch.sections.flatMap((section, sectionIndex) =>
  section.questionIds.map((id, position) => [id, { sectionIndex, position: position + 1 }])))
