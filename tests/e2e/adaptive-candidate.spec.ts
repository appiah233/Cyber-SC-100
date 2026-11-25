import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { build } from 'vite'

const fixtures = ['standard-59', 'standard-41', 'partial-23', 'single-1', 'special-only', 'multiple-families', 'normal-overlap'] as const
type Fixture = typeof fixtures[number]
const base = (fixture: Fixture) => '/Cyber-SC-100/adaptive-test/' + fixture + '/'
const data = new Map<string, string | Uint8Array>()
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
}
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const path = pathname.endsWith('/') ? pathname + 'index.html' : pathname
  const file = data.get(path)
  if (!file) { response.writeHead(404); response.end('Not found'); return }
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
  response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' })
  response.end(file)
})
let origin: string

test.beforeAll(async () => {
  for (const fixture of fixtures) {
    // Build the repository's actual index.html and main.tsx; only synthetic content is substituted.
    // Keep every test build in memory. CI neither serves nor captures protected content.
    const result = await build({
      base: base(fixture), logLevel: 'silent', build: { write: false },
      define: { __QA_ADAPTIVE_FIXTURE__: JSON.stringify(fixture) },
      resolve: { alias: [{ find: '../data/synthetic-preview', replacement: fileURLToPath(new URL('../fixtures/adaptive-browser-source.ts', import.meta.url)) }] },
    })
    if ('getOutput' in result || 'close' in result) throw new Error('Expected non-watching candidate build')
    const output = Array.isArray(result) ? result[0] : result
    for (const file of output.output) data.set(base(fixture) + file.fileName, file.type === 'chunk' ? file.code : file.source)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
})

test.afterAll(async () => {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

const main = (page: Page) => page.getByRole('main')
const question = (page: Page) => page.getByRole('region', { name: 'Question and response' })
const status = (page: Page) => page.getByRole('banner').getByRole('status')
const review = (page: Page) => page.getByRole('region', { name: 'Active section review' })
const outline = (page: Page) => page.getByRole('list', { name: 'Exam sections' })
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true })
const input = (page: Page) => question(page).getByRole('radio', { name: 'Example response B' })

async function saved(page: Page) {
  await expect(status(page)).toHaveText('Saved on this device')
}
async function open(page: Page, fixture: Fixture) {
  expect((await page.goto(origin + base(fixture)))?.status()).toBe(200)
  await saved(page)
}
async function start(page: Page) {
  await page.getByRole('button', { name: 'Start exam', exact: true }).click()
  await expect(question(page)).toBeVisible()
  await saved(page)
}
async function section(page: Page, label: string, position: number, count: number, total: number, overall = position) {
  await expect(page.getByRole('banner').getByText(label, { exact: true })).toBeVisible()
  await expect(question(page).getByText('Question ' + position + ' of ' + count, { exact: true })).toBeVisible()
  await expect(page.getByRole('banner')).toContainText('Exam position ' + overall + ' of ' + total)
  await saved(page)
}
async function expandOutline(page: Page) {
  if (!await outline(page).isVisible()) await page.getByText('Exam sections and locks', { exact: true }).click()
  await expect(outline(page)).toBeVisible()
}
async function finishSection(page: Page, finish: string, submit: string, stats: { total: number; unanswered?: number }) {
  await page.getByRole('button', { name: 'Review section', exact: true }).click()
  await expect(review(page).getByRole('button', { name: /^Open question \d+$/i })).toHaveCount(stats.total)
  const stat = (label: string) => review(page).locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
  await expect(stat('Total questions')).toHaveText(String(stats.total))
  if (stats.unanswered !== undefined) await expect(stat('Unanswered')).toHaveText(String(stats.unanswered))
  await review(page).getByRole('button', { name: finish, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/cannot return/i)
  await dialog.getByRole('button', { name: submit, exact: true }).click()
  await expect(dialog).toBeHidden()
  await saved(page)
}
async function final(page: Page, count: number) {
  await expect(main(page).getByRole('heading', { name: 'Final submission', exact: true })).toBeVisible()
  await expect(outline(page).getByRole('listitem').filter({ hasText: 'Locked' })).toHaveCount(count)
  await expect(question(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Submit exam', exact: true }).click()
  await expect(main(page).getByRole('heading', { name: 'Exam submitted', exact: true })).toBeVisible()
  await saved(page)
  await page.reload()
  await expect(main(page).getByRole('heading', { name: 'Exam submitted', exact: true })).toBeVisible()
  await saved(page)
}
async function choose(page: Page) {
  await input(page).click()
  await expect(input(page)).toBeChecked()
  await saved(page)
}

for (const [fixture, size] of [['standard-59', 59], ['standard-41', 41], ['single-1', 1]] as const) {
  test('candidate actual entry: ' + size + '-question standard-only batch bypasses nonexistent sections', async ({ page }) => {
    await open(page, fixture)
    await expect(main(page)).toContainText(size + (size === 1 ? ' question · 1 section' : ' questions · 1 section'))
    await expect(outline(page).getByRole('listitem')).toHaveCount(1)
    await expect(outline(page)).not.toContainText(/Case Study|Interactive Questions/)
    if (size < 59) await expect(main(page).getByRole('heading', { name: 'Final Examination Batch', exact: true })).toBeVisible()
    await start(page)
    await section(page, 'Standard Questions', 1, size, size)
    await choose(page)
    if (size > 1) {
      const nav = page.getByRole('navigation', { name: 'Current section questions' })
      if (!await nav.isVisible()) await page.getByText('Question navigator', { exact: true }).click()
      await expect(nav.getByRole('button')).toHaveCount(size)
      await nav.getByRole('button', { name: new RegExp('^Question ' + size + '\\b') }).click()
      await section(page, 'Standard Questions', size, size, size)
      await page.reload()
      await section(page, 'Standard Questions', size, size, size)
    } else {
      await expect(next(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
      await page.reload()
      await section(page, 'Standard Questions', 1, size, size)
      await expect(input(page)).toBeChecked()
    }
    await finishSection(page, 'Finish section', 'Submit section', { total: size, unanswered: size - 1 })
    await final(page, 1)
  })
}

test('candidate actual entry: two remaining case children, 20 standard and one interactive retain separate locks and actual counts', async ({ page, context }) => {
  await open(page, 'partial-23')
  await expect(main(page).getByRole('heading', { name: 'Final Examination Batch' })).toBeVisible()
  await expect(main(page)).toContainText('23 questions · 3 sections')
  await expect(outline(page).getByRole('listitem')).toHaveCount(3)
  await expect(outline(page)).not.toContainText(/Case Study 1|Case Study 2/)
  await start(page)
  await section(page, 'Case Study', 1, 2, 23)
  const scenario = page.getByText('Case study context', { exact: true })
  await expect(scenario).toBeVisible()
  const scenarioHeading = page.getByRole('heading', { name: 'Example two-question scenario' })
  if (!await scenarioHeading.isVisible()) await scenario.click()
  await expect(scenarioHeading).toBeVisible()
  await choose(page)
  await next(page).click()
  await section(page, 'Case Study', 2, 2, 23)
  await expect(scenario).toBeVisible()
  await finishSection(page, 'Finish case study', 'Submit case study', { total: 2, unanswered: 1 })
  await section(page, 'Standard Questions', 1, 20, 23, 3)
  await expandOutline(page)
  await expect(outline(page).getByRole('listitem').first()).toContainText('Locked')
  const passive = await context.newPage()
  expect((await passive.goto(origin + base('partial-23') + '?section=qa-family-1&question=2#/question/qa-family-1'))?.status()).toBe(200)
  await expect(status(passive)).toHaveText('Read-only in this tab')
  await expect(passive.getByRole('banner').getByText('Standard Questions', { exact: true })).toBeVisible()
  await expect(input(passive)).toBeDisabled()
  await expect(passive.getByRole('button', { name: 'Review section', exact: true })).toBeDisabled()
  await passive.close()
  await finishSection(page, 'Finish section', 'Submit section', { total: 20, unanswered: 20 })
  await section(page, 'Final Interactive Questions', 1, 1, 23, 23)
  const field = question(page).getByRole('combobox', { name: 'Example field' })
  await field.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await expect(field).not.toHaveValue('')
  await saved(page)
  await page.reload()
  await section(page, 'Final Interactive Questions', 1, 1, 23, 23)
  await expect(field).not.toHaveValue('')
  await finishSection(page, 'Finish interactive section', 'Submit section', { total: 1, unanswered: 0 })
  await final(page, 3)
})

test('candidate actual entry: skips a missing standard block between the real case and interactive sections', async ({ page }) => {
  await open(page, 'special-only')
  await expect(main(page)).toContainText('3 questions · 2 sections')
  await expect(outline(page)).not.toContainText('Standard Questions')
  await start(page)
  await section(page, 'Case Study', 1, 2, 3)
  await finishSection(page, 'Finish case study', 'Submit case study', { total: 2, unanswered: 2 })
  await section(page, 'Final Interactive Questions', 1, 1, 3, 3)
  await finishSection(page, 'Finish interactive section', 'Submit section', { total: 1, unanswered: 1 })
  await final(page, 2)
})

test('candidate actual entry: three partial families sharing a section kind maintain distinct locks and contexts', async ({ page }) => {
  await open(page, 'multiple-families')
  await expect(main(page)).toContainText('6 questions · 3 sections')
  await start(page)
  const seen = new Set<string>()
  for (let step = 1; step <= 3; step += 1) {
    await section(page, 'Case Study ' + step, 1, 2, 6, step * 2 - 1)
    const context = page.getByRole('heading', { name: /^Synthetic group \d+$/i })
    if (!await context.isVisible()) await page.getByText('Case study context', { exact: true }).click()
    await expect(context).toBeVisible()
    seen.add(await context.innerText())
    // Reload the second family and verify the durable unique case-section key.
    if (step === 2) {
      const current = await context.innerText()
      await choose(page)
      await page.reload()
      await section(page, 'Case Study 2', 1, 2, 6, 3)
      await expect(input(page)).toBeChecked()
      if (!await context.isVisible()) await page.getByText('Case study context', { exact: true }).click()
      await expect(context).toHaveText(current)
    }
    await finishSection(page, 'Finish case study', 'Submit case study', { total: 2, unanswered: step === 2 ? 1 : 2 })
  }
  expect(seen.size).toBe(3)
  await final(page, 3)
})

test('candidate actual entry: an approved dual-role normal question retains its original case context', async ({ page }) => {
  test.setTimeout(60_000)
  await open(page, 'normal-overlap')
  await start(page)
  for (let i = 0; i < 2; i += 1) {
    await finishSection(page, 'Finish case study', 'Submit case study', { total: 3 })
  }
  await section(page, 'Standard Questions', 1, 49, 59, 7)
  const item = page.getByRole('heading', { name: 'Double-eligible example question', exact: true })
  for (let i = 1; i < 49 && !await item.isVisible(); i += 1) { await next(page).click(); await saved(page) }
  await expect(item).toBeVisible()
  const context = page.getByText('Case study context', { exact: true })
  await expect(context).toBeVisible()
  const scenario = page.getByRole('heading', { name: 'Synthetic group 1', exact: true })
  if (!await scenario.isVisible()) await context.click()
  await expect(scenario).toBeVisible()
  await input(page).check()
  await saved(page)
  await page.reload()
  await saved(page)
  await expect(item).toBeVisible()
  await expect(context).toBeVisible()
  await expect(input(page)).toBeChecked()
  await finishSection(page, 'Finish section', 'Submit section', { total: 49 })
  await section(page, 'Final Interactive Questions', 1, 4, 59, 56)
})
