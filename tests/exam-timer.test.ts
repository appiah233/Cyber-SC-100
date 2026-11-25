import { describe, expect, it } from 'vitest'
import {
  createAttempt, crossedExamWarning, examExpirationAt, examSectionKey, formatExamTime,
  getFinalizedAnswerSnapshot, getRemainingTimeMs, isAttemptSnapshot, NORMAL_SECTIONS,
  restoreAttemptFinalization, transitionAttempt,
} from '../src/domain'
import type { AttemptEvent, ExamAttempt, ExamBatch } from '../src/domain'

const normal: ExamBatch = {
  id: 'timer-demo-normal', contentVersion: 'timer-demo-version', seed: 'timer-demo-seed',
  sections: NORMAL_SECTIONS.map(({ kind, count }, index) => ({
    kind, questionIds: Array.from({ length: count }, (_, question) => 'demo-' + index + '-' + question),
    ...(index < 2 ? { caseStudyId: 'demo-scenario-' + index } : {}),
  })),
}
const oneQuestion: ExamBatch = {
  ...normal, id: 'timer-demo-single', batchMode: 'FINAL_REMAINDER',
  sections: [{ kind: 'STANDARD_BLOCK', questionIds: ['demo-only'] }],
}
const adaptive: ExamBatch = {
  ...normal, id: 'timer-demo-adaptive', batchMode: 'ADAPTIVE',
  sections: [{ kind: 'STANDARD_BLOCK', questionIds: Array.from({ length: 59 }, (_, i) => 'demo-std-' + i) }],
}
const startedAt = 1_000
const expiresAt = 61_000
const fail = (reason: string) => ({ ok: false, reason })
const make = (batch = normal) => createAttempt({ id: 'timer-demo-attempt', cycleId: 'timer-demo-cycle', batch, at: 3 })

function run(attempt: ExamAttempt, event: AttemptEvent): ExamAttempt {
  const result = transitionAttempt(attempt, event)
  if (!result.ok) throw new Error(result.reason)
  return result.attempt
}
function start(batch = normal, durationMinutes: number | undefined = 1) {
  return run(run(make(batch), { type: 'PREPARE', at: 8 }), { type: 'START_SECTION', at: startedAt, durationMinutes })
}
function skip(attempt: ExamAttempt, through: number): ExamAttempt {
  for (let i = 0; i < through; i += 1) {
    attempt = run(attempt, { type: 'SUBMIT_SECTION', section: examSectionKey(attempt.batch.sections[i]!), at: startedAt + i + 1 })
    attempt = i + 1 === attempt.batch.sections.length
      ? run(attempt, { type: 'OPEN_FINAL_REVIEW', at: startedAt + i + 1 })
      : run(attempt, { type: 'START_SECTION', at: startedAt + i + 1 })
  }
  return attempt
}

