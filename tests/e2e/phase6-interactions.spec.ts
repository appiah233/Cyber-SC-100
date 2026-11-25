import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  finish, jumpTo, main, openPhase6, question, readSnapshot, review, saved, saveStatus, servePhase6, start,
} from './phase6-harness'
import type { Phase6Server } from './phase6-harness'

let server: Phase6Server
test.beforeAll(async () => { server = await servePhase6(['matrix']) })
test.afterAll(async () => { await server?.close() })

const labels: Record<string, string> = {
  'qa-single': 'Single choice fixture',
  'qa-multiple': 'Multiple choice fixture',
  'qa-dropdown': 'Dropdown fixture',
  'qa-statements': 'Statements fixture',
  'qa-matching': 'Matching fixture',
  'qa-ordering': 'Ordering fixture',
  'qa-position-order': 'Explicit ordering positions fixture',
  'qa-drag': 'Drag and drop fixture',
  'qa-hotspot-dropdown': 'Dropdown HOTSPOT fixture',
  'qa-exhibit': 'Exhibit fixture',
  'qa-missing-exhibit': 'Missing exhibit fixture',
  'qa-image-deferred': 'Image interaction safely unavailable',
}
const standards = ['qa-single', 'qa-multiple', 'qa-dropdown', 'qa-missing-exhibit'] as const
const interactives = ['qa-statements', 'qa-matching', 'qa-ordering', 'qa-position-order', 'qa-drag', 'qa-hotspot-dropdown', 'qa-exhibit', 'qa-image-deferred'] as const
const forbidden = /\b(?:correct answer|incorrect answer|expected answer|answer key|explanation|pass\/fail|your score)\b/i
const alpha = 'qa-option-a'
const beta = 'qa-option-b'
const gamma = 'qa-option-c'
const north = (page: Page) => question(page).getByRole('combobox', { name: 'North destination', exact: true })
const south = (page: Page) => question(page).getByRole('combobox', { name: 'South destination', exact: true })
const radio = (page: Page, name: RegExp) => question(page).getByRole('radio', { name })
const box = (page: Page, name: RegExp) => question(page).getByRole('checkbox', { name })
const picker = (page: Page, label: string) => question(page).getByRole('button', { name: 'Pick ' + label, exact: true })
const destination = (page: Page, label: string) => question(page).getByRole('button', { name: 'Place in ' + label, exact: true })
const list = (page: Page) => question(page).getByRole('list', { name: 'Response order' })

type Snapshot = { readonly answers: Readonly<Record<string, unknown>>; readonly revision: number }
async function answer(page: Page, id: string, expected: unknown) {
  await expect.poll(async () => (await readSnapshot<Snapshot>(page, 'matrix')).answers[id]).toEqual(expected)
  await saved(page)
}
async function at(page: Page, id: string) {
  await jumpTo(page, id)
  await expect(main(page).getByRole('heading', { name: labels[id], exact: true })).toBeVisible()
}
async function beginAt(page: Page, id: string) {
  await openPhase6(page, server, 'matrix')
  await start(page)
  if (interactives.includes(id as typeof interactives[number])) await finish(page)
  await at(page, id)
}
async function restore(page: Page, id: string) {
  await page.reload()
  await saved(page)
  await expect(main(page).getByRole('heading', { name: labels[id], exact: true })).toBeVisible()
}
async function enter(locator: Locator, key = 'Enter') { await locator.focus(); await locator.press(key) }

async function axes(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(results.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(node => node.target) }))).toEqual([])
}
async function noLeak(page: Page) {
  await expect(main(page)).not.toContainText(forbidden)
  expect(await main(page).ariaSnapshot()).not.toMatch(forbidden)
  await expect(main(page).locator('[data-correct], [data-answer-key], [data-correct-answer]')).toHaveCount(0)
}
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
    document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}
