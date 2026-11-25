import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const mount = '/Cyber-SC-100/'

async function openFoundation(page: Page) {
  const res = await page.goto(mount)
  expect(res?.status()).toBe(200)
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('banner').getByText('Examination Hub', { exact: true })).toBeVisible()
}

async function startPractice(page: Page) {
  await openFoundation(page)
  await page.getByRole('button', { name: 'Start exam' }).click()
  await expect(page.getByRole('region', { name: 'Question and response' })).toBeVisible()
}

async function openNavigator(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Current section questions' })
  if (!await nav.isVisible()) await page.getByText('Question navigator', { exact: true }).click()
  await expect(nav).toBeVisible()
  return nav
}

async function openOutline(page: Page) {
  const sections = page.getByRole('list', { name: 'Exam sections' })
  if (!await sections.isVisible()) await page.getByText('Exam sections and locks', { exact: true }).click()
  await expect(sections).toBeVisible()
  return sections
}

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const { documentElement, body } = document
    return Math.max(documentElement.scrollWidth, body.scrollWidth) - documentElement.clientWidth
  })).toBeLessThanOrEqual(1)
}

for (const width of [320, 375, 390, 768, 1024, 1440]) {
  test(`responsive built shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 780 : 900 })
    await startPractice(page)
    await expectNoPageOverflow(page)
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
    for (let i = 0; i < 2; i += 1) {
      await page.getByRole('button', { name: 'Review section', exact: true }).click()
      await page.getByRole('button', { name: 'Finish case study', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Submit case study', exact: true }).click()
    }
    const region = page.getByRole('region', { name: 'Question and response' })
    await expect(region.getByText('Question 1 of 49', { exact: true })).toBeVisible()
    await openNavigator(page)
    await expectNoPageOverflow(page)
    await page.getByRole('button', { name: 'Review section', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Active section review' })).toBeVisible()
    await expectNoPageOverflow(page)
    const screenshot = process.env.PLAYWRIGHT_SYNTHETIC_SCREENSHOT_PATH
    if (width === 1440 && screenshot) {
      await mkdir(dirname(screenshot), { recursive: true })
      await page.screenshot({ path: screenshot, fullPage: true })
    }
  })
}

test('built assets load at Pages prefix without server fallback or runtime APIs', async ({ page, request }) => {
  expect((await request.get('/')).status()).toBe(404)
  expect((await request.get(mount + 'missing-client-route')).status()).toBe(404)
  const errors: string[] = []
  const assets = new Set<string>()
  const requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', req => requests.push(req.url()))
  page.on('requestfailed', req => errors.push(req.url()))
  page.on('response', res => {
    if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`)
    const pathname = new URL(res.url()).pathname
    if (/\.(js|css)$/.test(pathname)) assets.add(pathname)
  })
  await openFoundation(page)
  await page.reload()
  await expect(page.getByRole('main')).toBeVisible()
  expect([...assets].some(path => path.endsWith('.js'))).toBe(true)
  expect([...assets].some(path => path.endsWith('.css'))).toBe(true)
  expect([...assets].every(path => path.startsWith(mount))).toBe(true)
  expect(requests).not.toHaveLength(0)
  const expectedOrigin = new URL(page.url()).origin
  expect(requests.every(requestUrl => {
    const url = new URL(requestUrl)
    return url.origin === expectedOrigin && url.pathname.startsWith(mount)
  })).toBe(true)
  expect(errors).toEqual([])
})

async function expectNoAxeViolations(page: Page) {
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(scan.violations.map(({ id, nodes }) => ({
    id,
    nodes: nodes.map(node => node.target),
  }))).toEqual([])
}

test('active shell passes a WCAG-tagged automated axe scan', async ({ page }) => {
  await startPractice(page)
  await expectNoAxeViolations(page)
})

