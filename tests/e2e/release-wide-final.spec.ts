import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { activeExamCycle } from '../../src/domain/cycle-lifecycle'
import { adaptivePool } from '../fixtures/adaptive-pool'
import { finish, main, question, saved, start } from './phase6-harness'
import { releaseHarness, releaseStore } from './release-harness'
import type { ReleaseHarness } from './release-harness'

const epoch = Date.UTC(2033, 3, 12, 10)
const limits = new Set(['qa-standard-107', 'qa-standard-108', 'qa-standard-109', 'qa-standard-110', 'qa-standard-111'])
const eligible = adaptivePool({ families: [3, 3], standard: 111, interactive: 4 }).questions.map(x => x.sourceId).sort()
const intro = (page: Page) => page.getByRole('button', { name: 'Start exam', exact: true })
const response = (page: Page) => question(page).getByRole('radio', { name: 'Example Alpha', exact: true })
const result = (page: Page) => page.getByRole('region', { name: 'Examination results', exact: true })
const cycle = (page: Page) => page.getByRole('region', { name: 'Exam cycle', exact: true })
const timer = (page: Page) => page.getByRole('timer', { name: 'Time remaining' })
const next = (page: Page) => question(page).getByRole('button', { name: 'Next', exact: true })
let server: ReleaseHarness
test.beforeAll(async () => { server = await releaseHarness({ wideFinal: true }) })
test.afterAll(async () => { await server?.close() })

async function begin(page: Page) {
  await start(page)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(timer(page)).toContainText('02:00')
}
async function choose(page: Page) {
  await response(page).focus()
  await response(page).press('Space')
  await expect(response(page)).toBeChecked()
  await saved(page)
}
async function answerLeading(page: Page, count: number) {
  const plan = (await releaseStore(page)).attempt!.batch
  let answered = 0
  for (const section of plan.sections) {
    const countThisSection = Math.min(count - answered, section.questionIds.length)
    for (let position = 0; position < countThisSection; position += 1) {
      await expect(question(page).getByText('Question ' + (position + 1) + ' of ' + section.questionIds.length, { exact: true })).toBeVisible()
      await choose(page)
      answered += 1
      if (position + 1 < countThisSection) { await next(page).click(); await saved(page) }
    }
    if (answered === count) break
    await finish(page)
  }
  expect(answered).toBe(count)
  const row = (await releaseStore(page)).attempt!
  expect(Object.keys(row.answers)).toHaveLength(count)
  expect(row.result).toBeNull()
  expect(row.finalizedAnswerSnapshot ?? null).toBeNull()
  await expect(result(page)).toHaveCount(0)
}
async function submit(page: Page, total: number, correct: number) {
  await page.getByRole('button', { name: 'End exam', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'End this exam?', exact: true })
  await expect(confirmation.getByText('Total questions: ' + total, { exact: true })).toBeVisible()
  await expect(confirmation.getByText('Answered: ' + correct, { exact: true })).toBeVisible()
  await confirmation.getByRole('button', { name: 'End and submit', exact: true }).click()
}
async function confirmScore(page: Page, total: number, score: number, reason: 'MANUAL_SUBMISSION' | 'TIME_EXPIRED', verdict: 'PASS' | 'FAIL') {
  await expect(result(page)).toBeVisible()
  const row = (await releaseStore(page)).attempt!
  expect(row.status).toBe('SCORED')
  expect(row.result).toMatchObject({
    rawScore: score, maximumScore: total, questionCount: total, passingPercentage: 90,
    outcome: verdict, unansweredCount: total - score, correctCount: score, incorrectCount: 0, finalizationReason: reason,
  })
  expect(row.result?.percentage).toBeCloseTo(score * 100 / total, 8)
  expect(row.finalizedAnswerSnapshot?.questionIds).toHaveLength(total)
  expect(row.finalizedAnswerSnapshot?.answers).toEqual(row.answers)
  const metric = result(page).locator('dl > div').filter({ has: page.getByText('Score', { exact: true }) }).locator('dd')
  await expect(metric).toHaveText(score + ' / ' + total)
  await expect(result(page)).toContainText((score * 100 / total).toFixed(2) + '%')
  await expect(result(page)).toContainText('Passing threshold: 90%')
  await expect(question(page)).toHaveCount(0)
}
async function overflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
    document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}

