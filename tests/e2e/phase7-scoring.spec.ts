import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { ExamAttempt, ScoredExamResult } from '../../src/domain/model'
import { finish, main, question, review, saved, start } from './phase6-harness'
import { goToSource, scoringRequest, servePhase7, snapshot } from './phase7-harness'
import type { Phase7Profile } from './phase7-harness'

type Attempt = ExamAttempt & { result: ScoredExamResult | null }
type CandidateAnswer = NonNullable<ExamAttempt['answers'][string]>
const epoch = Date.UTC(2032, 0, 22, 12)
const fourMinutes = 240_000
const bankSeen: WeakMap<Page, string[]> = new WeakMap()
const runtimeSeen: WeakMap<Page, string[]> = new WeakMap()
const scoringRuntimeRequest = /\/assets\/scoring-[^/]+\.js$/
const section = (page: Page) => page.getByRole('region', { name: 'Examination results', exact: true })
const title = (page: Page) => page.getByRole('heading', { name: 'Exam complete', exact: true })
const end = (page: Page) => page.getByRole('button', { name: 'End exam', exact: true })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'End this exam?', exact: true })
const activeForbidden = /\b(?:correct answer|incorrect answer|expected answer|answer key|explanation|pass\/fail|your score|percentage|section score)\b/i
const resultForbidden = /\b(?:correct answer|expected answer|answer key|explanation)\b/i
const scoreLoaderCalls = (page: Page) => page.evaluate(() => (window as Window & { __qaPhase7LoadCalls?: number }).__qaPhase7LoadCalls ?? 0)
let server: Awaited<ReturnType<typeof servePhase7>>
test.beforeAll(async () => { server = await servePhase7() })
test.afterAll(async () => { await server?.close() })

async function evidence(page: Page, filename: string) {
  const path = process.env.PLAYWRIGHT_PHASE7_SYNTHETIC_EVIDENCE_DIR
  if (!path) return
  if (!isAbsolute(path) || !relative(process.cwd(), resolve(path)).startsWith('..' + sep)) throw new Error('Synthetic evidence must stay outside the checkout')
  await mkdir(path, { recursive: true })
  if (!relative(await realpath(process.cwd()), await realpath(path)).startsWith('..' + sep)) throw new Error('Evidence path resolves inside the checkout')
  await page.screenshot({ path: join(path, filename + '.png'), animations: 'disabled', fullPage: true })
}

