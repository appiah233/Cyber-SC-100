import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openPrivateDisplayBank } from '../src/data/development-bank'

const synthetic = () => ({
  manifest: { scope: 'PRIVATE_DEVELOPMENT_ONLY', bankVersion: 'test-v1', questionCount: 1, productionEligibleCount: 0 },
  assets: [],
  questions: [{ sourceId: 'Q900', sourcePage: 2, prompt: 'Synthetic prompt', assetIds: [], requiresDiagram: false,
    interaction: { kind: 'ORDERING', items: [{ id: 'a', label: 'Synthetic option A' }, { id: 'b', label: 'Synthetic option B' }],
      positions: [{ id: 's1', label: 'Step 1' }] },
    caseStudyId: null, developmentOnly: true, productionEligible: false }],
})
describe('private display adapter', () => {
  it('exposes display-only fields, freezes its output, and preserves ordering slots separately from choices', () => {
    const bank = openPrivateDisplayBank(synthetic(), 'test-v1', 'DEVELOPMENT')
    const q = bank.getQuestion('Q900')
    expect(Object.isFrozen(q?.interaction)).toBe(true)
    expect(q?.interaction).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }], positions: [{ id: 's1' }] })
    expect(q).not.toHaveProperty('answerDefinitions')
  })
  it('rejects wrong versions, production imports, answer-bearing bundles and duplicate IDs', () => {
    expect(() => openPrivateDisplayBank(synthetic(), 'test-v2', 'DEVELOPMENT')).toThrow()
    expect(() => openPrivateDisplayBank(synthetic(), 'test-v1', 'PRODUCTION')).toThrow()
    expect(() => openPrivateDisplayBank({ ...synthetic(), answerDefinitions: [] }, 'test-v1', 'DEVELOPMENT')).toThrow()
    const s = synthetic(); s.questions.push(s.questions[0])
    expect(() => openPrivateDisplayBank(s, 'test-v1', 'DEVELOPMENT')).toThrow()
  })
  it('rejects remote and traversal paths, and missing required exhibits', () => {
    for (const path of ['https://example.invalid/a.png', 'assets/../a.png']) {
      expect(() => openPrivateDisplayBank({ ...synthetic(), assets: [{ assetId: 'a', path }] }, 'test-v1', 'DEVELOPMENT')).toThrow()
    }
    const s = synthetic(); s.questions[0].requiresDiagram = true
    expect(() => openPrivateDisplayBank(s, 'test-v1', 'DEVELOPMENT')).toThrow()
  })
  it.skipIf(!process.env.SC100_PRIVATE_DISPLAY)('loads the separately supplied real private display projection', () => {
    const bank = JSON.parse(readFileSync(process.env.SC100_PRIVATE_DISPLAY!, 'utf8'))
    const session = openPrivateDisplayBank(bank, bank.manifest.bankVersion, 'DEVELOPMENT')
    expect(session.count).toBe(357)
    expect(session.getQuestion('Q253')?.assetIds).toHaveLength(2)
    expect(() => openPrivateDisplayBank(bank, bank.manifest.bankVersion, 'PRODUCTION')).toThrow()
  })
})
