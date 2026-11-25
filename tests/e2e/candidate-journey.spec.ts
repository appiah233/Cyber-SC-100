import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const mount = '/Cyber-SC-100/'
const finishName = /^Finish (?:case study|section|interactive section)$/i
const submitName = /^Submit (?:case study|section)$/i
const correctness = /\b(?:correct answer|incorrect answer|expected answer|answer key|explanation|pass\/fail|your score)\b/i
const sections = ['Case Study 1', 'Case Study 2', 'Standard Questions', 'Interactive Questions'] as const
const sectionSizes = [3, 3, 49, 4] as const
const content = (page: Page) => page.getByRole('region', { name: 'Question and response' })
const review = (page: Page) => page.getByRole('region', { name: 'Active section review' })
const progress = (page: Page) => page.getByRole('list', { name: 'Exam sections' })
const status = (page: Page) => page.getByRole('banner').getByRole('status')
const nav = (page: Page) => page.getByRole('navigation', { name: 'Current section questions' })
const questionButton = (page: Page, number: number) => nav(page).getByRole('button', { name: new RegExp('^Question ' + number + '\\b') })
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true })
const previous = (page: Page) => page.getByRole('button', { name: 'Previous', exact: true })
const reviewButton = (page: Page) => page.getByRole('button', { name: 'Review section', exact: true })
const mark = (page: Page) => page.getByRole('button', { name: 'Mark for review', exact: true })
const marked = (page: Page) => page.getByRole('button', { name: 'Marked for review', exact: true })
const option = (page: Page, letter: 'A' | 'B' | 'C') => {
  const name = 'Sample option ' + letter
  return content(page).getByRole('radio', { name }).or(content(page).getByRole('checkbox', { name }))
}
const field = (page: Page, name: 'First field' | 'Second field') => content(page).getByRole('combobox', { name })

async function screenshot(page: Page, file: string) {
  const target = process.env.PLAYWRIGHT_SYNTHETIC_SCREENSHOTS_DIR
  if (!target) return
  if (!isAbsolute(target) || !relative(process.cwd(), resolve(target)).startsWith('..' + '/')) {
    throw new Error('Synthetic screenshot directory must be outside the repository')
  }
  await mkdir(target, { recursive: true })
  if (!relative(await realpath(process.cwd()), await realpath(target)).startsWith('..' + '/')) {
    throw new Error('Synthetic screenshots may not resolve inside the repository')
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  const path = join(target, file + '.png')
  if (file === '06-standard-navigator') {
    await page.locator('details').filter({ has: nav(page) }).screenshot({ path, animations: 'disabled' })
  } else {
    await page.screenshot({ path, fullPage: file !== '07-standard-review', animations: 'disabled' })
  }
}

async function saved(page: Page) {
  await expect(status(page)).toHaveText('Saved on this device')
}
async function open(page: Page) {
  const response = await page.goto(mount)
  expect(response?.status()).toBe(200)
  await saved(page)
}
async function start(page: Page) {
  await open(page)
  await page.getByRole('button', { name: 'Start exam', exact: true }).click()
  await active(page, 0, 1)
}
async function active(page: Page, index: number, pos = 1) {
  await expect(content(page).getByText(new RegExp('Question ' + pos + ' of ' + sectionSizes[index] + '\\b', 'i'))).toBeVisible()
  await openOutline(page)
  const li = progress(page).getByRole('listitem')
  await expect(li.nth(index)).toContainText(sections[index])
  await expect(li.nth(index)).toHaveAttribute('aria-current', 'step')
  for (let i = 0; i < index; i += 1) {
    await expect(li.nth(i)).toContainText(/locked|submitted/i)
    await expect(li.nth(i).getByRole('button')).toHaveCount(0)
    await expect(li.nth(i).getByRole('link')).toHaveCount(0)
  }
  await saved(page)
}
async function openOutline(page: Page) {
  if (!await progress(page).isVisible()) await page.getByText('Exam sections and locks', { exact: true }).click()
  await expect(progress(page)).toBeVisible()
}
async function openNav(page: Page) {
  if (!await nav(page).isVisible()) await page.getByText('Question navigator', { exact: true }).click()
  await expect(nav(page)).toBeVisible()
}
async function jump(page: Page, number: number) {
  await openNav(page)
  await questionButton(page, number).click()
}
async function changeChoice(page: Page, letter: 'A' | 'B' | 'C') {
  await option(page, letter).click()
  await expect(option(page, letter)).toBeChecked()
  await saved(page)
}
async function answerCaseChoice(page: Page, letter: 'A' | 'B' | 'C') {
  await changeChoice(page, letter)
  if (await content(page).getByRole('checkbox').count()) {
    await changeChoice(page, letter === 'A' ? 'C' : 'A')
  }
}
async function openReview(page: Page) {
  await reviewButton(page).click()
  await expect(review(page)).toBeVisible()
}
async function confirmSection(page: Page) {
  await page.getByRole('button', { name: finishName }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}
async function finish(page: Page) {
  await openReview(page)
  const dialog = await confirmSection(page)
  await dialog.getByRole('button', { name: submitName }).click()
  await expect(dialog).toBeHidden()
  await saved(page)
}
async function reload(page: Page) {
  await page.reload()
  await saved(page)
}
async function noLeak(page: Page) {
  const main = page.getByRole('main')
  await expect(main).not.toContainText(correctness)
  expect(await main.ariaSnapshot()).not.toMatch(correctness)
  await expect(main.locator('[data-correct], [data-answer-key], [data-correct-answer]')).toHaveCount(0)
}
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(
    document.body.scrollWidth, document.documentElement.scrollWidth,
  ) - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}
async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(node => node.target) }))).toEqual([])
}

