import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { assertOutsideWorktree } from './local-boundary.mjs'

const repo = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
const pinned = new Map([
  ['bank.json', '8bef3463bfc772b0b228dcd7030104c8126d6cadbca9630443d5072f6b64aa68'],
  ['display-bank.json', '7bc33e3ebe4b26ea6f81cae502688a64ec3e921572d7c735d1a44787a82cfb49'],
  ['reference-batch.json', 'c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48'],
])
const version = 'sc100-c1afae23f990-7cab33ce7722'
const contained = (dir, path) => {
  const rel = relative(dir, path)
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
const localOnly = () => {
  if (process.env.CI || process.env.GITHUB_ACTIONS) throw new Error('Protected build is disabled in CI.')
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const projectionId = 'virtual:local-candidate-display'
const safeCode = { sourcemap: false, minify: true, emptyOutDir: false, copyPublicDir: false, reportCompressedSize: false }

async function main() {
  localOnly()
  const [, , input, output, ...extra] = process.argv
  if (!input || !output || extra.length) throw new Error('Supply an external approved bank directory and a new external output directory.')
  const bankDir = await realpath(resolve(input))
  const outDir = join(await realpath(dirname(resolve(output))), basename(resolve(output)))
  if (contained(repo, bankDir) || contained(repo, outDir) || contained(bankDir, outDir)
    || contained(outDir, repo) || contained(outDir, bankDir)) throw new Error('Keep inputs and output separate and outside the checkout.')
  assertOutsideWorktree(bankDir)
  assertOutsideWorktree(dirname(outDir))
  const read = async (name) => {
    const path = join(bankDir, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid pinned input.')
    const bytes = await readFile(path)
    if (sha256(bytes) !== pinned.get(name)) throw new Error('A protected input failed its digest check.')
    return JSON.parse(bytes.toString('utf8'))
  }
  // Check all input bytes before any browser artifact can be produced.
  const [bank, display, reference] = await Promise.all([...pinned.keys()].map(read))
  const scratch = await mkdtemp(join(tmpdir(), 'examination-candidate-'))
  let created = false
  try {
    const projectionBuild = join(scratch, 'projector')
    await build({
      root: repo, configFile: false, publicDir: false, logLevel: 'silent',
      build: {
        ...safeCode, ssr: resolve(repo, 'src/data/candidate-reference.ts'), outDir: projectionBuild,
        minify: false, rolldownOptions: { output: { entryFileNames: 'projection.mjs', format: 'es' } },
      },
    })
    const { prepareCandidateReference } = await import(pathToFileURL(join(projectionBuild, 'projection.mjs')).href)
    const payload = prepareCandidateReference(bank, display, reference, version)
    const serialized = JSON.stringify(payload)
    if (/"(?:rawAnswer|rawExplanation|answerDefinitions|sourceAnswer|expectedAnswer|score|passThreshold|sourceDocumentChecksum)"/i.test(serialized)) {
      throw new Error('Unexpected non-display data.')
    }
    await mkdir(outDir, { mode: 0o700 })
    created = true
    const runner = resolve(repo, 'src/integration/development-runner.tsx')
    const result = await build({
      root: repo, configFile: false, publicDir: false, base: './', logLevel: 'silent',
      plugins: [
        react(),
        {
          name: 'local-development-candidate-display',
          resolveId(id) { return id === projectionId ? '\0' + id : null },
          load(id) { return id === '\0' + projectionId ? 'export default ' + serialized : null },
        },
      ],
      build: {
        ...safeCode, outDir,
        cssCodeSplit: false,
        rolldownOptions: {
          input: runner,
          output: { entryFileNames: 'candidate.js', assetFileNames: 'candidate.[ext]' },
        },
      },
    })
    if (Array.isArray(result) || !('output' in result)
      || result.output.some(file => !['candidate.js', 'candidate.css'].includes(file.fileName))
      || result.output.length !== 2) throw new Error('Unexpected protected build shape.')
    await writeFile(join(outDir, 'index.html'), `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; base-uri 'none'; form-action 'none'">
<title>Examination Hub | Local SC-100 practice</title>
<link rel="stylesheet" href="./candidate.css">
<script type="module" src="./candidate.js"></script>
</head><body><div id="root"></div><noscript>Enable JavaScript to open the local practice examination.</noscript></body></html>
`, { mode: 0o600 })
    await Promise.all(['candidate.js', 'candidate.css'].map(name => chmod(join(outDir, name), 0o600)))
    console.log('Built the protected local candidate: 59 questions, 2 case contexts, no scoring data. No network delivery or deployment.')
  } catch (cause) {
    if (created) await rm(outDir, { recursive: true, force: true })
    throw cause
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

try {
  await main()
} catch {
  // Raw tool errors may include excerpts from the protected input.
  console.error('Local candidate build refused or failed. Check the documented inputs, digests and output location. No examination content was logged.')
  process.exitCode = 1
}
