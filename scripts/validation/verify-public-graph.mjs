import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const filesOfInterest = new Set(['index.html', 'src/main.tsx']);
const protectedModules = /^(?:(?:src\/integration\/(?:release-)?development-(?:runner|module)|src\/data\/(?:development-bank|cycle-inventory|candidate-reference))(?:\.[^/]*)?$|scripts\/question-bank(?:\/|$))/i;
const protectedVirtual = /(?:^|\/)virtual:local-(?:candidate|release)-display(?:$|[?#])/i;

const slashes = (value) => value.replaceAll('\\', '/');

export function inspectPublicGraph(moduleIds, projectRoot) {
  const root = slashes(resolve(projectRoot)).replace(/\/$/, '') + '/';
  const found = new Set();
  const issues = new Set();
  for (const id of moduleIds) {
    const normalized = slashes(id).replace(/^\0/, '');
    const path = normalized.split(/[?#]/, 1)[0];
    const local = (path.startsWith(root) ? path.slice(root.length) : path)
      .replace(/^\//, '').replace(/^\.\//, '');
    if (protectedVirtual.test(normalized) || protectedModules.test(local)) {
      issues.add('private-module-in-public-graph');
    }
    if (filesOfInterest.has(local)) found.add(local);
  }
  if (found.size !== filesOfInterest.size) issues.add('missing-expected-public-entry');
  return [...issues].sort();
}

async function* listScripts(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) yield* listScripts(resolve(dir, entry.name), relative + '/');
    else if (/\.js$/i.test(relative)) yield relative;
  }
}

export async function comparePublicEmissions(output, distRoot) {
  const issues = new Set();
  const scripts = new Set();
  const root = await realpath(distRoot);
  if (!(await lstat(distRoot)).isDirectory()) return ['invalid-public-dist-root'];
  for (const item of output) {
    const file = item.fileName;
    // Vite's emitters use normalized relative filenames; don't follow output outside dist.
    if (!file || file.startsWith('/') || file.includes('\\')
      || file.split('/').some((part) => !part || part === '.' || part === '..')
      || /^[a-z]:/i.test(file)) {
      issues.add('unapproved-build-emission');
      continue;
    }
    if (item.type === 'chunk') scripts.add(file);
    try {
      const absolute = resolve(root, file);
      if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile()) {
        issues.add('unapproved-build-emission');
        continue;
      }
      const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
      if (!bytes.equals(await readFile(absolute))) issues.add('build-emission-mismatch');
    } catch {
      issues.add('build-emission-mismatch');
    }
  }
  if (!scripts.size) issues.add('missing-public-script-emission');
  for await (const script of listScripts(root)) {
    if (!scripts.has(script)) issues.add('unexpected-dist-script');
  }
  return [...issues].sort();
}

async function main() {
  try {
    const { build } = await import('vite');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const modules = new Set();
    // Load the normal production config. Do not replace its entry or enable a
    // special mode: the verification must see the graph of the ordinary Pages build.
    const result = await build({
      root,
      logLevel: 'silent',
      build: { write: false },
      plugins: [{
        name: 'examination-hub:verify-public-entry',
        generateBundle() {
          for (const id of this.getModuleIds()) modules.add(id);
        },
      }],
    });
    const builds = Array.isArray(result) ? result : [result];
    if (builds.some((entry) => !Array.isArray(entry.output))) throw new Error('Expected ordinary public build output');
    const output = builds.flatMap((entry) => entry.output);
    const issues = [
      ...inspectPublicGraph(modules, root),
      ...await comparePublicEmissions(output, resolve(root, 'dist')),
    ];
    if (issues.length) {
      process.stderr.write(`Public build graph failed: ${issues.sort().join(', ')}. No module IDs, paths, or file content were logged.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Public build graph passed (${modules.size} modules; ${output.length} emissions matched dist).\n`);
  } catch {
    process.stderr.write('Public build graph or emitted files could not be verified. Inspect the public build locally.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