test('keyboard skip link, question navigation and lock dialog preserve focus', async ({ page }) => {
  await openFoundation(page)
  const skip = page.getByRole('link', { name: 'Skip to exam content' })
  await page.keyboard.press('Tab')
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()

  const start = page.getByRole('button', { name: 'Start exam' })
  await expect(start).toBeEnabled()
  await start.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Question and response' })).toBeVisible()
  const questionHeading = page.getByRole('main').getByRole('heading', { level: 1 })
  await expect(questionHeading).toBeFocused()
  const next = page.getByRole('button', { name: 'Next', exact: true })
  await next.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Question and response' }).getByText('Question 2 of 3')).toBeVisible()
  await expect(questionHeading).toBeFocused()

  await page.getByRole('button', { name: 'Review section' }).click()
  const trigger = page.getByRole('button', { name: /^Finish (?:case study|section|interactive section)$/i })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Go back' })).toBeFocused()
  await expectNoAxeViolations(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Review section' })).toBeVisible()
})

test('active attempt UI and accessibility tree do not reveal answer keys', async ({ page }) => {
  await startPractice(page)
  const content = page.getByRole('region', { name: 'Question and response' })
  const noCorrectnessLabel = /\b(?:correct answer|answer key|solution|explanation)\b/i
  await expect(content).not.toContainText(noCorrectnessLabel)
  const candidateOption = content.locator('input[type="radio"], input[type="checkbox"]').first()
  await expect(candidateOption).toBeVisible()
  await candidateOption.click()
  await expect(candidateOption).toBeChecked()
  await expect(content).not.toContainText(noCorrectnessLabel)
  expect(await content.ariaSnapshot()).not.toMatch(noCorrectnessLabel)
  expect(await content.locator('[data-correct], [data-answer-key], [data-correct-answer]').count()).toBe(0)
  await page.getByRole('button', { name: 'Review section' }).click()
  const review = page.getByRole('region', { name: 'Active section review' })
  await expect(review).not.toContainText(noCorrectnessLabel)
  expect(await review.ariaSnapshot()).not.toMatch(noCorrectnessLabel)
})

test('exam shell reflows at an emulated 200% zoom', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 1100 })
  await startPractice(page)
  // CSS zoom exercises layout reflow in headless Chromium; this is not an OS or browser chrome zoom test.
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await expectNoPageOverflow(page)
  const controls = page.getByRole('region', { name: 'Question and response' })
  await expect(controls.getByRole('button', { name: 'Review section' })).toBeVisible()
  await controls.getByRole('button', { name: 'Review section' }).click()
  await expect(page.getByRole('heading', { name: 'Review section' })).toBeVisible()
  await expectNoPageOverflow(page)
})

