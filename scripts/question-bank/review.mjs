import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Local review only. Never import into a browser entrypoint or run with real data in public CI.
const usage = 'Usage: node scripts/question-bank/review.mjs --bank <private JSON> --id <source ID> --output <new private HTML path>'
const maxBytes = 100 * 1024 * 1024

class ReviewError extends Error {}

function parseArguments(args) {
  const inputs = new Map()
  const allowed = new Set(['--bank', '--id', '--output'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!allowed.has(key) || inputs.has(key) || !value?.trim() || value.startsWith('--')) {
      throw new ReviewError(usage)
    }
    inputs.set(key, value)
  }
  if (inputs.size !== allowed.size) throw new ReviewError(usage)
  return { bank: inputs.get('--bank'), id: inputs.get('--id').trim(), output: inputs.get('--output') }
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

async function fileExists(check) {
  try {
    return (await stat(check)).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

async function inGitWorktree(directory) {
  for (let current = directory; ; current = dirname(current)) {
    const marker = resolve(current, '.git')
    // Worktrees/submodules use a .git pointer file; ordinary repos have a .git/HEAD.
    if (await fileExists(marker) || await fileExists(resolve(marker, 'HEAD'))) return true
    if (dirname(current) === current) return false
  }
}

async function privatePaths(input, output) {
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
  const inputPath = resolve(input)
  const outputPath = resolve(output)
  if (inside(root, inputPath) || inside(root, outputPath)) {
    throw new ReviewError('Both bank and HTML paths must stay outside the worktree.')
  }
  if (!['.html', '.htm'].includes(extname(outputPath).toLowerCase())) {
    throw new ReviewError('Use an .html or .htm output filename.')
  }
  const [bank, outputDirectory] = await Promise.all([realpath(inputPath), realpath(dirname(outputPath))])
  const html = resolve(outputDirectory, basename(outputPath))
  if (inside(root, bank) || inside(root, html)) {
    throw new ReviewError('Bank or output directory resolves into the worktree.')
  }
  if (await inGitWorktree(outputDirectory)) {
    throw new ReviewError('Private HTML must stay outside all Git worktrees.')
  }
  return { bank, html }
}

async function readBank(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new ReviewError('The private bank must be a regular JSON file no larger than 100 MiB.')
    }
    const bytes = await file.readFile({ encoding: 'utf8' })
    try {
      return JSON.parse(bytes)
    } catch {
      // Do not print JSON.parse diagnostics; they can include private JSON excerpts.
      throw new ReviewError('The private bank is not valid JSON.')
    }
  } finally {
    await file.close()
  }
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => Array.isArray(value) ? value : []

function idKey(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
  const string = String(value).trim()
  // Permit convenient --id 15 lookup for a source ID convention of Q15, without dropping any source ID from output.
  return /^q?[0-9]+$/i.test(string) ? 'number:' + string.replace(/^q/i, '') : 'text:' + string
}

function findUnique(records, id, getId, missingMessage, ambiguousMessage) {
  const matches = records.filter((row) => record(row) && idKey(getId(row)) === id)
  if (matches.length > 1) throw new ReviewError(ambiguousMessage)
  if (matches.length === 0 && missingMessage) throw new ReviewError(missingMessage)
  return matches[0]
}

function display(value, empty = 'Not recorded') {
  if (value === undefined || value === null || value === '') return '<p class="muted">' + escapeText(empty) + '</p>'
  if (Array.isArray(value) && value.length === 0) return '<p class="muted">' + escapeText(empty) + '</p>'
  return '<pre>' + escapeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '</pre>'
}

function safeLabel(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? escapeText(value) : '<span class="muted">Not recorded</span>'
}

function assetRecord(records, id) {
  return findUnique(records, idKey(id), (asset) => asset.assetId ?? asset.sourceAssetId ?? asset.id, null, 'The selected question links to an ambiguous asset ID.')
}

function renderReview(bank, query) {
  if (!record(bank) || !Array.isArray(bank.questions) || !Array.isArray(bank.answerDefinitions)) {
    throw new ReviewError('Expected bank.questions and bank.answerDefinitions arrays.')
  }
  const key = idKey(query)
  const question = findUnique(
    bank.questions, key, (item) => item.sourceId ?? item.sourceQuestionId,
    'Source question ID not found.', 'Source question ID is ambiguous in the bank.',
  )
  const definition = findUnique(
    bank.answerDefinitions, key, (item) => item.sourceId ?? item.sourceQuestionId,
    null, 'More than one answer definition exists for the source question ID.',
  )

  const sourceId = question.sourceId ?? question.sourceQuestionId
  const view = record(question.display) ? question.display : {}
  const interaction = record(question.interaction) ? question.interaction : {}
  const interactionView = record(interaction.display) ? interaction.display : {}
  const groups = asArray(bank.caseStudies)
  const familyId = question.caseStudyId ?? question.familyId
  const family = familyId == null ? undefined : findUnique(
    groups, idKey(familyId), (item) => item.caseStudyId ?? item.familyId ?? item.id,
    null, 'The selected question links to an ambiguous case-study ID.',
  )
  const interactiveKind = typeof question.interaction === 'string'
    ? question.interaction : interaction.kind ?? interaction.type ?? question.interactionType
  const attachments = asArray(bank.assets)
  const references = [
    ...asArray(question.assetIds ?? view.assetIds ?? interaction.assetIds),
    ...asArray(question.requiredAssetIds),
    // Non-renderable placements, such as source placeholders, may be excluded from question.assetIds.
    ...attachments.filter((asset) => record(asset) && idKey(asset.sourceQuestionId) === key)
      .map((asset) => asset.assetId ?? asset.sourceAssetId ?? asset.id),
  ]
  const caseReferences = asArray(family?.sharedAssetIds)
  const assetReferences = new Map()
  for (const [role, ids] of [['Question placement', references], ['Shared case-study placement', caseReferences]]) {
    for (const id of ids) {
      const assetKey = idKey(id)
      if (assetKey === null) throw new ReviewError('The selected question contains an invalid asset ID.')
      if (!assetReferences.has(assetKey)) assetReferences.set(assetKey, { id, roles: new Set() })
      assetReferences.get(assetKey).roles.add(role)
    }
  }
  const assets = Array.from(assetReferences.values(), ({ id, roles }) => ({
    id, roles, row: assetRecord(attachments, id),
  }))
  const manifest = record(bank.manifest) ? bank.manifest : {}
  const title = question.title ?? view.title

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
  <title>Private source review</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #14243a; background: #f4f7fb; line-height: 1.55 }
    * { box-sizing: border-box } body { margin: 0; padding: 1rem }
    main { max-width: 60rem; margin: auto } h1, h2 { overflow-wrap: anywhere } h2 { font-size: 1.2rem }
    .banner { border: 1px solid #794a09; color: #573400; background: #fff3d6; padding: .75rem; border-radius: .45rem }
    section { margin-block: 1rem; background: #fff; padding: 1rem; border: 1px solid #687990; border-radius: .6rem }
    section h2 { margin-block-start: 0 } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin-block: .55rem }
    dl { display: grid; grid-template-columns: minmax(0, 12rem) minmax(0, 1fr); gap: .3rem 1rem } dt { font-weight: 700 }
    dd { margin: 0; overflow-wrap: anywhere } .muted { color: #42536b }
    @media (max-width: 36rem) { dl { grid-template-columns: minmax(0, 1fr) } dd { margin-block-end: .5rem } }
  </style>
</head>
<body>
<main>
  <h1>Private source review</h1>
  <p class="banner"><strong>Development only.</strong> This file may contain protected material. It is not a candidate screen, public artifact, or production approval.</p>
  <section aria-labelledby="source-heading">
    <h2 id="source-heading">Source</h2>
    <dl>
      <dt>Source question ID</dt><dd>${safeLabel(sourceId)}</dd>
      <dt>PDF page</dt><dd>${safeLabel(question.sourcePage ?? question.page)}</dd>
      <dt>Title</dt><dd>${safeLabel(title)}</dd>
      <dt>Interaction</dt><dd>${safeLabel(interactiveKind)}</dd>
      <dt>Content version</dt><dd>${safeLabel(manifest.contentVersion ?? manifest.bankVersion ?? manifest.version)}</dd>
      <dt>Source review status</dt><dd>${safeLabel(question.reviewStatus ?? question.sourceReviewStatus ?? question.status)}</dd>
      <dt>Source validated</dt><dd>${safeLabel(question.sourceValidated)}</dd>
      <dt>Interaction validated</dt><dd>${safeLabel(question.interactionValidated)}</dd>
      <dt>Case study validated</dt><dd>${safeLabel(question.caseStudyValidated)}</dd>
      <dt>Required exhibit</dt><dd>${safeLabel(question.requiresDiagram)}</dd>
      <dt>Development only</dt><dd>${safeLabel(question.developmentOnly)}</dd>
      <dt>Content approved</dt><dd>${safeLabel(question.contentApproved)}</dd>
      <dt>Answer review status</dt><dd>${safeLabel(definition?.reviewStatus ?? definition?.validationStatus)}</dd>
      <dt>Production eligible (recorded flag)</dt><dd>${question.productionEligible === true ? 'Yes' : 'No / not explicitly eligible'}</dd>
      <dt>Case-study ID</dt><dd>${safeLabel(familyId)}</dd>
    </dl>
  </section>
  <section aria-labelledby="prompt-heading">
    <h2 id="prompt-heading">Prompt</h2>
    ${display(question.prompt ?? view.prompt)}
  </section>
  <section aria-labelledby="display-heading">
    <h2 id="display-heading">Choices and targets</h2>
    <h3>Options</h3>
    ${display(view.options ?? interactionView.options ?? interaction.options ?? question.options)}
    <h3>Targets</h3>
    ${display(view.targets ?? interactionView.targets ?? interaction.targets ?? question.targets)}
    ${interaction.items == null ? '' : '<h3>Orderable items</h3>' + display(interaction.items)}
    ${interaction.choices == null ? '' : '<h3>Matchable choices</h3>' + display(interaction.choices)}
    ${interaction.positions == null ? '' : '<h3>Positions</h3>' + display(interaction.positions)}
  </section>
  <section aria-labelledby="answer-heading">
    <h2 id="answer-heading">Private answer definition</h2>
    ${display(definition?.mapping ?? definition?.answer ?? definition?.answerDefinition, 'No answer definition recorded for this question.')}
    <h3>Explanation</h3>
    ${display(definition?.explanation ?? question.explanation)}
  </section>
  <section aria-labelledby="family-heading">
    <h2 id="family-heading">Case-study metadata</h2>
    ${display(family, familyId == null ? 'No case-study reference recorded.' : 'Referenced case study was not found in this bank.')}
  </section>
  <section aria-labelledby="assets-heading">
    <h2 id="assets-heading">Asset metadata</h2>
    ${assets.length === 0 ? '<p class="muted">No asset IDs recorded.</p>' : assets.map(({ id, roles, row }) =>
      '<h3>Asset ' + escapeText(id) + '</h3><p>' + escapeText(Array.from(roles).join(' / ')) + '</p>' + display(row, 'Referenced asset was not found in this bank.')).join('\n')}
    <p class="muted">Asset paths are shown as text only. Images and URLs are not fetched.</p>
  </section>
</main>
</body>
</html>
`
}

async function run() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(usage + '\n')
    return
  }
  const args = parseArguments(process.argv.slice(2))
  const paths = await privatePaths(args.bank, args.output)
  const bank = await readBank(paths.bank)
  const html = renderReview(bank, args.id)
  let file
  try {
    // Refuse every pre-existing output, including a symlink or hard link.
    file = await open(paths.html, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ReviewError('The HTML output already exists; choose a new filename.')
    throw error
  }
  try {
    await file.writeFile(html, { encoding: 'utf8' })
  } finally {
    await file.close()
  }
  process.stdout.write('Private HTML review written. Do not publish it.\n')
}

try {
  await run()
} catch (error) {
  process.stderr.write('Private review failed: ' + (
    error instanceof ReviewError ? error.message : 'could not read the bank or write the private HTML.'
  ) + '\n')
  process.exitCode = 1
}
