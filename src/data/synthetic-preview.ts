// Synthetic controls only. This is not a question bank, substitute reference fixture, or score key.
import { NORMAL_SECTIONS } from '../domain'
import { generateBatch } from '../domain/batch-engine'
import type { ExamCycle, ExamSectionKind } from '../domain'
import type { BatchBank, BatchQuestion, GeneratedNormalBatch } from '../domain/batch-engine'
import type { FoundationPreview, FoundationQuestion } from '../app/App'

export const PREVIEW_VERSION = 'synthetic-preview-v3'
export const ATTEMPT_ID = 'synthetic-foundation-attempt'
export const CYCLE_ID = 'synthetic-foundation-cycle'

export const sectionTitles: Readonly<Record<ExamSectionKind, string>> = {
  CASE_STUDY_1: 'Case Study 1',
  CASE_STUDY_2: 'Case Study 2',
  STANDARD_BLOCK: 'Standard Questions',
  FINAL_INTERACTIVE_BLOCK: 'Final Interactive Questions',
}

const choiceOptions = [
  { id: 'a', label: 'Sample option A' }, { id: 'b', label: 'Sample option B' }, { id: 'c', label: 'Sample option C' },
] as const

const targetOptions = [{ id: 'a', label: 'Sample option A' }, { id: 'b', label: 'Sample option B' }] as const
const targets = ['First field', 'Second field'].map((label, index) => ({
  id: 'field-' + index, label, options: targetOptions,
}))
const pool = NORMAL_SECTIONS.flatMap(({ kind, count }, sectionIndex) =>
  Array.from({ length: count }, (_, index) => ({
    sourceId: 'demo-' + sectionIndex + '-' + (index + 1),
    interactionKind: kind === 'FINAL_INTERACTIVE_BLOCK'
      ? index < 2 ? 'DROPDOWN_HOTSPOT' : 'MATCHING'
      : (sectionIndex === 1 && index === 1 ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE'),
    developmentValidated: true,
    productionEligible: false,
    standardEligible: kind === 'STANDARD_BLOCK',
    interactiveEligible: kind === 'FINAL_INTERACTIVE_BLOCK',
    ...(kind === 'FINAL_INTERACTIVE_BLOCK' ? {} : {
      optionGroups: [{ id: 'options', optionIds: choiceOptions.map(({ id }) => id), shuffle: true }],
    }),
    sectionIndex,
  } satisfies BatchQuestion & { sectionIndex: number })),
)
const byId = new Map<string, BatchQuestion>(pool.map((q) => [q.sourceId, q]))
const bank: BatchBank = {
  version: PREVIEW_VERSION,
  questions: pool,
  caseStudies: [0, 1].map((index) => ({
    id: 'demo-case-' + index,
    childIds: pool.filter((q) => q.sectionIndex === index).map((q) => q.sourceId),
    developmentValidated: true,
    productionEligible: false,
  })),
}

// Pure and deterministic in every tab. This single preview does not create
// a competing cycle plan or mutate the independent cycle registry.
const preview = generateBatch({
  bank,
  cycleState: {
    cycleId: CYCLE_ID, bankVersion: PREVIEW_VERSION, consumedSourceIds: [], reservedSourceIds: [],
  },
  eligibilityPolicy: 'DEVELOPMENT',
  seed: 'foundation-preview',
})
if (!preview.ok || preview.batch.kind !== 'NORMAL_BATCH') throw new Error('The synthetic preview requires one complete normal batch.')
export const previewBatch: GeneratedNormalBatch = preview.batch

// The foundation attempt's display-order snapshot is flat. Its choice renderer
// uses this projection; target selects keep their fixed synthetic source order.
export const previewOptionOrder: Readonly<Partial<Record<string, readonly string[]>>> = preview.batch.optionOrder

// Compatibility wrapper for the one-attempt foundation preview repository only.
// Authoritative generated/started/completed cycle transitions use the separate cycle service.
export const previewCycle: ExamCycle = {
  id: CYCLE_ID,
  contentVersion: PREVIEW_VERSION,
  consumedQuestionIds: [],
  reservedQuestionIds: previewBatch.sections.flatMap((section) => section.questionIds),
}

export function previewQuestion(id: string, displayOrder: readonly string[] | undefined): FoundationQuestion {
  const source = byId.get(id)
  if (!source) throw new Error('Unknown synthetic preview question ID.')
  if (source.interactionKind === 'MATCHING' || source.interactionKind === 'DROPDOWN_HOTSPOT') {
    return {
      id,
      title: source.interactionKind === 'MATCHING' ? 'Match sample items' : 'Choose sample values',
      prompt: 'Try this practice control using touch, mouse, or keyboard. It does not contain exam content.',
      interaction: { kind: source.interactionKind, targets },
    }
  }
  const ordered = displayOrder?.flatMap((id) => choiceOptions.filter((option) => option.id === id)) ?? choiceOptions
  return {
    id,
    title: source.interactionKind === 'MULTIPLE_CHOICE' ? 'Select responses' : 'Select a response',
    prompt: 'This synthetic item demonstrates the examination controls. Select any option, mark it for review, or continue.',
    interaction: source.interactionKind === 'MULTIPLE_CHOICE'
      ? { kind: 'MULTIPLE_CHOICE', options: ordered, requiredSelections: 2 }
      : { kind: 'SINGLE_CHOICE', options: ordered },
  }
}

export function previewContext(caseStudyId: string): FoundationPreview['context'] {
  if (caseStudyId === 'demo-case-0') return {
    title: 'Northwind Learning Center',
    paragraphs: [
      'The learning center is moving staff documents from shared workstations to a managed workspace. Staff at two sites collaborate on course materials.',
      'Course coordinators need to edit their own materials, while visiting instructors need time-limited read access. The operations team wants a clear record of access changes.',
      'Use this fictional scenario to explore the controls. These practice items have no scoring key.',
    ],
  }
  if (caseStudyId === 'demo-case-1') return {
    title: 'Juniper Field Services',
    paragraphs: [
      'Juniper Field Services dispatches maintenance crews to customer sites. Crews use shared tablets to view job notes, and dispatch staff use a separate scheduling workspace.',
      'A tablet may spend a day offline. Team leads must be able to see which updates were saved before a shift ended.',
      'Use this fictional scenario to explore the controls. These practice items have no scoring key.',
    ],
  }
  throw new Error('Unknown synthetic case context.')
}
