import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { build } from 'vite'

export const phase7Profiles = ['normal', 'adaptive', 'remainder-41', 'mixed-23', 'one', 'threshold'] as const
export type Phase7Profile = typeof phase7Profiles[number]
export const scoringRequest = /\/assets\/phase7-browser-bank-[^/]+\.js$/
const baseFor = (name: Phase7Profile) => '/Cyber-SC-100/_phase7_test/' + name + '/'
const source = fileURLToPath(new URL('../fixtures/phase7-browser-source.ts', import.meta.url))
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

export async function servePhase7() {
  const assets = new Map<string, string | Uint8Array>()
  for (const profile of phase7Profiles) {
    const base = baseFor(profile)
    const result = await build({
      base, logLevel: 'silent', build: { write: false },
      define: { __QA_PHASE7_PROFILE__: JSON.stringify(profile) },
      plugins: [{
        name: 'phase7-qa-synthetic-source', enforce: 'pre',
        transform(code, path) {
          if (!path.endsWith('/src/main.tsx')) return
          const mount = /<Foundation(?:\s+[^<>]*?)?\s*\/>/
          if (!mount.test(code)) throw new Error('Synthetic browser harness must use the actual candidate application entry')
          return `import { phase7Fixture, phase7Positions } from ${JSON.stringify(source)};
globalThis.__qaPhase7Positions = phase7Positions;
${code.replace(mount, '<Foundation source={phase7Fixture} />')}`
        },
      }],
    })
    if ('getOutput' in result || 'close' in result) throw new Error('Expected an in-memory, non-watching candidate build')
    const output = Array.isArray(result) ? result[0] : result
    const bank = output.output.filter(item => scoringRequest.test(base + item.fileName))
    if (bank.length !== 1) throw new Error('Synthetic scoring definitions must be in one separate lazy browser chunk')
    for (const item of output.output) {
      const path = base + item.fileName
      const body = item.type === 'chunk' ? item.code : item.source
      if (!scoringRequest.test(path) && typeof body === 'string' && body.includes('Synthetic fixture has no supported authoritative response')) {
        throw new Error('Synthetic scoring definitions leaked outside their lazy module')
      }
      assets.set(path, body)
    }
  }
  const listener = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const path = pathname.endsWith('/') ? pathname + 'index.html' : pathname
    const asset = assets.get(path)
    if (asset === undefined) { response.writeHead(404); response.end('Synthetic fixture not found'); return }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' })
    response.end(asset)
  })
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const address = listener.address() as AddressInfo
  return {
    url: (profile: Phase7Profile) => 'http://127.0.0.1:' + address.port + baseFor(profile),
    close: () => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())),
  }
}

export async function snapshot<T>(page: Page, profile: Phase7Profile): Promise<T> {
  return page.evaluate(name => new Promise<T>((resolve, reject) => {
    const open = indexedDB.open('qa-phase7-database-' + name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction('attempts')
      const request = transaction.objectStore('attempts').get('qa-phase7-attempt-' + name)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => { db.close(); resolve(request.result?.attempt as T) }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
    }
  }), profile)
}

export async function goToSource(page: Page, profile: Phase7Profile, id: string) {
  const position = await page.evaluate(sourceId => (window as typeof window & {
    __qaPhase7Positions: Record<string, { position: number; sectionIndex: number }>,
  }).__qaPhase7Positions[sourceId], id)
  const current = () => snapshot<{ currentQuestionId: string }>(page, profile).then(row => row.currentQuestionId)
  if (await current() !== id) {
    const navigator = page.getByRole('navigation', { name: 'Current section questions' })
    if (!await navigator.isVisible()) await page.getByText('Question navigator', { exact: true }).click()
    await navigator.getByRole('button', { name: new RegExp('^Question ' + position.position + '\\b') }).click()
  }
  // The mobile navigator closes on selection. Verify the intended saved
  // question ID instead of checking a button in the closed disclosure.
  await expect.poll(current).toBe(id)
  await expect(page.getByRole('region', { name: 'Question and response' }).getByText(new RegExp('Question ' + position.position + ' of '))).toBeVisible()
  return position
}