async function open(page: Page, profile: Phase7Profile) {
  const requests: string[] = []
  bankSeen.set(page, requests)
  const runtime: string[] = []
  runtimeSeen.set(page, runtime)
  page.on('request', request => {
    if (scoringRequest.test(request.url())) requests.push(request.url())
    if (scoringRuntimeRequest.test(request.url())) runtime.push(request.url())
  })
  await page.clock.install({ time: epoch - 5_000 })
  await page.clock.pauseAt(epoch)
  expect((await page.goto(server.url(profile)))?.status()).toBe(200)
  await saved(page)
}
async function begin(page: Page, profile: Phase7Profile) {
  await open(page, profile)
  await start(page)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('timer', { name: 'Time remaining' })).toContainText('04:00')
}
async function noScore(page: Page, profile: Phase7Profile) {
  expect(await scoreLoaderCalls(page)).toBe(0)
  expect(bankSeen.get(page)).toHaveLength(0)
  expect(runtimeSeen.get(page)).toHaveLength(0)
  await expect(title(page)).toHaveCount(0)
  await expect(section(page)).toHaveCount(0)
  await expect(main(page)).not.toContainText(activeForbidden)
  expect(await main(page).ariaSnapshot()).not.toMatch(activeForbidden)
  const stored = await snapshot<Attempt>(page, profile)
  expect(stored.result).toBeNull()
  expect(stored.finalizedAnswerSnapshot ?? null).toBeNull()
}
async function first(page: Page, choice: 'Alpha' | 'Beta' = 'Alpha') {
  const option = question(page).getByRole('radio', { name: 'Example ' + choice, exact: true })
  await option.focus()
  await option.press('Space')
  await expect(option).toBeChecked()
  await saved(page)
}
async function manual(page: Page) {
  await end(page).click()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('button', { name: 'End and submit', exact: true }).click()
}
async function final(page: Page, profile: Phase7Profile, expected: {
  total: number
  score: number
  wrong: number
  unanswered: number
  reason?: 'TIME_EXPIRED' | 'MANUAL_SUBMISSION'
}) {
  await expect(title(page)).toBeVisible()
  await expect(section(page)).toBeVisible()
  const [percentage, display] = [expected.score / expected.total * 100, (expected.score / expected.total * 100).toFixed(2) + '%']
  const metric = (label: string) => section(page).locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
  await expect(metric('Score')).toHaveText(expected.score + ' / ' + expected.total)
  await expect(metric('Percentage')).toHaveText(display)
  await expect(metric('Questions answered')).toHaveText(String(expected.total - expected.unanswered))
  await expect(metric('Questions unanswered')).toHaveText(String(expected.unanswered))
  await expect(section(page)).toContainText(expected.reason === 'TIME_EXPIRED' ? /Time expired/i : /Submitted/i)
  const outcome = percentage >= 75 ? 'PASS' : 'FAIL'
  const verdict = outcome === 'PASS' ? 'Pass' : 'Fail'
  await expect(section(page).locator('strong').filter({ hasText: new RegExp('(?:^|\\s)' + verdict + '$') })).toBeVisible()
  await expect(section(page)).not.toContainText(resultForbidden)
  const semantic = await section(page).ariaSnapshot()
  expect(semantic).toContain('strong: ' + verdict)
  expect(semantic).not.toMatch(resultForbidden)
  await expect(question(page)).toHaveCount(0)
  await expect(review(page)).toHaveCount(0)
  await expect(end(page)).toHaveCount(0)
  const stored = await snapshot<Attempt>(page, profile)
  expect(stored).toMatchObject({ status: 'SCORED', activeSection: null, finalizationReason: expected.reason ?? 'MANUAL_SUBMISSION' })
  expect(stored.locks).toHaveLength(stored.batch.sections.length)
  const finalized = stored.finalizedAnswerSnapshot
  if (!finalized || !('snapshotId' in finalized)) throw new Error('The durable scoring result requires a pinned terminal snapshot')
  expect(finalized.questionIds).toHaveLength(expected.total)
  expect(new Set(finalized.questionIds).size).toBe(expected.total)
  expect(finalized.answers).toEqual(stored.answers)
  expect(finalized).toMatchObject({
    schemaVersion: 2, attemptId: stored.id, batchId: stored.batch.id, bankVersion: stored.contentVersion,
    finalizedAt: stored.submittedAt, finalizationReason: expected.reason ?? 'MANUAL_SUBMISSION',
    sections: stored.batch.sections, interactionKinds: stored.interactionKinds,
  })
  const score = stored.result
  expect(score).toMatchObject({
    schemaVersion: 2, rawScore: expected.score, maximumScore: expected.total, questionCount: expected.total,
    correctCount: expected.score, incorrectCount: expected.wrong, unansweredCount: expected.unanswered,
    outcome, finalizationReason: expected.reason ?? 'MANUAL_SUBMISSION',
    scoringVersion: 'qa-phase7-policy-v1', bankVersion: stored.contentVersion,
    passingPercentage: 75, postExamReviewPolicy: 'NONE',
  })
  expect(score?.percentage).toBeCloseTo(percentage, 10)
  expect(score?.displayPercentage).toBe(display)
  expect(score?.snapshotId).toBe(finalized.snapshotId)
  expect(Object.keys(stored.answers)).toHaveLength(expected.total - expected.unanswered)
  return stored
}
async function countsOnce(page: Page) {
  expect(bankSeen.get(page)).toHaveLength(1)
  expect(runtimeSeen.get(page)).toHaveLength(1)
  expect(await scoreLoaderCalls(page)).toBe(1)
}
async function next(page: Page) {
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await saved(page)
}
async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
    document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}
async function axeResults(page: Page) {
  // Axe schedules frame work and timers; this attempt is durably terminal.
  await page.clock.resume()
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(node => node.target) }))).toEqual([])
}

