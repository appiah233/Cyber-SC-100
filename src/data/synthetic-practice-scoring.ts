import { previewBatch } from './synthetic-preview'
import type { CandidateAnswer } from '../domain'
import type { ScoringBank } from '../domain/scoring'

/** Fictional practice targets only. This lazy module contains no source exam data. */
const definitions = Object.fromEntries(previewBatch.sourceIds.map(id => {
  const kind = previewBatch.interactionKinds[id]
  let answer: CandidateAnswer
  switch (kind) {
    case 'SINGLE_CHOICE': answer = { kind, optionId: 'a' }; break
    case 'MULTIPLE_CHOICE': answer = { kind, optionIds: ['a', 'b'] }; break
    case 'MATCHING':
    case 'DROPDOWN_HOTSPOT': answer = { kind, selections: { 'field-0': 'a', 'field-1': 'b' } }; break
    default: throw new Error('Synthetic practice fixture changed.')
  }
  return [id, answer]
}))
export const syntheticPracticeBank: ScoringBank = { bankVersion: previewBatch.contentVersion, definitions }
