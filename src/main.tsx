import { createRoot } from 'react-dom/client'
import { Foundation } from './integration/Foundation'
import type { FoundationSource } from './integration/Foundation'

// A fixture-only pass mark, not a real examination standard. Defining the
// importer does not fetch the scoring module until the saved terminal gate.
const syntheticScoring: NonNullable<FoundationSource['scoring']> = {
  policy: { scoringVersion: 'synthetic-exact-v1-p75', passingPercentage: 75, postExamReviewPolicy: 'NONE' },
  loadBank: async () => (await import('./data/synthetic-practice-scoring')).syntheticPracticeBank,
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing Examination Hub root')
createRoot(root).render(<Foundation defaultScoring={syntheticScoring} />)
