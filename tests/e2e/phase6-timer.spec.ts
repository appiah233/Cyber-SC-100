import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { ExamAttempt } from '../../src/domain/model'
import { finish, main, openPhase6, question, readSnapshot, review, saved, saveStatus, servePhase6, start } from './phase6-harness'
import type { Phase6Profile, Phase6Server } from './phase6-harness'

const epoch = Date.UTC(2031, 0, 1, 12)
const duration = 4 * 60 * 1000
const timer = (page: Page) => page.getByRole('timer', { name: 'Time remaining' })
const ann = (page: Page) => page.getByRole('status', { name: 'Exam timer announcements' })
const end = (page: Page) => page.getByRole('button', { name: 'End exam', exact: true })
const submitDialog = (page: Page) => page.getByRole('dialog', { name: 'End this exam?' })
const alpha = (page: Page) => question(page).getByRole('radio', { name: 'Example Alpha', exact: true })
const beta = (page: Page) => question(page).getByRole('radio', { name: 'Example Beta', exact: true })
const noScore = /\b(?:correct answer|incorrect answer|expected answer|answer key|explanation|pass\/fail|your score|score percentage)\b/i
let server: Phase6Server
test.beforeAll(async () => { server = await servePhase6(['normal-timed', 'one-timed', 'adaptive-timed']) })
test.afterAll(async () => { await server?.close() })

async function clockAt(page: Page, at = epoch) {
  await page.clock.install({ time: at - 5_000 })
  await page.clock.pauseAt(at)
}
async function beginTimed(page: Page, profile: Phase6Profile = 'normal-timed') {
  await clockAt(page)
  await openPhase6(page, server, profile)
  await expect(timer(page)).toHaveCount(0)
  await start(page)
  const row = await readSnapshot<ExamAttempt>(page, profile)
  expect(row.startedAt).toBe(epoch)
  expect(row.expiresAt).toBe(epoch + duration)
  expect(row.finalizedAnswerSnapshot ?? null).toBeNull()
  expect(row.result).toBeNull()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(timer(page)).toContainText('04:00')
  await expect(timer(page)).toHaveAttribute('aria-live', 'off')
}
async function scoreIsAbsent(page: Page) {
  await expect(main(page)).not.toContainText(noScore)
  expect(await main(page).ariaSnapshot()).not.toMatch(noScore)
}
async function nextCaseStage(page: Page, blocks: number) {
  for (let i = 0; i < blocks; ++i) await finish(page)
}
async function submitted(page: Page, profile: Phase6Profile, reason: 'TIME_EXPIRED' | 'MANUAL_SUBMISSION', total: number) {
  await expect(main(page).getByRole('heading', { name: 'Exam submitted' })).toBeVisible()
  await expect(timer(page)).toHaveCount(0)
  await expect(question(page)).toHaveCount(0)
  await expect(review(page)).toHaveCount(0)
  await expect(end(page)).toHaveCount(0)
  await saved(page)
  await scoreIsAbsent(page)
  const row = await readSnapshot<ExamAttempt>(page, profile)
  expect(row).toMatchObject({
    status: 'SUBMITTED', activeSection: null, finalizationReason: reason, result: null,
    finalizedAnswerSnapshot: {
      attemptId: row.id, cycleId: row.cycleId, batchId: row.batch.id, contentVersion: row.contentVersion,
      reason, submittedAt: row.submittedAt, answers: row.answers,
    },
  })
  expect(row.finalizedAnswerSnapshot?.questionIds).toHaveLength(total)
  expect(new Set(row.finalizedAnswerSnapshot?.questionIds).size).toBe(total)
  expect(row.locks).toHaveLength(row.batch.sections.length)
  return row
}

