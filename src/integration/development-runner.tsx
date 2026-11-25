import { createRoot } from 'react-dom/client'
import displayPackage from 'virtual:local-candidate-display'
import { Foundation } from './Foundation'
import type { ScoringBank } from '../domain/scoring'

const root = document.getElementById('root')
if (!root) throw new Error('Missing local examination root')
root.dataset.contentBoundary = 'PRIVATE_EXAM_CONTENT_CANARY'
const { batch, questions, contexts, examTiming, scoringPolicy } = displayPackage
createRoot(root).render(
  <Foundation source={{
    attemptId: 'protected-reference-candidate-v1',
    idbName: 'examination-hub-reference-development-v1',
    batch,
    // The pinned exact-reference generator rejects plans that do not cover
    // the full approved development inventory. Only then is exhaustion known.
    eligibleSourceIds: batch.sourceIds,
    examTitle: 'SC-100 Practice Examination',
    contentNotice: 'Protected local development copy. Do not upload or share this practice content. This is not an official certification exam.',
    synthetic: false,
    ...examTiming,
    ...(scoringPolicy ? { scoring: {
      policy: scoringPolicy,
      loadBank: async (): Promise<ScoringBank> => {
        const url = new URL('./candidate-scoring.js', window.location.href)
        if (url.origin !== window.location.origin || url.hostname !== '127.0.0.1') throw new Error('Local scoring is unavailable.')
        const loaded = (await import(/* @vite-ignore */ url.href)).default
        if (!loaded || loaded.scope !== 'PRIVATE_EXAM_SCORING_CANARY' || loaded.bankVersion !== batch.contentVersion
          || !loaded.definitions || typeof loaded.definitions !== 'object' || Array.isArray(loaded.definitions)
          || Object.keys(loaded.definitions).length !== batch.sourceIds.length
          || !batch.sourceIds.every(id => Object.hasOwn(loaded.definitions, id))) throw new Error('Local scoring is unavailable.')
        return { bankVersion: loaded.bankVersion, definitions: loaded.definitions }
      },
    } } : {}),
    question: (id, order) => {
      if (!Object.hasOwn(questions, id) || JSON.stringify(order) !== JSON.stringify(batch.optionOrder[id]))
        throw new Error('The pinned display question is unavailable')
      return questions[id]!
    },
    context: id => {
      if (!Object.hasOwn(contexts, id)) throw new Error('The pinned case study is unavailable')
      return contexts[id]!
    },
  }} />,
)
