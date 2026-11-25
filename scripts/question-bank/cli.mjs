import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileBank, digest, displayOnly, indexSource, ORACLE_SHA, REFERENCE_SHA, verifyBank, verifyOracle } from './bank.mjs';

const project = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const under = (x, parent) => x === parent || x.startsWith(parent + sep);
const fail = (code) => { throw new Error(code); };
const outside = (x) => { if (under(x, project)) fail('PRIVATE_DATA_PATH_IN_WORKTREE'); };
const allowed = new Set(['source','assets','review','reference','oracle','bank','output-dir']);
function args(argv) {
  const first = argv[0];
  if (!['build','verify'].includes(first)) fail('COMMAND_MUST_BE_BUILD_OR_VERIFY');
  const options = {};
  for (let i=1;i<argv.length;i+=2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.has(key) || !argv[i+1] || argv[i+1].startsWith('--') || options[key]) fail('INVALID_COMMAND_ARGUMENTS');
    options[key]=argv[i+1];
  }
  if (!options.source) fail('MISSING_SOURCE_INPUT');
  if (first==='build' && (!options['output-dir'] || options.bank)) fail('BUILD_REQUIRES_NEW_OUTPUT_DIRECTORY');
  if (first==='verify' && options['output-dir']) fail('VERIFY_DOES_NOT_WRITE_OUTPUT');
  if (first==='build' || options.bank) {
    if (!['assets','review','reference','oracle'].every((key)=>options[key])) fail('MISSING_PINNED_REVIEW_INPUTS');
  }
  return { first, options };
}

async function protectedFile(filename) {
  const path = resolve(filename);
  outside(path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 24_000_000) fail('INVALID_PRIVATE_INPUT_FILE');
  const actual = await realpath(path);
  outside(actual);
  const bytes = await readFile(actual);
  let parsed; try { parsed=JSON.parse(bytes); } catch { fail('INVALID_PRIVATE_JSON'); }
  return { value: parsed, bytes, path:actual };
}

async function validateAssetFiles(assetManifestInput, placements) {
  const assetsRoot = dirname(assetManifestInput.path);
  const seen = new Map();
  for (const a of placements) {
    if (a.path === null || seen.has(a.path)) continue;
    const candidate = resolve(assetsRoot,a.path);
    if (!under(candidate,resolve(assetsRoot,'assets'))) fail('UNTRUSTED_ASSET_PATH');
    const stat = await lstat(candidate);
    const actual = await realpath(candidate);
    outside(actual);
    if (!under(actual, resolve(assetsRoot,'assets')) || !stat.isFile() || stat.isSymbolicLink() || stat.size>24_000_000)
      fail('UNTRUSTED_ASSET_FILE');
    const bytes=await readFile(actual);
    if (bytes.length<24 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' ||
       bytes.subarray(12,16).toString('ascii')!=='IHDR' || createHash('sha256').update(bytes).digest('hex')!==a.checksum ||
       bytes.readUInt32BE(16)!==a.outputDimensions[0] || bytes.readUInt32BE(20)!==a.outputDimensions[1])
      fail('ASSET_BYTES_MISMATCH');
    seen.set(a.path,bytes);
  }
  return seen;
}

function summary(r) {
  process.stdout.write('SOURCE ANSWER INTEGRITY\n=======================\n'
    + 'Source questions: ' + r.sourceQuestions + '\n'
    + 'Source mappings structurally valid: ' + r.sourceMappingsStructurallyValid + '\n'
    + 'Source mappings requiring review: ' + r.sourceMappingsRequiringReview + '\n'
    + 'Published questions checked (private candidate representation only): ' + r.publishedQuestionsChecked + '\n'
    + 'Unauthorized differences: ' + r.unauthorizedDifferences + '\n'
    + 'Missing mappings: ' + r.missingMappings + '\n'
    + 'Result: ' + r.result + '\n');
  if (r.problems?.length) process.stderr.write('Integrity flags: '+[...new Set(r.problems)].join(', ')+'\n');
}

