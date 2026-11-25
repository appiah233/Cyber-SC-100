import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { ATTEMPT_ID, previewBatch, previewQuestion } from '../src/data/synthetic-preview'
import { activeExamCycle } from '../src/domain/cycle-lifecycle'
import { getPinnedFinalizedAnswerSnapshot } from '../src/domain'
import { scoreFinalizedSnapshot } from '../src/domain/scoring'
import { syntheticPracticeBank } from '../src/data/synthetic-practice-scoring'
import {
  candidateChange, candidateQuestion, candidateValidators, initialCandidate, recordCandidateScore, restoreCandidateCursor,
} from '../src/integration/candidate-attempt'
import type { CandidateCycle, CandidateEdit as Edit, CandidateSnapshot, FoundationSource } from '../src/integration/candidate-attempt'
import { createExamRepository } from '../src/storage'
import type { SavedExam, WriterLease } from '../src/storage'

const source: FoundationSource = { attemptId: ATTEMPT_ID, batch: previewBatch, question: previewQuestion }

function apply(record: ReturnType<typeof initialCandidate>, action: Edit, at = 20) {
  const next = candidateChange(record.attempt, record.cycle, source, action, at)
  expect(next).not.toBeNull()
  if (!next) throw new Error('Expected valid participant edit')
  return next
}

const tracked = (record: ReturnType<typeof initialCandidate>) => activeExamCycle(record.cycle.lifecycle)

describe('Phase 5 candidate command and storage boundary', () => {
  it('only reserves on deliberate START and consumes all pinned IDs on final submit', () => {
    let data = initialCandidate(source, 10)
    expect(data.attempt.status).toBe('CREATED')
    expect(data.attempt.currentQuestionId).toBeNull()
    expect(tracked(data).batches[0].status).toBe('GENERATED')
    expect(tracked(data).reservedSourceIds).toEqual([])
    data = apply(data, { type: 'START' })
    expect(data.attempt.revision).toBe(1)
    expect(data.attempt.status).toBe('CASE_STUDY_1_IN_PROGRESS')
    expect(tracked(data).reservedSourceIds).toEqual(previewBatch.sourceIds)
    expect(candidateChange(data.attempt, data.cycle, source, { type: 'FINAL_SUBMIT' }, 20)).toBeNull()
    expect(candidateChange(data.attempt, data.cycle, source, { type: 'START' }, 20)).toBeNull()

    previewBatch.sections.forEach((section, i) => {
      const next = apply(data, { type: 'SUBMIT_SECTION', sectionId: section.kind })
      expect(next.attempt.locks).toEqual(previewBatch.sections.slice(0, i + 1).map(x => x.kind))
      expect(next.attempt.revision).toBe(data.attempt.revision + 1)
      expect(next.attempt.activeSection).toBe(previewBatch.sections[i + 1]?.kind ?? null)
      expect(next.attempt.optionOrder).toEqual(previewBatch.optionOrder)
      expect(tracked(next).reservedSourceIds.length).toBe(59)
      const lockedQuestion = section.questionIds[0]
      expect(candidateChange(next.attempt, next.cycle, source,
        { type: 'ANSWER', questionId: lockedQuestion, response: { selected: ['a'] } }, 20)).toBeNull()
      expect(candidateChange(next.attempt, next.cycle, source,
        { type: 'SUBMIT_SECTION', sectionId: section.kind }, 20)).toBeNull()
      data = next
    })
    expect(data.attempt.status).toBe('FINAL_SUBMISSION_PENDING')
    data = apply(data, { type: 'FINAL_SUBMIT' })
    expect(data.attempt.status).toBe('SUBMITTED')
    expect(data.attempt.submittedAt).toBe(20)
    expect(data.attempt.result).toBeNull()
    expect(tracked(data).reservedSourceIds).toEqual([])
    expect(tracked(data).consumedSourceIds).toEqual(previewBatch.sourceIds)
    expect(tracked(data).batches[0].status).toBe('COMPLETED')
  })

  it('reconciles the derived question ID, rejects impossible stages or indices, and persists review in the snapshot', () => {
    const started = apply(initialCandidate(source, 10), { type: 'START' })
    const next = apply(started, { type: 'NAVIGATE', position: 2 })
    const review = apply(next, { type: 'OPEN_REVIEW' })
    const stored = structuredClone(review.attempt)
    expect(stored.candidateView).toBe('review')
    expect(stored.position).toBe(2)
    const extraId = previewBatch.sections[2].questionIds[0]
    const tampered = { ...stored, currentQuestionId: extraId }
    const validator = candidateValidators(source)
    expect(validator.validateAttempt(tampered)).toBe(true)
    expect(restoreCandidateCursor(tampered).currentQuestionId).toBe(previewBatch.sections[0].questionIds[2])
    expect(validator.validateAttempt({ ...stored, position: 999 })).toBe(false)
    expect(validator.validateAttempt({ ...stored, activeSection: 'STANDARD_BLOCK' })).toBe(false)
    expect(validator.validateAttempt({ ...stored, optionOrder: {} })).toBe(false)
    expect(candidateChange(next.attempt, next.cycle, source, { type: 'NAVIGATE', position: Infinity }, 20)).toBeNull()
    expect(candidateChange(next.attempt, next.cycle, source, { type: 'NAVIGATE', position: 2 }, 20)).toBeNull()
    const question = apply(review, { type: 'NAVIGATE', position: 2 })
    expect(question.attempt.candidateView).toBe('question')
  })

  it('uses the saved option order and refuses to reinterpret options at the content boundary', () => {
    const qid = previewBatch.sections[0].questionIds[0]
    const contract = candidateQuestion(source, qid).interaction
    expect('options' in contract && contract.options.map(({ id }) => id)).toEqual(previewBatch.optionOrder[qid])
    expect(() => candidateQuestion({ ...source, question: (id, order) => {
      const question = previewQuestion(id, order)
      return 'options' in question.interaction
        ? { ...question, interaction: { ...question.interaction, options: [...question.interaction.options].reverse() } }
        : question
    } }, qid)).toThrow('does not match the pinned batch')
  })

  it('enforces attempt/cycle pairing in the same fenced IndexedDB transaction', async () => {
    const indexes = new IDBFactory()
    const options = { indexedDB: indexes, leaseDurationMs: 100, now: () => 50, ...candidateValidators(source) }
    const writer = createExamRepository<CandidateSnapshot, CandidateCycle>(options)
    const follower = createExamRepository<CandidateSnapshot, CandidateCycle>(options)
    const generated = initialCandidate(source, 10)
    const lease = await writer.initialize({ ...generated, contentVersion: previewBatch.contentVersion, writerId: 'writer' })
    await expect(follower.acquireWriter(ATTEMPT_ID, 'follower')).rejects.toHaveProperty('code', 'WRITER_ACTIVE')
    const started = apply(generated, { type: 'START' })
    await expect(writer.save({ attempt: started.attempt, expectedRevision: 0, lease })).rejects.toHaveProperty('code', 'CORRUPT')
    expect((await follower.load(ATTEMPT_ID))?.attempt.status).toBe('CREATED')
    await writer.save({ attempt: started.attempt, expectedRevision: 0, lease, cycleUpdate: { cycle: started.cycle, expectedRevision: 0 } })

    const read = async (): Promise<SavedExam<CandidateSnapshot, CandidateCycle>> => {
      const row = await follower.load(ATTEMPT_ID, previewBatch.contentVersion)
      if (!row) throw new Error('Expected initialized attempt')
      return row
    }
    const review = apply(await read(), { type: 'OPEN_REVIEW' })
    const qId = started.attempt.currentQuestionId
    expect(qId).not.toBeNull()
    // Only the active writer may persist the review screen.
    const forged: WriterLease = { ...lease, writerId: 'follower' }
    await expect(follower.save({ attempt: review.attempt, expectedRevision: 1, lease: forged })).rejects.toHaveProperty('code', 'LEASE_LOST')
    await writer.save({ attempt: review.attempt, expectedRevision: 1, lease })
    writer.close()
    const restored = await read()
    expect(restored.attempt.candidateView).toBe('review')
    expect(restored.attempt.currentQuestionId).toBe(qId)
    expect(tracked(restored).reservedSourceIds).toEqual(previewBatch.sourceIds)
    expect(restored.cycleRevision).toBe(1)
    await expect(follower.load(ATTEMPT_ID, 'changed-bank')).rejects.toHaveProperty('code', 'CONTENT_VERSION_MISMATCH')
    follower.close()
  })
})


