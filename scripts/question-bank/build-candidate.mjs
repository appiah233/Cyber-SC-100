import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { assertOutsideWorktree } from './local-boundary.mjs'
import { projectProtectedScoring } from './local-score-projection.mjs'
import { RELEASE_SCOPE, RELEASE_SCORING_SCOPE } from './release-bank.mjs'

const repo = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
const pinned = new Map([
  ['bank.json', '8bef3463bfc772b0b228dcd7030104c8126d6cadbca9630443d5072f6b64aa68'],
  ['display-bank.json', '7bc33e3ebe4b26ea6f81cae502688a64ec3e921572d7c735d1a44787a82cfb49'],
  ['reference-batch.json', 'c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48'],
])
const scoringPin = 'fcfae55a1f79077c87839f0a1da863018cdc875ebde8f9f63e966a11e71302ce'
const version = 'sc100-c1afae23f990-7cab33ce7722'
// Independently reproduced offline from the pinned PDF, extraction, oracle,
// assets and review metadata. Do not trust mutable checksums beside input files.
const releasePins = Object.freeze({
  version: 'sc100-release-b050d8bdf147ecce012b',
  display: '9e1aeb5e21e5bb143b10566dd5d5ec949013803982661604c5e79b3428eaa626',
  scoring: '009df81717ee57bbe8ce516c7aa896c77ef2983881bf0509fe572a2c7a9b6544',
})
const contained = (dir, path) => {
  const rel = relative(dir, path)
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
const localOnly = () => {
  if (process.env.CI || process.env.GITHUB_ACTIONS) throw new Error('Protected build is disabled in CI.')
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safeCode = { sourcemap: false, minify: true, emptyOutDir: false, copyPublicDir: false, reportCompressedSize: false }

function localExamTiming(env) {
  const raw = env.EXAM_DURATION_MINUTES
  const warn = env.EXAM_TIMER_WARNING_MINUTES
  if (raw === undefined && warn === undefined) return undefined
  const minutes = value => {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('Use configured whole minutes.')
    const count = Number(value)
    if (!Number.isSafeInteger(count * 60_000) || count * 60_000 > Number.MAX_SAFE_INTEGER - Date.now()) {
      throw new Error('The configured exam duration is out of range.')
    }
    return count
  }
  const examDurationMinutes = minutes(raw)
  const timerWarningMinutes = warn === undefined ? [] : warn.split(',').map(part => minutes(part.trim()))
  if (timerWarningMinutes.some(value => value >= examDurationMinutes) || new Set(timerWarningMinutes).size !== timerWarningMinutes.length)
    throw new Error('Configured warning minutes must be unique and less than the exam duration.')
  return { examDurationMinutes, timerWarningMinutes }
}


function localScoringPolicy(env) {
  const value = env.EXAM_PASSING_PERCENTAGE
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(value)) throw new Error('Invalid configured passing percentage.')
  const passingPercentage = Number(value)
  if (passingPercentage < 0 || passingPercentage > 100) throw new Error('Invalid configured passing percentage.')
  return { passingPercentage, scoringVersion: 'phase7-exact-v1-p' + String(passingPercentage).replace('.', '_'), postExamReviewPolicy: 'NONE' }
}

async function main() {
  localOnly()
  const examTiming = localExamTiming(process.env)
  const scoringPolicy = localScoringPolicy(process.env)
  const [mode, ...rest] = process.argv.slice(2)
  const release = mode === '--release'
  const [input, output, ...extra] = release ? rest : [mode, ...rest]
  if (release && (!examTiming || !scoringPolicy)) throw new Error('The protected release needs explicit duration and passing policy.')
  if (!input || !output || extra.length) throw new Error('Supply an external approved bank directory and a new external output directory.')
  const bankDir = await realpath(resolve(input))
  const outDir = join(await realpath(dirname(resolve(output))), basename(resolve(output)))
  if (contained(repo, bankDir) || contained(repo, outDir) || contained(bankDir, outDir)
    || contained(outDir, repo) || contained(outDir, bankDir)) throw new Error('Keep inputs and output separate and outside the checkout.')
  assertOutsideWorktree(bankDir)
  assertOutsideWorktree(dirname(outDir))
  const read = async (name, expected = pinned.get(name)) => {
    const path = join(bankDir, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || path !== await realpath(path) || stat.size > 4 * 1024 * 1024) throw new Error('Invalid pinned input.')
    const bytes = await readFile(path)
    if (sha256(bytes) !== expected) throw new Error('A protected input failed its digest check.')
    return JSON.parse(bytes.toString('utf8'))
  }
  // Check all input bytes before any browser artifact can be produced.
  const projectionId = release ? 'virtual:local-release-display' : 'virtual:local-candidate-display'
  const scratch = await mkdtemp(join(tmpdir(), 'examination-candidate-'))
  let created = false
  try {
    let payload, assetFiles, sealed
    if (release) {
      const [candidate, scoring] = await Promise.all([
        read('release-bank.json', releasePins.display), read('release-scoring.json', releasePins.scoring),
      ])
      if (candidate.scope !== RELEASE_SCOPE || scoring.scope !== RELEASE_SCORING_SCOPE ||
          candidate.bankVersion !== releasePins.version || scoring.bankVersion !== releasePins.version ||
          candidate.inventory.version !== releasePins.version || candidate.contentCounts.publicEligible !== 0 ||
          candidate.inventory.questions.some(question => question.productionEligible) ||
          candidate.inventory.caseStudies.some(family => family.productionEligible))
        throw new Error('Invalid protected release scope.')
      ;({ assetFiles, ...payload } = candidate)
      sealed = scoring
    } else {
      const [bank, display, reference] = await Promise.all([...pinned.keys()].map(name => read(name)))
      const scoringInput = scoringPolicy ? await read('scoring-bank.json', scoringPin) : undefined
      const projectionBuild = join(scratch, 'projector')
      await build({
        root: repo, configFile: false, publicDir: false, logLevel: 'silent',
        build: {
          ...safeCode, ssr: resolve(repo, 'src/data/candidate-reference.ts'), outDir: projectionBuild,
          minify: false, rolldownOptions: { output: { entryFileNames: 'projection.mjs', format: 'es' } },
        },
      })
      const { prepareCandidateReference } = await import(pathToFileURL(join(projectionBuild, 'projection.mjs')).href)
      ;({ assetFiles, ...payload } = prepareCandidateReference(bank, display, reference, version))
      sealed = scoringPolicy ? projectProtectedScoring(payload, bank, scoringInput) : undefined
    }
    const exhibitSources = new Map()
    const copiedRasters = new Map()
    let rasterBytes = 0
    const rasterBudget = (release ? 8 : 2) * 1024 * 1024
    for (const { id, path, checksum } of assetFiles) {
      if (!/^assets\/[A-Za-z0-9][\w-]{0,95}\.png$/.test(path)) throw new Error('Invalid approved exhibit path.')
      const assetPath = join(bankDir, path)
      const stat = await lstat(assetPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || assetPath !== await realpath(assetPath))
        throw new Error('Unverifiable approved exhibit file.')
      const bytes = await readFile(assetPath)
      const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      if (!bytes.subarray(0, 8).equals(pngSignature) || sha256(bytes) !== checksum) throw new Error('Approved exhibit digest mismatch.')
      rasterBytes += bytes.byteLength
      if (rasterBytes > rasterBudget) throw new Error('Approved local exhibit budget exceeded.')
      if (release) {
        const name = basename(path)
        exhibitSources.set(id, 'assets/exhibits/' + name)
        if (copiedRasters.has(name)) throw new Error('Duplicate validated raster filename.')
        copiedRasters.set(name, bytes)
      } else exhibitSources.set(id, 'data:image/png;base64,' + bytes.toString('base64'))
    }
    for (const item of [...Object.values(payload.questions), ...Object.values(payload.contexts)]) {
      for (const asset of item.assets ?? []) {
        const src = exhibitSources.get(asset.id)
        if (release && !src && asset.label === 'Source exhibit placeholder' && asset.src === undefined) continue
        if (!src) throw new Error('Unresolved approved exhibit.')
        asset.src = src
      }
    }
    const serialized = JSON.stringify({ ...payload, ...(examTiming ? { examTiming } : {}), ...(scoringPolicy ? { scoringPolicy } : {}) })
    if (/"(?:rawAnswer|rawExplanation|answerDefinitions|definitions|sourceAnswer|expectedAnswer|score|passThreshold|sourceDocumentChecksum)"/i.test(serialized)) {
      throw new Error('Unexpected non-display data.')
    }
    await mkdir(outDir, { mode: 0o700 })
    created = true
    const runner = resolve(repo, release ? 'src/integration/release-development-runner.tsx' : 'src/integration/development-runner.tsx')
    if (copiedRasters.size) {
      const directory = join(outDir, 'assets', 'exhibits')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      for (const [name, bytes] of copiedRasters) await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' })
    }
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
          output: { entryFileNames: 'candidate.js', assetFileNames: 'candidate.[ext]', codeSplitting: false },
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<title>Examination Hub | Local SC-100 practice</title>
<link rel="stylesheet" href="./candidate.css">
<script type="module" src="./candidate.js"></script>
</head><body><div id="root"></div><noscript>Enable JavaScript to open the local practice examination.</noscript></body></html>
`, { mode: 0o600 })
    if (sealed) {
      // Kept out of the candidate/display bundle. Same-origin load happens only
      // at the durable terminal gate; a static server cannot promise key secrecy
      // against someone who explicitly fetches its development-only path.
      await writeFile(join(outDir, 'candidate-scoring.js'), 'export default ' + JSON.stringify(sealed) + ';\n', { mode: 0o600 })
    }
    await Promise.all(['candidate.js', 'candidate.css'].map(name => chmod(join(outDir, name), 0o600)))
    const quantity = release
      ? payload.contentCounts.eligible + ' questions, ' + payload.contentCounts.caseFamilies + ' case contexts, ' + copiedRasters.size + ' approved rasters. '
      : '59 questions, 2 case contexts. '
    console.log('Built the protected local candidate: ' + quantity + (sealed ? 'Separate local-only scoring module; ' : 'Scoring disabled; ') + 'no network delivery or deployment.')
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
