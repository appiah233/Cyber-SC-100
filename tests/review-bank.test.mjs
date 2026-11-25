import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const script = fileURLToPath(new URL('../scripts/question-bank/review.mjs', import.meta.url))

const sample = () => ({
  manifest: { contentVersion: 'synthetic-review-01' },
  questions: [
    {
      sourceId: 'Q999', sourcePage: 2, title: 'Synthetic item & display',
      prompt: 'Example <script>this is only text</script> and </pre><img src=x onerror=x>',
      interaction: { kind: 'DROPDOWN' },
      display: { options: [{ id: 'T:O1', label: 'A & B' }], targets: [{ id: 'T', name: 'First choice' }] },
      assetIds: ['test-asset'], caseStudyId: 'test-family', reviewStatus: 'DEV_ONLY', productionEligible: false,
    },
    { sourceId: 'Q998', sourcePage: 3, prompt: 'Excluded synthetic row' },
  ],
  answerDefinitions: [
    { sourceId: 999, mapping: [{ targetId: 'T', optionId: 'T:O1' }], explanation: 'Synthetic reason "only".' },
    { sourceId: 'Q998', mapping: [{ optionId: 'DO-NOT-SHOW-OTHER-ROW' }] },
  ],
  assets: [{ assetId: 'test-asset', placement: 'sample-top', localPath: 'file:///synthetic-example.png' }],
  caseStudies: [{ caseStudyId: 'test-family', title: 'Synthetic family', reviewStatus: 'PENDING' }],
})

function fixture(context, data = sample()) {
  const directory = mkdtempSync(join(tmpdir(), 'exam-local-review-test-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'input.json')
  const output = join(directory, 'review.html')
  writeFileSync(input, JSON.stringify(data), { mode: 0o600 })
  return { directory, input, output }
}

const run = (input, id, output) => spawnSync(process.execPath, [script, '--bank', input, '--id', id, '--output', output], { encoding: 'utf8' })

test('produces only an escaped standalone review for one question outside the worktree', (context) => {
  const { input, output } = fixture(context)
  const message = execFileSync(process.execPath, [script, '--bank', input, '--id', '999', '--output', output], { encoding: 'utf8' })
  assert.equal(message, 'Private HTML review written. Do not publish it.\n')
  const html = readFileSync(output, 'utf8')
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'/)
  assert.match(html, /Q999/)
  assert.match(html, /Synthetic item &amp; display/)
  assert.match(html, /&lt;script&gt;this is only text&lt;\/script&gt;/)
  assert.match(html, /&lt;\/pre&gt;&lt;img src=x onerror=x&gt;/)
  assert.match(html, /A &amp; B/)
  assert.match(html, /First choice/)
  assert.match(html, /T:O1/)
  assert.match(html, /Synthetic reason &quot;only&quot;/)
  assert.match(html, /Synthetic family/)
  assert.match(html, /sample-top/)
  assert.match(html, /file:\/\/\/synthetic-example\.png/)
  assert.match(html, /No \/ not explicitly eligible/)
  assert.doesNotMatch(html, /<script\b|<img\b|\s(?:src|href)=(?:")/)
  assert.doesNotMatch(html, /Excluded synthetic row|DO-NOT-SHOW-OTHER-ROW/)
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o777, 0o600)
})

test('refuses a bank path or HTML write path inside the worktree', (context) => {
  const { input, output } = fixture(context)
  const privateInputTest = run(resolve(repository, 'package.json'), '999', output)
  assert.equal(privateInputTest.status, 1)
  assert.match(privateInputTest.stderr, /outside the worktree/)
  assert.equal(existsSync(output), false)
  const privateOutputTest = run(input, '999', resolve(repository, 'index.html'))
  assert.equal(privateOutputTest.status, 1)
  assert.match(privateOutputTest.stderr, /outside the worktree/)
})

test('rejects symlink aliases into the worktree', { skip: process.platform === 'win32' }, (context) => {
  const { directory, input, output } = fixture(context)
  const linkedRepo = join(directory, 'linked-repo')
  symlinkSync(repository, linkedRepo, 'dir')
  const inputResult = run(join(linkedRepo, 'package.json'), '999', output)
  assert.equal(inputResult.status, 1)
  assert.match(inputResult.stderr, /resolves into the worktree/)
  const outputResult = run(input, '999', join(linkedRepo, 'index.html'))
  assert.equal(outputResult.status, 1)
  assert.match(outputResult.stderr, /resolves into the worktree/)
  assert.equal(existsSync(output), false)
})

test('refuses an existing destination and never overwrites it', (context) => {
  const { input, output } = fixture(context)
  writeFileSync(output, 'previous file')
  const result = run(input, 'Q999', output)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /already exists/)
  assert.equal(readFileSync(output, 'utf8'), 'previous file')
})

test('refuses an output symlink even when the destination does not exist', { skip: process.platform === 'win32' }, (context) => {
  const { directory, input, output } = fixture(context)
  const target = join(directory, 'not-created.html')
  symlinkSync(target, output)
  const result = run(input, '999', output)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /already exists/)
  assert.equal(existsSync(target), false)
})

test('rejects missing source IDs, ambiguous IDs and malformed banks without output', (context) => {
  const { input, output } = fixture(context)
  const missing = run(input, '9999', output)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /not found/)
  const questions = sample()
  questions.questions.push({ sourceId: 999 })
  writeFileSync(input, JSON.stringify(questions))
  const ambiguous = run(input, 'Q999', output)
  assert.equal(ambiguous.status, 1)
  assert.match(ambiguous.stderr, /ambiguous/)
  writeFileSync(input, 'synthetic private error value')
  const invalid = run(input, 'Q999', output)
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /not valid JSON/)
  assert.doesNotMatch(invalid.stderr, /synthetic private error value/)
  assert.equal(existsSync(output), false)
})

