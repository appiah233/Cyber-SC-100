import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const prefix = '/Cyber-SC-100/'
const port = Number(process.env.PLAYWRIGHT_STATIC_PORT ?? 4177)
const root = await realpath(resolve('dist'))
if (!(await stat(resolve(root, 'index.html'))).isFile()) {
  throw new Error('Build the application before testing the static output.')
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

function notFound(response) {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Not found')
}

createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }
  try {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (!path.startsWith(prefix)) return notFound(response)
    const relativePath = decodeURIComponent(path.slice(prefix.length)) || 'index.html'
    const file = await realpath(resolve(root, relativePath))
    if (!file.startsWith(root + sep)) return notFound(response)
    const fileStat = await stat(file)
    if (!fileStat.isFile()) return notFound(response)
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') return response.end()
    createReadStream(file).on('error', () => response.destroy()).pipe(response)
  } catch {
    notFound(response)
  }
}).listen(port, '127.0.0.1')
