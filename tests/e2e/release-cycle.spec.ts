import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { chromium, expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { activeExamCycle } from '../../src/domain/cycle-lifecycle'
import { adaptivePool } from '../fixtures/adaptive-pool'
import { finish, main, question, review, saved, start } from './phase6-harness'
import { releaseBase, releaseHarness, releaseStore } from './release-harness'
import type { Corruption, ReleaseHarness } from './release-harness'

const epoch = Date.UTC(2033, 0, 3, 9)
const expectedEligible = adaptivePool({ families: [3, 3], standard: 131, interactive: 4 }).questions.map(item => item.sourceId).sort()
const cycleRegion = (page: Page) => page.getByRole('region', { name: 'Exam cycle', exact: true })
const result = (page: Page) => page.getByRole('region', { name: 'Examination results', exact: true })
const timer = (page: Page) => page.getByRole('timer', { name: 'Time remaining' })
const alpha = (page: Page) => question(page).getByRole('radio', { name: 'Example Alpha', exact: true })
const mark = (page: Page) => question(page).getByRole('button', { name: 'Mark for review', exact: true })
const marked = (page: Page) => question(page).getByRole('button', { name: 'Marked for review', exact: true })
const startButton = (page: Page) => page.getByRole('button', { name: 'Start exam', exact: true })
const title = (page: Page, name: string) => main(page).getByRole('heading', { name, exact: true })
const scorer = /\/assets\/(?:phase7-browser-bank|scoring)-[^/]+\.js$/
let server: ReleaseHarness
test.beforeAll(async () => { server = await releaseHarness() })
test.afterAll(async () => { await server?.close() })

async function press(locator: Locator, keyboardKey = 'Enter') {
  await locator.focus()
  await locator.press(keyboardKey)
}
async function open(page: Page, frozen = false) {
  if (frozen) {
    await page.clock.install({ time: epoch - 5000 })
    await page.clock.pauseAt(epoch)
  }
  expect((await page.goto(server.url))?.status()).toBe(200)
  await expect(startButton(page)).toBeEnabled()
  await saved(page)
}
async function verifyActive(page: Page, section: string, position: number, total: number) {
  await expect(page.getByRole('banner').getByText(section, { exact: true })).toBeVisible()
  await expect(question(page).getByText('Question ' + position + ' of ' + total, { exact: true })).toBeVisible()
}
async function choose(page: Page) {
  await press(alpha(page), 'Space')
  await expect(alpha(page)).toBeChecked()
  await saved(page)
}
async function keyboardFinish(page: Page) {
  await press(question(page).getByRole('button', { name: 'Review section', exact: true }))
  await expect(review(page)).toBeVisible()
  await press(review(page).getByRole('button', { name: /^Finish (?:case study|section|interactive section)$/i }))
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/cannot return/i)
  await press(dialog.getByRole('button', { name: /^Submit (?:section|case study)$/i }))
  await expect(dialog).toBeHidden()
  await saved(page)
}
async function manual(page: Page) {
  await press(page.getByRole('button', { name: 'End exam', exact: true }))
  const warning = page.getByRole('dialog', { name: 'End this exam?', exact: true })
  await expect(warning).toContainText(/cannot change your answers/i)
  await expect(warning.getByRole('button', { name: 'Return to exam' })).toBeFocused()
  await press(warning.getByRole('button', { name: 'End and submit', exact: true }))
}
async function scored(page: Page, total: number, reason: 'MANUAL_SUBMISSION' | 'TIME_EXPIRED') {
  await expect(title(page, 'Exam complete')).toBeVisible()
  await expect(result(page)).toContainText(reason === 'TIME_EXPIRED' ? /Time expired/i : /Submitted/i)
  await expect(result(page)).not.toContainText(/answer key|expected answer|explanation/i)
  await expect(question(page)).toHaveCount(0)
  await expect(review(page)).toHaveCount(0)
  const store = await releaseStore(page)
  expect(store.attempt?.status).toBe('SCORED')
  expect(store.attempt?.result).toMatchObject({ maximumScore: total, questionCount: total, finalizationReason: reason })
  expect(store.attempt?.finalizedAnswerSnapshot?.questionIds).toHaveLength(total)
  expect(store.attempt?.locks).toHaveLength(store.attempt?.batch.sections.length ?? 0)
  expect(store.attempt?.finalizedAnswerSnapshot?.answers).toEqual(store.attempt?.answers)
  return store
}
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
    document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}
async function checkAxe(page: Page) {
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(scan.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(node => node.target) }))).toEqual([])
}

