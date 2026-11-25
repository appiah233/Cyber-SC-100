import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bindDevelopmentInventory } from '../src/data/cycle-inventory'
import { generateBatch } from '../src/domain/batch-engine'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'

const paths = {
  bank: process.env.EXAM_PHASE4_PRIVATE_BANK_PATH,
  reference: process.env.EXAM_PHASE4_PRIVATE_REFERENCE_PATH,
  expectedDigest: process.env.EXAM_PHASE4_PRIVATE_BANK_SHA256,
  expectedVersion: process.env.EXAM_PHASE4_PRIVATE_BANK_VERSION,
}
// Public CI never opens protected inputs. Private validation must provide a complete pinned bundle.
const isPrivateRun = Object.values(paths).some(value => value !== undefined)
const worktree = realpathSync(dirname(fileURLToPath(new URL('../package.json', import.meta.url))))
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const approvedReferenceDigest = 'c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48'
function outsideWorktree(path: string) {
  const actual = realpathSync(path)
  if (actual === worktree || actual.startsWith(worktree + sep)) throw new Error('Protected inputs must stay outside the worktree')
  return readFileSync(actual)
}

describe.skipIf(!isPrivateRun)('Local-only exact protected bank verification', () => {
  it('uses only owner-approved development IDs and does not promote any protected question', () => {
    const { bank, reference, expectedDigest, expectedVersion } = paths
    if (!bank || !reference || !expectedDigest || !expectedVersion) throw new Error('Both paths and both bank identity pins are required')
    const bankBytes = outsideWorktree(bank)
    const referenceBytes = outsideWorktree(reference)
    expect(sha256(bankBytes)).toBe(expectedDigest)
    expect(sha256(referenceBytes)).toBe(approvedReferenceDigest)

    const bankJson = JSON.parse(bankBytes.toString('utf8')) as Parameters<typeof bindDevelopmentInventory>[0]
    const ref = JSON.parse(referenceBytes.toString('utf8')) as { sections: { sourceIds: number[] }[] }
    const inventory = bindDevelopmentInventory(bankJson, ref, expectedVersion)
    expect(inventory.questions).toHaveLength(357)
    expect(inventory.questions.filter(question => question.productionEligible)).toHaveLength(0)
    expect(inventory.caseStudies.filter(study => study.developmentValidated)).toHaveLength(2)
    expect(inventory.caseStudies.filter(study => study.productionEligible)).toHaveLength(0)
    const expectedSections = ref.sections.map(section => new Set(section.sourceIds.map(id => 'Q' + id)))
    const approved = new Set(expectedSections.flatMap(set => [...set]))
    expect(approved.size).toBe(59)
    const allowed = new Set(inventory.questions.filter(question => question.developmentValidated).map(question => question.sourceId))
    expect(allowed.size).toBe(59)
    expect([...allowed].every(id => approved.has(id))).toBe(true)
    const state = {
      cycleId: 'local-regression',
      bankVersion: expectedVersion,
      consumedSourceIds: [],
      reservedSourceIds: [],
    }
    const result = generateBatch({ bank: inventory, cycleState: state, eligibilityPolicy: 'DEVELOPMENT', seed: 'independent-check' })
    if (!result.ok) throw new Error('Protected reference composition rejected: ' + result.reason)
    expect(result.batch.kind).toBe('NORMAL_BATCH')
    expect(result.batch.total).toBe(59)
    expect(new Set(result.batch.sourceIds).size).toBe(59)
    for (const [index, section] of result.batch.sections.entries()) {
      const expected = index < 2
        ? expectedSections.find((set, i) => i < 2 && section.questionIds.every(id => set.has(id)))
        : expectedSections[index]
      expect(expected?.size).toBe(section.questionIds.length)
      expect(section.questionIds.every(id => expected?.has(id))).toBe(true)
    }
    const capacity = analyzeCycleCapacity({ bank: inventory, cycleState: state, eligibilityPolicy: 'DEVELOPMENT' })
    expect(capacity).toMatchObject({ ok: true, maximumFullBatches: 1, anticipatedRemainder: { size: 0 } })
    const exhausted = generateBatch({
      bank: inventory, eligibilityPolicy: 'DEVELOPMENT', seed: 'independent-next',
      cycleState: { ...state, consumedSourceIds: result.batch.sourceIds },
    })
    expect(exhausted.ok).toBe(false)
    const production = generateBatch({ bank: inventory, cycleState: state, eligibilityPolicy: 'PRODUCTION', seed: 'independent-check' })
    expect(production).toMatchObject({ ok: false, reason: 'INSUFFICIENT_PRODUCTION_CONTENT' })

    const mutation = structuredClone(bankJson) as {
      questions: { productionEligible: boolean; developmentOnly: boolean; reviewStatus: string }[]
    }
    const changed = mutation.questions.find(q => !q.developmentOnly)
    if (!changed) throw new Error('No held-out protected row to exercise')
    changed.developmentOnly = true
    changed.reviewStatus = 'VALIDATED_FOR_DEVELOPMENT'
    expect(() => bindDevelopmentInventory(mutation, ref, expectedVersion)).toThrow('Development inventory is invalid or untraced')
  })
})
