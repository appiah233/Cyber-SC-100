import { describe, expect, it } from 'vitest'
import {
  createAttempt,
  immutableSourceQuestion,
  isAttemptSnapshot,
  isProductionEligible,
  NORMAL_SECTIONS,
  projectDisplayQuestion,
  seededQuestionOrder,
  seededShuffle,
  transitionAttempt,
  validateNormalBatch,
} from '../src/domain'
import type { AttemptEvent, ExamAttempt, ExamBatch } from '../src/domain'

const batch: ExamBatch = {
  id: 'synthetic-batch',
  contentVersion: 'synthetic-bank-v1',
  seed: 'training-seed',
  sections: NORMAL_SECTIONS.map(({ kind, count }, section) => ({
    kind,
    questionIds: Array.from({ length: count }, (_, index) => `synthetic-${section}-${index}`),
    ...(section < 2 ? { caseStudyId: `synthetic-case-${section}` } : {}),
  })),
}

function created(): ExamAttempt {
  return createAttempt({ id: 'synthetic-attempt', cycleId: 'synthetic-cycle', batch })
}

function advance(attempt: ExamAttempt, event: AttemptEvent): ExamAttempt {
  const result = transitionAttempt(attempt, event)
  if (!result.ok) throw new Error(result.reason)
  return result.attempt
}

function inFirstSection(): ExamAttempt {
  return advance(advance(created(), { type: 'PREPARE' }), { type: 'START_SECTION' })
}

describe('normal batch policy', () => {
  it('requires exact ordered 3/3/49/4 sections and all 59 unique ids', () => {
    expect(NORMAL_SECTIONS.map(({ count }) => count)).toEqual([3, 3, 49, 4])
    expect(validateNormalBatch(batch)).toEqual({ ok: true })
    expect(new Set(batch.sections.flatMap(({ questionIds }) => questionIds)).size).toBe(59)
  })

  it('rejects a missing question, repeated ids, and swapped sections', () => {
    const sections = batch.sections
    const first = sections[0]!
    const second = sections[1]!
    expect(validateNormalBatch({
      ...batch, sections: [{ ...first, questionIds: first.questionIds.slice(1) }, ...sections.slice(1)],
    })).toEqual({ ok: false, reason: 'SECTION_CARDINALITY' })
    expect(validateNormalBatch({
      ...batch, sections: [
        first,
        { ...second, questionIds: [first.questionIds[0]!, ...second.questionIds.slice(1)] },
        ...sections.slice(2),
      ],
    })).toEqual({ ok: false, reason: 'DUPLICATE_QUESTION' })
    expect(validateNormalBatch({ ...batch, sections: [second, first, ...sections.slice(2)] }))
      .toEqual({ ok: false, reason: 'SECTION_ORDER' })
  })

  it('rejects missing or identical case family ids', () => {
    const [first, second, ...rest] = batch.sections
    expect(validateNormalBatch({
      ...batch, sections: [{ ...first!, caseStudyId: '' }, second!, ...rest],
    })).toEqual({ ok: false, reason: 'CASE_STUDY_ID' })
    expect(validateNormalBatch({
      ...batch, sections: [first!, { ...second!, caseStudyId: first!.caseStudyId! }, ...rest],
    })).toEqual({ ok: false, reason: 'CASE_STUDY_ID' })
  })
})

