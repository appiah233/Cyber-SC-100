import type {
  AnswerableQuestionInteraction,
  InteractionOption,
  PublishedQuestion,
  QuestionInteraction,
  QuestionMetadata,
  SourceQuestion,
} from './model'

function copyOptions(options: readonly InteractionOption[]): readonly InteractionOption[] {
  return Object.freeze(options.map(({ id, label }) => Object.freeze({ id, label })))
}

export function immutableSourceQuestion(source: SourceQuestion): SourceQuestion {
  if (!Number.isInteger(source.sourcePage) || source.sourcePage < 1) {
    throw new Error('Source page must be a positive, one-based integer')
  }
  return Object.freeze({
    sourceId: source.sourceId,
    sourceDocumentId: source.sourceDocumentId,
    sourcePage: source.sourcePage,
    ...(source.sourceSpan === undefined ? {} : { sourceSpan: source.sourceSpan }),
    sourceInteraction: source.sourceInteraction,
    rawText: source.rawText,
    rawOptions: copyOptions(source.rawOptions),
    rawAnswer: source.rawAnswer,
    rawExplanation: source.rawExplanation,
    sourceAssets: Object.freeze([...source.sourceAssets]),
  })
}

function copyAnswerableInteraction(interaction: AnswerableQuestionInteraction): AnswerableQuestionInteraction {
  switch (interaction.kind) {
    case 'SINGLE_CHOICE':
    case 'MULTIPLE_CHOICE':
      return Object.freeze({ kind: interaction.kind, options: copyOptions(interaction.options) })
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
    case 'STATEMENT':
      return Object.freeze({
        kind: interaction.kind,
        targets: Object.freeze(interaction.targets.map(({ id, label, options }) =>
          Object.freeze({ id, label, options: copyOptions(options) }))),
      })
    case 'MATCHING':
    case 'DRAG_DROP':
      return Object.freeze({
        kind: interaction.kind,
        targets: Object.freeze(interaction.targets.map(({ id, label }) => Object.freeze({ id, label }))),
        choices: copyOptions(interaction.choices),
      })
    case 'ORDERING':
      return Object.freeze({ kind: interaction.kind, items: copyOptions(interaction.items) })
    case 'IMAGE_HOTSPOT':
      return Object.freeze({
        kind: interaction.kind,
        assetId: interaction.assetId,
        regions: Object.freeze(interaction.regions.map(({ id, label, points }) => Object.freeze({
          id,
          label,
          points: Object.freeze(points.map(({ x, y }) => Object.freeze({ x, y }))),
        }))),
      })
  }
}

function copyInteraction(interaction: QuestionInteraction): QuestionInteraction {
  if (interaction.kind === 'DIAGRAM_DEPENDENT') {
    return Object.freeze({
      kind: interaction.kind,
      assetId: interaction.assetId,
      interaction: copyAnswerableInteraction(interaction.interaction),
    })
  }
  return copyAnswerableInteraction(interaction)
}

/** Copy only renderer fields, even when the caller holds a wider record. */
export function projectDisplayQuestion(question: PublishedQuestion): PublishedQuestion {
  return Object.freeze({
    sourceId: question.sourceId,
    prompt: question.prompt,
    interaction: copyInteraction(question.interaction),
    assetIds: Object.freeze([...question.assetIds]),
  })
}

/** Development validation never implies eligibility for publication. */
export function isProductionEligible(metadata: QuestionMetadata): boolean {
  return metadata.productionEligible === true
    && metadata.contentApproved === true
    && metadata.sourceValidated === true
    && metadata.interactionValidated === true
    && (metadata.caseStudyIds.length === 0 || metadata.caseStudyValidated === true)
}