describe('Phase 6 candidate finalization', () => {
  const timed: FoundationSource = { ...source, examDurationMinutes: 1, eligibleSourceIds: previewBatch.sourceIds }

  it('makes one configured deadline persist across sections and refuses boundary-local reviews after it', () => {
    const draft = initialCandidate(timed, 100)
    const start = candidateChange(draft.attempt, draft.cycle, timed, { type: 'START' }, 200)!
    expect(start.attempt.startedAt).toBe(200)
    expect(start.attempt.expiresAt).toBe(60_200)
    const next = candidateChange(start.attempt, start.cycle, { ...timed, examDurationMinutes: 99 },
      { type: 'SUBMIT_SECTION', sectionId: 'CASE_STUDY_1' }, 300)!
    expect(next.attempt.expiresAt).toBe(start.attempt.expiresAt)
    expect(next.attempt.activeSection).toBe('CASE_STUDY_2')
    expect(candidateChange(next.attempt, next.cycle, timed, { type: 'OPEN_REVIEW' }, 60_200)).toBeNull()
    const review = candidateChange(next.attempt, next.cycle, timed, { type: 'OPEN_REVIEW' }, 60_199)!
    expect(review.attempt.candidateView).toBe('review')
    expect(restoreCandidateCursor(structuredClone(review.attempt)).expiresAt).toBe(60_200)
    const expired = candidateChange(review.attempt, review.cycle, timed, { type: 'TIME_EXPIRED' }, 60_500)!
    expect(expired.attempt.status).toBe('SUBMITTED')
    expect(expired.attempt.finalizationReason).toBe('TIME_EXPIRED')
    expect(expired.attempt.submittedAt).toBe(60_500)
    expect(expired.attempt.locks).toEqual(previewBatch.sections.map(section => section.kind))
    expect(activeExamCycle(expired.cycle.lifecycle).status).toBe('COMPLETE')
  })

  it('pins captured option IDs in a detached final snapshot and never leaks a result', () => {
    const draft = initialCandidate(timed, 100)
    const start = candidateChange(draft.attempt, draft.cycle, timed, { type: 'START' }, 200)!
    const id = start.attempt.currentQuestionId!
    const display = candidateQuestion(timed, id).interaction
    if (!('options' in display)) throw new Error('Expected a synthetic choice')
    const option = display.options[0].id
    const typed = candidateChange(start.attempt, start.cycle, timed,
      { type: 'ANSWER', questionId: id, response: { selected: [option] } }, 60_198)!
    const end = candidateChange(typed.attempt, typed.cycle, timed, { type: 'END_EXAM' }, 60_199)!
    expect(end.attempt.finalizationReason).toBe('MANUAL_SUBMISSION')
    expect(end.attempt.finalizedAnswerSnapshot?.answers[id]).toEqual(typed.attempt.answers[id])
    expect(Object.isFrozen(end.attempt.finalizedAnswerSnapshot?.answers[id])).toBe(true)
    expect(end.attempt.result).toBeNull()
    expect(candidateChange(end.attempt, end.cycle, timed, { type: 'TIME_EXPIRED' }, 70_000)).toBeNull()
    const tie = candidateChange(typed.attempt, typed.cycle, timed, { type: 'END_EXAM' }, 60_200)!
    expect(tie.attempt.finalizationReason).toBe('TIME_EXPIRED')
  })
})