test('candidate completes actual 59-question entry, six persistence checkpoints and every irreversible boundary', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await open(page)
  const startExam = page.getByRole('button', { name: 'Start exam', exact: true })
  await expect(startExam).toBeEnabled()
  const intro = page.getByRole('main')
  await expect(intro).toContainText(/Synthetic practice content/i)
  await expect(page.getByRole('timer')).toHaveCount(0)
  await expect(intro).toContainText(/59\s+questions/i)
  await expect(intro).toContainText(/cannot be reopened/i)
  for (let i = 0; i < sections.length; i += 1) {
    await expect(intro).toContainText(sections[i])
    await expect(intro).toContainText(new RegExp(sectionSizes[i] + '\\s+questions', 'i'))
  }
  await expect(content(page)).toHaveCount(0)
  await reload(page)
  await expect(startExam).toBeEnabled()
  await screenshot(page, '01-exam-start')
  await axe(page)
  await startExam.click()

  for (let i = 0; i < 2; i += 1) {
    await active(page, i)
    await expect(previous(page)).toBeDisabled()
    const scenario = page.getByText('Case study context', { exact: true })
    await expect(scenario).toBeVisible()
    const scenarioDetails = page.locator('details').filter({ has: scenario })
    if (!await scenarioDetails.evaluate(node => (node as HTMLDetailsElement).open)) {
      await scenario.click()
    }
    await expect(scenarioDetails.getByRole('heading').first()).toBeVisible()
    await screenshot(page, i === 0 ? '02-case-study-1' : '04-case-study-2')
    await answerCaseChoice(page, 'A')
    await next(page).click()
    await active(page, i, 2)
    await expect(scenario).toBeVisible()
    await answerCaseChoice(page, 'B')
    await mark(page).click()
    await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
    await saved(page)
    await reload(page)
    await active(page, i, 2)
    await expect(option(page, 'B')).toBeChecked()
    await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
    await previous(page).click()
    await active(page, i, 1)
    await expect(option(page, 'A')).toBeChecked()
    await jump(page, 3)
    await active(page, i, 3)
    await expect(scenario).toBeVisible()
    await answerCaseChoice(page, 'C')
    await openReview(page)
    const dialog = await confirmSection(page)
    await expect(dialog).toContainText(/cannot return|cannot reopen/i)
    const safe = dialog.getByRole('button', { name: 'Go back' })
    await expect(safe).toBeFocused()
    if (i === 0) {
      await screenshot(page, '03-submission-warning')
      await page.mouse.click(8, 8) // Native modal backdrop, not a deliberate submit action.
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible() // A backdrop click did not focus the irreversible action.
      await safe.focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()
      await expect(review(page)).toBeVisible()
      const reopened = await confirmSection(page)
      await expect(reopened).toBeVisible()
    }
    await dialog.getByRole('button', { name: submitName }).click()
    await active(page, i + 1)
  }

  await screenshot(page, '05-standard-question')
  await openNav(page)
  await expect(nav(page).getByRole('button')).toHaveCount(49)
  await expect(questionButton(page, 1)).toHaveAccessibleName(/current question.*unanswered|unanswered.*current question/i)
  await changeChoice(page, 'A')
  await changeChoice(page, 'B')
  await expect(questionButton(page, 1)).toHaveAccessibleName(/\banswered\b/i)
  await mark(page).click()
  await expect(questionButton(page, 1)).toHaveAccessibleName(/marked/i)
  await jump(page, 25)
  await active(page, 2, 25)
  await changeChoice(page, 'A')
  await expect(questionButton(page, 1)).toHaveAccessibleName(/answered.*marked/i)
  await expect(questionButton(page, 25)).toHaveAccessibleName(/answered.*current question/i)
  await expect(questionButton(page, 26)).toHaveAccessibleName(/unanswered/i)
  await screenshot(page, '06-standard-navigator')
  await reload(page)
  await active(page, 2, 25)
  await expect(option(page, 'A')).toBeChecked()
  await jump(page, 49)
  await active(page, 2, 49)
  await openReview(page)
  await expect(review(page)).toContainText('49')
  await expect(review(page)).toContainText('47')
  await screenshot(page, '07-standard-review')
  await axe(page)
  const filters = [
    ['All questions', 49], ['Unanswered', 47], ['Marked', 1],
  ] as const
  for (const [name, count] of filters) {
    await review(page).getByRole('button', { name, exact: true }).click()
    await expect(review(page).getByRole('button', { name: /^Open question \d+/i })).toHaveCount(count)
  }
  await review(page).getByRole('button', { name: /^Open question 1\b/i }).click()
  await active(page, 2, 1)
  await expect(option(page, 'B')).toBeChecked()
  await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
  for (let n = 2; n <= 48; n += 1) {
    await next(page).click()
    await active(page, 2, n)
    await changeChoice(page, 'A')
  }
  await openReview(page)
  await reload(page)
  await expect(review(page)).toBeVisible()
  await noLeak(page)
  const stdDialog = await confirmSection(page)
  await expect(stdDialog).toContainText(/1 unanswered(?: or incomplete)? question/i)
  await expect(stdDialog).toContainText(/cannot return|cannot reopen/i)
  await stdDialog.getByRole('button', { name: 'Submit section', exact: true }).click()
  await active(page, 3)
  await expect(previous(page)).toBeDisabled()

  await screenshot(page, '08-final-interactive-question')
  await axe(page)
  for (let n = 1; n <= 4; n += 1) {
    await active(page, 3, n)
    await expect(content(page).getByRole('combobox')).toHaveCount(2)
    await expect(content(page).getByRole('img')).toHaveCount(0)
    for (const label of ['First field', 'Second field'] as const) {
      const select = field(page, label)
      await select.focus()
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowDown')
      await expect(select).not.toHaveValue('')
      await saved(page)
    }
    if (n === 2) {
      await mark(page).click()
      await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
      await saved(page)
      const firstValue = await field(page, 'First field').inputValue()
      const secondValue = await field(page, 'Second field').inputValue()
      await reload(page)
      await active(page, 3, n)
      await expect(field(page, 'First field')).toHaveValue(firstValue)
      await expect(field(page, 'Second field')).toHaveValue(secondValue)
      await expect(marked(page)).toHaveAttribute('aria-pressed', 'true')
    }
    await noLeak(page)
    if (n < 4) await next(page).click()
  }
  await openReview(page)
  await expect(review(page).getByRole('button', { name: /^Open question \d+/i })).toHaveCount(4)
  const interactiveDialog = await confirmSection(page)
  await expect(interactiveDialog).toContainText(/cannot return|cannot reopen/i)
  await interactiveDialog.getByRole('button', { name: 'Submit section', exact: true }).click()
  const finalHeading = page.getByRole('heading', { name: 'Final submission', exact: true })
  await expect(finalHeading).toBeVisible()
  await expect(progress(page).getByRole('listitem').filter({ hasText: /locked|submitted/i })).toHaveCount(4)
  await expect(content(page)).toHaveCount(0)
  await expect(nav(page)).toHaveCount(0)
  await noLeak(page)
  await reload(page)
  await expect(finalHeading).toBeVisible()
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click()
  const finalDialog = page.getByRole('dialog', { name: 'End this exam?' })
  await expect(finalDialog.getByRole('button', { name: 'Return to exam' })).toBeFocused()
  await finalDialog.getByRole('button', { name: 'End and submit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Exam complete', exact: true })).toBeVisible()
  await reload(page)
  await expect(page.getByRole('heading', { name: 'Exam complete', exact: true })).toBeVisible()
  await noLeak(page)
})