test('normal 59: ready, question, review and cancelled End never load scoring; durable terminal snapshot gates results', async ({ page }) => {
  const profile = 'normal'
  await open(page, profile)
  await noScore(page, profile)
  await start(page)
  await first(page)
  await page.getByRole('button', { name: 'Mark for review', exact: true }).click()
  await saved(page)
  await page.getByRole('button', { name: 'Review section', exact: true }).click()
  await expect(review(page)).toBeVisible()
  await saved(page)
  await page.evaluate(() => { window.location.hash = '#/results' })
  await expect(review(page)).toBeVisible()
  await noScore(page, profile)
  await end(page).click()
  const warning = dialog(page)
  await expect(warning).toContainText(/Total questions:\s*59/i)
  await expect(warning.getByText('Answered: 1', { exact: true })).toBeVisible()
  await expect(warning).toContainText(/Unanswered or incomplete:\s*58/i)
  await expect(warning.getByText('Marked for review: 1', { exact: true })).toBeVisible()
  await expect(warning).toContainText(/Time remaining:.*04:00/i)
  await expect(warning).toContainText(/scored/i)
  await expect(warning.getByRole('button', { name: 'Return to exam' })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.clock.runFor(20)
  await expect(warning).toBeHidden()
  await expect(end(page)).toBeFocused()
  await noScore(page, profile)
  let atLoad: Attempt | undefined
  let resume = () => {}
  const held = new Promise<void>(resolve => { resume = resolve })
  await page.route(scoringRequest, async route => {
    atLoad = await snapshot<Attempt>(page, profile)
    await held
    await route.continue()
  })
  let scored: Attempt
  try {
    await manual(page)
    await expect.poll(() => atLoad?.status).toBe('SUBMITTED')
    expect(atLoad?.result).toBeNull()
    expect(atLoad?.finalizedAnswerSnapshot?.questionIds).toHaveLength(59)
    await expect(section(page)).toHaveCount(0)
    await expect(question(page)).toHaveCount(0)
    await expect(end(page)).toHaveCount(0)
    resume()
    scored = await final(page, profile, { total: 59, score: 1, wrong: 0, unanswered: 58 })
  } finally { resume() }
  await countsOnce(page)
  expect(scored.revision).toBe(atLoad!.revision + 1)
  expect(scored.result?.sectionBreakdown.map(row => row.questionCount)).toEqual([3, 3, 49, 4])
  await expect(section(page)).toContainText('Case Study 1')
  await expect(section(page)).toContainText('Case Study 2')
  await expect(section(page).getByRole('heading', { name: 'Section performance' })).toBeVisible()
  await page.clock.runFor(20)
  await expect(title(page)).toBeFocused()
  await axeResults(page)
  await evidence(page, '01-normal-result-desktop')
})

test('59-question adaptive manual and exact timeout converge to the same score, with distinct durable reasons', async ({ page, browser }) => {
  const profile = 'adaptive'
  await begin(page, profile)
  await first(page)
  await manual(page)
  const manualResult = await final(page, profile, { total: 59, score: 1, wrong: 0, unanswered: 58 })
  await countsOnce(page)
  expect(manualResult.result?.sectionBreakdown.map(row => row.questionCount)).toEqual([59])
  await expect(section(page)).not.toContainText(/Case Study|Interactive Questions/)

  const context = await browser.newContext()
  try {
    const auto = await context.newPage()
    await begin(auto, profile)
    await first(auto)
    await noScore(auto, profile)
    await auto.clock.fastForward(fourMinutes)
    await auto.evaluate(() => window.dispatchEvent(new Event('focus')))
    const expired = await final(auto, profile, { total: 59, score: 1, wrong: 0, unanswered: 58, reason: 'TIME_EXPIRED' })
    await countsOnce(auto)
    const aggregate = (row: Attempt) => {
      const { completedAt, finalizationReason, snapshotId, ...scores } = row.result!
      void [completedAt, finalizationReason, snapshotId]
      return scores
    }
    expect(aggregate(expired)).toEqual(aggregate(manualResult))
    expect(expired.finalizedAnswerSnapshot?.answers).toEqual(manualResult.finalizedAnswerSnapshot?.answers)
    await evidence(auto, '02-automatic-timeout-result')
  } finally { await context.close() }
})

test('41-question remainder scores with its actual denominator and restores persisted result without fetching or loading the scorer again', async ({ page, context }) => {
  const profile = 'remainder-41'
  await begin(page, profile)
  await first(page)
  await next(page)
  await first(page)
  await next(page)
  await first(page, 'Beta')
  await manual(page)
  const result = await final(page, profile, { total: 41, score: 2, wrong: 1, unanswered: 38 })
  await countsOnce(page)
  expect(result.result?.sectionBreakdown.map(row => row.questionCount)).toEqual([41])
  await evidence(page, '03-final-remainder-result')
  let reloadRequests = 0
  await page.route(scoringRequest, route => { reloadRequests += 1; return route.abort() })
  await page.reload()
  expect(await final(page, profile, { total: 41, score: 2, wrong: 1, unanswered: 38 })).toEqual(result)
  expect(await scoreLoaderCalls(page)).toBe(0)
  expect(reloadRequests).toBe(0)
  expect(bankSeen.get(page)).toHaveLength(1)
  expect(runtimeSeen.get(page)).toHaveLength(1)
  const passive = await context.newPage()
  await passive.route(scoringRequest, route => { reloadRequests += 1; return route.abort() })
  await passive.goto(server.url(profile) + '#/question')
  expect(await final(passive, profile, { total: 41, score: 2, wrong: 1, unanswered: 38 })).toEqual(result)
  expect(await scoreLoaderCalls(passive)).toBe(0)
  expect(reloadRequests).toBe(0)
})

test('mixed 23: exact scorer strategies, actual sections, mobile result at 320/390/768px and 200% zoom', async ({ page }) => {
  test.setTimeout(55_000)
  const profile = 'mixed-23'
  await page.setViewportSize({ width: 390, height: 1000 })
  await begin(page, profile)
  await finish(page)
  const committed = async (id: string, expected: CandidateAnswer) => {
    await expect.poll(async () => (await snapshot<Attempt>(page, profile)).answers[id]).toEqual(expected)
    await saved(page)
  }
  const matching = (kind: 'DROPDOWN' | 'DROPDOWN_HOTSPOT' | 'MATCHING' | 'DRAG_DROP', north: 'a' | 'b', south: 'a' | 'b'): CandidateAnswer => ({
    kind, selections: { 'qa-north': 'sample-option-' + north, 'qa-south': 'sample-option-' + south },
  })
  await goToSource(page, profile, 'qa-standard-1')
  await question(page).getByRole('checkbox', { name: 'Example Alpha', exact: true }).click()
  await expect(question(page).getByRole('checkbox', { name: 'Example Alpha', exact: true })).toBeChecked()
  await question(page).getByRole('checkbox', { name: 'Example Gamma', exact: true }).click()
  const order = (await snapshot<Attempt>(page, profile)).optionOrder['qa-standard-1'] ?? []
  const correctOptions = order.filter(id => id === 'sample-option-a' || id === 'sample-option-c')
  expect(correctOptions).toHaveLength(2)
  await committed('qa-standard-1', { kind: 'MULTIPLE_CHOICE', optionIds: correctOptions })
  async function targets(north: 'a' | 'b', south: 'a' | 'b') {
    await question(page).getByRole('combobox', { name: 'North destination', exact: true }).selectOption('sample-option-' + north)
    await question(page).getByRole('combobox', { name: 'South destination', exact: true }).selectOption('sample-option-' + south)
    await saved(page)
  }
  await goToSource(page, profile, 'qa-standard-2')
  await targets('b', 'a')
  await committed('qa-standard-2', matching('DROPDOWN', 'b', 'a'))
  await goToSource(page, profile, 'qa-standard-3')
  await question(page).getByRole('button', { name: 'Use this order' }).click()
  await committed('qa-standard-3', { kind: 'ORDERING', optionIds: ['qa-step-a', 'qa-step-b', 'qa-step-c'] })
  await goToSource(page, profile, 'qa-standard-4')
  await question(page).getByRole('group', { name: 'First sample statement' }).getByRole('radio', { name: 'Yes' }).click()
  await question(page).getByRole('group', { name: 'Second sample statement' }).getByRole('radio', { name: 'No' }).click()
  await committed('qa-standard-4', { kind: 'STATEMENT', selections: { 'qa-statement-first': 'qa-yes', 'qa-statement-second': 'qa-no' } })
  await goToSource(page, profile, 'qa-standard-5')
  await targets('a', 'b')
  await committed('qa-standard-5', matching('MATCHING', 'a', 'b'))
  await goToSource(page, profile, 'qa-standard-6')
  await targets('b', 'a')
  await committed('qa-standard-6', matching('DRAG_DROP', 'b', 'a'))
  await noScore(page, profile)
  await finish(page)
  await goToSource(page, profile, 'qa-interactive-1')
  await targets('b', 'a')
  await committed('qa-interactive-1', matching('DROPDOWN_HOTSPOT', 'b', 'a'))
  await manual(page)
  const result = await final(page, profile, { total: 23, score: 5, wrong: 2, unanswered: 16 })
  await countsOnce(page)
  expect(result.result?.sectionBreakdown.map(row => row.questionCount)).toEqual([2, 20, 1])
  const found = new Map(result.result?.interactionTypeBreakdown.map(row => [row.interactionKind, row] as const))
  for (const kind of ['MULTIPLE_CHOICE', 'DROPDOWN', 'STATEMENT', 'DRAG_DROP', 'DROPDOWN_HOTSPOT'] as const) {
    expect(found.get(kind)).toMatchObject({ questionCount: 1, correctCount: 1, incorrectCount: 0 })
  }
  for (const kind of ['MATCHING', 'ORDERING'] as const) {
    expect(found.get(kind)).toMatchObject({ questionCount: 1, correctCount: 0, incorrectCount: 1 })
  }
  await expect(section(page).getByRole('heading', { name: 'Question-type performance' })).toBeVisible()
  await axeResults(page)
  await evidence(page, '04-mixed-result-mobile')
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 })
    await noHorizontalOverflow(page)
    await expect(title(page)).toBeVisible()
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await noHorizontalOverflow(page)
  await expect(section(page)).toContainText('21.74%')
})