describe('absolute local exam time', () => {
  it('derives refresh/return time from the persisted deadline and uses no fallback duration', () => {
    const attempt = start()
    expect(attempt).toMatchObject({ startedAt, expiresAt })
    const restored = JSON.parse(JSON.stringify(attempt)) as ExamAttempt
    expect(isAttemptSnapshot(restored)).toBe(true)
    expect(getRemainingTimeMs(restored.expiresAt, 60_999)).toBe(1)
    expect(getRemainingTimeMs(restored.expiresAt, 61_000)).toBe(0)
    expect(getRemainingTimeMs(restored.expiresAt, 200_000)).toBe(0)
    expect(getRemainingTimeMs(undefined, 200_000)).toBeNull()
    expect(formatExamTime(1)).toBe('00:00:01')
    expect(formatExamTime(0)).toBe('00:00:00')
  })

  it('rejects missing or invalid timed start timestamps and out-of-range deadlines', () => {
    const ready = run(make(), { type: 'PREPARE' })
    expect(transitionAttempt(ready, { type: 'START_SECTION', durationMinutes: 1 })).toEqual(fail('INVALID_TIMESTAMP'))
    expect(transitionAttempt(ready, { type: 'START_SECTION', at: startedAt, durationMinutes: 0 })).toEqual(fail('INVALID_DURATION'))
    expect(transitionAttempt(ready, { type: 'START_SECTION', at: Number.MAX_SAFE_INTEGER, durationMinutes: 1 })).toEqual(fail('INVALID_DURATION'))
    expect(examExpirationAt(50, 0.01)).toBe(650)
    expect(examExpirationAt(50, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('does not restart for a newly entered section or announce every tick', () => {
    const active = skip(start(), 2)
    expect(active).toMatchObject({ status: 'STANDARD_BLOCK_IN_PROGRESS', startedAt, expiresAt })
    expect(crossedExamWarning(61_000, 60_000, [1, 5, 15])).toBe(1)
    expect(crossedExamWarning(59_000, 58_000, [1, 5, 15])).toBeNull()
    expect(crossedExamWarning(1_200_000, 42_000, [15, 5, 1])).toBe(1)
    expect(crossedExamWarning(1_200_000, 0, [15, 5, 1])).toBeNull()
  })

  it.each([
    ['case study', 0, 'CASE_STUDY_1_IN_PROGRESS'],
    ['standard', 2, 'STANDARD_BLOCK_IN_PROGRESS'],
    ['interactive', 3, 'INTERACTIVE_BLOCK_IN_PROGRESS'],
    ['final review', 4, 'FINAL_SUBMISSION_PENDING'],
  ] as const)('automatically locks all sections when elapsed during %s', (_label, through, status) => {
    const pre = skip(start(), through)
    expect(pre.status).toBe(status)
    expect(transitionAttempt(pre, { type: 'TIME_EXPIRED', at: expiresAt - 1 })).toEqual(fail('DEADLINE_NOT_REACHED'))
    const terminal = run(pre, { type: 'TIME_EXPIRED', at: expiresAt })
    expect(terminal).toMatchObject({
      status: 'SUBMITTED', activeSection: null, position: 0, finalizationReason: 'TIME_EXPIRED', submittedAt: expiresAt,
      locks: normal.sections.map(examSectionKey), answers: {},
    })
    expect(isAttemptSnapshot(JSON.parse(JSON.stringify(terminal)))).toBe(true)
  })

  it.each([oneQuestion, adaptive])('is independent of the size and mode of $id', batch => {
    const attempt = start(batch)
    const terminal = run(attempt, { type: 'TIME_EXPIRED', at: expiresAt + 40_000 })
    expect(terminal.locks).toEqual(['STANDARD_BLOCK'])
    expect(getFinalizedAnswerSnapshot(terminal)?.questionIds).toEqual(batch.sections[0]?.questionIds)
  })
})

describe('terminal snapshot boundary', () => {
  it('finalizes manually from an active section with unanswered and marked items, without scoring', () => {
    let attempt = start()
    const questionId = 'demo-0-0'
    const preferences = ['demo-option']
    attempt = run(attempt, { type: 'SAVE_ANSWER', questionId, answer: { kind: 'ORDERING', optionIds: preferences }, at: expiresAt - 5 })
    attempt = run(attempt, { type: 'TOGGLE_REVIEW', questionId, at: expiresAt - 4 })
    expect(getFinalizedAnswerSnapshot(attempt)).toBeNull()
    const terminal = run(attempt, { type: 'END_EXAM', at: expiresAt - 1 })
    preferences.push('mutated')
    const snapshot = getFinalizedAnswerSnapshot(terminal)!
    expect(snapshot).toMatchObject({
      attemptId: terminal.id, cycleId: terminal.cycleId, batchId: normal.id, contentVersion: normal.contentVersion,
      submittedAt: expiresAt - 1, reason: 'MANUAL_SUBMISSION',
      answers: { [questionId]: { kind: 'ORDERING', optionIds: ['demo-option'] } },
    })
    expect(Object.keys(snapshot.answers)).toEqual([questionId])
    expect(snapshot.questionIds).toHaveLength(59)
    expect(terminal.reviewMarks).toEqual({ [questionId]: true })
    expect(terminal.result).toBeNull()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.questionIds)).toBe(true)
    expect(Object.isFrozen(snapshot.answers)).toBe(true)
    expect(Object.isFrozen(snapshot.answers[questionId])).toBe(true)
    expect(Object.isFrozen(terminal.finalizedAnswerSnapshot!.answers[questionId])).toBe(true)
    expect(transitionAttempt(terminal, { type: 'SAVE_ANSWER', questionId, answer: null, at: expiresAt }))
      .toEqual(fail('INVALID_TRANSITION'))
  })

  it('retains accepted pre-deadline changes and rejects changes captured at the deadline', () => {
    let attempt = start(oneQuestion)
    // The IO completion can occur later, but this timestamp came from UI acceptance.
    attempt = run(attempt, { type: 'SAVE_ANSWER', questionId: 'demo-only', at: expiresAt - 1,
      answer: { kind: 'DROPDOWN_HOTSPOT', selections: { 'demo-target': 'demo-option' } } })
    expect(transitionAttempt(attempt, { type: 'SAVE_ANSWER', questionId: 'demo-only', answer: null, at: expiresAt }))
      .toEqual(fail('TIME_EXPIRED'))
    const ended = run(attempt, { type: 'TIME_EXPIRED', at: expiresAt })
    expect(ended.finalizedAnswerSnapshot?.answers['demo-only']).toEqual(attempt.answers['demo-only'])
  })

  it('is idempotent for manual/timeout races and gives the exact deadline to expiry', () => {
    const active = start(oneQuestion)
    const manual = run(active, { type: 'END_EXAM', at: expiresAt - 1 })
    expect(run(manual, { type: 'TIME_EXPIRED', at: expiresAt })).toBe(manual)
    expect(run(manual, { type: 'END_EXAM', at: expiresAt + 1 })).toBe(manual)
    const exactZero = run(active, { type: 'END_EXAM', at: expiresAt })
    expect(exactZero.finalizationReason).toBe('TIME_EXPIRED')
    expect(run(exactZero, { type: 'END_EXAM', at: expiresAt + 1 })).toBe(exactZero)
    expect(run(exactZero, { type: 'TIME_EXPIRED', at: expiresAt + 2 })).toBe(exactZero)
    expect(transitionAttempt(make(oneQuestion), { type: 'END_EXAM', at: expiresAt })).toEqual(fail('INVALID_TRANSITION'))
  })

  it('validates candidate-only fields and the timer on durable reload; legacy stays untimed', () => {
    const untimed = run(run(make(oneQuestion), { type: 'PREPARE', at: 8 }), { type: 'START_SECTION' })
    expect(isAttemptSnapshot(untimed)).toBe(true)
    expect(transitionAttempt(untimed, { type: 'TIME_EXPIRED', at: expiresAt })).toEqual(fail('DEADLINE_NOT_REACHED'))
    const legacy = run(untimed, { type: 'END_EXAM', at: expiresAt })
    const old = { ...legacy, finalizationReason: undefined, finalizedAnswerSnapshot: undefined }
    expect(isAttemptSnapshot(old)).toBe(true)
    expect(getFinalizedAnswerSnapshot(old)).toBeNull()
    expect(restoreAttemptFinalization(old)).toMatchObject({ finalizationReason: 'MANUAL_SUBMISSION', submittedAt: expiresAt })
    const active = start(oneQuestion)
    expect(isAttemptSnapshot({ ...active, expiresAt: startedAt })).toBe(false)
    expect(isAttemptSnapshot({ ...active, updatedAt: expiresAt })).toBe(false)
    const terminal = run(active, { type: 'TIME_EXPIRED', at: expiresAt })
    expect(isAttemptSnapshot({ ...terminal, finalizationReason: 'MANUAL_SUBMISSION' })).toBe(false)
    expect(isAttemptSnapshot({ ...terminal, finalizedAnswerSnapshot: { ...terminal.finalizedAnswerSnapshot, questionIds: [] } })).toBe(false)
    expect(isAttemptSnapshot({ ...terminal, finalizedAnswerSnapshot: {
      ...terminal.finalizedAnswerSnapshot, answers: { 'demo-only': { kind: 'SINGLE_CHOICE', optionId: 'other' } },
    } })).toBe(false)
  })
})
