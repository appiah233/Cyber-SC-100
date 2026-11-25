import type { AnswerableQuestionInteraction, InteractionOption, InteractionTarget, PublishedQuestion } from '../domain'

const asObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(v)
const string = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const map = <T>(value: unknown, parse: (x: unknown) => T): readonly T[] => {
  if (!Array.isArray(value)) throw new Error('Bank list is invalid')
  return Object.freeze(value.map(parse))
}
const getOption = (v: unknown): InteractionOption => {
  if (!asObject(v) || !token(v.id) || !string(v.label)) throw new Error('Bank option is invalid')
  return Object.freeze({ id: v.id, label: v.label })
}
const getTarget = (v: unknown): Pick<InteractionTarget, 'id' | 'label'> => getOption(v)
const distinct = <T extends { readonly id: string },>(rows: readonly T[]): readonly T[] => {
  if (!rows.length || new Set(rows.map((x) => x.id)).size !== rows.length) throw new Error('Bank interaction identity is invalid')
  return rows
}
type Ordering = Extract<AnswerableQuestionInteraction, { readonly kind: 'ORDERING' }>
  & { readonly positions: readonly Pick<InteractionTarget, 'id' | 'label'>[] }
type BankInteraction = Exclude<AnswerableQuestionInteraction, { readonly kind: 'ORDERING' }> | Ordering
export type BankDisplayQuestion = Omit<PublishedQuestion, 'interaction'> & {
  readonly sourcePage: number
  readonly interaction: BankInteraction
  readonly requiresDiagram: boolean
  readonly caseStudyId: string | null
  readonly developmentOnly: boolean
}
function interaction(v: unknown): BankInteraction {
  if (!asObject(v)) throw new Error('Bank interaction is invalid')
  const kind = v.kind
  if (kind === 'SINGLE_CHOICE' || kind === 'MULTIPLE_CHOICE') return Object.freeze({ kind, options: distinct(map(v.options, getOption)) })
  if (kind === 'DROPDOWN' || kind === 'DROPDOWN_HOTSPOT' || kind === 'STATEMENT') {
    return Object.freeze({ kind, targets: distinct(map(v.targets, (t) => {
      if (!asObject(t)) throw new Error('Bank target is invalid')
      return Object.freeze({ ...getTarget(t), options: distinct(map(t.options, getOption)) })
    })) })
  }
  if (kind === 'MATCHING' || kind === 'DRAG_DROP') return Object.freeze({ kind,
    targets: distinct(map(v.targets, getTarget)), choices: distinct(map(v.choices, getOption)) })
  if (kind === 'ORDERING') return Object.freeze({ kind, items: distinct(map(v.items, getOption)), positions: distinct(map(v.positions, getTarget)) })
  // Foundation has no validated image selection geometry. Never infer it.
  throw new Error('Unsupported bank interaction')
}

/** The offline loader consumes a pre-verified display projection, never scores or loads files.
 * It is deliberately not imported by the public synthetic application. */
export function openPrivateDisplayBank(input: unknown, expectedVersion: string, profile: 'DEVELOPMENT' | 'PRODUCTION') {
  if (profile !== 'DEVELOPMENT' || !asObject(input) || !asObject(input.manifest) ||
      input.manifest.scope !== 'PRIVATE_DEVELOPMENT_ONLY' || input.manifest.bankVersion !== expectedVersion ||
      !token(expectedVersion) || input.manifest.productionEligibleCount !== 0 ||
      Object.hasOwn(input, 'answerDefinitions')) throw new Error('Private bank scope or version mismatch')

  const exposedAssets = new Map<string, string>()
  for (const v of map(input.assets, (a) => a)) {
    if (!asObject(v) || !token(v.assetId) || exposedAssets.has(v.assetId) ||
        (v.path !== null && (typeof v.path !== 'string' || !/^assets\/[A-Za-z0-9][\w-]{0,95}\.png$/.test(v.path))))
      throw new Error('Invalid bank asset')
    exposedAssets.set(v.assetId, v.path ?? '')
  }

  const byId = new Map<string, BankDisplayQuestion>()
  for (const q of map(input.questions, (x) => x)) {
    if (!asObject(q) || typeof q.sourceId !== 'string' || !/^Q[1-9][0-9]{0,5}$/.test(q.sourceId) || byId.has(q.sourceId) ||
        typeof q.sourcePage !== 'number' || !Number.isSafeInteger(q.sourcePage) || q.sourcePage < 1 || !string(q.prompt) ||
        q.productionEligible !== false || typeof q.developmentOnly !== 'boolean' || typeof q.requiresDiagram !== 'boolean' ||
        (q.caseStudyId !== null && !token(q.caseStudyId))) throw new Error('Invalid display question')
    const assetIds = map(q.assetIds, (id) => {
      if (!token(id) || !exposedAssets.get(id)) throw new Error('Untraced display asset')
      return id
    })
    if (new Set(assetIds).size !== assetIds.length || (q.requiresDiagram && !assetIds.length)) throw new Error('Missing display exhibit')
    byId.set(q.sourceId, Object.freeze({ sourceId: q.sourceId, sourcePage: q.sourcePage, prompt: q.prompt,
      interaction: interaction(q.interaction), assetIds, caseStudyId: q.caseStudyId, requiresDiagram: q.requiresDiagram,
      developmentOnly: q.developmentOnly,
    }))
  }
  if (byId.size !== input.manifest.questionCount || byId.size === 0) throw new Error('Display count mismatch')
  return Object.freeze({
    version: expectedVersion,
    count: byId.size,
    getQuestion: (sourceId: string) => byId.get(sourceId),
    getAssetPath: (assetId: string) => exposedAssets.get(assetId) || undefined,
  })
}