for (const [event, correct, wrong, unanswered, description] of [
  ['correct', 1, 0, 0, '100 percent'],
  ['wrong', 0, 1, 0, '0 percent incorrect'],
  ['unanswered', 0, 0, 1, '0 percent unanswered'],
] as const) {
  test('one-question remainder renders ' + description + ' using one actual item', async ({ page }) => {
    const profile = 'one'
    await begin(page, profile)
    if (event !== 'unanswered') await first(page, event === 'correct' ? 'Alpha' : 'Beta')
    await manual(page)
    await final(page, profile, { total: 1, score: correct, wrong, unanswered })
    await countsOnce(page)
  })
}

for (const [correct, label] of [[3, 'passes at exactly 75%'], [2, 'fails one raw point below the 75% threshold']] as const) {
  test('configured threshold: candidate ' + label, async ({ page }) => {
    const profile = 'threshold'
    await begin(page, profile)
    for (let i = 0; i < 4; i += 1) {
      await first(page, i < correct ? 'Alpha' : 'Beta')
      if (i !== 3) await next(page)
    }
    await manual(page)
    await final(page, profile, { total: 4, score: correct, wrong: 4 - correct, unanswered: 0 })
    await countsOnce(page)
    await expect(section(page)).toContainText('Passing threshold')
    await evidence(page, correct === 3 ? '05-exact-passing-threshold' : '06-one-point-below-threshold')
  })
}

