import { compileBank, digest, indexSource, verifyBank, verifyOracle } from './bank.mjs'

export const RELEASE_SCOPE = 'PRIVATE_RELEASE_CANDIDATE_ONLY'
export const RELEASE_SCORING_SCOPE = 'PRIVATE_RELEASE_CANDIDATE_SCORING_ONLY'
const AUDIT_SCOPE = 'PRIVATE_RELEASE_CANDIDATE_AUDIT_ONLY'
const POLICY_VERSION = 'release-v1-source-gates'
const choiceCounts = { two: 2, three: 3, four: 4, five: 5, six: 6 }
const interactionKinds = new Set([
  'DROPDOWN_HOTSPOT', 'MATCHING', 'ORDERING', 'DRAG_DROP', 'STATEMENT', 'DIAGRAM_DEPENDENT',
])
const heldAnomalies = Object.freeze({
  Q6: 'SOURCE_WORDING_DISCREPANCY',
  Q58: 'ALTERNATIVE_ORDER_SOURCE_AMBIGUITY',
  Q360: 'SOURCE_INTERACTION_REVIEW_REQUIRED',
})
const noteAnomalies = Object.freeze({
  Q44: 'SOURCE_PLACEHOLDER_TEXT_SUFFICIENT',
  Q113: 'SOURCE_PLACEHOLDER_TEXT_SUFFICIENT',
  Q253: 'WRAPPED_STATEMENT_SOURCE_REVALIDATED',
})
const err = (code) => { throw new Error(code) }
const values = Object.values

function instructionCounts(prompt) {
  const counts = [...prompt.matchAll(/\b(?:which|what|choose|select|identify|pick|recommend|required)\s+(?:(?:are|the)\s+){0,2}(two|three|four|five|six|[2-6])\b/gi)]
  return [...new Set(counts.map(([, count]) => choiceCounts[count.toLowerCase()] ?? Number(count)))]
}

export function reviewReleaseInteraction(interaction, sourceText, mapping) {
  const groups = []
  const capture = (id, options) => {
    if (!Array.isArray(options) || !options.length) err('RELEASE_OPTION_GROUP_INVALID')
    groups.push({ id, optionIds: options.map(option => option.id), shuffle: false })
  }
  const verifyOption = (group, id) => group.some(option => option.id === id)
  const requireSelections = (targets) => {
    if (mapping.length !== targets.length) err('RELEASE_TARGET_COUNT_MISMATCH')
    const result = new Map()
    for (const [index, target] of targets.entries()) {
      const pair = mapping[index]
      if (pair.targetId !== target.id || result.has(target.id) || !verifyOption(target.options, pair.optionId))
        err('RELEASE_TARGET_MAPPING_MISMATCH')
      result.set(target.id, pair.optionId)
    }
    return Object.fromEntries(result)
  }
  const kind = interaction.kind
  let shown, answer
  switch (kind) {
    case 'SINGLE_CHOICE': {
      capture('options', interaction.options)
      const [{ optionId }] = mapping
      if (mapping.length !== 1 || !verifyOption(interaction.options, optionId)) err('RELEASE_SINGLE_MAPPING_MISMATCH')
      shown = interaction
      answer = { kind, optionId }
      break
    }
    case 'MULTIPLE_CHOICE': {
      capture('options', interaction.options)
      const expected = instructionCounts(sourceText)
      const optionIds = mapping.map(({ optionId }) => optionId)
      if (expected.length !== 1 || optionIds.length !== expected[0] ||
        new Set(optionIds).size !== optionIds.length || !optionIds.every(id => verifyOption(interaction.options, id)))
        err('RELEASE_CHOICE_INSTRUCTION_MAPPING_MISMATCH')
      shown = { ...interaction, requiredSelections: expected[0] }
      answer = { kind, optionIds }
      break
    }
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
      for (const target of interaction.targets) capture(target.id, target.options)
      shown = interaction
      answer = { kind, selections: requireSelections(shown.targets) }
      break
    case 'STATEMENT': {
      capture('statement-choices', interaction.targets[0]?.options)
      if (interaction.targets.some(target => digest(target.options) !== digest(interaction.targets[0].options)))
        err('RELEASE_STATEMENT_OPTION_SCOPE_MISMATCH')
      shown = interaction
      answer = { kind, selections: requireSelections(shown.targets) }
      break
    }
    case 'MATCHING':
    case 'DRAG_DROP': {
      capture('choices', interaction.choices)
      // Explicit source reuse semantics determine whether the workflow may use
      // an option more than once. Never derive this policy from a keyed answer.
      const reusable = /\bmore than once\b/i.test(sourceText)
      if (!reusable) err('RELEASE_REUSE_INSTRUCTION_REVIEW_REQUIRED')
      shown = { kind, selectionPolicy: 'REUSABLE', targets: interaction.targets.map(target => ({ ...target, options: interaction.choices })) }
      answer = { kind, selections: requireSelections(shown.targets) }
      break
    }
    case 'ORDERING': {
      capture('items', interaction.items)
      if (!/\b(?:in (?:the )?(?:correct |appropriate )?(?:order|sequence)|order should|sequence of|first)\b/i.test(sourceText) ||
        /\b(?:more than one|any order|multiple orders)\b/i.test(sourceText)) err('RELEASE_ORDERING_INSTRUCTION_REVIEW_REQUIRED')
      const selections = requireSelections(interaction.positions.map((position) => ({ ...position, options: interaction.items })))
      const optionIds = interaction.positions.map(({ id }) => selections[id])
      if (new Set(optionIds).size !== optionIds.length) err('RELEASE_ORDERING_MAPPING_MISMATCH')
      shown = interaction
      answer = { kind, optionIds }
      break
    }
    default:
      err('RELEASE_INTERACTION_UNSUPPORTED')
  }
  if (new Set(groups.flatMap(group => group.optionIds)).size !== groups.flatMap(group => group.optionIds).length)
    err('RELEASE_DUPLICATE_OPTION_ID')
  return { shown, answer, optionGroups: groups }
}

