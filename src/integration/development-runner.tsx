import { createRoot } from 'react-dom/client'
import displayPackage from 'virtual:local-candidate-display'
import { Foundation } from './Foundation'

const root = document.getElementById('root')
if (!root) throw new Error('Missing local examination root')
root.dataset.contentBoundary = 'PRIVATE_EXAM_CONTENT_CANARY'
const { batch, questions, contexts } = displayPackage
createRoot(root).render(
  <Foundation source={{
    attemptId: 'protected-reference-candidate-v1',
    idbName: 'examination-hub-reference-development-v1',
    batch,
    examTitle: 'SC-100 Practice Examination',
    contentNotice: 'Protected local development copy. Do not upload or share this practice content. This is not an official certification exam.',
    synthetic: false,
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