const navigationProbes = [
  ['direct submitted case question', 'section=CASE_STUDY_1&question=2'],
  ['manipulated question index', 'section=STANDARD_BLOCK&question=9999'],
  ['unknown section identifier', 'section=not-an-exam-section&question=1'],
] as const
for (const [description, fragment] of navigationProbes) {
  test('negative navigation: ' + description + ' reconciles to the saved active question', async ({ page }) => {
    await start(page)
    await finish(page)
    await active(page, 1)
    await finish(page)
    await active(page, 2)
    await jump(page, 4)
    await active(page, 2, 4)
    await changeChoice(page, 'B')
    const path = mount + '?' + fragment + '#/question/' + fragment
    expect((await page.goto(path))?.status()).toBe(200)
    await active(page, 2, 4)
    await expect(page).toHaveURL(/#\/question$/)
    await expect(option(page, 'B')).toBeChecked()
    await noLeak(page)
  })
}

test('negative navigation: browser Back and refresh cannot reopen submitted standard or case questions', async ({ page }) => {
  await start(page)
  await finish(page)
  await active(page, 1)
  await finish(page)
  await active(page, 2)
  await jump(page, 49)
  await active(page, 2, 49)
  await page.goto(mount + '?section=STANDARD_BLOCK&question=49')
  await active(page, 2, 49)
  await finish(page)
  await active(page, 3)
  await jump(page, 3)
  await active(page, 3, 3)
  await page.goBack()
  await active(page, 3, 3)
  await reload(page)
  await active(page, 3, 3)
})

test('negative navigation: stale second tab is read-only with no competing exam or editable action', async ({ page, context }) => {
  await start(page)
  await changeChoice(page, 'B')
  const second = await context.newPage()
  expect((await second.goto(mount + '?section=CASE_STUDY_1&question=1'))?.status()).toBe(200)
  await expect(status(second)).toHaveText('Read-only in this tab')
  await expect(option(second, 'B')).toBeChecked()
  await expect(option(second, 'C')).toBeDisabled()
  await expect(mark(second)).toBeDisabled()
  await expect(next(second)).toBeDisabled()
  await expect(reviewButton(second)).toBeDisabled()
  await expect(second.getByRole('button', { name: 'Start exam', exact: true })).toHaveCount(0)
  await expect(second.getByRole('button', { name: finishName })).toHaveCount(0)
  await screenshot(second, '12-read-only-second-tab')
  await finish(page)
  await active(page, 1)
  await second.reload()
  await expect(status(second)).toHaveText('Read-only in this tab')
  await openOutline(second)
  await expect(progress(second).getByRole('listitem').first()).toContainText(/locked|submitted/i)
  await expect(progress(second).getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(previous(second)).toBeDisabled()
  await expect(reviewButton(second)).toBeDisabled()
  await expect(option(second, 'A')).toBeDisabled()
  await expect(option(page, 'A')).toBeEnabled()
})

test('save fault preserves committed answer, gates navigation and submission, and can retry', async ({ page, context }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const row = value as { attempt?: { answers?: Record<string, unknown> } } | undefined
      if (this.name === 'attempts' && sessionStorage.getItem('qa-save-fault-pending') === 'true' &&
        Object.keys(row?.attempt?.answers ?? {}).length > 0) {
        sessionStorage.removeItem('qa-save-fault-pending')
        throw new DOMException('Synthetic candidate QA quota fault', 'QuotaExceededError')
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    }
  })
  await start(page)
  await changeChoice(page, 'A')
  await page.evaluate(() => sessionStorage.setItem('qa-save-fault-pending', 'true'))
  await option(page, 'B').click()
  await expect(status(page)).toHaveText('Save failed')
  await expect(option(page, 'B')).toBeChecked()
  const reader = await context.newPage()
  await reader.goto(mount)
  await expect(status(reader)).toHaveText('Read-only in this tab')
  await expect(option(reader, 'A')).toBeChecked()
  await expect(option(reader, 'B')).not.toBeChecked()
  await reader.close()
  await expect(next(page)).toBeDisabled()
  await expect(reviewButton(page)).toBeDisabled()
  await openNav(page)
  await expect(questionButton(page, 2)).toBeDisabled()
  await expect(page.getByRole('button', { name: finishName })).toHaveCount(0)
  const retry = page.getByRole('button', { name: 'Retry save' })
  await expect(retry).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Discard unsaved change' })).toBeEnabled()
  await screenshot(page, '11-save-failure')
  await retry.click()
  await expect(option(page, 'B')).toBeChecked()
  await saved(page)
  await reload(page)
  await active(page, 0)
  await expect(option(page, 'B')).toBeChecked()
})

