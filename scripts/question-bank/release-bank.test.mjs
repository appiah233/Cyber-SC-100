import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { digest } from './bank.mjs'
import { reviewReleaseInteraction, reviewReleaseRecord, validReleaseAssetBoundary } from './release-bank.mjs'

const options = [{ id: 'first-choice', label: 'First specimen' }, { id: 'second-choice', label: 'Second specimen' }, { id: 'third-choice', label: 'Third specimen' }]
const single = { kind: 'SINGLE_CHOICE', options }
const pairs = [{ optionId: 'second-choice' }]
const raw = ['Synthetic keyed record; not a source question.']
function record(id = 'synthetic-question') {
  return {
    question: { sourceId: id, sourcePage: 1, sourceValidated: true, interactionValidated: true,
      requiredAssetIds: [], requiresDiagram: false, caseStudyId: null, interaction: single },
    row: { SourcePage: 1, MappingValidated: true, RawAnswerBlock: raw },
    prompt: 'Select a specimen.', mapping: pairs,
    answer: { sourceAnswerDigest: digest(raw), normalizedMappingDigest: digest(pairs) },
    assetsForQuestion: [],
  }
}

describe('protected release policy gates (synthetic source only)', () => {
  it('requires source identity and the same exact mapping digests', () => {
    const source = record()
    assert.equal(reviewReleaseRecord(source).classification, 'ELIGIBLE')
    assert.equal(reviewReleaseRecord({ ...source, row: { ...source.row, SourcePage: 4 } }).gates.sourceIdentity, 'FAIL')
    const mutation = reviewReleaseRecord({ ...source, mapping: [{ optionId: 'third-choice' }] })
    assert.equal(mutation.gates.answerMapping, 'FAIL')
    assert.equal(mutation.eligible, false)
  })

  it('rejects prompt answer/explanation headings and any asset at or below the answer boundary', () => {
    const source = record()
    assert.equal(reviewReleaseRecord({ ...source, prompt: 'Synthetic item.\nExplanation:' }).gates.interaction, 'HOLD')
    assert.equal(validReleaseAssetBoundary({ placementsChecked: 4, crossingAnswerBoundary: 1 }, 4), false)
    assert.equal(validReleaseAssetBoundary({ placementsChecked: 3, crossingAnswerBoundary: 0 }, 4), false)
    assert.equal(validReleaseAssetBoundary({ placementsChecked: 4, crossingAnswerBoundary: 0 }, 4), true)
  })

  it('requires genuine known raster dependencies and never promotes a missing required exhibit', () => {
    const source = record()
    const question = { ...source.question, requiresDiagram: true, requiredAssetIds: ['illustration'] }
    const fixture = { assetId: 'illustration', path: 'assets/synthetic.png', reviewStatus: 'VALIDATED_SOURCE_PLACEMENT' }
    assert.equal(reviewReleaseRecord({ ...source, question }).gates.asset, 'HOLD')
    assert.equal(reviewReleaseRecord({ ...source, question, assetsForQuestion: [{ ...fixture, reviewStatus: 'UNREVIEWED' }] }).eligible, false)
    assert.equal(reviewReleaseRecord({ ...source, question, assetsForQuestion: [fixture] }).eligible, true)
  })

  it('blocks documented anomalies independently of synthetic mapping and holds ambiguous case dependencies', () => {
    const placeholder = { assetId: 'stub', path: null }
    const item = record('Q44')
    assert.equal(reviewReleaseRecord({ ...item, assetsForQuestion: [placeholder] }).classification, 'ELIGIBLE_WITH_SOURCE_NOTE')
    assert.equal(reviewReleaseRecord({ ...item, assetsForQuestion: [placeholder],
      question: { ...item.question, requiresDiagram: true, requiredAssetIds: ['stub'] } }).classification, 'REVIEW_HOLD')
    for (const id of ['Q6', 'Q58', 'Q360']) assert.equal(reviewReleaseRecord(record(id)).gates.anomaly, 'HOLD')
    const standalone = record()
    const related = { ...standalone, question: { ...standalone.question, caseStudyId: 'case-specimen' } }
    assert.equal(reviewReleaseRecord(related).gates.caseRelationship, 'HOLD')
    const family = { heldChildIds: [], rejectedChildIds: [], validatedChildIds: [standalone.question.sourceId], scenarioText: 'Synthetic source scenario.' }
    assert.equal(reviewReleaseRecord({ ...related, family }).eligible, true)
    assert.equal(reviewReleaseRecord({ ...related, family: { ...family, heldChildIds: [standalone.question.sourceId] } }).eligible, false)
    assert.equal(reviewReleaseRecord({ ...related, family: { ...family, rejectedChildIds: [standalone.question.sourceId] } }).classification, 'EXCLUDED')
  })

  it('requires explicit multiple-choice counts and never infers them from number of mapped answers', () => {
    const multi = { kind: 'MULTIPLE_CHOICE', options }
    const chosen = [{ optionId: 'first-choice' }, { optionId: 'third-choice' }]
    assert.throws(() => reviewReleaseInteraction(multi, 'Make some selections.', chosen), /RELEASE_CHOICE_INSTRUCTION_MAPPING_MISMATCH/)
    assert.throws(() => reviewReleaseInteraction(multi, 'Which three choices work?', chosen), /RELEASE_CHOICE_INSTRUCTION_MAPPING_MISMATCH/)
    assert.throws(() => reviewReleaseInteraction(multi, 'Which two choices work?', [chosen[0], chosen[0]]), /RELEASE_CHOICE_INSTRUCTION_MAPPING_MISMATCH/)
    const result = reviewReleaseInteraction(multi, 'What are two ways to organize this fixture?', chosen)
    assert.equal(result.shown.requiredSelections, 2)
    assert.deepEqual(result.answer.optionIds, ['first-choice', 'third-choice'])
    assert.deepEqual(result.optionGroups[0].optionIds, options.map(({ id }) => id))
    assert.equal(result.optionGroups[0].shuffle, false)
  })

  it('retains target identities, scoring map direction and ordered positions; rejects made-up geometry', () => {
    const targets = [{ id: 'slot-a', label: 'First position' }, { id: 'slot-b', label: 'Second position' }]
    const mapped = [{ targetId: 'slot-a', optionId: 'third-choice' }, { targetId: 'slot-b', optionId: 'first-choice' }]
    const matching = { kind: 'MATCHING', targets, choices: options }
    const match = reviewReleaseInteraction(matching, 'An item may be used more than once.', mapped)
    assert.deepEqual(match.answer.selections, { 'slot-a': 'third-choice', 'slot-b': 'first-choice' })
    assert.equal(match.shown.selectionPolicy, 'REUSABLE')
    assert.throws(() => reviewReleaseInteraction(matching, 'Make associations.', mapped), /RELEASE_REUSE_INSTRUCTION_REVIEW_REQUIRED/)
    assert.throws(() => reviewReleaseInteraction(matching, 'May be used more than once.', [...mapped].reverse()), /RELEASE_TARGET_MAPPING_MISMATCH/)
    const ordering = { kind: 'ORDERING', positions: targets, items: options }
    assert.deepEqual(reviewReleaseInteraction(ordering, 'Put steps in correct order.', mapped).answer.optionIds, ['third-choice', 'first-choice'])
    assert.throws(() => reviewReleaseInteraction(ordering, 'Use the correct order. More than one sequence is possible.', mapped), /RELEASE_ORDERING_INSTRUCTION_REVIEW_REQUIRED/)
    assert.throws(() => reviewReleaseInteraction({ kind: 'IMAGE_HOTSPOT' }, 'Synthetic unsupported type.', []), /RELEASE_INTERACTION_UNSUPPORTED/)
  })
})