test('actual Pages-prefix synthetic candidate consumes its exact bank over normal, adaptive, remainder and explicit restart', async ({ page, context }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 930 })
  expect((await page.goto(server.origin + '/'))?.status()).toBe(404)
  expect((await page.goto(server.url + 'unknown-page'))?.status()).toBe(404)
  expect(await page.evaluate(async () => ({
    local: localStorage.length, databases: (await indexedDB.databases()).length, serviceWorker: Boolean(navigator.serviceWorker?.controller),
  }))).toEqual({ local: 0, databases: 0, serviceWorker: false })
  const observedRequests: string[] = []
  page.on('request', request => observedRequests.push(request.url()))
  await open(page, true)
  expect(observedRequests.filter(path => scorer.test(path))).toHaveLength(0)
  const initial = await releaseStore(page)
  expect(initial.attempt?.batch.sections.map(section => section.questionIds.length)).toEqual([3, 3, 49, 4])
  expect(initial.attempt?.finalizedAnswerSnapshot ?? null).toBeNull()
  const initialCycle = initial.journey!.cycleId
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to exam content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(main(page)).toBeFocused()
  await press(startButton(page))
  await verifyActive(page, 'Case Study 1', 1, 3)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(timer(page)).toContainText('02:00')
  await press(question(page).getByRole('button', { name: 'Next', exact: true }))
  await verifyActive(page, 'Case Study 1', 2, 3)
  await choose(page)
  await press(mark(page), 'Space')
  await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
  await saved(page)
  const inProgress = (await releaseStore(page)).attempt!
  await page.clock.fastForward(20_000)
  await page.reload()
  await verifyActive(page, 'Case Study 1', 2, 3)
  await saved(page)
  await expect(alpha(page)).toBeChecked()
  await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(timer(page)).toContainText('01:40')
  expect((await releaseStore(page)).attempt?.expiresAt).toBe(inProgress.expiresAt)

  await keyboardFinish(page)
  await verifyActive(page, 'Case Study 2', 1, 3)
  await choose(page)
  await keyboardFinish(page)
  await verifyActive(page, 'Standard Questions', 1, 49)
  await choose(page)
  await press(mark(page), 'Space')
  await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
  await saved(page)
  await keyboardFinish(page)
  await verifyActive(page, 'Final Interactive Questions', 1, 4)
  const north = question(page).getByRole('combobox', { name: 'North destination', exact: true })
  const south = question(page).getByRole('combobox', { name: 'South destination', exact: true })
  await press(north, 'Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(north).toHaveValue('sample-option-b')
  await press(south, 'Home')
  await page.keyboard.press('ArrowDown')
  await expect(south).toHaveValue('sample-option-a')
  await saved(page)
  expect(observedRequests.filter(path => scorer.test(path))).toHaveLength(0)
  await manual(page)
  const first = await scored(page, 59, 'MANUAL_SUBMISSION')
  expect(first.attempt?.result?.rawScore).toBe(4)
  await expect(cycleRegion(page)).toContainText('Continue this cycle')
  await expect(cycleRegion(page)).toContainText('82')
  await page.reload()
  expect((await scored(page, 59, 'MANUAL_SUBMISSION')).attempt?.result).toEqual(first.attempt?.result)
  await press(cycleRegion(page).getByRole('button', { name: 'Next exam', exact: true }))
  await expect(startButton(page)).toBeEnabled()
  const secondDraft = await releaseStore(page)
  expect(secondDraft.journey?.cycleId).toBe(initialCycle)
  expect(secondDraft.journey?.attemptId).not.toBe(first.journey?.attemptId)
  expect(secondDraft.attempt?.batch).toMatchObject({ batchMode: 'ADAPTIVE' })
  expect(secondDraft.attempt?.batch.sections.map(section => section.questionIds.length)).toEqual([59])
  await press(startButton(page))
  await verifyActive(page, 'Standard Questions', 1, 59)
  await choose(page)
  const deadline = (await releaseStore(page)).attempt?.expiresAt
  expect(deadline).toBeGreaterThan(epoch)
  await page.clock.setSystemTime(deadline!)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const second = await scored(page, 59, 'TIME_EXPIRED')
  expect(second.attempt?.result?.rawScore).toBe(1)
  await expect(cycleRegion(page)).toContainText('23')
  await press(cycleRegion(page).getByRole('button', { name: 'Next exam', exact: true }))
  await expect(startButton(page)).toBeEnabled()
  await expect(title(page, 'Final Examination Batch')).toBeVisible()
  const finalDraft = await releaseStore(page)
  expect(finalDraft.attempt?.batch).toMatchObject({ batchMode: 'FINAL_REMAINDER' })
  await press(startButton(page))
  await verifyActive(page, 'Standard Questions', 1, 23)
  await choose(page)
  await manual(page)
  const third = await scored(page, 23, 'MANUAL_SUBMISSION')
  expect(third.attempt?.result?.rawScore).toBe(1)
  await expect(cycleRegion(page).getByRole('heading', { name: 'Cycle complete' })).toBeVisible()
  await expect(cycleRegion(page).getByRole('button', { name: 'Next exam' })).toHaveCount(0)
  const history = activeExamCycle(third.lifecycle!)
  expect(history.status).toBe('COMPLETE')
  expect(history.reservedSourceIds).toHaveLength(0)
  expect(history.batches.map(row => row.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED'])
  expect(history.batches.map(({ batch }) => batch.actualQuestionCount)).toEqual([59, 59, 23])
  expect(history.batches.map(({ batch }) => batch.batchMode)).toEqual(['NORMAL', 'ADAPTIVE', 'FINAL_REMAINDER'])
  const played = history.batches.flatMap(({ batch }) => batch.sourceIds)
  expect(played).toHaveLength(expectedEligible.length)
  expect(new Set(played).size).toBe(expectedEligible.length)
  expect(played.toSorted()).toEqual(expectedEligible)
  expect(history.consumedSourceIds.toSorted()).toEqual(expectedEligible)

  const passive = await context.newPage()
  await passive.clock.install({ time: deadline! })
  await passive.goto(server.url + '#/question')
  await expect(title(passive, 'Exam complete')).toBeVisible()
  await expect(question(passive)).toHaveCount(0)
  expect((await releaseStore(passive)).journey?.attemptId).toBe(third.journey?.attemptId)
  await passive.close()
  await page.clock.resume()
  await checkAxe(page)
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 950 })
    await expect(cycleRegion(page)).toBeVisible()
    await noOverflow(page)
  }
  await page.setViewportSize({ width: 768, height: 950 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await noOverflow(page)
  await page.evaluate(() => { document.documentElement.style.zoom = '' })
  const restart = cycleRegion(page).getByRole('button', { name: 'Start new cycle', exact: true })
  await press(restart)
  const confirmation = page.getByRole('dialog', { name: 'Start a new cycle?', exact: true })
  await expect(confirmation.getByRole('button', { name: 'Keep result', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeHidden()
  expect((await releaseStore(page)).journey?.cycleId).toBe(initialCycle)
  await press(restart)
  await press(confirmation.getByRole('button', { name: 'Start new cycle', exact: true }))
  await expect(startButton(page)).toBeEnabled()
  const restarted = await releaseStore(page)
  expect(restarted.journey?.cycleId).not.toBe(initialCycle)
  expect(restarted.attempt?.status).toMatch(/CREATED|READY/)
  expect(restarted.attemptKeys).toHaveLength(third.attemptKeys.length + 1)
  expect(activeExamCycle(restarted.lifecycle!).consumedSourceIds).toEqual([])
  expect(observedRequests.every(url => new URL(url).origin === server.origin && new URL(url).pathname.startsWith(releaseBase))).toBe(true)
})

for (const corruption of ['missing-attempt', 'section', 'missing-batch', 'old-bank', 'missing-cycle'] satisfies readonly Corruption[]) {
  test('actual release recovery refuses to fabricate a replacement after ' + corruption, async ({ page }) => {
    await open(page)
    await start(page)
    await releaseStore(page, corruption)
    const broken = await releaseStore(page)
    await page.reload()
    await expect(main(page)).toBeVisible()
    await expect(startButton(page)).toHaveCount(0)
    await expect(question(page)).toHaveCount(0)
    await expect(result(page)).toHaveCount(0)
    await expect(main(page)).toContainText(/recover|could not|unavailable|couldn’t|cannot|unable/i)
    const persisted = await releaseStore(page)
    expect(persisted.journey).toEqual(broken.journey)
    expect(persisted.attemptKeys).toEqual(broken.attemptKeys)
    expect(persisted.attempt?.revision).toEqual(broken.attempt?.revision)
  })
}

test('corrupted question cursor recovers to the immutable saved position without reopening old sections', async ({ page }) => {
  await open(page)
  await start(page)
  await finish(page)
  await verifyActive(page, 'Case Study 2', 1, 3)
  await choose(page)
  const before = await releaseStore(page, 'cursor')
  await page.reload()
  await verifyActive(page, 'Case Study 2', 1, 3)
  await expect(alpha(page)).toBeChecked()
  const after = await releaseStore(page)
  expect(after.attempt?.answers).toEqual(before.attempt?.answers)
  expect(after.attempt?.position).toBe(before.attempt?.position)
  expect(after.attempt?.locks).toEqual(before.attempt?.locks)
})

test('stale second tab cannot edit or advance a live result; leaving and returning preserves the writer', async ({ page, context }) => {
  await open(page)
  await start(page)
  await choose(page)
  const first = await releaseStore(page)
  const passive = await context.newPage()
  await passive.goto(server.url)
  await expect(passive.getByRole('banner').getByRole('status').filter({ hasText: 'Read-only in this tab' })).toBeVisible()
  await expect(alpha(passive)).toBeDisabled()
  await expect(passive.getByRole('button', { name: 'End exam' })).toBeDisabled()
  expect((await releaseStore(passive)).attempt?.revision).toBe(first.attempt?.revision)
  await manual(page)
  await scored(page, 59, 'MANUAL_SUBMISSION')
  await passive.reload()
  await expect(title(passive, 'Exam complete')).toBeVisible()
  const next = cycleRegion(passive).getByRole('button', { name: 'Next exam', exact: true })
  await expect(next).toBeDisabled()
  expect((await releaseStore(passive)).journey?.attemptId).toBe(first.journey?.attemptId)
  await expect(cycleRegion(page).getByRole('button', { name: 'Next exam', exact: true })).toBeEnabled()
})

test('a fault during Next exam rolls back incomplete linked writes rather than replacing the scored exam', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (this.name === 'journeys' && sessionStorage.getItem('qa-release-next-fault') === 'armed') {
        sessionStorage.setItem('qa-release-next-fault', 'raised')
        throw new DOMException('Synthetic next-exam transaction quota fault', 'QuotaExceededError')
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    }
  })
  await open(page)
  await start(page)
  await manual(page)
  const before = await scored(page, 59, 'MANUAL_SUBMISSION')
  await page.evaluate(() => sessionStorage.setItem('qa-release-next-fault', 'armed'))
  const next = cycleRegion(page).getByRole('button', { name: 'Next exam', exact: true })
  await next.click()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('qa-release-next-fault'))).toBe('raised')
  await expect(next).toBeEnabled()
  await expect(title(page, 'Exam complete')).toBeVisible()
  const failed = await releaseStore(page)
  expect(failed.journey).toEqual(before.journey)
  expect(failed.lifecycle).toEqual(before.lifecycle)
  expect(failed.attempt).toEqual(before.attempt)
  expect(failed.attemptKeys).toEqual(before.attemptKeys)
  await next.click()
  await expect(startButton(page)).toBeEnabled()
  const recovered = await releaseStore(page)
  expect(recovered.journey?.attemptId).not.toBe(before.journey?.attemptId)
  expect(recovered.attemptKeys).toHaveLength(before.attemptKeys.length + 1)
})

