const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (value, key) => Object.hasOwn(value, key)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const reject = () => { throw new Error('Protected scoring projection could not be verified.') }

function findUnique(rows, currentIds) {
  if (!Array.isArray(rows)) return reject()
  const found = new Map()
  for (const row of rows) {
    if (!object(row) || !currentIds.has(row.sourceId)) continue
    if (found.has(row.sourceId)) return reject()
    found.set(row.sourceId, row)
  }
  if (found.size !== currentIds.size) return reject()
  return found
}

function checkedMapping(mapping) {
  if (!Array.isArray(mapping) || !mapping.length || mapping.some(row => !object(row)
    || typeof row.optionId !== 'string' || !row.optionId)) return reject()
  return mapping
}
function selectedOptions(rows, options) {
  const ids = rows.map(item => {
    if (Object.keys(item).length !== 1 || !options.some(o => o.id === item.optionId)) return reject()
    return item.optionId
  })
  if (new Set(ids).size !== ids.length) return reject()
  return ids
}
function selections(rows, targets) {
  if (rows.length !== targets.length) return reject()
  const pairs = rows.map(item => {
    if (Object.keys(item).length !== 2 || typeof item.targetId !== 'string') return reject()
    const target = targets.find(t => t.id === item.targetId)
    if (!target?.options.some(o => o.id === item.optionId)) return reject()
    return [item.targetId, item.optionId]
  })
  if (new Set(pairs.map(([id]) => id)).size !== targets.length) return reject()
  return Object.fromEntries(pairs)
}

function convert(rawMapping, interaction) {
  const rows = checkedMapping(rawMapping)
  const { kind } = interaction
  switch (kind) {
    case 'SINGLE_CHOICE': {
      const ids = selectedOptions(rows, interaction.options)
      if (ids.length !== 1) return reject()
      return { kind, optionId: ids[0] }
    }
    case 'MULTIPLE_CHOICE': {
      const optionIds = selectedOptions(rows, interaction.options)
      if (interaction.requiredSelections !== undefined && optionIds.length !== interaction.requiredSelections) return reject()
      return { kind, optionIds }
    }
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
    case 'MATCHING':
    case 'DRAG_DROP':
    case 'STATEMENT':
      return { kind, selections: selections(rows, interaction.targets) }
    case 'ORDERING': {
      // The authored position IDs define the score sequence, not DOM order.
      const targets = interaction.positions?.map(position => ({ id: position.id, options: interaction.items }))
      if (!targets?.length) return reject()
      const mapped = selections(rows, targets)
      const optionIds = targets.map(({id}) => mapped[id])
      if (new Set(optionIds).size !== optionIds.length) return reject()
      return { kind, optionIds }
    }
    case 'DIAGRAM_DEPENDENT':
      if (!interaction.assetId || !interaction.interaction) return reject()
      return { kind, response: convert(rows, interaction.interaction) }
    default:
      return reject() // No verified coordinate-based image HOTSPOT exists.
  }
}

/** Called only by the digest-pinned offline builder. Nothing from an
 * authoritative row escapes except its normalized stable-ID answer. */
export function projectProtectedScoring(payload, privateBank, scoringFile) {
  const { batch, questions } = payload
  const ids = new Set(batch.sourceIds)
  if (ids.size !== 59 || ids.size !== batch.sourceIds.length
    || !object(scoringFile) || scoringFile.scope !== 'PRIVATE_DEVELOPMENT_ONLY'
    || scoringFile.bankVersion !== batch.contentVersion || privateBank.manifest?.bankVersion !== batch.contentVersion)
    return reject()
  const source = findUnique(privateBank.answerDefinitions, ids)
  const sealed = findUnique(scoringFile.answerDefinitions, ids)
  const defs = []
  for (const id of batch.sourceIds) {
    const a = source.get(id), b = sealed.get(id)
    if (!a || !b || !owns(questions, id) || !digest(a.sourceAnswerDigest)
      || !digest(a.normalizedMappingDigest) || a.sourceAnswerDigest !== b.sourceAnswerDigest
      || a.normalizedMappingDigest !== b.normalizedMappingDigest || !same(a.mapping, b.mapping)) return reject()
    const question = questions[id]
    if (question.id !== id || question.interaction.kind !== batch.interactionKinds[id]) return reject()
    defs.push([id, convert(b.mapping, question.interaction)])
  }
  return { scope: 'PRIVATE_EXAM_SCORING_CANARY', bankVersion: batch.contentVersion, definitions: Object.fromEntries(defs) }
}