test('manual confirmation racing timeout and repeated submit persist one score and one stable result', async ({ page }) => {
  const profile = 'one'
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const attempt = (value as { attempt?: { status?: string; expiresAt?: number } })?.attempt
      if (this.name === 'attempts' && attempt?.status === 'SUBMITTED' && attempt.expiresAt &&
        !sessionStorage.getItem('qa-phase7-terminal-race')) {
        sessionStorage.setItem('qa-phase7-terminal-race', 'true')
        const deadline = attempt.expiresAt
        const now = Date.now
        Date.now = () => Math.max(deadline, now())
        window.dispatchEvent(new Event('focus'))
      }
      if (this.name === 'attempts' && attempt?.status === 'SCORED') {
        sessionStorage.setItem('qa-phase7-score-writes', String(Number(sessionStorage.getItem('qa-phase7-score-writes') ?? 0) + 1))
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  })
  await begin(page, profile)
  await first(page)
  const active = await snapshot<Attempt>(page, profile)
  await end(page).click()
  await dialog(page).getByRole('button', { name: 'End and submit' }).evaluate(node => {
    const button = node as HTMLButtonElement
    button.click()
    button.click()
  })
  const completed = await final(page, profile, { total: 1, score: 1, wrong: 0, unanswered: 0 })
  expect(completed.revision).toBe(active.revision + 2)
  await countsOnce(page)
  expect(await page.evaluate(() => sessionStorage.getItem('qa-phase7-score-writes'))).toBe('1')
  await page.clock.fastForward(fourMinutes + 2000)
  await page.reload()
  const after = await final(page, profile, { total: 1, score: 1, wrong: 0, unanswered: 0 })
  expect(after).toEqual(completed)
  expect(await scoreLoaderCalls(page)).toBe(0)
  expect(await page.evaluate(() => sessionStorage.getItem('qa-phase7-score-writes'))).toBe('1')
})