test('manual End Exam can cancel safely and deliberately submit unanswered/marked normal items before any section lock', async ({ page }) => {
  await beginTimed(page)
  await alpha(page).click()
  await saved(page)
  await page.getByRole('button', { name: 'Mark for review', exact: true }).click()
  await saved(page)
  await scoreIsAbsent(page)
  await end(page).click()
  const dialog = submitDialog(page)
  await expect(dialog).toContainText('Unanswered or incomplete: 58')
  await expect(dialog).toContainText('Marked for review: 1')
  await expect(dialog).toContainText(/Time remaining:.*04:00/i)
  const cancel = dialog.getByRole('button', { name: 'Return to exam' })
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Escape')
  await page.clock.runFor(20)
  await expect(dialog).toBeHidden()
  await expect(end(page)).toBeFocused()
  await expect(alpha(page)).toBeChecked()
  const active = await readSnapshot<ExamAttempt>(page, 'normal-timed')
  expect(active.finalizedAnswerSnapshot ?? null).toBeNull()
  expect(active.result).toBeNull()
  await end(page).click()
  await dialog.getByRole('button', { name: 'End and submit' }).click()
  const final = await submitted(page, 'normal-timed', 'MANUAL_SUBMISSION', 59)
  expect(Object.keys(final.finalizedAnswerSnapshot?.answers ?? {})).toHaveLength(1)
  expect(final.reviewMarks).toEqual(active.reviewMarks)
  await page.reload()
  const again = await submitted(page, 'normal-timed', 'MANUAL_SUBMISSION', 59)
  expect(again).toEqual(final)
})

test('one exam-wide timer, persisted timestamp, and meaningful threshold announcements survive section changes and reload', async ({ page }) => {
  await beginTimed(page)
  await page.clock.fastForward(59_000)
  await expect(timer(page)).toContainText('03:01')
  await expect(ann(page)).toBeEmpty()
  await finish(page)
  await expect(timer(page)).toContainText('03:01')
  await page.reload()
  await saved(page)
  await expect(timer(page)).toContainText('03:01')
  const before = await readSnapshot<ExamAttempt>(page, 'normal-timed')
  expect([before.startedAt, before.expiresAt]).toEqual([epoch, epoch + duration])
  await page.clock.fastForward(61_000)
  await expect(timer(page)).toContainText('02:00')
  await expect(ann(page)).toHaveText('2 minutes remaining.')
  await page.clock.fastForward(1_000)
  await expect(ann(page)).toHaveText('2 minutes remaining.')
  await page.clock.fastForward(59_000)
  await expect(timer(page)).toContainText('01:00')
  await expect(ann(page)).toHaveText('1 minute remaining.')
  await scoreIsAbsent(page)
})

for (const [label, profile, total, block, duringReview] of [
  ['case study', 'normal-timed', 59, 0, false],
  ['standard block', 'normal-timed', 59, 2, false],
  ['interactive block', 'normal-timed', 59, 3, false],
  ['review screen', 'normal-timed', 59, 2, true],
  ['one-question final remainder', 'one-timed', 1, 0, false],
  ['standard-only adaptive batch', 'adaptive-timed', 59, 0, false],
] as const) {
  test('auto-submits at exact zero from ' + label, async ({ page }) => {
    await beginTimed(page, profile)
    await nextCaseStage(page, block)
    if (duringReview) {
      await page.getByRole('button', { name: 'Review section', exact: true }).click()
      await expect(review(page)).toBeVisible()
      await saved(page)
    }
    await scoreIsAbsent(page)
    await page.clock.fastForward(duration - 1)
    await expect(timer(page)).toContainText('00:01')
    expect((await readSnapshot<ExamAttempt>(page, profile)).finalizedAnswerSnapshot ?? null).toBeNull()
    await page.clock.runFor(1)
    // Polling may not have reached its next tick at the subsecond boundary;
    // a return-to-window event observes the same clock at exactly zero.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const final = await submitted(page, profile, 'TIME_EXPIRED', total)
    expect(final.submittedAt).toBe(epoch + duration)
    expect(final.answers).toEqual({})
    await expect(main(page)).toContainText(/Time expired/i)
    await page.reload()
    expect(await submitted(page, profile, 'TIME_EXPIRED', total)).toEqual(final)
  })
}

