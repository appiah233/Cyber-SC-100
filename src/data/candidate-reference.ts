import type { FoundationAsset, FoundationPreview, FoundationQuestion } from '../app/App'
import { generateExactDevelopmentBatch } from '../domain/batch-engine'
import type { GeneratedNormalBatch } from '../domain/batch-engine'
import { NORMAL_SECTIONS } from '../domain/model'
import type { ExamSection } from '../domain/model'
import type { AnswerableDisplayInteraction, DisplayInteraction } from '../features/exam/interaction-types'
import { bindDevelopmentInventory } from './cycle-inventory'
import { openPrivateDisplayBank } from './development-bank'
import type { BankDisplayQuestion } from './development-bank'

/** This module is a local build input, never an application/public bundle entry. */
export interface CandidateReferencePackage {
  readonly batch: GeneratedNormalBatch
  readonly questions: Readonly<Record<string, FoundationQuestion>>
  readonly contexts: Readonly<Record<string, NonNullable<FoundationPreview['context']>>>
  /** Local builder only; never sent to the browser. */
  readonly assetFiles: readonly { readonly id: string; readonly path: string; readonly checksum: string }[]
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(v)
const reject = (): never => { throw new Error('The protected reference cannot be projected safely.') }

function toDisplay(question: BankDisplayQuestion, order: readonly string[] | undefined): AnswerableDisplayInteraction {
  const interaction = question.interaction
  const ids: string[] = []
  const options = (list: readonly { readonly id: string; readonly label: string }[]) => {
    ids.push(...list.map(opt => opt.id))
    return list.map(opt => ({ id: opt.id, label: opt.label }))
  }
  let view: AnswerableDisplayInteraction
  switch (interaction.kind) {
    case 'SINGLE_CHOICE':
      view = { kind: interaction.kind, options: options(interaction.options) }
      break
    case 'MULTIPLE_CHOICE': {
      const counts = new Set([...question.prompt.matchAll(/\bwhich (two|three)\b/gi)]
        .map(match => match[1]?.toLowerCase() === 'two' ? 2 : 3))
      view = {
        kind: interaction.kind, options: options(interaction.options),
        ...(counts.size === 1 ? { requiredSelections: [...counts][0]! } : {}),
      }
      break
    }
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
    case 'STATEMENT':
      view = { kind: interaction.kind, targets: interaction.targets.map((target, index) => ({
        id: target.id, label: target.label,
        options: interaction.kind === 'STATEMENT' && index > 0
          ? target.options.map(opt => ({ id: opt.id, label: opt.label })) : options(target.options),
      })) }
      break
    case 'MATCHING':
    case 'DRAG_DROP': {
      const choices = options(interaction.choices)
      view = { kind: interaction.kind, targets: interaction.targets.map(target => ({
        id: target.id, label: target.label, options: choices,
      })) }
      break
    }
    case 'ORDERING':
      view = { kind: interaction.kind, items: options(interaction.items), positions: interaction.positions.map(({ id, label }) => ({ id, label })) }
      break
    case 'IMAGE_HOTSPOT':
      return reject() // No source-coordinate contract has been verified.
  }
  if (JSON.stringify(ids) !== JSON.stringify(order ?? [])) return reject()
  return view
}

/** Only explicit display fields from the digest-pinned display file can reach the browser. */
export function prepareCandidateReference(inventoryBank: unknown, displayBank: unknown, reference: unknown,
  bankVersion: string): CandidateReferencePackage {
  const inventory = bindDevelopmentInventory(inventoryBank, reference, bankVersion)
  const display = openPrivateDisplayBank(displayBank, bankVersion, 'DEVELOPMENT')
  if (!object(reference) || !Array.isArray(reference.sections) || !object(displayBank)
    || !Array.isArray(displayBank.assets) || !Array.isArray(displayBank.caseStudies) || !object(displayBank.manifest)
    || displayBank.manifest.sourceDocumentChecksum !== reference.sourcePdfSha256) return reject()
  const sections: ExamSection[] = reference.sections.map((section, index) => {
    if (!object(section) || !Array.isArray(section.sourceIds)) return reject()
    return {
      kind: NORMAL_SECTIONS[index]!.kind,
      questionIds: section.sourceIds.map(id => 'Q' + String(id)),
      ...(index < 2 && token(section.familyId) ? { caseStudyId: section.familyId } : {}),
    }
  })
  const plan = generateExactDevelopmentBatch({
    bank: inventory, cycleState: {
      cycleId: 'candidate-development-reference-cycle-v1', bankVersion, consumedSourceIds: [], reservedSourceIds: [],
    }, eligibilityPolicy: 'DEVELOPMENT', seed: 'approved-reference-order-v1',
  }, sections)
  if (!plan.ok || plan.batch.kind !== 'NORMAL_BATCH') return reject()
  const batch = plan.batch
  const questions = {} as Record<string, FoundationQuestion>
  const contexts = {} as Record<string, NonNullable<FoundationPreview['context']>>
  const assetFiles = new Map<string, CandidateReferencePackage['assetFiles'][number]>()
  const exhibit = (assetId: unknown, index: number): FoundationAsset => {
    if (!token(assetId)) return reject()
    const matches = (displayBank.assets as unknown[]).filter(item => object(item) && item.assetId === assetId)
    const row = matches[0]
    if (matches.length !== 1 || !object(row)) return reject()
    const path = display.getAssetPath(assetId)
    if (!path || typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.checksum)) return reject()
    assetFiles.set(assetId, { id: assetId, path, checksum: row.checksum })
    return { id: assetId, label: `Exhibit ${index + 1}` }
  }
  for (const section of batch.sections) {
    if (section.caseStudyId) {
      const matches = displayBank.caseStudies.filter((study: unknown) => object(study) && study.id === section.caseStudyId)
      const study: unknown = matches[0]
      if (matches.length !== 1 || !object(study) || typeof study.title !== 'string' || !study.title.trim()
        || typeof study.scenarioText !== 'string' || !study.scenarioText.trim()
        || !Array.isArray(study.sharedAssetIds)) return reject()
      const assets = study.sharedAssetIds.map(exhibit)
      contexts[section.caseStudyId] = {
        title: study.title,
        paragraphs: study.scenarioText.split('\n'),
        ...(assets.length ? { assets } : {}),
      }
    }
    for (const id of section.questionIds) {
      const q = display.getQuestion(id)
      // Some ordinary standard prompts mention a case organization; their pinned
      // display association controls, not matching brand text in a question.
      if (!q?.developmentOnly || (section.caseStudyId && q.caseStudyId !== section.caseStudyId)) return reject()
      const assets = q.assetIds.map(exhibit)
      const interaction = toDisplay(q, batch.optionOrder[id])
      const wrapped = batch.interactionKinds[id] === 'DIAGRAM_DEPENDENT'
      if ((!wrapped && batch.interactionKinds[id] !== q.interaction.kind) || (wrapped && (!q.requiresDiagram || !assets.length))) return reject()
      const shown: DisplayInteraction = wrapped
        ? { kind: 'DIAGRAM_DEPENDENT', assetId: assets[0]!.id, interaction }
        : interaction
      questions[id] = {
        id,
        prompt: q.prompt,
        interaction: shown,
        ...(assets.length ? { assets } : {}),
      }
    }
  }
  if (Object.keys(questions).length !== 59 || Object.keys(contexts).length !== 2) return reject()
  return { batch, questions, contexts, assetFiles: [...assetFiles.values()] }
}
