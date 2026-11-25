import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// This is a deliberate local-only check. Do not import or invoke it from a built client or public CI.
try {
  const external = process.argv[2]
  if (!external) throw new Error('Pass the protected original fixture path as an argument.')
  const project = await realpath(fileURLToPath(new URL('../', import.meta.url)))
  const file = await realpath(resolve(external))
  if (file === project || file.startsWith(project + sep)) throw new Error('The fixture must stay outside the worktree.')
  const bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== 'c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48') {
    throw new Error('Fixture digest differs from the approved Phase 1 manifest.')
  }
  const fixture = JSON.parse(bytes)
  const sizes = fixture.sections.map((section) => section.sourceIds.length)
  if (fixture.fixtureId !== 'REFERENCE-BATCH-001' || fixture.scope !== 'PRIVATE_DEVELOPMENT_ONLY' ||
      fixture.productionEligible !== false || fixture.contentApproved !== false ||
      sizes.join(',') !== '3,3,49,4' ||
      new Set(fixture.sections.flatMap((section) => section.sourceIds)).size !== 59) {
    throw new Error('Fixture shape or private status is invalid.')
  }
  process.stdout.write('Private reference verified: exact approved digest and 3/3/49/4 section counts; 59 distinct source IDs.\n')
} catch (error) {
  process.stderr.write('Private reference check failed: ' + (error instanceof Error && !('code' in error) ? error.message : 'could not read protected file') + '\n')
  process.exitCode = 1
}
