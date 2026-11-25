import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPublicBoundary } from './public-boundary.mjs';
import { comparePublicEmissions, inspectPublicGraph } from './verify-public-graph.mjs';

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'exam-boundary-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    const file = parts.pop();
    const parent = join(dir, ...parts);
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, file), text);
  }
}

test('accepts intended public source and excludes ordinary generated local output', () => withDirectory(async dir => {
  await write(dir, {
    'src/contract.ts': 'export type SourceQuestion = { readonly rawAnswer: string };',
    'README.md': 'Private reference data must stay outside this checkout.',
    'dist/placeholder.map': '{}',
    'node_modules/dependency.js': '',
  });
  assert.deepEqual(await inspectPublicBoundary(dir, 'source'), { inspected: 2, issues: [] });
}));

test('rejects blocked source paths, disguised private content and symlinks', () => withDirectory(async dir => {
  await write(dir, {
    'public/sample.pdf': 'not a real PDF',
    'src/notes.txt': JSON.stringify({ rawAnswer: 'synthetic safety canary' }),
    'src/hidden.bin': ['%P', 'DF-1.7'].join(''),
    'src/file.ts': 'export const synthetic = 1;',
  });
  await symlink(join(dir, 'src/file.ts'), join(dir, 'public/link.ts'), 'file');
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, [
    'pdf-content', 'restricted-content-marker', 'restricted-file-path', 'unsupported-file-or-directory',
  ]);
}));

test('accepts Vite output with entry and assets under the Pages base', () => withDirectory(async dir => {
  await write(dir, {
    'index.html': '<link rel="stylesheet" href="/Cyber-SC-100/assets/main.css"><script type="module" src="/Cyber-SC-100/assets/main.js"></script>',
    'assets/main.js': 'console.log("synthetic shell");',
    'assets/main.css': 'main { background-image: url("./mark.svg"); }',
    'assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>',
  });
  assert.deepEqual(await inspectPublicBoundary(dir, 'dist'), { inspected: 4, issues: [] });
}));

test('rejects root-only links, missing files, metadata leaks and source maps', () => withDirectory(async dir => {
  await write(dir, {
    'index.html': '<link rel="stylesheet" href="/Cyber-SC-100/assets/missing.css"><script type="module" src="/assets/main.js"></script>',
    'assets/main.js': "export const sample = '" + ['PRIVATE_EXAM_', 'CONTENT_CANARY'].join('') + "';",
    'assets/main.js.map': '{}',
    'notes.txt': 'not an approved output',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'dist')).issues, [
    'restricted-bundle-marker', 'restricted-file-path', 'unapproved-dist-file',
    'unapproved-or-missing-resource', 'unapproved-or-missing-resource',
  ]);
}));

test('rejects an inline script claiming to be a Vite module entry', () => withDirectory(async dir => {
  await write(dir, {
    'index.html': '<script type="module">console.log("synthetic inline");</script>',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'dist')).issues, ['inline-script', 'missing-module-entry']);
}));

test('rejects unsafe application markup sinks and external styles', () => withDirectory(async dir => {
  await write(dir, {
    'src/view.ts': 'export function apply(node: Element) { node.innerHTML = ""; }',
    'docs/design.md': 'Do not use dangerouslySetInnerHTML in the shell.',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, ['unsafe-application-markup-sink']);
  await rm(join(dir, 'src'), { recursive: true });
  await rm(join(dir, 'docs'), { recursive: true });
  await write(dir, {
    'index.html': '<script type="module" src="./assets/main.js"></script>',
    'assets/main.js': '',
    'assets/main.css': '@import "https://example.invalid/test.css";',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'dist')).issues, ['unapproved-or-missing-resource']);
}));