describe('owner correction for documented source-limitations (synthetic candidate data)', () => {
  it('keeps independent case-based holds when provenance/role do not match the audited source', () => {
    for (const [sourceId, page, caseStudyId] of [
      ['Q6', 7, 'CS-FABRIKAM'], ['Q209', 207, 'CS-FRONT-DOOR'], ['Q211', 209, 'CS-FRONT-DOOR'],
    ]) {
      const base = record(sourceId)
      const family = { id: caseStudyId, heldChildIds: [sourceId], rejectedChildIds: [], validatedChildIds: [], scenarioText: 'Synthesized test scenario only.' }
      const item = { ...base, family, question: { ...base.question, sourcePage: page, caseStudyId }, row: { ...base.row, SourcePage: page } }
      assert.equal(reviewReleaseRecord(item).classification, 'ELIGIBLE_WITH_SOURCE_LIMITATION')
      assert.deepEqual(reviewReleaseRecord(item).projected.shown.options, options)
      assert.equal(reviewReleaseRecord({ ...item, family: { ...family, id: 'another-test-family' } }).classification, 'REVIEW_HOLD')
      assert.equal(reviewReleaseRecord({ ...item, family: { ...family, heldChildIds: [] } }).classification, 'REVIEW_HOLD')
    }
  })

  it('does not generate alternative keys for an authored ambiguous sequence', () => {
    const base = record('Q58')
    const positionIds = ['pos-a', 'pos-b']
    const positions = positionIds.map((id, i) => ({ id, label: 'Position ' + (i + 1) }))
    const printed = [{ targetId: 'pos-a', optionId: 'third-choice' }, { targetId: 'pos-b', optionId: 'first-choice' }]
    const interaction = { kind: 'ORDERING', positions, items: options }
    const prompt = 'Place the items in correct order. More than one can work.'
    const item = { ...base, prompt, mapping: printed, row: { ...base.row, SourcePage: 58 },
      question: { ...base.question, sourcePage: 58, interaction },
      answer: { ...base.answer, normalizedMappingDigest: digest(printed) } }
    const reviewed = reviewReleaseRecord(item)
    assert.equal(reviewed.classification, 'ELIGIBLE_WITH_SOURCE_LIMITATION')
    assert.deepEqual(reviewed.projected.answer, { kind: 'ORDERING', optionIds: ['third-choice', 'first-choice'] })
    assert.deepEqual(reviewed.projected.shown, interaction)
    assert.throws(() => reviewReleaseInteraction(interaction, prompt, printed), /RELEASE_ORDERING_INSTRUCTION_REVIEW_REQUIRED/)
  })

  it('will not substitute another image or invent geometry for the source dropdown raster', () => {
    const base = record('Q360')
    const raster = { sourceQuestionId: 'Q360', sourcePage: 358, sourceXref: 1466,
      path: 'assets/sc100-x1466-d389f9dbde5466e0.png',
      checksum: 'd389f9dbde5466e02a501a07dcaaec809ad7855635ed728142a898ac902c1747',
      reviewStatus: 'SOURCE_INTERACTION_REVIEW_REQUIRED' }
    const targets = ['d1', 'd2'].map(id => ({ id, label: 'Fixture ' + id, options: options.map(option => ({ ...option, id: id + ':' + option.id })) }))
    const mapping = targets.map(t => ({ targetId: t.id, optionId: t.options[0].id }))
    const question = { ...base.question, sourcePage: 358, interactionValidated: false, interaction: { kind: 'DROPDOWN', targets } }
    const item = { ...base, question, mapping, row: { ...base.row, SourcePage: 358 },
      answer: { ...base.answer, normalizedMappingDigest: digest(mapping) }, assetsForQuestion: [raster] }
    const final = reviewReleaseRecord(item)
    assert.equal(final.classification, 'ELIGIBLE_WITH_SOURCE_LIMITATION')
    assert.deepEqual(final.projected.shown, question.interaction)
    assert.deepEqual(final.approvedAssets, [raster])
    assert.equal(reviewReleaseRecord({ ...item, assetsForQuestion: [{ ...raster, checksum: 'wrong' }] }).eligible, false)
    assert.equal(reviewReleaseRecord({ ...item, assetsForQuestion: [] }).eligible, false)
    assert.equal(reviewReleaseRecord({ ...item, question: { ...question, interaction: { kind: 'IMAGE_HOTSPOT' } } }).eligible, false)
  })
})
