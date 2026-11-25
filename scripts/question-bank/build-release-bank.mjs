import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, ORACLE_SHA, REFERENCE_SHA, SOURCE_SHA } from './bank.mjs'
import { assertOutsideWorktree } from './local-boundary.mjs'
import { compileReleaseBank } from './release-bank.mjs'

const extractionPin = '5a93a3821d56d86a376b019ee87de7baeee8c93a0cabe59bb1c6767add6ee2f7'
const assetManifestPin = 'a77c23f53f33e0920b8169874846d251c79d5489519d29904dd145982468fd1f'
const reviewPin = '2a360f2c49ba830876e2cf9aa2696741b1d1f258216cc10dfb16a5a450fd9021'
const fail = (code) => { throw new Error(code) }

async function input(path, digestPin, maxBytes, binary = false) {
  const candidate = resolve(path)
  assertOutsideWorktree(dirname(candidate))
  const metadata = await lstat(candidate)
  if (!metadata.isFile() || metadata.size > maxBytes || candidate !== await realpath(candidate))
    fail('INVALID_PINNED_LOCAL_INPUT')
  const bytes = await readFile(candidate)
  if (digest(bytes) !== digestPin) fail('RELEASE_PROTECTED_INPUT_DIGEST_MISMATCH')
  return binary ? bytes : JSON.parse(bytes)
}
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')

async function main() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) fail('RELEASE_PRIVATE_COMPILATION_DISABLED_IN_CI')
  const [pdf, source, assets, review, reference, oracle, output, ...extra] = process.argv.slice(2)
  if (!pdf || !source || !assets || !review || !reference || !oracle || !output || extra.length)
    fail('RELEASE_PROTECTED_INPUTS_REQUIRED')
  await input(pdf, SOURCE_SHA, 64 * 1024 * 1024, true)
  const [sourceJson, assetManifest, reviewJson, referenceJson, oracleJson] = await Promise.all([
    input(source, extractionPin, 4 * 1024 * 1024), input(assets, assetManifestPin, 1024 * 1024),
    input(review, reviewPin, 1024 * 1024), input(reference, REFERENCE_SHA, 1024 * 1024),
    input(oracle, ORACLE_SHA, 4 * 1024 * 1024),
  ])
  const evidence = spawnSync('python3', [fileURLToPath(new URL('./release-asset-proof.py', import.meta.url)), resolve(pdf), resolve(assets)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4096, timeout: 10_000,
  })
  if (evidence.status !== 0) fail('RELEASE_PDF_PLACEMENT_CHECK_FAILED')
  const sourceAssetProof = JSON.parse(evidence.stdout)
  const { bank, scoring, audit } = compileReleaseBank({
    source: sourceJson, assetManifest, review: reviewJson, reference: referenceJson,
    referenceDigest: REFERENCE_SHA, oracle: oracleJson, sourceAssetProof,
  })
  const bankBytes = json(bank), scoringBytes = json(scoring), auditBytes = json(audit)
  const outputPath = resolve(output)
  const parent = await realpath(dirname(outputPath))
  if (parent !== dirname(outputPath)) fail('RELEASE_OUTPUT_LINKED_PARENT')
  assertOutsideWorktree(parent)
  const material = join(parent, basename(outputPath))
  await mkdir(material, { mode: 0o700 })
  try {
    await mkdir(join(material, 'assets'), { mode: 0o700 })
    for (const asset of bank.assetFiles) {
      if (!/^assets\/[A-Za-z0-9][\w-]{0,95}\.png$/.test(asset.path)) fail('RELEASE_INVALID_ASSET_PATH')
      const bytes = await input(join(dirname(resolve(assets)), asset.path), asset.checksum, 2 * 1024 * 1024, true)
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || bytes.readUInt32BE(16) !== asset.dimensions[0] ||
          bytes.readUInt32BE(20) !== asset.dimensions[1]) fail('RELEASE_INVALID_RASTER')
      await writeFile(join(material, asset.path), bytes, { mode: 0o600, flag: 'wx' })
    }
    const digests = {
      scope: 'PRIVATE_RELEASE_CANDIDATE_MANIFEST_ONLY',
      bankVersion: bank.bankVersion, candidate: digest(bankBytes), scoring: digest(scoringBytes), audit: digest(auditBytes),
    }
    for (const [name, bytes] of [
      ['release-bank.json', bankBytes], ['release-scoring.json', scoringBytes], ['release-audit.json', auditBytes],
      ['release-manifest.json', json(digests)],
    ]) await writeFile(join(material, name), bytes, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({
      sourceGate: 'PASS', ...bank.contentCounts, sourceAnswerDifferences: audit.sourceAnswerDifferences,
      verifiedSourceAssetPlacements: sourceAssetProof.placementsChecked, selectedRasterFiles: bank.assetFiles.length, ...digests,
    }))
  } catch (error) {
    await rm(material, { recursive: true, force: true })
    throw error
  }
}

try {
  await main()
} catch (error) {
  const code = error instanceof Error && /^RELEASE_[A-Z0-9_]+$/.test(error.message)
    ? error.message : 'RELEASE_PRIVATE_INPUT_OR_IO_ERROR'
  console.error(code + ': no source data printed.')
  process.exitCode = 1
}