test('rejects private checkout directories and extracted record data in pipeline source', () => withDirectory(async dir => {
  await write(dir, {
    '.private/notes.txt': 'synthetic marker only',
    'scripts/source/pipeline.py': 'example = ' + JSON.stringify({ [['Raw', 'AnswerBlock'].join('')]: ['synthetic review canary'] }),
    'scripts/source/__pycache__/pipeline.pyc': 'not a retained binary',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, [
    'restricted-content-marker', 'restricted-file-path', 'unsupported-file-or-directory',
  ]);
}));

test('rejects renamed private projections and viewer output without reading them into logs', () => withDirectory(async dir => {
  await write(dir, {
    'src/data/mislabeled.json': JSON.stringify({ scope: 'PRIVATE_DEVELOPMENT_ONLY', questions: [] }),
    'docs/mislabeled.htm': '<title>Private source review</title><p>Synthetic marker.</p>',
    'src/data/scoring-bank.json': '{}',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, [
    'restricted-file-path', 'restricted-private-projection', 'restricted-private-projection',
  ]);
}));

test('keeps generated source-crop and review-output naming lanes out of public source', () => withDirectory(async dir => {
  await write(dir, {
    'public/assets/sc100-x0000-aaaaaaaaaaaaaaaa.png': 'synthetic absent PNG bytes',
    'src/data/sc100-q000-p000-exhibit-00-crop-bbbbbbbbbbbbbbbb.png': 'synthetic marker only',
    'assets/sc100-q000-p000-exhibit-00-cccccccccccccccc.png': 'synthetic preview naming',
    'review-output/innocuous.txt': 'synthetic marker only',
    'scripts/question-bank/review.mjs': 'export const safe = true;',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, [
    'restricted-file-path', 'restricted-file-path', 'restricted-file-path', 'unsupported-file-or-directory',
  ]);
}));

test('public entry graph must use the public HTML and boot module without private dependencies', () => withDirectory(async dir => {
  const ordinary = [join(dir, 'index.html'), join(dir, 'src/main.tsx')];
  assert.deepEqual(inspectPublicGraph(ordinary, dir), []);
  for (const privateId of [
    join(dir, 'src/integration/development-runner.tsx') + '?compiled',
    join(dir, 'src/integration/development-module.d.ts'),
    join(dir, 'src/integration/release-development-runner.tsx'),
    join(dir, 'src/integration/release-development-module.d.ts'),
    join(dir, 'src/data/development-bank.ts'),
    join(dir, 'src/data/cycle-inventory.ts'),
    join(dir, 'src/data/candidate-reference.ts'),
    join(dir, 'scripts/question-bank/build-candidate.mjs'),
    '\0' + ['virtual:', 'local-candidate-display'].join(''),
    '\0' + ['virtual:', 'local-release-display'].join('') + '?compiled',
  ]) {
    assert.deepEqual(inspectPublicGraph([...ordinary, privateId], dir), ['private-module-in-public-graph']);
  }
  assert.deepEqual(inspectPublicGraph(ordinary.slice(1), dir), ['missing-expected-public-entry']);
}));

test('in-memory verification matches the exact ordinary dist and rejects unexpected scripts', () => withDirectory(async dir => {
  const output = [
    { type: 'asset', fileName: 'index.html', source: 'Synthetic entry' },
    { type: 'chunk', fileName: 'assets/main.js', code: 'export const demo = 1;' },
  ];
  await write(dir, { 'index.html': output[0].source, 'assets/main.js': output[1].code });
  assert.deepEqual(await comparePublicEmissions(output, dir), []);
  await write(dir, { 'index.html': 'Unexpected entry', 'assets/unverified.js': '' });
  assert.deepEqual(await comparePublicEmissions(output, dir), ['build-emission-mismatch', 'unexpected-dist-script']);
  assert.deepEqual(await comparePublicEmissions([...output, { type: 'asset', fileName: '../outside', source: '' }], dir), [
    'build-emission-mismatch', 'unapproved-build-emission', 'unexpected-dist-script',
  ]);
}));

test('rejects a private candidate virtual module marker in otherwise allowed dist JavaScript', () => withDirectory(async dir => {
  await write(dir, {
    'index.html': '<script type="module" src="./assets/main.js"></script>',
    'assets/main.js': 'export const marker = "' + ['virtual:', 'local-candidate-display'].join('') + '";',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'dist')).issues, ['restricted-bundle-marker']);
}));

test('candidate visual evidence is not part of the public checkout', () => withDirectory(async dir => {
  await write(dir, {
    'phase5-evidence/screenshots/start.png': 'synthetic image marker',
    'work/phase-7-evidence/notes.md': 'synthetic evidence marker',
    'release-evidence/start.png': 'synthetic image marker',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, Array(3).fill('unsupported-file-or-directory'));
}));

test('blocks protected local scoring by path, route, and retained canary while permitting fictional scoring', () => withDirectory(async dir => {
  await write(dir, {
    'index.html': '<script type="module" src="./assets/main.js"></script>',
    'assets/main.js': 'export const practice = () => import("./synthetic-practice-scoring.js");',
    'assets/synthetic-practice-scoring.js': 'export const practice = { fictional: true };',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'dist')).issues, []);
  await write(dir, {
    'assets/candidate-scoring.js': 'export default {};',
    'assets/renamed.js': 'export const marker = "' + ['PRIVATE_EXAM', 'SCORING_CANARY'].join('_') + '";',
    'assets/loader.js': 'const route = "' + ['candidate','scoring.js'].join('-') + '";',
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'dist')).issues, [
    'restricted-bundle-marker', 'restricted-bundle-marker', 'restricted-file-path',
  ]);
}));

test('blocks protected full-bank artifacts in checkout and copied markers in public output', () => withDirectory(async dir => {
  const displayScope = ['PRIVATE_RELEASE', 'CANDIDATE_ONLY'].join('_');
  const answerScope = ['PRIVATE_RELEASE', 'CANDIDATE_SCORING_ONLY'].join('_');
  const auditScope = ['PRIVATE_RELEASE', 'CANDIDATE_AUDIT_ONLY'].join('_');
  const manifestScope = ['PRIVATE_RELEASE', 'CANDIDATE_MANIFEST_ONLY'].join('_');
  await write(dir, {
    'documents/release-bank.json': '{}',
    'public/RELEASE_scoring.JSON': '{}',
    'evidence/release-audit.json': '{}',
    'evidence/release-manifest.json': '{}',
    'notes/display-copy.json': JSON.stringify({ manifest: { scope: displayScope } }),
    'notes/answer-copy.json': JSON.stringify({ scope: answerScope }),
    'notes/audit-copy.json': JSON.stringify({ scope: auditScope }),
    'notes/manifest-copy.json': JSON.stringify({ scope: manifestScope }),
  });
  assert.deepEqual((await inspectPublicBoundary(dir, 'source')).issues, [
    ...Array(4).fill('restricted-file-path'), ...Array(4).fill('restricted-private-projection'),
  ]);
  const dist = join(dir, 'dist');
  await write(dist, {
    'index.html': '<script type="module" src="./assets/index.js"></script>',
    'assets/index.js': 'export const practice = true;',
    'assets/display.js': 'export const label = "' + displayScope + '";',
    'assets/scoring.js': 'export const label = "' + answerScope + '";',
    'assets/audit.js': 'export const label = "' + auditScope + '";',
    'assets/manifest.js': 'export const label = "' + manifestScope + '";',
    'assets/loader.js': 'export const local = "' + ['virtual:', 'local-release-display'].join('') + '";',
    'assets/route.js': 'export const local = "' + ['release','bank.json'].join('-') + '";',
  });
  assert.deepEqual((await inspectPublicBoundary(dist, 'dist')).issues, Array(6).fill('restricted-bundle-marker'));
}));