export function validReleaseAssetBoundary(proof, expectedCount) {
  return Number.isInteger(expectedCount) && expectedCount >= 0 &&
    proof?.placementsChecked === expectedCount && proof?.crossingAnswerBoundary === 0
}

/** Independent gates consume already traced source/manifest records, with
 * positive evidence needed for a release-candidate projection. */
export function reviewReleaseRecord({ question, row, prompt, mapping, answer, family, assetsForQuestion }) {
  const { sourceId, sourcePage, interaction, caseStudyId } = question
  const knownHold = Object.hasOwn(heldAnomalies, sourceId) ? heldAnomalies[sourceId] : null
  const note = Object.hasOwn(noteAnomalies, sourceId) ? noteAnomalies[sourceId] : null
  const heldByFamily = family?.heldChildIds.includes(sourceId) && 'SOURCE_CASE_CHILD_REVIEW_REQUIRED'
  const excludedByFamily = family?.rejectedChildIds.includes(sourceId)
  const missing = assetsForQuestion.filter(asset => asset.path === null)
  const approvedAssets = assetsForQuestion.filter(asset => asset.path && asset.reviewStatus === 'VALIDATED_SOURCE_PLACEMENT')
  const gates = {
    sourceIdentity: question.sourceValidated && Number.isInteger(sourcePage) && row.SourcePage === sourcePage ? 'PASS' : 'FAIL',
    answerMapping: answer && row.MappingValidated && answer.sourceAnswerDigest === digest(row.RawAnswerBlock) &&
      answer.normalizedMappingDigest === digest(mapping) ? 'PASS' : 'FAIL',
    interaction: question.interactionValidated && !/^(?:correct answer|explanation)\s*:?[ \t]*$/mi.test(prompt) ? 'PASS' : 'HOLD',
    asset: question.requiredAssetIds.every(id => approvedAssets.some(asset => asset.assetId === id))
      && (!question.requiresDiagram || question.requiredAssetIds.length > 0)
      && (!missing.length || (note === 'SOURCE_PLACEHOLDER_TEXT_SUFFICIENT' && !question.requiresDiagram)) ? 'PASS' : 'HOLD',
    caseRelationship: !caseStudyId || (family?.validatedChildIds.includes(sourceId) && !!family.scenarioText) ? 'PASS' : 'HOLD',
    anomaly: knownHold || heldByFamily ? 'HOLD' : 'PASS',
  }
  let projected, interactionHold = null
  if (gates.interaction === 'PASS' && !knownHold && !heldByFamily && !excludedByFamily) {
    try {
      projected = reviewReleaseInteraction(interaction, prompt, mapping)
    } catch (error) {
      if (!(error instanceof Error) || !/^RELEASE_[A-Z_]+$/.test(error.message)) throw error
      interactionHold = error.message
      gates.interaction = 'HOLD'
    }
  }
  const eligible = !excludedByFamily && values(gates).every(status => status === 'PASS') && !!projected
  const classification = eligible ? (note ? 'ELIGIBLE_WITH_SOURCE_NOTE' : 'ELIGIBLE') : excludedByFamily ? 'EXCLUDED' : 'REVIEW_HOLD'
  return {
    eligible, classification, gates, missing, approvedAssets, projected, excludedByFamily,
    anomaly: knownHold || heldByFamily || interactionHold || note || null,
  }
}