test('mobile navigator works by keyboard, exposes status and keeps the page within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await start(page)
  await finish(page)
  await active(page, 1)
  await finish(page)
  await active(page, 2)
  await noOverflow(page)
  await screenshot(page, '09-mobile-question')
  const toggle = page.getByText('Question navigator', { exact: true })
  await expect(toggle).toBeVisible()
  await expect(nav(page)).toBeHidden()
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(nav(page)).toBeVisible()
  await expect(nav(page).getByRole('button')).toHaveCount(49)
  await expect(questionButton(page, 1)).toHaveAccessibleName(/current question/i)
  await expect(questionButton(page, 2)).toHaveAccessibleName(/unanswered/i)
  await noOverflow(page)
  await screenshot(page, '10-mobile-navigator')
  const q2 = questionButton(page, 2)
  await q2.focus()
  await expect(q2).toBeFocused()
  const size = await q2.boundingBox()
  expect(size?.width).toBeGreaterThanOrEqual(24)
  expect(size?.height).toBeGreaterThanOrEqual(24)
  await page.keyboard.press('Enter')
  await active(page, 2, 2)
  await changeChoice(page, 'A')
  await mark(page).click()
  await openNav(page)
  await expect(questionButton(page, 2)).toHaveAccessibleName(/marked/i)
  await noOverflow(page)
  await axe(page)
})

