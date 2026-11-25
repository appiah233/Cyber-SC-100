import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prepareCandidateReference } from '../src/data/candidate-reference'

const bankDirectory = process.env.EXAM_PHASE5_LOCAL_BANK_DIR
const pins = {
  'bank.json': '8bef3463bfc772b0b228dcd7030104c8126d6cadbca9630443d5072f6b64aa68',
  'display-bank.json': '7bc33e3ebe4b26ea6f81cae502688a64ec3e921572d7c735d1a44787a82cfb49',
  'reference-batch.json': 'c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48',
} as const
const version = 'sc100-c1afae23f990-7cab33ce7722'

describe.skipIf(!bankDirectory || Boolean(process.env.CI || process.env.GITHUB_ACTIONS))('protected candidate integration (opt-in, local only)', () => {
  const open = (name: keyof typeof pins) => {
    const worktree = realpathSync(dirname(fileURLToPath(new URL('../package.json', import.meta.url))))
    const file = join(realpathSync(bankDirectory!), name)
    const path = relative(worktree, file)
    if (!path.startsWith('..' + sep) || !lstatSync(file).isFile() || file !== realpathSync(file))
      throw new Error('Unapproved protected test file')
    const bytes = readFileSync(file)
    if (createHash('sha256').update(bytes).digest('hex') !== pins[name]) throw new Error('Protected test input digest mismatch')
    return JSON.parse(bytes.toString('utf8'))
  }

  it('projects the exact reference membership, order, prompts, contexts, and validated response contracts', () => {
    const bank = open('bank.json')
    const display = open('display-bank.json')
    const reference = open('reference-batch.json')
    const projected = prepareCandidateReference(bank, display, reference, version)
    const ids = projected.batch.sourceIds
    expect(ids.length).toBe(59)
    expect(new Set(ids).size).toBe(59)
    expect(projected.batch.sections.map(section => section.questionIds.length)).toEqual([3, 3, 49, 4])
    expect(projected.batch.sections.every((section, i) => section.questionIds.every((id, j) => id === 'Q' + reference.sections[i].sourceIds[j]))).toBe(true)
    const questions = display.questions as { sourceId: string; prompt: string; interaction: { kind: string } }[]
    const cases = display.caseStudies as { id: string; title: string; scenarioText: string }[]
    expect(ids.every(id => questions.some(q => q.sourceId === id
      && q.prompt === projected.questions[id]?.prompt && q.interaction.kind === projected.questions[id]?.interaction.kind))).toBe(true)
    expect(Object.entries(projected.contexts).every(([id, actual]) =>
      cases.some(study => study.id === id && study.title === actual.title && actual.paragraphs?.join('\n') === study.scenarioText))).toBe(true)
    expect(projected.batch.sections[3]!.questionIds.map(id => projected.questions[id]!.interaction.kind))
      .toEqual(['DROPDOWN_HOTSPOT', 'DROPDOWN_HOTSPOT', 'MATCHING', 'MATCHING'])
    expect(JSON.stringify(projected).match(/"(?:answerDefinitions|rawAnswer|rawExplanation|expectedAnswer|scoringPolicy|productionEligible)"\s*:/gi) ?? [])
      .toHaveLength(0)
  })

  it('rejects wrong projection version, missing case text and unvalidated interaction replacement', () => {
    const bank = open('bank.json')
    const display = open('display-bank.json')
    const reference = open('reference-batch.json')
    expect(() => prepareCandidateReference(bank, display, reference, 'different-version')).toThrow()
    const missing = structuredClone(display)
    missing.caseStudies = []
    expect(() => prepareCandidateReference(bank, missing, reference, version)).toThrow()
    const changed = structuredClone(display)
    const approvedId = 'Q' + reference.sections[3].sourceIds[0]
    const row = changed.questions.find((q: { sourceId: string }) => q.sourceId === approvedId)
    row.interaction.kind = 'IMAGE_HOTSPOT'
    expect(() => prepareCandidateReference(bank, changed, reference, version)).toThrow()
  })
})