async function outputDirectory(requested) {
  const destination = resolve(requested);
  outside(destination);
  const parent=await realpath(dirname(destination));
  outside(parent);
  const material=resolve(parent,basename(destination));
  outside(material);
  const git=spawnSync('git',['-C',parent,'rev-parse','--is-inside-work-tree'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  if (git.error) fail('PRIVATE_OUTPUT_GIT_GUARD_UNAVAILABLE');
  if (git.status===0 && git.stdout.trim()==='true') fail('PRIVATE_OUTPUT_IN_GIT_WORKTREE');
  await mkdir(material,{mode:0o700}); // No overwrite, symlink destination, or existing bank.
  return material;
}
async function writePrivate(directory,filename,content) {
  await writeFile(resolve(directory,filename),JSON.stringify(content,null,2)+'\n',{flag:'wx',mode:0o600});
}

let failureCounts = { sourceQuestions:0,sourceMappingsStructurallyValid:0,sourceMappingsRequiringReview:0,
  publishedQuestionsChecked:0,unauthorizedDifferences:0,missingMappings:0,result:'FAIL' };
try {
  const {first,options}=args(process.argv.slice(2));
  const {value:source}=await protectedFile(options.source);
  const sourceCount=indexSource(source,true).size;
  failureCounts={ ...failureCounts,sourceQuestions:sourceCount,sourceMappingsStructurallyValid:sourceCount,sourceMappingsRequiringReview:sourceCount };
  if (first==='verify' && !options.bank) {
    summary(verifyBank({source,bank:null,exact:true}));
    process.exitCode=2;
  } else {
    const [assetFile, reviewFile, refFile, oracleFile]=await Promise.all(
      ['assets','review','reference','oracle'].map((key)=>protectedFile(options[key])),
    );
    const referenceDigest=digest(refFile.bytes);
    if (referenceDigest!==REFERENCE_SHA) fail('REFERENCE_DIGEST_MISMATCH');
    if (digest(oracleFile.bytes)!==ORACLE_SHA) fail('SOURCE_ORACLE_DIGEST_MISMATCH');
    verifyOracle(source,oracleFile.value);
    const context={assetManifest:assetFile.value,review:reviewFile.value,reference:refFile.value,referenceDigest};
    const bankFile=first==='verify' ? await protectedFile(options.bank) : null;
    const bank=bankFile ? bankFile.value : compileBank({...context,source,exact:true});
    const check=verifyBank({source,bank,context,exact:true});
    if (check.result!=='PASS') { summary(check);process.exitCode=check.result==='INCOMPLETE'?2:1; }
    else {
      const approvedAssetBytes=await validateAssetFiles(assetFile,bank.assets);
      const view=displayOnly(bank);
      const scores={scope:'PRIVATE_DEVELOPMENT_ONLY',bankVersion:bank.manifest.bankVersion,answerDefinitions:bank.answerDefinitions};
      if (bankFile) {
        const directory=dirname(bankFile.path);
        const names=['display-bank.json','scoring-bank.json','manifest.json','reference-batch.json'];
        const siblings=await Promise.all(names.map((name)=>protectedFile(resolve(directory,name))));
        const [copiedView,copiedScores,copiedManifest,copiedReference]=siblings;
        if (digest(copiedView.value)!==digest(view) || digest(copiedScores.value)!==digest(scores) ||
            digest(copiedManifest.value)!==digest(bank.manifest) || digest(copiedReference.bytes)!==REFERENCE_SHA)
          fail('PRIVATE_STATIC_PROJECTION_MISMATCH');
        await validateAssetFiles(bankFile,bank.assets);
      } else {
        const output=await outputDirectory(options['output-dir']);
        const assetsDir=resolve(output,'assets');
        await mkdir(assetsDir,{mode:0o700});
        for(const [relative,bytes] of approvedAssetBytes)
          await writeFile(resolve(output,relative),bytes,{flag:'wx',mode:0o600});
        await writePrivate(output,'bank.json',bank);
        await writePrivate(output,'display-bank.json',view);
        await writePrivate(output,'scoring-bank.json',scores);
        await writeFile(resolve(output,'reference-batch.json'),refFile.bytes,{flag:'wx',mode:0o600});
        await writePrivate(output,'manifest.json',bank.manifest);
      }
      summary(check);
      process.stdout.write('Output scope: private development only; public production eligible: 0.\n');
    }
  }
} catch (e) {
  const safeCode=e instanceof Error && /^[A-Z][A-Z_]{3,80}$/.test(e.message) ? e.message : 'PRIVATE_PIPELINE_INPUT_OR_IO_ERROR';
  if (safeCode==='SOURCE_ORACLE_ANSWER_DIFFERENCE') failureCounts.unauthorizedDifferences=1; // at least one; never print source values
  summary(failureCounts);
  process.stderr.write('Integrity gate: '+safeCode+'\n');
  process.exitCode=1;
}