test('all sections locked is not terminal until final confirmation; a zero-response exam still scores', async ({ page }) => {
  const profile = 'one'
  await begin(page, profile)
  await finish(page)
  await expect(page.getByRole('heading', { name: 'Final submission', exact: true })).toBeVisible()
  expect((await snapshot<Attempt>(page, profile)).status).toBe('FINAL_SUBMISSION_PENDING')
  await noScore(page, profile)
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('button', { name: 'End and submit', exact: true }).click()
  await final(page, profile, { total: 1, score: 0, wrong: 0, unanswered: 1 })
  await countsOnce(page)
})

test('score-storage quota fault keeps submission locked; retry persists cached aggregate without loading again', async ({ page }) => {
  const profile = 'one'
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const attempt = (value as { attempt?: { status?: string } })?.attempt
      if (this.name === 'attempts' && attempt?.status === 'SCORED' && !sessionStorage.getItem('qa-phase7-score-first-failed')) {
        sessionStorage.setItem('qa-phase7-score-first-failed', 'true')
        throw new DOMException('Synthetic result persistence quota fault', 'QuotaExceededError')
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    }
  })
  await begin(page, profile)
  await first(page)
  await manual(page)
  const retry = page.getByRole('button', { name: 'Retry scoring', exact: true })
  await expect(retry).toBeVisible()
  await expect(question(page)).toHaveCount(0)
  await expect(title(page)).toHaveCount(0)
  await countsOnce(page)
  const durable = await snapshot<Attempt>(page, profile)
  expect(durable.status).toBe('SUBMITTED')
  expect(durable.result).toBeNull()
  expect(durable.finalizedAnswerSnapshot?.answers).toEqual(durable.answers)
  await retry.click()
  const result = await final(page, profile, { total: 1, score: 1, wrong: 0, unanswered: 0 })
  expect(result.revision).toBe(durable.revision + 1)
  expect(result.finalizedAnswerSnapshot).toEqual(durable.finalizedAnswerSnapshot)
  await countsOnce(page)
})

test('activating the already-current navigator does not drop a candidate response captured immediately after', async ({ page }) => {
  const profile = 'one'
  await begin(page, profile)
  const before = await snapshot<Attempt>(page, profile)
  const navigator = page.getByRole('navigation', { name: 'Current section questions' })
  if (!await navigator.isVisible()) await page.getByText('Question navigator', { exact: true }).click()
  await expect(navigator.getByRole('button', { name: /current question/i })).toHaveAttribute('aria-current', 'true')
  await page.evaluate(() => {
    const same = document.querySelector<HTMLButtonElement>('nav button[aria-current="true"]')
    const answer = document.querySelector<HTMLInputElement>('input[value="sample-option-a"]')
    if (!same || !answer) throw new Error('Synthetic current-question controls were not rendered')
    same.click()
    answer.click()
  })
  const key = before.batch.sections[0]!.questionIds[0]!
  await expect.poll(async () => (await snapshot<Attempt>(page, profile)).answers[key]).toEqual({
    kind: 'SINGLE_CHOICE', optionId: 'sample-option-a',
  })
  await saved(page)
  expect((await snapshot<Attempt>(page, profile)).revision).toBe(before.revision + 1)
  await noScore(page, profile)
  await manual(page)
  await final(page, profile, { total: 1, score: 1, wrong: 0, unanswered: 0 })
  await countsOnce(page)
})
