import { createServer } from 'node:http'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { assertOutsideWorktree } from './local-boundary.mjs'

const [, , bundle, portArg = '4177'] = process.argv
const port = Number(portArg)
if (!bundle || !Number.isInteger(port) || port < 1024 || port > 65535 || process.env.CI || process.env.GITHUB_ACTIONS) {
  console.error('Usage (local desktop only): node scripts/question-bank/serve-candidate.mjs /path/to/local-output [4177]')
  process.exit(1)
}
const directory = await realpath(bundle)
const checkout = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
const paths = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/candidate.js', ['candidate.js', 'text/javascript; charset=utf-8']],
  ['/candidate.css', ['candidate.css', 'text/css; charset=utf-8']],
])
const within = (folder, file) => {
  const rel = relative(folder, file)
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
if (within(checkout, directory)) throw new Error('The protected bundle must be outside the checkout.')
assertOutsideWorktree(directory)
// Load exactly three known local files. Other assets, source/project paths, and
// directory listings cannot be addressed. No request can write to disk.
const resources = new Map()
for (const [url, [filename, contentType]] of paths) {
  const path = join(directory, filename)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4 * 1024 * 1024
    || path !== await realpath(path)) throw new Error('Invalid protected bundle file.')
  resources.set(url, { bytes: await readFile(path), contentType })
}
createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  const item = resources.get(req.url?.split('?')[0])
  if (req.headers.host !== `127.0.0.1:${port}` || !item || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404).end()
    return
  }
  res.setHeader('Content-Type', item.contentType)
  res.end(req.method === 'HEAD' ? undefined : item.bytes)
}).listen(port, '127.0.0.1', () => {
  console.log(`Protected practice exam ready on this computer only: http://127.0.0.1:${port}/`)
})