test('keyboard dialogs trap focus, allow safe cancellation, and tolerate reduced motion and forced colors', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  await start(page)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches &&
    matchMedia('(forced-colors: active)').matches)).toBe(true)
  await reviewButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(review(page)).toBeVisible()
  const trigger = page.getByRole('button', { name: finishName })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  const cancel = dialog.getByRole('button', { name: 'Go back' })
  const destructive = dialog.getByRole('button', { name: submitName })
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(destructive).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(review(page)).toBeVisible()
})

test('negative navigation: persisted currentQuestionId cannot point back into a submitted case', async ({ page }) => {
  await start(page)
  const access = (replacement?: string) => page.evaluate((value) => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('examination-hub:Cyber-SC-100:foundation')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('attempts', value === undefined ? 'readonly' : 'readwrite')
      const store = tx.objectStore('attempts')
      const request = store.get('synthetic-foundation-attempt')
      let priorId: string
      request.onsuccess = () => {
        const row = request.result as { attempt?: { currentQuestionId?: string } } | undefined
        const id = row?.attempt?.currentQuestionId
        if (!id) { tx.abort(); return }
        priorId = id
        if (value !== undefined) store.put({ ...row, attempt: { ...row?.attempt, currentQuestionId: value } })
      }
      tx.oncomplete = () => { db.close(); resolve(priorId) }
      tx.onabort = () => { db.close(); reject(new Error('No synthetic candidate cursor was available')) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }), replacement)
  const lockedId = await access()
  await finish(page)
  await active(page, 1)
  await jump(page, 2)
  await active(page, 1, 2)
  await changeChoice(page, 'B')
  const activeId = await access(lockedId)
  expect(activeId).not.toBe(lockedId)
  expect(await access()).toBe(lockedId)
  await reload(page)
  await active(page, 1, 2)
  await expect(option(page, 'B')).toBeChecked()
  await next(page).click()
  await active(page, 1, 3)
  expect(await access()).not.toBe(lockedId)
})