async function evidence(page: Page, file: string) {
  const target = process.env.PLAYWRIGHT_PHASE6_SYNTHETIC_EVIDENCE_DIR
  if (!target) return
  if (!isAbsolute(target) || !relative(process.cwd(), resolve(target)).startsWith('..' + sep)) {
    throw new Error('Use a screenshot directory outside the public checkout')
  }
  await mkdir(target, { recursive: true })
  if (!relative(await realpath(process.cwd()), await realpath(target)).startsWith('..' + sep)) {
    throw new Error('Synthetic screenshot destination resolves inside the public checkout')
  }
  await page.screenshot({ path: join(target, file + '.png'), animations: 'disabled', fullPage: true })
}
async function reviewStatus(page: Page, id: string, status: 'Answered' | 'Incomplete' | 'Unanswered') {
  const { position } = await jumpTo(page, id)
  await page.getByRole('button', { name: 'Review section', exact: true }).click()
  const row = review(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Open question ' + position, exact: true }) })
  await expect(row.getByText(status, { exact: true })).toBeVisible()
  await noLeak(page)
  await row.getByRole('button', { name: 'Open question ' + position, exact: true }).click()
  await expect(main(page).getByRole('heading', { name: labels[id], exact: true })).toBeVisible()
}

test('single choice uses native labelled radios and stable option identity through reload and review', async ({ page }) => {
  await beginAt(page, 'qa-single')
  await expect(question(page).getByRole('group', { name: 'Select one option' })).toBeVisible()
  await question(page).getByText('Example Alpha', { exact: true }).click()
  await expect(radio(page, /^Example Alpha$/)).toBeChecked()
  await answer(page, 'qa-single', { kind: 'SINGLE_CHOICE', optionId: alpha })
  await radio(page, /^Example Alpha$/).press('ArrowDown')
  await expect(radio(page, /^Example Alpha$/)).not.toBeChecked()
  await enter(radio(page, /^Example Beta$/), 'Space')
  await answer(page, 'qa-single', { kind: 'SINGLE_CHOICE', optionId: beta })
  await restore(page, 'qa-single')
  await expect(radio(page, /^Example Beta$/)).toBeChecked()
  await evidence(page, '01-single-choice')
  await reviewStatus(page, 'qa-single', 'Answered')
  await noLeak(page)
  await axes(page)
})

test('multiple choice honors the supplied count, preserves IDs, and permits deselection', async ({ page }) => {
  await beginAt(page, 'qa-multiple')
  await expect(question(page).getByRole('group', { name: 'Select 2 options' })).toBeVisible()
  await enter(box(page, /^Example Alpha$/), 'Space')
  await reviewStatus(page, 'qa-multiple', 'Incomplete')
  await enter(box(page, /^Example Beta$/), 'Space')
  await expect(box(page, /^Example Gamma/)).toBeDisabled()
  await enter(box(page, /^Example Alpha$/), 'Space')
  await expect(box(page, /^Example Gamma/)).toBeEnabled()
  await enter(box(page, /^Example Gamma/), 'Space')
  await expect.poll(async () => {
    const value = (await readSnapshot<Snapshot>(page, 'matrix')).answers['qa-multiple'] as { kind: string; optionIds: string[] }
    return [value.kind, [...value.optionIds].sort()]
  }).toEqual(['MULTIPLE_CHOICE', [beta, gamma]])
  await restore(page, 'qa-multiple')
  await expect(box(page, /^Example Beta$/)).toBeChecked()
  await expect(box(page, /^Example Gamma/)).toBeChecked()
  await evidence(page, '02-multiple-choice')
  await reviewStatus(page, 'qa-multiple', 'Answered')
  await axes(page)
})

async function rapidDropdown(page: Page) {
  await question(page).evaluate(region => {
    const [first, second] = [...region.querySelectorAll('select')]
    if (!first || !second) throw new Error('Two independently labelled native fields are required')
    for (const [field, value] of [[first, 'qa-option-a'], [second, 'qa-option-c'], [first, 'qa-option-b']] as const) {
      field.value = value
      field.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
}

for (const [id, kind, filename] of [
  ['qa-dropdown', 'DROPDOWN', '03-dropdown'],
  ['qa-hotspot-dropdown', 'DROPDOWN_HOTSPOT', '04-dropdown-hotspot'],
] as const) {
  test(kind + ' maintains both labelled targets in rapid changes, clear, keyboard and reload', async ({ page }) => {
    await beginAt(page, id)
    await expect(question(page).locator('canvas, map, area, [data-region]')).toHaveCount(0)
    await rapidDropdown(page)
    await expect(north(page)).toHaveValue(beta)
    await expect(south(page)).toHaveValue(gamma)
    await answer(page, id, { kind, selections: { 'qa-target-north': beta, 'qa-target-south': gamma } })
    await north(page).selectOption('')
    await answer(page, id, { kind, selections: { 'qa-target-south': gamma } })
    await reviewStatus(page, id, 'Incomplete')
    await north(page).focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    await answer(page, id, { kind, selections: { 'qa-target-north': alpha, 'qa-target-south': gamma } })
    await restore(page, id)
    await expect(north(page)).toHaveValue(alpha)
    await expect(south(page)).toHaveValue(gamma)
    await evidence(page, filename)
    await reviewStatus(page, id, 'Answered')
    await axes(page)
  })
}

test('matching is keyboard-operable, visibly editable, and keeps independent IDs', async ({ page }) => {
  await beginAt(page, 'qa-matching')
  await enter(picker(page, 'Example Alpha'), 'Space')
  await enter(destination(page, 'North destination'), 'Space')
  await answer(page, 'qa-matching', { kind: 'MATCHING', selections: { 'qa-target-north': alpha } })
  await south(page).selectOption(beta)
  await answer(page, 'qa-matching', { kind: 'MATCHING', selections: { 'qa-target-north': alpha, 'qa-target-south': beta } })
  await north(page).selectOption('')
  await reviewStatus(page, 'qa-matching', 'Incomplete')
  await north(page).selectOption(gamma)
  await answer(page, 'qa-matching', { kind: 'MATCHING', selections: { 'qa-target-north': gamma, 'qa-target-south': beta } })
  await restore(page, 'qa-matching')
  await expect(north(page)).toHaveValue(gamma)
  await expect(south(page)).toHaveValue(beta)
  await evidence(page, '05-matching')
  await reviewStatus(page, 'qa-matching', 'Answered')
  await axes(page)
})

async function drag(page: Page, from: Locator, to: Locator, touch = false, targetTop = false) {
  await from.scrollIntoViewIfNeeded()
  await to.scrollIntoViewIfNeeded()
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error('Synthetic interaction elements are not visible')
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const end = { x: b.x + b.width / 2, y: b.y + b.height * (targetTop ? .22 : .5) }
  if (touch) {
    const cdp = await page.context().newCDPSession(page)
    try {
      const touchPoints = (point: typeof start) => [{ ...point, id: 1 }]
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoints(start) })
      for (let i = 1; i <= 7; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints({
          x: start.x + (end.x - start.x) * i / 7, y: start.y + (end.y - start.y) * i / 7,
        }) })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally { await cdp.detach() }
    return
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  if (targetTop) {
    // Pointer motion can trigger browser scrolling before the drop. Only
    // complete the gesture after the UI confirms the intended insertion edge.
    await expect(async () => {
      const destination = await to.boundingBox()
      if (!destination) throw new Error('Ordering destination is unavailable')
      await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height * .22)
      await expect(to).toHaveAttribute('data-drop-edge', 'before', { timeout: 250 })
    }).toPass({ timeout: 3000 })
  }
  await page.mouse.up()
}
test('ordering supports reversible pointer and keyboard moves with actual stable sequence persisted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1050 })
  await beginAt(page, 'qa-ordering')
  const handle = question(page).getByRole('button', { name: 'Reorder Publish output' })
  const first = list(page).getByRole('listitem').filter({ hasText: 'Collect inputs' })
  await drag(page, handle, first, false, true)
  await answer(page, 'qa-ordering', { kind: 'ORDERING', optionIds: ['qa-step-c', 'qa-step-a', 'qa-step-b'] })
  await enter(question(page).getByRole('button', { name: 'Move Publish output down' }))
  await answer(page, 'qa-ordering', { kind: 'ORDERING', optionIds: ['qa-step-a', 'qa-step-c', 'qa-step-b'] })
  await enter(question(page).getByRole('button', { name: 'Move Process inputs up' }))
  await answer(page, 'qa-ordering', { kind: 'ORDERING', optionIds: ['qa-step-a', 'qa-step-b', 'qa-step-c'] })
  // Both actions capture item IDs before the first IndexedDB save can finish.
  await question(page).evaluate(region => {
    const source = region.querySelector<HTMLButtonElement>('[aria-label="Move Publish output up"]')
    const second = region.querySelector<HTMLButtonElement>('[aria-label="Move Collect inputs down"]')
    if (!source || !second) throw new Error('Two ordering controls are required')
    source.click()
    second.click()
  })
  await answer(page, 'qa-ordering', { kind: 'ORDERING', optionIds: ['qa-step-c', 'qa-step-a', 'qa-step-b'] })
  await restore(page, 'qa-ordering')
  await expect(list(page).getByRole('listitem')).toHaveCount(3)
  await expect(list(page).getByRole('listitem').first()).toContainText('Publish output')
  await evidence(page, '06-ordering')
  await reviewStatus(page, 'qa-ordering', 'Answered')
  await axes(page)
})

test('drag and drop supports mouse movement between targets and reversible keyboard response', async ({ page }) => {
  await beginAt(page, 'qa-drag')
  await drag(page, picker(page, 'Example Alpha'), destination(page, 'North destination'))
  await answer(page, 'qa-drag', { kind: 'DRAG_DROP', selections: { 'qa-target-north': alpha } })
  await drag(page, question(page).getByRole('button', { name: 'Move Example Alpha from North destination' }), destination(page, 'South destination'))
  await answer(page, 'qa-drag', { kind: 'DRAG_DROP', selections: { 'qa-target-south': alpha } })
  await enter(picker(page, 'Example Beta'))
  await enter(destination(page, 'North destination'))
  await answer(page, 'qa-drag', { kind: 'DRAG_DROP', selections: { 'qa-target-north': beta, 'qa-target-south': alpha } })
  await restore(page, 'qa-drag')
  await expect(north(page)).toHaveValue(beta)
  await expect(south(page)).toHaveValue(alpha)
  await evidence(page, '07-drag-drop')
  await reviewStatus(page, 'qa-drag', 'Answered')
  await axes(page)
})

test('statement answers are independent named groups and round-trip without a whole-question boolean', async ({ page }) => {
  await beginAt(page, 'qa-statements')
  const northGroup = question(page).getByRole('group', { name: 'The example map has a North destination' })
  const southGroup = question(page).getByRole('group', { name: 'The example map has a South destination' })
  await enter(northGroup.getByRole('radio', { name: 'Yes' }), 'Space')
  await reviewStatus(page, 'qa-statements', 'Incomplete')
  await enter(southGroup.getByRole('radio', { name: 'No' }), 'Space')
  await enter(northGroup.getByRole('radio', { name: 'No' }), 'Space')
  await answer(page, 'qa-statements', { kind: 'STATEMENT', selections: { 'qa-statement-a': 'qa-no', 'qa-statement-b': 'qa-no' } })
  await enter(question(page).getByRole('button', { name: 'Clear response for The example map has a North destination' }))
  await answer(page, 'qa-statements', { kind: 'STATEMENT', selections: { 'qa-statement-b': 'qa-no' } })
  await enter(northGroup.getByRole('radio', { name: 'No' }), 'Space')
  await answer(page, 'qa-statements', { kind: 'STATEMENT', selections: { 'qa-statement-a': 'qa-no', 'qa-statement-b': 'qa-no' } })
  await restore(page, 'qa-statements')
  await expect(northGroup.getByRole('radio', { name: 'No' })).toBeChecked()
  await expect(southGroup.getByRole('radio', { name: 'No' })).toBeChecked()
  await evidence(page, '08-statements')
  await reviewStatus(page, 'qa-statements', 'Answered')
  await axes(page)
})

test('diagram dependency retains accessible original asset and qualified response; viewer restores focus', async ({ page }) => {
  await beginAt(page, 'qa-exhibit')
  const image = question(page).getByRole('img', { name: 'Three example nodes joined by arrows' })
  await expect(image).toBeVisible()
  expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(860)
  const expand = question(page).getByRole('button', { name: 'Expand exhibit: Synthetic flow diagram' })
  await enter(expand)
  const dialog = page.getByRole('dialog', { name: 'Synthetic flow diagram' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'Three example nodes joined by arrows' })).toBeVisible()
  await enter(dialog.getByRole('button', { name: 'Zoom in' }))
  await noOverflow(page)
  await evidence(page, '09-diagram-viewer')
  await axes(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(expand).toBeFocused()
  await evidence(page, '10-keyboard-focus')
  await enter(radio(page, /^Example Beta$/), 'Space')
  await expect(radio(page, /^Example Beta$/)).toBeChecked()
  await saved(page)
  await answer(page, 'qa-exhibit', { kind: 'DIAGRAM_DEPENDENT', response: { kind: 'SINGLE_CHOICE', optionId: beta } })
  await restore(page, 'qa-exhibit')
  await expect(radio(page, /^Example Beta$/)).toBeChecked()
  await reviewStatus(page, 'qa-exhibit', 'Answered')
})

test('missing or unsafe asset stays unavailable with ordinary source response still usable; no image geometry is manufactured', async ({ page }) => {
  await beginAt(page, 'qa-missing-exhibit')
  await expect(question(page).getByText(/exhibit image is unavailable|exhibit unavailable/i)).toHaveCount(2)
  await expect(question(page).getByRole('img')).toHaveCount(0)
  await expect(question(page).getByRole('button', { name: /expand exhibit/i })).toHaveCount(0)
  await enter(radio(page, /^Example Alpha$/), 'Space')
  await answer(page, 'qa-missing-exhibit', { kind: 'SINGLE_CHOICE', optionId: alpha })
  await finish(page)
  await at(page, 'qa-image-deferred')
  await expect(question(page).getByRole('alert')).toContainText(/unavailable/i)
  await expect(question(page).locator('canvas, area, map, input, select')).toHaveCount(0)
  expect((await readSnapshot<Snapshot>(page, 'matrix')).answers['qa-image-deferred']).toBeUndefined()
})

for (const width of [320, 390, 768]) {
  test('every candidate renderer and exhibit remain operable at ' + width + ' CSS px', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: 1040 })
    await openPhase6(page, server, 'matrix')
    await start(page)
    for (const id of standards) {
      await at(page, id)
      await noOverflow(page)
    }
    await finish(page)
    for (const id of interactives) {
      await at(page, id)
      await noOverflow(page)
      if (width === 390 && id === 'qa-matching') {
        await enter(picker(page, 'Example Alpha'))
        await enter(destination(page, 'North destination'))
        await expect(north(page)).toHaveValue(alpha)
        await evidence(page, '11-mobile-matching')
      }
      if (width === 390 && id === 'qa-ordering') {
        await enter(question(page).getByRole('button', { name: 'Move Publish output up' }))
        await expect(list(page).getByRole('listitem').last()).toContainText('Process inputs')
        await evidence(page, '12-mobile-ordering')
        await axes(page)
      }
      if (id === 'qa-exhibit') {
        await enter(question(page).getByRole('button', { name: 'Expand exhibit: Synthetic flow diagram' }))
        const dialog = page.getByRole('dialog', { name: 'Synthetic flow diagram' })
        await expect(dialog).toBeVisible()
        await enter(dialog.getByRole('button', { name: 'Zoom in' }))
        await noOverflow(page)
        await enter(dialog.getByRole('button', { name: 'Close exhibit' }))
      }
    }
  })
}

