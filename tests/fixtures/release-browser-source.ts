// Original synthetic display and inventory only. Nothing here is an exam source.
import type { FoundationQuestion } from '../../src/app/App'
import type { GeneratedBatch } from '../../src/domain/batch-engine'
import { adaptivePool, choiceOptionIds } from './adaptive-pool'

declare const __QA_RELEASE_WIDE_FINAL__: boolean
const wideFinal = __QA_RELEASE_WIDE_FINAL__

export const releaseTestJourney = 'qa-release-browser'
export const releaseTestDatabase = 'qa-release-browser-store'
const pool = adaptivePool({ families: [3, 3], standard: wideFinal ? 111 : 131, interactive: 4 })
export const releaseTestEligible = wideFinal ? {
  ...pool,
  questions: pool.questions.map(question => /^qa-standard-10[7-9]$|^qa-standard-11[01]$/.test(question.sourceId)
    ? { ...question, finalOnly: true }
    : question),
} : pool
const labels = ['Example Alpha', 'Example Beta', 'Example Gamma'] as const
const options = choiceOptionIds.map((id, index) => ({ id, label: labels[index] }))
const matchingTargets = ['North destination', 'South destination'].map((label, index) => ({
  id: index ? 'qa-south' : 'qa-north', label, options,
}))
const definitions = new Map(releaseTestEligible.questions.map(item => [item.sourceId, item]))
export function releaseTestSourceFor(batch: GeneratedBatch) {
  function question(id: string, order: readonly string[] | undefined): FoundationQuestion {
    const item = definitions.get(id)
    if (!item) throw new Error('Invalid candidate fixture question')
    const kind = item.interactionKind
    return {
      id,
      title: 'Original synthetic ' + (kind === 'SINGLE_CHOICE' ? 'choice item' : 'interactive item'),
      prompt: 'This original synthetic question exercises the release candidate cycle.',
      interaction: kind === 'MATCHING' || kind === 'DROPDOWN_HOTSPOT'
        ? { kind, targets: matchingTargets }
        : { kind: 'SINGLE_CHOICE', options: order?.map(id => options.find(option => option.id === id)!) ?? options },
    }
  }
  return {
    attemptId: batch.id,
    idbName: releaseTestDatabase,
    batch,
    question,
    context: (id: string) => ({
      title: id === 'qa-family-1' ? 'Original synthetic operations scenario' : 'Original synthetic delivery scenario',
      paragraphs: ['This scenario exists only to exercise the public candidate cycle.'],
    }),
    synthetic: true,
    eligibleSourceIds: releaseTestEligible.questions.map(({ sourceId }) => sourceId),
    examDurationMinutes: 2,
    timerWarningMinutes: [1],
    scoring: {
      policy: { scoringVersion: wideFinal ? 'qa-release-score-v2' : 'qa-release-score-v1', passingPercentage: wideFinal ? 90 : 75, postExamReviewPolicy: 'NONE' as const },
      loadBank: async () => {
        const state = globalThis as typeof globalThis & { __qaReleaseScoringInvocations?: number }
        state.__qaReleaseScoringInvocations = (state.__qaReleaseScoringInvocations ?? 0) + 1
        return (await import('./phase7-browser-bank')).makeSyntheticBank(batch)
      },
    },
  }
}
export const releaseTestFixture = {
  id: releaseTestJourney, idbName: releaseTestDatabase, bank: releaseTestEligible,
  eligibilityPolicy: 'DEVELOPMENT' as const, sourceFor: releaseTestSourceFor,
}
