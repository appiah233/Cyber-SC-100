// Synthetic controls only. This is not a question bank, substitute reference fixture, or score key.
import { NORMAL_SECTIONS } from '../domain'
import { generateBatch } from '../domain/batch-engine'
import type { ExamBatch, ExamCycle, ExamSectionKind } from '../domain'
import type { BatchBank, BatchQuestion } from '../domain/batch-engine'
import type { FoundationQuestion } from '../app/App'

export const PREVIEW_VERSION = 'synthetic-preview-v2'
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
      : 'SINGLE_CHOICE',
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
export const previewBatch: ExamBatch = preview.batch

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
    title: 'Select a response',
    prompt: 'This synthetic item demonstrates the examination controls. Select any option, mark it for review, or continue.',
    interaction: { kind: 'SINGLE_CHOICE', options: ordered },
  }
}
