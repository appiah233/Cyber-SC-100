import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { build } from 'vite'
import type { ExamAttempt, ScoredExamResult } from '../../src/domain/model'
import type { CycleLifecycle } from '../../src/domain/cycle-lifecycle'

export const releaseBase = '/Cyber-SC-100/'
export const releaseDatastore = 'qa-release-browser-store'
export const releaseJourneyKey = 'qa-release-browser'
const source = fileURLToPath(new URL('../fixtures/release-browser-source.ts', import.meta.url))
const cycleRunner = fileURLToPath(new URL('../../src/integration/CycleJourney.tsx', import.meta.url))
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

export async function releaseHarness() {
  const buildResult = await build({
    base: releaseBase, logLevel: 'silent', build: { write: false },
    plugins: [{
      name: 'qa-release-cycle-source', enforce: 'pre',
      transform(code, path) {
        if (!path.endsWith('/src/main.tsx')) return
        const mount = /<(?:Foundation|CycleJourney)(?:\s+[^<>]*?)?\s*\/>/
        if (!mount.test(code)) throw new Error('The fixture needs the actual candidate entry')
        return `import { releaseTestFixture } from ${JSON.stringify(source)};
import { CycleJourney as QaCycleJourney } from ${JSON.stringify(cycleRunner)};
${code.replace(mount, '<QaCycleJourney configuration={releaseTestFixture} />')}`
      },
    }],
  })
  if ('getOutput' in buildResult || 'close' in buildResult) throw new Error('Expected a non-watching in-memory build')
  const output = Array.isArray(buildResult) ? buildResult[0] : buildResult
  const files = new Map<string, string | Uint8Array>(output.output.map(item => [
    releaseBase + item.fileName, item.type === 'chunk' ? item.code : item.source,
  ]))
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const path = pathname === releaseBase ? pathname + 'index.html' : pathname
    const file = files.get(path)
    if (file === undefined) { response.writeHead(404); response.end('Not found'); return }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' })
    response.end(file)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  const origin = 'http://127.0.0.1:' + address.port
  return {
    origin,
    url: origin + releaseBase,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

export type ReleaseHarness = Awaited<ReturnType<typeof releaseHarness>>
export type ReleaseAttempt = ExamAttempt & { currentQuestionId?: string; result: ScoredExamResult | null }
export type JourneyPointer = { id: string; attemptId: string; cycleId: string; contentVersion: string }
export type ReleaseStore = {
  journey: JourneyPointer | undefined
  attempt: ReleaseAttempt | undefined
  lifecycle: CycleLifecycle | undefined
  attemptKeys: string[]
}
export type Corruption = 'missing-attempt' | 'cursor' | 'section' | 'missing-batch' | 'old-bank' | 'missing-cycle'

export async function releaseStore(page: Page, corruption?: Corruption): Promise<ReleaseStore> {
  return page.evaluate(([database, key, broken]) => new Promise<ReleaseStore>((resolve, reject) => {
    const open = indexedDB.open(database)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction(['journeys', 'attempts', 'cycles'], broken ? 'readwrite' : 'readonly')
      const journals = transaction.objectStore('journeys')
      const attempts = transaction.objectStore('attempts')
      const cycles = transaction.objectStore('cycles')
      let pointer: JourneyPointer | undefined
      let attempt: ReleaseAttempt | undefined
      let lifecycle: CycleLifecycle | undefined
      const all = attempts.getAllKeys()
      const journal = journals.get(key)
      journal.onsuccess = () => {
        pointer = journal.result as JourneyPointer | undefined
        if (!pointer) return
        const row = attempts.get(pointer.attemptId)
        const cycle = cycles.get(pointer.cycleId)
        cycle.onsuccess = () => {
          lifecycle = (cycle.result as { cycle?: { lifecycle?: CycleLifecycle } } | undefined)?.cycle?.lifecycle
          if (broken === 'missing-cycle') cycles.delete(pointer!.cycleId)
        }
        row.onsuccess = () => {
          const saved = row.result as { attempt?: ReleaseAttempt } | undefined
          attempt = saved?.attempt
          if (!saved || !attempt || !broken) return
          if (broken === 'missing-attempt') attempts.delete(pointer!.attemptId)
          if (broken === 'cursor') attempts.put({ ...saved, attempt: { ...attempt, currentQuestionId: 'qa-invalid-cursor' } })
          if (broken === 'section') attempts.put({ ...saved, attempt: { ...attempt, activeSection: 'qa-invalid-section' } })
          if (broken === 'missing-batch') attempts.put({ ...saved, attempt: { ...attempt, batch: { ...attempt.batch, id: 'qa-invalid-batch' } } })
          if (broken === 'old-bank') journals.put({ ...pointer, contentVersion: 'qa-retired-bank' })
        }
      }
      transaction.oncomplete = () => { db.close(); resolve({ journey: pointer, attempt, lifecycle, attemptKeys: all.result.map(String) }) }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
      transaction.onabort = () => { db.close(); reject(transaction.error) }
    }
  }), [releaseDatastore, releaseJourneyKey, corruption] as const)
}
