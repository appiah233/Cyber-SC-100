import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { FoundationAction } from '../src/app/App'
import { ATTEMPT_ID, previewBatch, previewQuestion } from '../src/data/synthetic-preview'
import { activeExamCycle } from '../src/domain/cycle-lifecycle'
import {
  candidateChange, candidateQuestion, candidateValidators, initialCandidate, restoreCandidateCursor,
} from '../src/integration/candidate-attempt'
import type { CandidateCycle, CandidateSnapshot, FoundationSource } from '../src/integration/candidate-attempt'
import { createExamRepository } from '../src/storage'
import type { SavedExam, WriterLease } from '../src/storage'

const source: FoundationSource = { attemptId: ATTEMPT_ID, batch: previewBatch, question: previewQuestion }
type Edit = Exclude<FoundationAction, { type: 'TAKE_OVER' | 'RETRY_SAVE' | 'DISCARD_UNSAVED' }>

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