test('matching, ordering, and diagram viewer reflow at emulated 200% zoom without page-level overflow', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1060 })
  await openPhase6(page, server, 'matrix')
  await start(page)
  await finish(page)
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  for (const id of ['qa-matching', 'qa-ordering', 'qa-exhibit']) {
    await at(page, id)
    await noOverflow(page)
  }
  await enter(question(page).getByRole('button', { name: 'Expand exhibit: Synthetic flow diagram' }))
  await expect(page.getByRole('dialog', { name: 'Synthetic flow diagram' })).toBeVisible()
  await noOverflow(page)
})

test.describe('touch-operated placement at phone size', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 1000 } })
  test('touch can select a match and performs real pointer drag/drop', async ({ page }) => {
    await beginAt(page, 'qa-matching')
    await picker(page, 'Example Alpha').tap()
    await destination(page, 'North destination').tap()
    await answer(page, 'qa-matching', { kind: 'MATCHING', selections: { 'qa-target-north': alpha } })
    await at(page, 'qa-drag')
    await drag(page, picker(page, 'Example Beta'), destination(page, 'North destination'), true)
    await answer(page, 'qa-drag', { kind: 'DRAG_DROP', selections: { 'qa-target-north': beta } })
    await noOverflow(page)
  })
})

test('second tab is read-only for every answerable renderer and submitted sections never reopen', async ({ page, context }) => {
  test.setTimeout(80_000)
  await openPhase6(page, server, 'matrix')
  await start(page)
  const other = await context.newPage()
  async function passive(id: string) {
    await at(page, id)
    await other.goto(server.url('matrix') + '?question=' + id + '#/question/' + id)
    await expect(saveStatus(other)).toHaveText('Read-only in this tab')
    await expect(main(other).getByRole('heading', { name: labels[id], exact: true })).toBeVisible()
    const responseControls = question(other).locator('input, select, button[aria-label^="Pick "], button[aria-label^="Place in "], button[aria-label^="Reorder "], button[aria-label^="Move "]')
    expect(await responseControls.count()).toBeGreaterThan(0)
    for (const candidate of await responseControls.all()) await expect(candidate).toBeDisabled()
    await expect(other.getByRole('button', { name: 'Review section', exact: true })).toBeDisabled()
  }
  for (const id of standards) await passive(id)
  await finish(page)
  for (const id of interactives.filter(id => id !== 'qa-image-deferred')) await passive(id)
  await finish(page)
  await expect(main(page).getByRole('heading', { name: 'Final submission', exact: true })).toBeVisible()
  await other.goto(server.url('matrix') + '#/question/qa-drag')
  await expect(saveStatus(other)).toHaveText('Read-only in this tab')
  await expect(main(other).getByRole('heading', { name: 'Final submission', exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Submit exam', exact: true })).toBeDisabled()
  await expect(other.getByRole('list', { name: 'Exam sections' }).getByRole('listitem').filter({ hasText: 'Locked' })).toHaveCount(2)
  await expect(question(other)).toHaveCount(0)
})

test('ordering with authored positions starts empty and preserves add, remove, and replaced item IDs', async ({ page }) => {
  await beginAt(page, 'qa-position-order')
  await expect(list(page).getByRole('listitem')).toHaveCount(0)
  const first = question(page).getByRole('combobox', { name: 'First assigned position' })
  const second = question(page).getByRole('combobox', { name: 'Second assigned position' })
  await first.selectOption('qa-step-b')
  await answer(page, 'qa-position-order', { kind: 'ORDERING', optionIds: ['qa-step-b'] })
  await reviewStatus(page, 'qa-position-order', 'Incomplete')
  await second.selectOption('qa-step-a')
  await answer(page, 'qa-position-order', { kind: 'ORDERING', optionIds: ['qa-step-b', 'qa-step-a'] })
  await enter(question(page).getByRole('button', { name: 'Remove Process inputs' }))
  await expect(second).toBeVisible()
  await answer(page, 'qa-position-order', { kind: 'ORDERING', optionIds: ['qa-step-a'] })
  await second.selectOption('qa-step-c')
  await answer(page, 'qa-position-order', { kind: 'ORDERING', optionIds: ['qa-step-a', 'qa-step-c'] })
  await restore(page, 'qa-position-order')
  await expect(list(page).getByRole('listitem').first()).toContainText('First assigned position Collect inputs')
  await expect(list(page).getByRole('listitem').last()).toContainText('Second assigned position Publish output')
  await reviewStatus(page, 'qa-position-order', 'Answered')
})