describe('Phase 7 candidate result storage boundary', () => {
  it('migrates a durable legacy terminal snapshot and records one fenced result without changing the cycle', async () => {
    const indexedDB = new IDBFactory()
    const repo = createExamRepository<CandidateSnapshot, CandidateCycle>({
      indexedDB, ...candidateValidators(source), now: () => 100,
    })
    const inserted = initialCandidate(source, 10)
    const lease = await repo.initialize({ ...inserted, contentVersion: previewBatch.contentVersion, writerId: 'writer' })
    const start = apply(inserted, { type: 'START' })
    await repo.save({ attempt: start.attempt, expectedRevision: 0, lease, cycleUpdate: { cycle: start.cycle, expectedRevision: 0 } })
    expect(getPinnedFinalizedAnswerSnapshot(start.attempt)).toBeNull()
    const terminal = apply(start, { type: 'END_EXAM' }, 25)
    const pinned = getPinnedFinalizedAnswerSnapshot(terminal.attempt)
    if (!pinned) throw new Error('Expected pinned final')
    // Store the shape actually emitted by Phase 6, with no guesses about
    // interaction provenance in the legacy row.
    const { attemptId, cycleId, batchId, contentVersion, questionIds, submittedAt, reason, answers } = pinned
    const legacy = {
      ...terminal.attempt, interactionKinds: undefined,
      finalizedAnswerSnapshot: { attemptId, cycleId, batchId, contentVersion, questionIds, submittedAt, reason, answers },
    }
    await repo.save({ attempt: legacy, expectedRevision: 1, lease, cycleUpdate: { cycle: terminal.cycle, expectedRevision: 1 } })
    const saved = await repo.load(ATTEMPT_ID)
    if (!saved) throw new Error('Missing candidate')
    expect(getPinnedFinalizedAnswerSnapshot(saved.attempt)).toBeNull()
    const migrated = restoreCandidateCursor(saved.attempt, source)
    const snapshot = getPinnedFinalizedAnswerSnapshot(migrated)
    if (!snapshot) throw new Error('Expected normalized final')
    const computed = scoreFinalizedSnapshot(snapshot, syntheticPracticeBank, {
      scoringVersion: 'scoring-test-v1', postExamReviewPolicy: 'NONE', passingPercentage: 75,
    })
    if (!computed.ok) throw new Error(computed.reason)
    expect(computed.result.unansweredCount).toBe(59)
    expect(recordCandidateScore(start.attempt, computed.result, 100)).toBeNull()
    expect(recordCandidateScore(migrated, { ...computed.result, snapshotId: 'wrong-attempt' }, 100)).toBeNull()
    const scored = recordCandidateScore(migrated, computed.result, 100)
    if (!scored) throw new Error('Expected scoring revision')
    await repo.save({ attempt: scored, expectedRevision: saved.attempt.revision, lease })
    await expect(repo.save({ attempt: scored, expectedRevision: saved.attempt.revision, lease }))
      .rejects.toHaveProperty('code', 'STALE_REVISION')
    const retained = await repo.load(ATTEMPT_ID)
    expect(retained?.attempt.result).toEqual(computed.result)
    expect(retained?.attempt.revision).toBe(saved.attempt.revision + 1)
    expect(retained?.cycleRevision).toBe(saved.cycleRevision)
    expect(retained?.attempt.status && recordCandidateScore(retained.attempt, computed.result, 100)).toBeNull()
    repo.close()
  })
})
