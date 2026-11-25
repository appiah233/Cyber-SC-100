// Synthetic controls only. This is not a question bank, substitute reference fixture, or score key.
import { NORMAL_SECTIONS, seededQuestionOrder } from '../domain'
import type { ExamBatch, ExamCycle, ExamSectionKind } from '../domain'
import type { FoundationQuestion } from '../app/App'

export const PREVIEW_VERSION = 'synthetic-preview-v1'
export const ATTEMPT_ID = 'synthetic-foundation-attempt'
export const CYCLE_ID = 'synthetic-foundation-cycle'

export const sectionTitles: Readonly<Record<ExamSectionKind, string>> = {
  CASE_STUDY_1: 'Case Study 1',
  CASE_STUDY_2: 'Case Study 2',
  STANDARD_BLOCK: 'Standard Questions',
  FINAL_INTERACTIVE_BLOCK: 'Final Interactive Questions',
}
const seed = 'foundation-preview'
export const previewBatch: ExamBatch = {
  id: 'synthetic-foundation-batch',
  contentVersion: PREVIEW_VERSION,
  mode: 'DEVELOPMENT',
  seed,
  sections: NORMAL_SECTIONS.map(({ kind, count }, index) => {
    const ids = Array.from({ length: count }, (_, i) => 'demo-' + index + '-' + (i + 1))
    return {
      kind,
      questionIds: index === 2 ? seededQuestionOrder(ids, seed, PREVIEW_VERSION) : ids,
      ...(index < 2 ? { caseStudyId: 'demo-case-' + index } : {}),
    }
  }),
}

export const previewCycle: ExamCycle = {
  id: CYCLE_ID,
  contentVersion: PREVIEW_VERSION,
  consumedQuestionIds: [],
  reservedQuestionIds: previewBatch.sections.flatMap((section) => section.questionIds),
}

export function previewQuestion(id: string, kind: ExamSectionKind, position: number): FoundationQuestion {
  if (kind === 'FINAL_INTERACTIVE_BLOCK') {
    const matching = position >= 2
    return {
      id,
      title: matching ? 'Match sample items' : 'Choose sample values',
      prompt: 'Try this practice control using touch, mouse, or keyboard. It does not contain exam content.',
      interaction: {
        kind: matching ? 'MATCHING' : 'DROPDOWN_HOTSPOT',
        targets: ['First field', 'Second field'].map((label, index) => ({
          id: 'field-' + index, label,
          options: [{ id: 'a', label: 'Sample option A' }, { id: 'b', label: 'Sample option B' }],
        })),
      },
    }
  }
  return {
    id,
    title: 'Select a response',
    prompt: 'This synthetic item demonstrates the examination controls. Select any option, mark it for review, or continue.',
    interaction: { kind: 'SINGLE_CHOICE', options: [
      { id: 'a', label: 'Sample option A' }, { id: 'b', label: 'Sample option B' }, { id: 'c', label: 'Sample option C' },
    ] },
  }
}