test('a saved answer and review mark survive reload and the submitted section stays locked', async ({ page }) => {
  await startPractice(page)
  const response = page.getByRole('region', { name: 'Question and response' })
    .locator('input[type="radio"], input[type="checkbox"]').first()
  await response.click()
  await expect(response).toBeChecked()
  await page.getByRole('button', { name: 'Mark for review', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Marked for review', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('banner').getByRole('status')).toContainText(/saved/i)

  await page.reload()
  await expect(page.getByRole('region', { name: 'Question and response' })).toBeVisible()
  await expect(response).toBeChecked()
  await expect(page.getByRole('button', { name: 'Marked for review', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Review section' }).click()
  await page.getByRole('button', { name: /^Finish (?:case study|section|interactive section)$/i }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Submit (?:case study|section)$/i }).click()
  const sections = await openOutline(page)
  await expect(sections.getByRole('listitem').nth(0)).toContainText(/locked/i)
  await expect(sections.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('banner').getByRole('status')).toContainText(/saved/i)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Question and response' })).toBeVisible()
  await openOutline(page)
  await expect(sections.getByRole('listitem').nth(0)).toContainText(/locked/i)
  await expect(sections.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
})

test('a separate tab with an active writer is visibly read-only', async ({ page, context }) => {
  await startPractice(page)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Saved on this device')
  const second = await context.newPage()
  await openFoundation(second)
  await expect(second.getByRole('banner').getByRole('status')).toHaveText('Read-only in this tab')
  await expect(second.getByLabel('Sample option A', { exact: true })).toBeDisabled()
  await expect(second.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Sample option A', { exact: true })).toBeEnabled()
  await second.close()
})

test('unavailable IndexedDB is visible and does not silently start a session', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined })
  })
  await openFoundation(page)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Local storage unavailable')
  await expect(page.getByRole('button', { name: 'Start exam' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reload exam' })).toBeEnabled()
})

test('all four locks lead to a separate final submission, with native accessible interactive controls', async ({ page }) => {
  await startPractice(page)
  const sections = page.getByRole('list', { name: 'Exam sections' })
  const lockCurrent = async () => {
    await page.getByRole('button', { name: 'Review section' }).click()
    await page.getByRole('button', { name: /^Finish (?:case study|section|interactive section)$/i }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Submit (?:case study|section)$/i }).click()
  }
  for (let section = 0; section < 3; section += 1) {
    await openOutline(page)
    await expect(sections.getByRole('listitem').nth(section)).toHaveAttribute('aria-current', 'step')
    await lockCurrent()
    await openOutline(page)
    await expect(sections.getByRole('listitem').nth(section)).toContainText('Locked')
    await expect(sections.getByRole('listitem').nth(section + 1)).toHaveAttribute('aria-current', 'step')
    await expect(page.getByRole('region', { name: 'Question and response' })).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: 'Choose sample values' })).toBeVisible()
  const first = page.getByRole('combobox', { name: 'First field' })
  const second = page.getByRole('combobox', { name: 'Second field' })
  const question = page.getByRole('region', { name: 'Question and response' })
  await question.evaluate(node => {
    const fields = node.querySelectorAll('select')
    if (fields.length !== 2) throw new Error('Expected two practice dropdown targets')
    // Issue both native changes in one browser task, before either local save completes.
    fields[0].value = 'a'
    fields[0].dispatchEvent(new Event('change', { bubbles: true }))
    fields[1].value = 'b'
    fields[1].dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(first).toHaveValue('a')
  await expect(second).toHaveValue('b')
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Saved on this device')
  await page.reload()
  await expect(first).toHaveValue('a')
  await expect(second).toHaveValue('b')
  await openNavigator(page)
  await page.getByRole('navigation', { name: 'Current section questions' }).getByRole('button', { name: /^Question 3\b/ }).click()
  await expect(page.getByRole('heading', { name: 'Match sample items' })).toBeVisible()
  await expect(page.getByText(/no dragging is required/i)).toBeVisible()
  await first.selectOption('b')
  await expect(first).toHaveValue('b')
  await lockCurrent()
  await expect(page.getByRole('heading', { name: 'Final submission' })).toBeVisible()
  await expect(sections.getByRole('listitem').filter({ hasText: 'Locked' })).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'Question and response' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Submit exam' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Submit exam' }).click()
  await expect(page.getByRole('heading', { name: 'Exam submitted' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Exam submitted' })).toBeVisible()
})

test('a corrupted local snapshot fails closed without replacing saved data', async ({ page }) => {
  await startPractice(page)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Saved on this device')
  const accessLocalSnapshot = (replace: boolean) => page.evaluate((corrupt) => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open('examination-hub:Cyber-SC-100:foundation')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction('attempts', corrupt ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('attempts')
      const read = store.get('synthetic-foundation-attempt')
      let savedPosition: unknown
      read.onsuccess = () => {
        if (!read.result?.attempt) {
          transaction.abort()
          return
        }
        savedPosition = corrupt ? -1 : read.result.attempt.position
        if (corrupt) store.put({ ...read.result, attempt: { ...read.result.attempt, position: -1 } })
      }
      transaction.oncomplete = () => { db.close(); resolve(savedPosition) }
      transaction.onabort = () => { db.close(); reject(new Error('Synthetic fixture record was unavailable')) }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
    }
  }), replace)
  expect(await accessLocalSnapshot(true)).toBe(-1)
  await page.reload()
  await expect(page.getByText(/could not be validated. Nothing was reset/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start exam' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reload exam' })).toBeEnabled()
  expect(await accessLocalSnapshot(false)).toBe(-1)
})

for (const recovery of ['Retry save', 'Discard unsaved change'] as const) {
  test(`a failed answer save blocks next and section review until ${recovery}`, async ({ page }) => {
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put
      let faultPending = true
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
        const row = value as { attempt?: { answers?: Record<string, unknown> } } | undefined
        if (faultPending && this.name === 'attempts' && Object.keys(row?.attempt?.answers ?? {}).length > 0) {
          faultPending = false
          throw new DOMException('Synthetic quota fault', 'QuotaExceededError')
        }
        return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
      }
    })
    await startPractice(page)
    const radio = page.getByLabel('Sample option A', { exact: true })
    await radio.click()
    const retry = page.getByRole('button', { name: 'Retry save', exact: true })
    const discard = page.getByRole('button', { name: 'Discard unsaved change', exact: true })
    await expect(retry).toBeEnabled()
    await expect(discard).toBeEnabled()
    const next = page.getByRole('button', { name: 'Next', exact: true })
    const review = page.getByRole('button', { name: 'Review section', exact: true })
    await expect(next).toBeDisabled()
    await expect(review).toBeDisabled()
    await expect(page.getByRole('button', { name: /^Finish (?:case study|section|interactive section)$/i })).toHaveCount(0)

    await (recovery === 'Retry save' ? retry : discard).click()
    await expect(retry).toHaveCount(0)
    await expect(discard).toHaveCount(0)
    await expect(next).toBeEnabled()
    await expect(review).toBeEnabled()
    if (recovery === 'Retry save') {
      await expect(radio).toBeChecked()
    } else {
      await expect(radio).not.toBeChecked()
    }
    await review.click()
    await expect(page.getByRole('button', { name: /^Finish (?:case study|section|interactive section)$/i })).toBeEnabled()
  })
}