test('refuses duplicate definitions instead of guessing a mapping', (context) => {
  const data = sample()
  data.answerDefinitions.push({ sourceId: 'Q999', mapping: [{ optionId: 'duplicate' }] })
  const { input, output } = fixture(context, data)
  const duplicate = run(input, '999', output)
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /More than one answer definition/)
  assert.equal(existsSync(output), false)
})

test('refuses private HTML output in a different Git worktree', (context) => {
  const { directory, input } = fixture(context)
  const ordinary = join(directory, 'ordinary')
  const linked = join(directory, 'linked')
  mkdirSync(join(ordinary, '.git'), { recursive: true })
  mkdirSync(linked)
  writeFileSync(join(ordinary, '.git', 'HEAD'), 'ref: refs/heads/synthetic')
  writeFileSync(join(linked, '.git'), 'gitdir: ../some-metadata-location')
  for (const checkout of [ordinary, linked]) {
    const output = join(checkout, 'private-preview.html')
    const result = run(input, '999', output)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /outside all Git worktrees/)
    assert.equal(existsSync(output), false)
  }
})

test('includes non-rendered source placeholders, matching choices and linked case assets as text', (context) => {
  const data = sample()
  const question = data.questions[0]
  question.interaction = { kind: 'MATCHING', choices: [{ id: 'C', label: 'Synthetic matching choice' }] }
  question.assetIds = []
  question.developmentOnly = true
  data.assets.push({
    assetId: 'missing-asset', sourceQuestionId: 'Q999', classification: 'SOURCE_PLACEHOLDER', path: null,
  })
  data.caseStudies[0].sharedAssetIds = ['test-asset']
  const { input, output } = fixture(context, data)
  assert.equal(run(input, '999', output).status, 0)
  const html = readFileSync(output, 'utf8')
  assert.match(html, /Matchable choices/)
  assert.match(html, /Synthetic matching choice/)
  assert.match(html, /Asset missing-asset/)
  assert.match(html, /SOURCE_PLACEHOLDER/)
  assert.match(html, /Shared case-study placement/)
  assert.match(html, /Development only<\/dt><dd>true/)
  assert.doesNotMatch(html, /<img\b|\s(?:src|href)="/)
})
