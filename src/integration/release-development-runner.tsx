import { createRoot } from 'react-dom/client'
import display from 'virtual:local-release-display'
import App from '../app/App'
import { CycleJourney } from './CycleJourney'
import type { CandidateJourneyOptions } from './CycleJourney'
import releasePolicy from '../domain/sc100-release-policy.json'
import type { ScoringBank } from '../domain/scoring'

const root = document.getElementById('root')
if (!root) throw new Error('Missing local examination root')
const react = createRoot(root)
root.dataset.contentBoundary = 'PRIVATE_EXAM_CONTENT_CANARY'

function configuration(): CandidateJourneyOptions {
  const { inventory, bankVersion, questions, contexts, examTiming, scoringPolicy, contentCounts } = display
  if (window.location.protocol !== 'http:' || window.location.hostname !== '127.0.0.1'
    || display.scope !== 'PRIVATE_RELEASE_CANDIDATE_ONLY' || inventory.version !== bankVersion
    || !examTiming || !scoringPolicy || contentCounts.publicEligible !== 0
    || scoringPolicy.passingPercentage !== releasePolicy.passingPercentage || scoringPolicy.scoringVersion !== releasePolicy.scoringVersion
    || scoringPolicy.postExamReviewPolicy !== releasePolicy.postExamReviewPolicy) throw new Error('Protected release unavailable.')
  const metadata = new Map(inventory.questions.filter(q => q.developmentValidated && !q.held).map(q => [q.sourceId, q]))
  const deferred = [...metadata.values()].filter(item => item.finalOnly).length
  if (!metadata.size || metadata.size !== contentCounts.eligible || metadata.size !== contentCounts.sourceRecords
    || deferred !== contentCounts.eligibleWithSourceLimitation || metadata.size - deferred !== contentCounts.standardEligible
    || Object.keys(questions).length !== metadata.size
    || ![...metadata].every(([key]) => Object.hasOwn(questions, key))) throw new Error('Protected release unavailable.')

  const loadBank = async (): Promise<ScoringBank> => {
    const url = new URL('./candidate-scoring.js', window.location.href)
    if (url.origin !== window.location.origin || url.hostname !== '127.0.0.1') throw new Error('Local scoring unavailable.')
    const candidate = (await import(/* @vite-ignore */ url.href)).default
    if (!candidate || candidate.scope !== 'PRIVATE_RELEASE_CANDIDATE_SCORING_ONLY' || candidate.bankVersion !== bankVersion
      || !candidate.definitions || typeof candidate.definitions !== 'object' || Array.isArray(candidate.definitions)
      || Object.keys(candidate.definitions).length !== metadata.size
      || ![...metadata].every(([key]) => Object.hasOwn(candidate.definitions, key))) throw new Error('Local scoring unavailable.')
    return { bankVersion, definitions: candidate.definitions }
  }

  return {
    id: 'protected-sc100-release',
    // Do not overwrite or retroactively rescore results from the earlier
    // protected 352-question release or its distinct scoring policy.
    idbName: 'examination-hub-protected-release-v2',
    bank: inventory,
    eligibilityPolicy: 'DEVELOPMENT',
    sourceFor: (batch) => ({
      examTitle: 'SC-100 Practice Examination',
      synthetic: false,
      contentNotice: 'Protected local release review. Do not share this material. This is not an official certification exam.',
      ...examTiming,
      scoring: { policy: scoringPolicy, loadBank },
      question: (key, order) => {
        const meta = metadata.get(key)
        const item = Object.hasOwn(questions, key) ? questions[key] : undefined
        const expectedOrder = meta?.optionGroups?.flatMap(group => group.optionIds)
        if (!item || !meta || !batch.sourceIds.includes(key) || item.interaction.kind !== meta.interactionKind
          || item.interaction.kind !== batch.interactionKinds[key]
          || JSON.stringify(order) !== JSON.stringify(expectedOrder?.length ? expectedOrder : undefined)) {
          throw new Error('Pinned source question unavailable.')
        }
        return item
      },
      context: key => {
        if (!Object.hasOwn(contexts, key)) throw new Error('Pinned case study unavailable.')
        return contexts[key]
      },
    }),
  }
}

try {
  react.render(<CycleJourney configuration={configuration()} />)
} catch {
  react.render(<App preview={{
    sections: [], activeSectionId: '', questions: [], position: 0, view: 'error', readOnly: true,
    error: {title: 'Protected examination unavailable', description: 'Open the verified local release package. No examination data was reset.'},
  }} />)
}
