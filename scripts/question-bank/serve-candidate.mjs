import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { assertOutsideWorktree } from './local-boundary.mjs'

const [, , bundle, portArg = '4177', mode, ...extra] = process.argv
const pagesPath = mode === '--pages-equivalent' ? '/Cyber-SC-100' : ''
if ((mode && !pagesPath) || extra.length) throw new Error('Unrecognized protected server option.')
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
// Serve only known local files. The optional local scoring module is never
// included in the default public build or fetched by an active candidate.
try {
  await lstat(join(directory, 'candidate-scoring.js'))
  paths.set('/candidate-scoring.js', ['candidate-scoring.js', 'text/javascript; charset=utf-8'])
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
// The private release contains only copied, digest-verified rasters. Serve a
// bounded list of plain basenames; never traverse request paths or list a folder.
const exhibitDir = join(directory, 'assets', 'exhibits')
try {
  if (exhibitDir !== await realpath(exhibitDir)) throw new Error('Invalid exhibit location.')
  const entries = await readdir(exhibitDir, { withFileTypes: true })
  if (entries.length > 27) throw new Error('Too many private release assets.')
  for (const entry of entries) {
    if (!entry.isFile() || !/^sc100-x[0-9]{4}-[a-f0-9]{16}\.png$/.test(entry.name)) throw new Error('Invalid release exhibit.')
    paths.set('/assets/exhibits/' + entry.name, ['assets/exhibits/' + entry.name, 'image/png'])
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const resources = new Map()
for (const [url, [filename, contentType]] of paths) {
  const path = join(directory, filename)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4 * 1024 * 1024
    || path !== await realpath(path)) throw new Error('Invalid protected bundle file.')
  const bytes = await readFile(path)
  if (contentType === 'image/png') {
    const suffix = filename.match(/-([a-f0-9]{16})\.png$/)?.[1]
    if (!suffix || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || !createHash('sha256').update(bytes).digest('hex').startsWith(suffix)) throw new Error('Protected raster signature mismatch.')
  }
  resources.set(pagesPath + url, { bytes, contentType })
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
  console.log(`Protected practice exam ready on this computer only: http://127.0.0.1:${port}${pagesPath}/`)
})
