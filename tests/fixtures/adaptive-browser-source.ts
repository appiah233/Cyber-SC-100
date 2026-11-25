// Vite aliases only the synthetic source import in the real candidate entry for these browser tests.
import type { FoundationPreview, FoundationQuestion } from '../../src/app/App'
import { previewContext, sectionTitles } from '../../src/data/synthetic-preview'
import { generateCycleBatch } from '../../src/domain/cycle-plan'
import type { BatchBank } from '../../src/domain/batch-engine'
import { adaptivePool, choiceOptionIds } from './adaptive-pool'

declare const __QA_ADAPTIVE_FIXTURE__: string

const fixture = __QA_ADAPTIVE_FIXTURE__
export const ATTEMPT_ID = 'qa-adaptive-attempt-' + fixture
const cycleId = 'qa-adaptive-browser-cycle-' + fixture

let bank: BatchBank
switch (fixture) {
  case 'standard-59':
  case 'standard-41':
    bank = adaptivePool({ standard: 100 })
    break
  case 'partial-23':
    bank = adaptivePool({ families: [2], standard: 20, interactive: 1 })
    break
  case 'single-1':
    bank = adaptivePool({ standard: 1 })
    break
  case 'multiple-families':
    bank = adaptivePool({ families: [2, 2, 2] })
    break
  case 'normal-overlap': {
    const base = adaptivePool({ families: [4, 3], standard: 48, interactive: 4 })
    bank = { ...base, questions: base.questions.map(question => question.sourceId === 'qa-case-1-4'
      ? { ...question, standardEligible: true } : question) }
    break
  }
  case 'special-only':
    bank = adaptivePool({ families: [2], interactive: 1 })
    break
  default:
    throw new Error('Unknown synthetic adaptive browser fixture')
}

function plan(consumedSourceIds: readonly string[] = []) {
  const result = generateCycleBatch({
    bank, seed: 'qa-adaptive-browser-seed', eligibilityPolicy: 'DEVELOPMENT',
    cycleState: { cycleId, bankVersion: bank.version, consumedSourceIds, reservedSourceIds: [] },
  })
  if (!result.ok) throw new Error('Synthetic browser batch generation failed: ' + result.reason)
  return result.batch
}

const first = plan()
export const previewBatch = fixture === 'standard-41' ? plan(first.sourceIds) : first
export const eligibleSourceIds = bank.questions.map(question => question.sourceId)

export { sectionTitles }

export function previewQuestion(id: string, optionOrder: readonly string[] | undefined): FoundationQuestion {
  const question = bank.questions.find(source => source.sourceId === id)
  if (!question) throw new Error('Invalid test-only question reference')
  const [a, b, c] = choiceOptionIds
  const display = new Map([[a, 'Example response A'], [b, 'Example response B'], [c, 'Example response C']])
  const makeOption = (id: string) => ({ id, label: display.get(id as typeof a | typeof b | typeof c) ?? 'Unknown response' })
  const prompt = 'This synthetic fixture exercises variable candidate section counts without protected examination material.'
  if (question.interactionKind === 'DROPDOWN_HOTSPOT' || question.interactionKind === 'MATCHING') {
    return {
      id, title: 'Example interactive question', prompt,
      interaction: { kind: question.interactionKind, targets: [
        { id: 'demo-field', label: 'Example field', options: [makeOption(a), makeOption(b)] },
      ] },
    }
  }
  return {
    id, title: fixture === 'normal-overlap' && id === 'qa-case-1-4' ? 'Double-eligible example question' : 'Example choice question', prompt,
    interaction: { kind: 'SINGLE_CHOICE', options: (optionOrder ?? choiceOptionIds).map(makeOption) },
  }
}

export function contextForFixture(id: string): FoundationPreview['context'] {
  if (!bank.caseStudies.some(family => family.id === id)) return previewContext(id)
  return { title: 'Example two-question scenario', paragraphs: ['This original synthetic scenario is common to both remaining case items.'],
    sections: [{ title: 'Synthetic group ' + id.slice(-1), paragraphs: ['The test checks that one family cannot reopen another.'] }],
  }
}

export { contextForFixture as previewContext }