describe('central attempt machine', () => {
  it('uses each named in-progress and submitted state in order and permits a single final commit', () => {
    let attempt = created()
    expect(attempt.status).toBe('CREATED')
    attempt = advance(attempt, { type: 'PREPARE' })
    expect(attempt.status).toBe('READY')
    const expected = [
      ['CASE_STUDY_1_IN_PROGRESS', 'CASE_STUDY_1_SUBMITTED'],
      ['CASE_STUDY_2_IN_PROGRESS', 'CASE_STUDY_2_SUBMITTED'],
      ['STANDARD_BLOCK_IN_PROGRESS', 'STANDARD_BLOCK_SUBMITTED'],
      ['INTERACTIVE_BLOCK_IN_PROGRESS', 'INTERACTIVE_BLOCK_SUBMITTED'],
    ]
    for (const [index, section] of batch.sections.entries()) {
      attempt = advance(attempt, { type: 'START_SECTION' })
      expect(attempt.status).toBe(expected[index]![0])
      expect(attempt.activeSection).toBe(section.kind)
      attempt = advance(attempt, { type: 'SUBMIT_SECTION', section: section.kind })
      expect(attempt.status).toBe(expected[index]![1])
      expect(attempt.activeSection).toBeNull()
      expect(attempt.locks).toContain(section.kind)
    }
    attempt = advance(attempt, { type: 'OPEN_FINAL_REVIEW' })
    expect(attempt.status).toBe('FINAL_SUBMISSION_PENDING')
    attempt = advance(attempt, { type: 'FINAL_SUBMIT', at: 1_234 })
    expect(attempt.status).toBe('SUBMITTED')
    expect(attempt.submittedAt).toBe(1_234)
    expect(advance(attempt, { type: 'FINAL_SUBMIT', at: 9_999 })).toBe(attempt)
    attempt = advance(attempt, {
      type: 'RECORD_RESULT', result: { correctCount: 0, questionCount: 59, percentage: 0 },
    })
    expect(attempt.status).toBe('SCORED')
    expect(attempt.result?.questionCount).toBe(59)
  })

  it('blocks jumps, off-section edits, invalid indices, and premature scoring', () => {
    const original = created()
    expect(transitionAttempt(original, { type: 'START_SECTION' }))
      .toEqual({ ok: false, reason: 'INVALID_TRANSITION' })
    expect(transitionAttempt(original, { type: 'FINAL_SUBMIT' }))
      .toEqual({ ok: false, reason: 'INVALID_TRANSITION' })
    const attempt = inFirstSection()
    expect(transitionAttempt(attempt, { type: 'NAVIGATE', position: 3 }))
      .toEqual({ ok: false, reason: 'INVALID_POSITION' })
    expect(transitionAttempt(attempt, { type: 'TOGGLE_REVIEW', questionId: 'synthetic-1-0' }))
      .toEqual({ ok: false, reason: 'QUESTION_NOT_IN_ACTIVE_SECTION' })
    expect(transitionAttempt(attempt, { type: 'SUBMIT_SECTION', section: 'CASE_STUDY_2' }))
      .toEqual({ ok: false, reason: 'SECTION_MISMATCH' })
    expect(transitionAttempt(attempt, {
      type: 'RECORD_RESULT', result: { correctCount: 59, questionCount: 59, percentage: 100 },
    })).toEqual({ ok: false, reason: 'INVALID_TRANSITION' })
  })

  it('saves answers and marks immutably, then locks prior sections against future changes', () => {
    const questionId = 'synthetic-0-0'
    const before = inFirstSection()
    const options = ['synthetic-a']
    let attempt = advance(before, {
      type: 'SAVE_ANSWER', questionId, answer: { kind: 'MULTIPLE_CHOICE', optionIds: options },
    })
    options.push('not-part-of-snapshot')
    attempt = advance(attempt, { type: 'TOGGLE_REVIEW', questionId })
    attempt = advance(attempt, { type: 'NAVIGATE', position: 2 })
    expect(before.answers[questionId]).toBeUndefined()
    expect(before.reviewMarks[questionId]).toBeUndefined()
    expect(attempt.answers[questionId]).toEqual({
      kind: 'MULTIPLE_CHOICE', optionIds: ['synthetic-a'],
    })
    expect(attempt.reviewMarks[questionId]).toBe(true)
    expect(attempt.position).toBe(2)
    const locked = advance(attempt, { type: 'SUBMIT_SECTION', section: 'CASE_STUDY_1' })
    const next = advance(locked, { type: 'START_SECTION' })
    expect(next.position).toBe(0)
    expect(transitionAttempt(next, { type: 'SAVE_ANSWER', questionId, answer: null }))
      .toEqual({ ok: false, reason: 'QUESTION_NOT_IN_ACTIVE_SECTION' })
    expect(next.answers[questionId]).toEqual(attempt.answers[questionId])
  })
})

describe('persisted attempt invariants', () => {
  it('validates cloned snapshots and rejects missing locks, future answers, and mismatched versions', () => {
    const active = inFirstSection()
    const submitted = advance(active, { type: 'SUBMIT_SECTION', section: 'CASE_STUDY_1' })
    expect(isAttemptSnapshot(JSON.parse(JSON.stringify(submitted)))).toBe(true)
    expect(isAttemptSnapshot({ ...submitted, locks: [] })).toBe(false)
    expect(isAttemptSnapshot({
      ...active, answers: { 'synthetic-1-0': { kind: 'SINGLE_CHOICE', optionId: 'synthetic-a' } },
    })).toBe(false)
    expect(isAttemptSnapshot({ ...active, contentVersion: 'synthetic-wrong-version' })).toBe(false)
    expect(isAttemptSnapshot({ ...active, position: 3 })).toBe(false)
    expect(transitionAttempt({ ...submitted, locks: [] }, { type: 'START_SECTION' }))
      .toEqual({ ok: false, reason: 'INVALID_TRANSITION' })
  })
})

