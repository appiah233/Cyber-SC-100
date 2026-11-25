import { lstat, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const ignoredWorkDirs = new Set([
  '.git', 'node_modules', 'dist', 'coverage', 'playwright-report', 'test-results',
]);
const origin = 'https://exam-foundation.invalid';
const base = '/Cyber-SC-100/';
const distAsset = /^assets\/[\w.-]+\.(?:js|css|svg)$/i;
const firstPartyIcon = /^(?:favicon|exam-icon)\.svg$/i;

// A denylist only catches known mistakes. Do not put private materials in the checkout.
const privatePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.(?:pdf|map|zip|tgz|tar|pem|pfx|p12|key|pyc)|\.?private(?:[-_.][^/]*)?|reference[-_]batch[-_]\d+(?:\.[^/]*)?|answer[-_]keys?(?:\.[^/]*)?|scoring[-_]bank\.json|review[-_]outputs?|sc100-x\d+-[a-f0-9]{16}\.png|sc100-q\d{3}-p\d{3}-exhibit-\d{2}-(?:crop-)?[a-f0-9]{16}\.png|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?)($|\/)/i;
const materialMarkers = [
  /(?:^|\b)%PDF-\d|data:application\/pdf|\bJVBERi0[A-Za-z0-9+/]{12,}/i,
  /["'](?:rawAnswer(?:Text|Block)?|rawExplanation|sourceAnswer|sourcePdfSha256)["']\s*:\s*["'][^"'\r\n]+/i,
  /["'](?:rawAnswerBlock|rawExplanationLayout|rawQuestionAreaLayout)["']\s*:\s*\[\s*["'][^"'\r\n]+/i,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
];
const bundledOnlyMarkers = [
  /\bREFERENCE[-_]BATCH[-_]\d+\b/i,
  /\b(?:PRIVATE_DEVELOPMENT_ONLY|PRIVATE_EXAM_CONTENT_CANARY)\b/,
  /(?:\/\/|\/\*)[#@]\s*sourceMappingURL\s*=/,
  /\b(?:private[-_](?:source[-_]?map|answer[-_]?key)|raw[-_]source[-_]pdf)\b/i,
];
const privateJsonScope = /"scope"\s*:\s*"PRIVATE_DEVELOPMENT_ONLY"/;
const privateReviewHtml = /<title>\s*Private source review\s*<\/title>/i;
const unsafeSvg = /<\s*(?:script|foreignobject|iframe|object|embed)\b|\bon\w+\s*=|(?:xlink:)?href\s*=\s*["']\s*(?!#)[^"']+/i;
const unsafeApplicationSink = /\bdangerouslySetInnerHTML\b|\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|\bdocument\.write\s*\(/;
const rootText = /\.(?:m?[jt]sx?|css|json|md|html?|ya?ml|toml|txt|svg|xml|py)$/i;

async function walk(dir, prefix, skipRootDirectories, records) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      records.push({ relative, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      if (!prefix && skipRootDirectories?.has(entry.name)) continue;
      if (privatePath.test(relative)) records.push({ relative, blockedDirectory: true });
      else await walk(resolve(dir, entry.name), relative, skipRootDirectories, records);
    } else {
      records.push({ relative, regular: entry.isFile(), absolute: resolve(dir, entry.name) });
    }
  }
}

function inspectTrackedPaths(dir, issues) {
  try {
    const tracked = execFileSync('git', ['ls-files', '--stage', '-z'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 ** 20,
    });
    for (const row of tracked.split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      const mode = row.slice(0, 6);
      const path = row.slice(tab + 1);
      if (mode === '120000' || mode === '160000') issues.push('unsupported-tracked-entry');
      if (path.includes('/') && ignoredWorkDirs.has(path.split('/')[0])) issues.push('tracked-tool-output');
    }
  } catch {
    // Local review may be performed in an exported review directory.
  }
}

function checkResource(reference, path, available, issues) {
  if (!reference || reference.startsWith('#')) return;
  try {
    const resolved = new URL(reference, `${origin}${base}${path}`);
    if (
      resolved.origin !== origin ||
      !resolved.pathname.startsWith(base) ||
      !available.has(decodeURIComponent(resolved.pathname.slice(base.length)))
    ) {
      issues.push('unapproved-or-missing-resource');
    }
  } catch {
    issues.push('invalid-resource-reference');
  }
}

export async function inspectPublicBoundary(directory, mode) {
  if (mode !== 'source' && mode !== 'dist') throw new Error('Unknown validation mode');
  const dir = resolve(directory);
  const issues = [];
  const stats = await lstat(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { inspected: 0, issues: ['invalid-scan-root'] };
  }
  const records = [];
  await walk(dir, '', mode === 'source' ? ignoredWorkDirs : undefined, records);
  if (mode === 'source') inspectTrackedPaths(dir, issues);
  const available = new Set(records.map(({ relative }) => relative));
  if (mode === 'dist' && !available.has('index.html')) issues.push('missing-entry');

  for (const record of records) {
    const { relative, symlink, regular, absolute } = record;
    if (symlink || !regular) {
      issues.push('unsupported-file-or-directory');
      continue;
    }
    if (privatePath.test(relative)) {
      issues.push('restricted-file-path');
      continue;
    }
    if (mode === 'dist' && relative !== 'index.html' && !distAsset.test(relative) && !firstPartyIcon.test(relative)) {
      issues.push('unapproved-dist-file');
      continue;
    }
    const raw = await readFile(absolute);
    if (/^%PDF-\d\.\d/.test(raw.subarray(0, 16).toString('latin1'))) issues.push('pdf-content');
    if (mode === 'source' && !rootText.test(relative)) continue;
    const content = raw.toString('utf8');
    if (materialMarkers.some(pattern => pattern.test(content))) issues.push('restricted-content-marker');
    if ((/\.json$/i.test(relative) && privateJsonScope.test(content)) ||
        (/\.html?$/i.test(relative) && privateReviewHtml.test(content))) {
      issues.push('restricted-private-projection');
    }
    if (mode === 'source' && relative.startsWith('src/') && /\.[jt]sx?$/.test(relative) && unsafeApplicationSink.test(content)) issues.push('unsafe-application-markup-sink');
    if (mode === 'dist' && bundledOnlyMarkers.some(pattern => pattern.test(content))) issues.push('restricted-bundle-marker');
    if (/\.svg$/i.test(relative) && unsafeSvg.test(content)) issues.push('unsafe-svg-content');
    if (mode === 'dist' && relative === 'index.html') {
      const scripts = [...content.matchAll(/<script\b([^>]*)>/gi)].map(match => match[1]);
      let hasModuleEntry = false;
      for (const attrs of scripts) {
        const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
        if (!source) issues.push('inline-script');
        else if (/\btype\s*=\s*["']module["']/i.test(attrs) && /\.js(?:[?#]|$)/i.test(source)) {
          hasModuleEntry = true;
        }
      }
      if (!hasModuleEntry) issues.push('missing-module-entry');
      for (const [, reference] of content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        checkResource(reference, relative, available, issues);
      }
    }
    if (mode === 'dist' && /\.css$/i.test(relative)) {
      for (const [, reference] of content.matchAll(/@import\s*["']([^"']+)["']/gi)) {
        checkResource(reference.trim(), relative, available, issues);
      }
      for (const [, reference] of content.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        checkResource(reference.trim(), relative, available, issues);
      }
    }
  }
  return { inspected: records.length, issues: issues.sort() };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'source' && mode !== 'dist') {
    process.stderr.write('Usage: node scripts/validation/public-boundary.mjs source|dist\n');
    process.exitCode = 2;
    return;
  }
  try {
    const { inspected, issues } = await inspectPublicBoundary(mode === 'dist' ? 'dist' : '.', mode);
    if (issues.length) {
      const counts = Object.fromEntries([...new Set(issues)].map(issue => [issue, issues.filter(item => item === issue).length]));
      process.stderr.write(`Public ${mode} boundary failed: ${JSON.stringify(counts)}. Inspect locally; no file paths or contents were logged.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Public ${mode} boundary passed (${inspected} files).\n`);
    }
  } catch {
    process.stderr.write(`Public ${mode} boundary could not be read. Inspect the checkout or build locally.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