export function compileReleaseBank({ source, assetManifest, review, reference, referenceDigest, oracle, sourceAssetProof }) {
  const index = indexSource(source, true)
  const baselineInput = { source, assetManifest, review, reference, referenceDigest, exact: true }
  const original = compileBank(baselineInput)
  if (verifyOracle(source, oracle) !== index.size) err('RELEASE_ORACLE_COVERAGE_MISMATCH')
  const verification = verifyBank({ source, bank: original, context: baselineInput, exact: true })
  if (verification.result !== 'PASS' || verification.publishedQuestionsChecked !== index.size ||
      verification.unauthorizedDifferences !== 0 || verification.missingMappings !== 0) err('RELEASE_SOURCE_ANSWER_INTEGRITY_FAILED')
  if (!validReleaseAssetBoundary(sourceAssetProof, original.assets.length)) err('RELEASE_ASSET_SOURCE_BOUNDARY_UNVERIFIED')

  const answers = new Map(original.answerDefinitions.map(value => [value.sourceId, value]))
  const sourceAssets = new Map(original.assets.map(value => [value.assetId, value]))
  const originalFamilies = new Map(original.caseStudies.map(value => [value.id, value]))
  const familyCandidates = new Map(original.caseStudies.map(value => [value.id, []]))
  const contexts = {}
  const questions = {}, definitions = {}
  const inventoryQuestions = []
  const auditRows = []
  const assets = new Map()
  // A digest identifies the raster bytes; retain every distinct placement in
  // the audit and allow one candidate copy for byte-equivalent shared exhibits.
  const canonicalAsset = new Map()
  function displayAsset(assetId, indexValue) {
    const sourceAsset = sourceAssets.get(assetId)
    if (!sourceAsset || !sourceAsset.path || sourceAsset.reviewStatus !== 'VALIDATED_SOURCE_PLACEMENT') err('RELEASE_UNREVIEWED_ASSET')
    let approved = canonicalAsset.get(sourceAsset.checksum)
    if (!approved) {
      approved = { id: sourceAsset.assetId, path: sourceAsset.path, checksum: sourceAsset.checksum, dimensions: sourceAsset.outputDimensions }
      canonicalAsset.set(sourceAsset.checksum, approved)
    }
    assets.set(approved.id, approved)
    return { id: approved.id, label: 'Exhibit ' + (indexValue + 1) }
  }
  const contentCounts = {
    sourceRecords: index.size, eligible: 0, reviewHold: 0, excluded: 0, publicEligible: 0,
    caseFamilies: 0, caseChildren: 0,
    interactions: Object.fromEntries([
      'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'DROPDOWN', 'MATCHING', 'ORDERING', 'DRAG_DROP',
      'STATEMENT', 'DROPDOWN_HOTSPOT', 'IMAGE_HOTSPOT', 'DIAGRAM_DEPENDENT',
    ].map(kind => [kind, 0])),
    sourceInteractions: {},
  }

  for (const question of original.questions) {
    const { sourceId, sourcePage, interaction, caseStudyId } = question
    const { row, prompt, mapping } = index.get(sourceId)
    const answer = answers.get(sourceId)
    const family = caseStudyId ? originalFamilies.get(caseStudyId) : undefined
    const assetsForQuestion = original.assets.filter(asset => asset.sourceQuestionId === sourceId)
    // The original profile stays untouched; only this explicit local-release
    // JSON sets private-development eligibility. Public eligibility is zero.
    const { eligible, classification, gates, missing, approvedAssets, projected, excludedByFamily, anomaly } =
      reviewReleaseRecord({ question, row, prompt, mapping, answer, family, assetsForQuestion })
    const wrapped = Boolean(question.requiresDiagram)
    if (eligible) {
      const assetViews = [...new Map(approvedAssets.map((asset, indexValue) => {
        const view = displayAsset(asset.assetId, indexValue)
        return [view.id, view]
      })).values()]
      for (const placeholder of missing) assetViews.push({
        id: placeholder.assetId, label: 'Source exhibit placeholder',
        description: 'The source contains no recoverable image. The question and choices are provided as text.',
      })
      const required = wrapped ? displayAsset(question.requiredAssetIds[0], 0).id : null
      questions[sourceId] = {
        id: sourceId, prompt,
        interaction: wrapped ? { kind: 'DIAGRAM_DEPENDENT', assetId: required, interaction: projected.shown } : projected.shown,
        ...(assetViews.length ? { assets: assetViews } : {}),
      }
      definitions[sourceId] = wrapped
        ? { kind: 'DIAGRAM_DEPENDENT', response: projected.answer }
        : projected.answer
      if (caseStudyId) familyCandidates.get(caseStudyId).push(sourceId)
      contentCounts.eligible++
      contentCounts.interactions[questions[sourceId].interaction.kind]++
      contentCounts.sourceInteractions[interaction.kind] = (contentCounts.sourceInteractions[interaction.kind] ?? 0) + 1
    } else if (excludedByFamily) contentCounts.excluded++
    else contentCounts.reviewHold++
    const kind = wrapped ? 'DIAGRAM_DEPENDENT' : interaction.kind
    inventoryQuestions.push({
      sourceId, interactionKind: kind, developmentValidated: eligible, productionEligible: false, held: !eligible,
      standardEligible: eligible && !caseStudyId && !interactionKinds.has(kind),
      interactiveEligible: eligible && !caseStudyId && interactionKinds.has(kind),
      ...(eligible ? { optionGroups: projected.optionGroups } : {}),
    })
    auditRows.push({
      sourceId, sourcePage, questionType: row.QuestionType, sourceInteractionType: interaction.kind,
      presentedInteractionType: kind, classification, gates, caseStudyId,
      assetDependencies: question.assetIds, requiredAssetIds: question.requiredAssetIds,
      anomaly,
      sourceAnswerDigest: answer.sourceAnswerDigest, normalizedMappingDigest: answer.normalizedMappingDigest,
    })
  }

  const auditedFamilies = original.caseStudies.map(family => {
    const childIds = familyCandidates.get(family.id)
    const approved = childIds.length > 0
    if (approved) {
      const assets = [...new Map(family.sharedAssetIds.map((id, indexValue) => {
        const asset = displayAsset(id, indexValue)
        return [asset.id, asset]
      })).values()]
      contexts[family.id] = {
        title: family.title, paragraphs: family.scenarioText.split('\n'),
        ...(assets.length ? { assets } : {}),
      }
      contentCounts.caseFamilies++
      contentCounts.caseChildren += childIds.length
    }
    return {
      id: family.id, childIds, developmentValidated: approved, productionEligible: false,
    }
  })
  if (contentCounts.eligible + contentCounts.reviewHold + contentCounts.excluded !== index.size ||
      Object.keys(questions).length !== contentCounts.eligible || Object.keys(definitions).length !== contentCounts.eligible ||
      contentCounts.interactions.IMAGE_HOTSPOT !== 0 || !contentCounts.eligible) err('RELEASE_ELIGIBILITY_RECONCILIATION_FAILED')
  if ([...questions.Q253?.interaction?.interaction?.targets ?? []].length !== 3 ||
      Object.keys(definitions.Q253?.response?.selections ?? {}).length !== 3 ||
      questions.Q104?.interaction?.kind !== 'DROPDOWN_HOTSPOT' || questions.Q225?.interaction?.kind !== 'DROPDOWN_HOTSPOT')
    err('RELEASE_KNOWN_SOURCE_REGRESSION')
  const identity = digest({ policy: POLICY_VERSION, source: original.manifest.sourceDocumentChecksum,
    development: original.manifest.buildIdentity, auditRows, inventoryQuestions, auditedFamilies })
  const bankVersion = 'sc100-release-' + identity.slice(0, 20)
  const bank = {
    scope: RELEASE_SCOPE, bankVersion, inventory: { version: bankVersion, questions: inventoryQuestions, caseStudies: auditedFamilies },
    questions, contexts, assetFiles: [...assets.values()], contentCounts,
  }
  const scoring = { scope: RELEASE_SCORING_SCOPE, bankVersion, definitions }
  const audit = {
    scope: AUDIT_SCOPE, bankVersion, policyVersion: POLICY_VERSION, sourceAnswerDifferences: verification.unauthorizedDifferences,
    sourceAssetProof, contentCounts, rows: auditRows,
    families: original.caseStudies.map(family => ({
      id: family.id, fullChildIds: family.sourceQuestionIds, eligibleChildIds: familyCandidates.get(family.id),
      sourceScenarioPages: family.scenarioSourcePages,
      scenarioDigest: digest(family.scenarioText),
      sharedAssetIds: family.sharedAssetIds,
      releaseReviewStatus: familyCandidates.get(family.id).length ? 'VERIFIED_FOR_PRIVATE_RELEASE' : 'REVIEW_HOLD',
    })),
  }
  return { bank, scoring, audit }
}