describe('seeded ordering', () => {
  const eligible = ['synthetic-4', 'synthetic-1', 'synthetic-3', 'synthetic-2', 'synthetic-0']

  it('is independent of source array order, preserves membership, and returns an immutable order', () => {
    const order = seededQuestionOrder(eligible, 'synthetic-seed', 'synthetic-bank-v1')
    expect(order).toEqual(seededQuestionOrder([...eligible].reverse(), 'synthetic-seed', 'synthetic-bank-v1'))
    expect(new Set(order)).toEqual(new Set(eligible))
    expect(Object.isFrozen(order)).toBe(true)
    expect(eligible[0]).toBe('synthetic-4')
  })

  it('pins a golden vector and provides separate scope streams', () => {
    expect(seededQuestionOrder(eligible, 'synthetic-seed', 'synthetic-bank-v1')).toEqual([
      'synthetic-2', 'synthetic-1', 'synthetic-4', 'synthetic-0', 'synthetic-3',
    ])
    const items = Array.from({ length: 24 }, (_, index) => ({ id: `synthetic-${index}` }))
    expect(seededShuffle(items, 19, 'v1', ({ id }) => id, 'case')).not.toEqual(
      seededShuffle(items, 19, 'v1', ({ id }) => id, 'standard'),
    )
    expect(() => seededQuestionOrder(['same', 'same'], 1, 'v1')).toThrow('Duplicate shuffle identity')
  })
})

describe('source, metadata and display boundaries', () => {
  it('keeps development-only content outside production even when structurally validated', () => {
    const metadata = {
      sourceId: 'synthetic-source',
      contentVersion: 'synthetic-bank-v1',
      interactionType: 'SINGLE_CHOICE' as const,
      caseStudyIds: ['synthetic-case'],
      requiredAssetIds: [],
      sourceValidated: true,
      interactionValidated: true,
      caseStudyValidated: true,
      contentApproved: false,
      productionEligible: false,
      reviewStatus: 'VALIDATED_FOR_DEVELOPMENT',
    }
    expect(isProductionEligible(metadata)).toBe(false)
    expect(isProductionEligible({ ...metadata, productionEligible: true })).toBe(false)
    expect(isProductionEligible({
      ...metadata, productionEligible: true, contentApproved: true, caseStudyValidated: false,
    })).toBe(false)
    expect(isProductionEligible({ ...metadata, productionEligible: true, contentApproved: true })).toBe(true)
  })

  it('preserves raw source text/answers while copying and freezing editable input objects', () => {
    const options = [{ id: 'synthetic-opt', label: 'Synthetic option', extraPrivateField: 'not for renderer' }]
    const raw = { kind: 'SINGLE_CHOICE' as const, optionId: 'synthetic-opt' }
    const source = immutableSourceQuestion({
      sourceId: 'synthetic-source',
      sourceDocumentId: 'synthetic-document',
      sourcePage: 1,
      rawText: 'Synthetic prompt  ',
      sourceInteraction: 'SINGLE_CHOICE',
      rawOptions: options,
      rawAnswer: 'Source answer composed elsewhere ',
      rawExplanation: 'Explanation kept out of the renderer',
      sourceAssets: [],
    })
    const display = projectDisplayQuestion({
      sourceId: source.sourceId,
      prompt: source.rawText,
      interaction: { kind: raw.kind, options },
      assetIds: [],
    })
    options[0]!.label = 'Mutated elsewhere'
    expect(source.rawText).toBe('Synthetic prompt  ')
    expect(source.rawAnswer).toBe('Source answer composed elsewhere ')
    expect(source.rawOptions[0]?.label).toBe('Synthetic option')
    expect(Object.isFrozen(source.rawOptions[0])).toBe(true)
    expect(display).not.toHaveProperty('rawAnswer')
    expect(display).not.toHaveProperty('explanation')
    expect(display.interaction).toEqual({ kind: raw.kind, options: [{ id: 'synthetic-opt', label: 'Synthetic option' }] })
  })
})
