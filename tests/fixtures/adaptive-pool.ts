// Independent synthetic fixtures. No original exam questions, layouts, or scoring content.
import type { BatchBank, BatchQuestion } from '../../src/domain/batch-engine'

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => prefix + '-' + (i + 1))

export const choiceOptionIds = ['sample-option-a', 'sample-option-b', 'sample-option-c'] as const

export function adaptivePool({
  families = [], standard = 0, interactive = 0, exclusions = false,
}: {
  families?: readonly number[]
  standard?: number
  interactive?: number
  exclusions?: boolean
}): BatchBank {
  const caseStudies = families.map((count, i) => ({
    id: 'qa-family-' + (i + 1),
    childIds: ids('qa-case-' + (i + 1), count),
    developmentValidated: true,
    productionEligible: false,
  }))
  const regular = (sourceId: string, standardEligible: boolean): BatchQuestion => ({
    sourceId, developmentValidated: true, productionEligible: false,
    standardEligible, interactionKind: 'SINGLE_CHOICE',
    optionGroups: [{ id: 'options', optionIds: choiceOptionIds, shuffle: true }],
  })
  const questions: BatchQuestion[] = [
    ...caseStudies.flatMap(({ childIds }) => childIds.map(id => regular(id, false))),
    ...ids('qa-standard', standard).map(id => regular(id, true)),
    ...ids('qa-interactive', interactive).map((sourceId, index): BatchQuestion => ({
      sourceId, developmentValidated: true, productionEligible: false, standardEligible: false,
      interactiveEligible: true, interactionKind: index % 2 ? 'MATCHING' : 'DROPDOWN_HOTSPOT',
    })),
  ]
  if (exclusions) questions.push(
    { ...regular('qa-held-exclusion', true), held: true },
    { ...regular('qa-unvalidated-exclusion', true), developmentValidated: false },
  )
  return { version: 'qa-adaptive-pool-v1', questions, caseStudies }
}

type PoolOptions = Parameters<typeof adaptivePool>[0]
export type QaCase = {
  readonly letter: string
  readonly description: string
  readonly pool: PoolOptions
  readonly retired: readonly string[]
  readonly breakdown: readonly (readonly [mode: 'NORMAL' | 'ADAPTIVE' | 'FINAL_REMAINDER', cases: number, standard: number, interactive: number])[]
}

export const ownerScenarios: readonly QaCase[] = [
  { letter: 'A', description: '118 standard only', pool: { standard: 118 }, retired: [],
    breakdown: [['ADAPTIVE', 0, 59, 0], ['ADAPTIVE', 0, 59, 0]] },
  { letter: 'B', description: '100 standard only', pool: { standard: 100 }, retired: [],
    breakdown: [['ADAPTIVE', 0, 59, 0], ['FINAL_REMAINDER', 0, 41, 0]] },
  { letter: 'C', description: 'six case children, four interactive, 90 standard', pool: { families: [3, 3], interactive: 4, standard: 90 }, retired: [],
    breakdown: [['NORMAL', 6, 49, 4], ['FINAL_REMAINDER', 0, 41, 0]] },
  { letter: 'D', description: 'case families exhausted with interactive still available', pool: { families: [3, 3], interactive: 4, standard: 55 },
    retired: [...ids('qa-case-1', 3), ...ids('qa-case-2', 3)], breakdown: [['ADAPTIVE', 0, 55, 4]] },
  { letter: 'E', description: 'interactive exhausted with case families still available', pool: { families: [3, 3], interactive: 4, standard: 53 },
    retired: ids('qa-interactive', 4), breakdown: [['ADAPTIVE', 6, 53, 0]] },
  { letter: 'F', description: 'both special pools exhausted with standard still available', pool: { families: [3, 3], interactive: 4, standard: 59 },
    retired: [...ids('qa-case-1', 3), ...ids('qa-case-2', 3), ...ids('qa-interactive', 4)], breakdown: [['ADAPTIVE', 0, 59, 0]] },
  { letter: 'G', description: 'two genuine case children, one interactive, and 20 standard', pool: { families: [2], interactive: 1, standard: 20 }, retired: [],
    breakdown: [['FINAL_REMAINDER', 2, 20, 1]] },
  { letter: 'H', description: 'one question remains', pool: { standard: 1 }, retired: [],
    breakdown: [['FINAL_REMAINDER', 0, 1, 0]] },
]