test('fresh persistent browser process resumes past the original deadline and scores without an editable flash', async () => {
  test.setTimeout(45_000)
  const profile = await mkdtemp(join(tmpdir(), 'qa-release-browser-profile-'))
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  let context = await chromium.launchPersistentContext(profile, { executablePath })
  try {
    const writer = context.pages()[0] ?? await context.newPage()
    await open(writer, true)
    await start(writer)
    await choose(writer)
    const old = (await releaseStore(writer)).attempt!
    expect(old.expiresAt).toBeGreaterThan(epoch)
    await context.close()
    context = await chromium.launchPersistentContext(profile, { executablePath })
    const resumed = context.pages()[0] ?? await context.newPage()
    await resumed.clock.install({ time: old.expiresAt! + 15_000 })
    await resumed.addInitScript(() => {
      const control = window as Window & { __qaEditableAfterTimeout?: boolean }
      new MutationObserver(() => {
        const response = document.querySelector('[aria-label="Question and response"]')
        if (response?.querySelector('input[type="radio"]:enabled, input[type="checkbox"]:enabled, select:enabled')) control.__qaEditableAfterTimeout = true
      }).observe(document, { subtree: true, childList: true, attributes: true })
    })
    await resumed.goto(server.url + '#/question')
    const result = await scored(resumed, 59, 'TIME_EXPIRED')
    expect(result.attempt?.expiresAt).toBe(old.expiresAt)
    expect(result.attempt?.result?.rawScore).toBe(1)
    expect(await resumed.evaluate(() => (window as Window & { __qaEditableAfterTimeout?: boolean }).__qaEditableAfterTimeout)).not.toBe(true)
  } finally {
    await context.close().catch(() => undefined)
    await rm(profile, { recursive: true, force: true })
  }
})
