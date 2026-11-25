// Lazy, public synthetic browser-test scoring definitions; never real examination material.
// Kept separate to verify network/module gating before terminal submission.
import type { GeneratedBatch } from '../../src/domain/batch-engine'
import type { CandidateAnswer } from '../../src/domain/model'
import { choiceOptionIds } from './adaptive-pool'

export function makeSyntheticBank(batch: GeneratedBatch) {
  const [alpha, beta, gamma] = choiceOptionIds
  const definitions: Record<string, CandidateAnswer> = {}
  for (const id of batch.sourceIds) {
    const kind = batch.interactionKinds[id]
    if (kind === 'SINGLE_CHOICE') definitions[id] = { kind, optionId: alpha }
    else if (kind === 'MULTIPLE_CHOICE') definitions[id] = { kind, optionIds: [gamma, alpha] }
    else if (kind === 'ORDERING') definitions[id] = { kind, optionIds: ['qa-step-c', 'qa-step-a', 'qa-step-b'] }
    else if (kind === 'STATEMENT') definitions[id] = { kind, selections: { 'qa-statement-first': 'qa-yes', 'qa-statement-second': 'qa-no' } }
    else if (kind === 'DROPDOWN' || kind === 'DROPDOWN_HOTSPOT' || kind === 'MATCHING' || kind === 'DRAG_DROP') {
      definitions[id] = { kind, selections: { 'qa-north': beta, 'qa-south': alpha } }
    } else throw new Error('Synthetic fixture has no supported authoritative response')
  }
  return { bankVersion: batch.contentVersion, definitions }
}
