import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { build } from 'vite'

export type Phase6Profile = 'matrix' | 'normal-timed' | 'one-timed' | 'adaptive-timed'

export const phase6Mount = (profile: Phase6Profile) => '/Cyber-SC-100/_phase6_test/' + profile + '/'
const fixture = fileURLToPath(new URL('../fixtures/phase6-browser-source.ts', import.meta.url))
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
}

function exampleExhibit() {
  // Generated QA-only three-box graphic, not a redraw of any source diagram.
  function chunk(kind: string, bytes: Uint8Array) {
    const name = Buffer.from(kind)
    const data = name.length + bytes.length
    const result = Buffer.alloc(8 + data)
    result.writeUInt32BE(bytes.length); name.copy(result, 4); result.set(bytes, 8)
    let crc = 0xffffffff
    for (const v of result.subarray(4, 4 + data)) {
      crc ^= v
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data + 4)
    return result
  }
  const width = 860
  const height = 330
  const pixels = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const box = [60, 350, 640].find(offset => x >= offset && x < offset + 155 && y >= 90 && y < 240)
      const connector = [[215, 350], [505, 640]].some(([left, right]) =>
        (x >= left && x < right && Math.abs(y - 165) < 3) ||
        (x >= right - 23 && x < right && Math.abs(Math.abs(y - 165) - (right - x)) < 3))
      const offset = y * (width * 3 + 1) + 1 + x * 3
      const color = box !== undefined ? [19, 81, 167] : connector ? [31, 47, 71] : [232, 242, 255]
      pixels.set(color, offset)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ])
}

export async function servePhase6(profiles: readonly Phase6Profile[]) {
  const resources = new Map<string, string | Uint8Array>()
  for (const profile of profiles) {
    const base = phase6Mount(profile)
    const result = await build({
      base, logLevel: 'silent', build: { write: false },
      define: {
        __QA_PHASE6_PROFILE__: JSON.stringify(profile),
        __QA_PHASE6_ASSET_ROOT__: JSON.stringify(base),
      },
      plugins: [{
        name: 'phase6-qa-synthetic-source', enforce: 'pre',
        transform(code, path) {
          if (!path.endsWith('/src/main.tsx')) return undefined
          const entry = '<Foundation />'
          if (!code.includes(entry)) throw new Error('The Phase 6 harness needs the actual Foundation mount')
          return `import { phase6Fixture, phase6MatrixPositions } from ${JSON.stringify(fixture)};
globalThis.__qaPhase6Positions = phase6MatrixPositions;
${code.replace(entry, '<Foundation source={phase6Fixture} />')}`
        },
      }],
    })
    if ('getOutput' in result || 'close' in result) throw new Error('Unexpected watching fixture build')
    const first = Array.isArray(result) ? result[0] : result
    for (const file of first.output) resources.set(base + file.fileName, file.type === 'chunk' ? file.code : file.source)
    if (profile === 'matrix') resources.set(base + 'assets/exhibits/example-exhibit.png', exampleExhibit())
  }
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const path = pathname.endsWith('/') ? pathname + 'index.html' : pathname
    const data = resources.get(path)
    if (data === undefined) {
      response.writeHead(404); response.end('Missing synthetic fixture'); return
    }
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' })
    response.end(data)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: (profile: Phase6Profile) => 'http://127.0.0.1:' + address.port + phase6Mount(profile),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

export type Phase6Server = Awaited<ReturnType<typeof servePhase6>>
export const question = (page: Page) => page.getByRole('region', { name: 'Question and response' })
export const saveStatus = (page: Page) => page.getByRole('banner').getByRole('status').filter({
  hasText: /Saved on this device|Saving|Save failed|Read-only|storage/i,
})
export const review = (page: Page) => page.getByRole('region', { name: 'Active section review' })
export const main = (page: Page) => page.getByRole('main')
export async function saved(page: Page) { await expect(saveStatus(page)).toHaveText('Saved on this device') }
export async function openPhase6(page: Page, server: Phase6Server, profile: Phase6Profile) {
  const response = await page.goto(server.url(profile))
  expect(response?.status()).toBe(200)
  await saved(page)
}
export async function start(page: Page) {
  await page.getByRole('button', { name: 'Start exam', exact: true }).click()
  await expect(question(page)).toBeVisible()
  await saved(page)
}
export async function finish(page: Page, label: RegExp = /^Finish (?:section|case study|interactive section)$/i) {
  await page.getByRole('button', { name: 'Review section', exact: true }).click()
  await expect(review(page)).toBeVisible()
  await review(page).getByRole('button', { name: label }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /^Submit (?:section|case study)$/i }).click()
  await expect(dialog).toBeHidden()
  await saved(page)
}

export async function jumpTo(page: Page, id: string) {
  const position = await page.evaluate(sourceId => (window as typeof window & {
    __qaPhase6Positions: Record<string, { position: number; sectionIndex: number }>,
  }).__qaPhase6Positions[sourceId], id)
  const navigator = page.getByRole('navigation', { name: 'Current section questions' })
  if (!await navigator.isVisible()) await page.getByText('Question navigator', { exact: true }).click()
  await navigator.getByRole('button', { name: new RegExp('^Question ' + position.position + '\\b') }).click()
  await expect(question(page).getByText(new RegExp('Question ' + position.position + ' of '))).toBeVisible()
  await saved(page)
  return position
}

export async function readSnapshot<T>(page: Page, profile: Phase6Profile): Promise<T> {
  return await page.evaluate((name) => new Promise<T>((resolve, reject) => {
    const open = indexedDB.open('qa-phase6-database-' + name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('attempts')
      const request = tx.objectStore('attempts').get('qa-phase6-attempt-' + name)
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => { db.close(); resolve(request.result?.attempt as T) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }), profile)
}