test('suspended/background clock jumps do not reopen the attempt or rely on missed timer ticks', async ({ page }) => {
  await beginTimed(page, 'normal-timed')
  await alpha(page).click()
  await saved(page)
  await page.clock.setSystemTime(epoch + duration + 17_000)
  // System-time jump without advancing pending JS intervals, then the real
  // visibility/pageshow listeners re-evaluate persisted expiresAt on resume.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  const final = await submitted(page, 'normal-timed', 'TIME_EXPIRED', 59)
  expect(Object.keys(final.answers)).toHaveLength(1)
})

test('browser-tab close/reopen past expiry never exposes an editable persisted answer', async ({ page, context }) => {
  await beginTimed(page, 'one-timed')
  await alpha(page).click()
  await saved(page)
  await page.close()
  const reopened = await context.newPage()
  await clockAt(reopened, epoch + duration + 20_000)
  await reopened.addInitScript(() => {
    type ProbeWindow = Window & { __qaEditorVisible?: boolean }
    const record = window as ProbeWindow
    const watch = new MutationObserver(() => {
      if (document.querySelector('input[type="radio"]:enabled, input[type="checkbox"]:enabled')) record.__qaEditorVisible = true
    })
    watch.observe(document, { subtree: true, childList: true, attributes: true })
  })
  await reopened.goto(server.url('one-timed') + '#/question')
  const final = await submitted(reopened, 'one-timed', 'TIME_EXPIRED', 1)
  expect(Object.keys(final.answers)).toHaveLength(1)
  expect(await reopened.evaluate(() => (window as Window & { __qaEditorVisible?: boolean }).__qaEditorVisible)).not.toBe(true)
})

test('response accepted before expiry survives a pending write failure in the atomic terminal snapshot', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const attempt = (value as { attempt?: { status?: string; answers?: Record<string, unknown> } })?.attempt
      if (this.name === 'attempts' && sessionStorage.getItem('qa-phase6-fail-next') === 'true'
        && attempt?.status !== 'SUBMITTED' && Object.keys(attempt?.answers ?? {}).length > 0) {
        sessionStorage.removeItem('qa-phase6-fail-next')
        throw new DOMException('Synthetic write fault at deadline', 'QuotaExceededError')
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  })
  await beginTimed(page, 'one-timed')
  await alpha(page).click()
  await saved(page)
  const durable = await readSnapshot<ExamAttempt>(page, 'one-timed')
  await page.evaluate(() => sessionStorage.setItem('qa-phase6-fail-next', 'true'))
  await beta(page).click()
  await expect(saveStatus(page)).toHaveText('Save failed')
  await expect(beta(page)).toBeChecked()
  expect((await readSnapshot<ExamAttempt>(page, 'one-timed')).answers).toEqual(durable.answers)
  await expect(end(page)).toBeDisabled()
  await page.clock.fastForward(duration)
  const final = await submitted(page, 'one-timed', 'TIME_EXPIRED', 1)
  expect(Object.values(final.finalizedAnswerSnapshot?.answers ?? {})).toEqual([{ kind: 'SINGLE_CHOICE', optionId: 'sample-option-b' }])
  expect(final.revision).toBe(durable.revision + 1)
})

test('manual End action race at the deadline makes one durable submission and never starts scoring', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const attempt = (value as { attempt?: { status?: string; expiresAt?: number } })?.attempt
      if (this.name === 'attempts' && attempt?.status === 'SUBMITTED' && attempt.expiresAt &&
        !sessionStorage.getItem('qa-phase6-terminal-race')) {
        sessionStorage.setItem('qa-phase6-terminal-race', 'true')
        const deadline = attempt.expiresAt
        const previous = Date.now
        Date.now = () => Math.max(deadline, previous())
        window.dispatchEvent(new Event('focus'))
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    }
  })
  await beginTimed(page, 'one-timed')
  const durable = await readSnapshot<ExamAttempt>(page, 'one-timed')
  await end(page).click()
  const confirm = submitDialog(page).getByRole('button', { name: 'End and submit' })
  await confirm.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click() })
  const final = await submitted(page, 'one-timed', 'MANUAL_SUBMISSION', 1)
  expect(final.revision).toBe(durable.revision + 1)
  await page.clock.fastForward(duration + 1000)
  await page.reload()
  expect(await submitted(page, 'one-timed', 'MANUAL_SUBMISSION', 1)).toEqual(final)
})