for (const vector of [
  { normal: 53, final: 55, reason: 'MANUAL_SUBMISSION', verdict: 'FAIL' },
  { normal: 54, final: 56, reason: 'TIME_EXPIRED', verdict: 'PASS' },
] as const) {
  test('wide terminal 62: actual normal ' + vector.normal + '/59 and final ' + vector.final + '/62 resolve ' + vector.verdict + ' at 90%', async ({ page }) => {
    test.setTimeout(110_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.clock.install({ time: epoch - 5000 })
    await page.clock.pauseAt(epoch)
    expect((await page.goto(server.url))?.status()).toBe(200)
    await expect(intro(page)).toBeEnabled()
    const originalCycle = (await releaseStore(page)).journey!.cycleId
    await begin(page)
    await answerLeading(page, vector.normal)
    await submit(page, 59, vector.normal)
    await confirmScore(page, 59, vector.normal, 'MANUAL_SUBMISSION', vector.verdict)
    await cycle(page).getByRole('button', { name: 'Next exam', exact: true }).click()
    await expect(intro(page)).toBeEnabled()
    await expect(main(page).getByRole('heading', { name: 'Final Exam', exact: true })).toBeVisible()
    await expect(main(page)).toContainText(/62 questions/i)
    const openFinal = await releaseStore(page)
    const tracked = activeExamCycle(openFinal.lifecycle!).batches
    expect(tracked.map(x => x.batch.actualQuestionCount)).toEqual([59, 62])
    expect(tracked.map(x => x.batch.batchMode)).toEqual(['NORMAL', 'FINAL_REMAINDER'])
    expect(tracked[0]!.batch.sourceIds.filter(id => limits.has(id))).toEqual([])
    expect(tracked[1]!.batch.sourceIds.filter(id => limits.has(id)).sort()).toEqual([...limits].sort())
    expect(openFinal.journey?.cycleId).toBe(originalCycle)
    await begin(page)
    await expect(page.getByRole('banner')).toContainText('Exam position 1 of 62')
    await answerLeading(page, vector.final)
    const last = (await releaseStore(page)).attempt!
    const count = last.position + 1
    await page.clock.fastForward(10_000)
    await page.reload()
    await saved(page)
    await expect(page.getByRole('banner')).toContainText('Exam position ' + count + ' of 62')
    await expect(response(page)).toBeChecked()
    const resumed = (await releaseStore(page)).attempt!
    expect(resumed.startedAt).toBe(last.startedAt)
    expect(resumed.expiresAt).toBe(last.expiresAt)
    expect(resumed.answers).toEqual(last.answers)
    const navigation = page.getByRole('navigation', { name: 'Current section questions', exact: true })
    if (!await navigation.isVisible()) await page.getByText('Question navigator', { exact: true }).click()
    await navigation.getByRole('button', { name: /^Question 62\b/ }).click()
    await expect(page.getByRole('banner')).toContainText('Exam position 62 of 62')
    await expect(question(page).getByText('Question 62 of 62', { exact: true })).toBeVisible()
    await saved(page)
    expect((await releaseStore(page)).attempt?.result).toBeNull()
    expect(await page.evaluate(() => (window as Window & { __qaReleaseScoringInvocations?: number }).__qaReleaseScoringInvocations ?? 0)).toBe(0)
    await expect(main(page)).not.toContainText(/source limitation|review hold|answer key|your score/i)

    if (vector.reason === 'TIME_EXPIRED') {
      await page.clock.setSystemTime(resumed.expiresAt!)
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    } else await submit(page, 62, vector.final)
    await confirmScore(page, 62, vector.final, vector.reason, vector.verdict)
    await expect(cycle(page).getByRole('heading', { name: 'Cycle complete', exact: true })).toBeVisible()
    await expect(cycle(page).getByRole('button', { name: 'Next exam', exact: true })).toHaveCount(0)
    const complete = activeExamCycle((await releaseStore(page)).lifecycle!)
    expect(complete.status).toBe('COMPLETE')
    expect(complete.batches).toHaveLength(2)
    const generated = complete.batches.flatMap(({ batch }) => batch.sourceIds)
    expect(generated).toHaveLength(eligible.length)
    expect(new Set(generated).size).toBe(eligible.length)
    expect(generated.toSorted()).toEqual(eligible)
    expect(complete.consumedSourceIds.toSorted()).toEqual(eligible)
    if (vector.reason === 'MANUAL_SUBMISSION') {
      await page.clock.resume()
      await page.setViewportSize({ width: 320, height: 950 })
      await overflow(page)
      await page.setViewportSize({ width: 768, height: 950 })
      await page.evaluate(() => { document.documentElement.style.zoom = '2' })
      await overflow(page)
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      expect(scan.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(node => node.target) }))).toEqual([])
    }
  })
}
