import { createHash } from 'node:crypto';

export const SOURCE_SHA = 'c1afae23f990c0ee3fc1a20b38ca2f945c244a8b827c50ce0b7e51a785003041';
export const REFERENCE_SHA = 'c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48';
export const ORACLE_SHA = 'b6043debc02af9dd713cd7ab14512113f2c646bdf88214911636eea8f90d10e8';
const PRIVATE = 'PRIVATE_DEVELOPMENT_ONLY';
const SCHEMA = 1;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter((k)=>value[k]!==undefined)
    .map((k)=>JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
}
const object = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x) => typeof x === 'string' && x.trim().length > 0;
const hash = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = (x) => /^Q[1-9][0-9]{0,5}$/.test(x);
const slug = (x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(x);
const stableId = (x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(x) && !['constructor','prototype'].includes(x);
const list = (x) => Array.isArray(x) ? x : [];
const unique = (x) => new Set(x).size === x.length;
const same = (a, b) => canonical(a) === canonical(b);
const insist = (ok, code) => { if (!ok) throw new Error(code); };
const sanitAssetPath = (p) => typeof p === 'string' && /^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.png$/.test(p);
const dimensions = (x) => Array.isArray(x) && x.length === 2 && x.every((v) => Number.isInteger(v) && v > 0 && v <= 16000);
const bounds = (x) => Array.isArray(x) && x.length === 4 && x.every(Number.isFinite) && x[0] >= 0 && x[1] >= 0 && x[2] > x[0] && x[3] > x[1];
const option = ({ id, text: label }) => ({ id, label });

export function sourceKey(value) {
  if (Number.isSafeInteger(value) && value > 0 && value < 1000000) return 'Q' + value;
  if (typeof value === 'string' && id(value)) return value;
  throw new Error('INVALID_SOURCE_ID');
}

const whitespace = (s) => s.trim().replace(/\s+/g,' ');
function sourcePrompt(row) {
  if (row.PromptText === undefined) return row.RawQuestionAreaLayout;
  insist(text(row.PromptText) && whitespace(row.RawQuestionAreaLayout).includes(whitespace(row.PromptText)), 'UNTRACED_SOURCE_PROMPT');
  return row.PromptText;
}
const norm = (s) => s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.join(' ') ?? '';

function sourceInteraction(row) {
  const opts = list(row.Options);
  const targets = list(row.Targets);
  const parts = list(row.ParsedAnswerDefinition);
  insist(opts.length > 0 && opts.every((x) => object(x) && stableId(x.id) && text(x.text)) &&
    unique(opts.map((x) => x.id)) && same(row.AnswerOptionIds, opts.map((x) => x.id)), 'INVALID_SOURCE_OPTIONS');
  insist(targets.every((x) => object(x) && stableId(x.id) && text(x.source_label)) && unique(targets.map((x) => x.id)), 'INVALID_SOURCE_TARGETS');
  insist(parts.length > 0 && parts.every((x) => object(x) && stableId(x.option_id) && text(x.source_value)), 'MISSING_SOURCE_MAPPING');
  const choices = new Map(opts.map((x) => [x.id, x.text]));
  insist(parts.every((x) => choices.has(x.option_id) && norm(choices.get(x.option_id)) === norm(x.source_value)), 'SOURCE_ANSWER_LABEL_MISMATCH');
  const tag = row.NormalizedInteractionType ?? row.RenderedInteractionType;
  const targetLabels = targets.map((x) => ({ id: x.id, label: x.source_label }));
  if (row.QuestionType === 'Multiple Choice') {
    insist(['Multiple Choice','SINGLE_CHOICE','MULTIPLE_CHOICE','MULTI_CHOICE'].includes(tag) &&
      targets.length === 0 && parts.every((x) => x.target_id === undefined) && unique(parts.map((x) => x.option_id)), 'MALFORMED_CHOICE_MAPPING');
    const kind = parts.length === 1 ? 'SINGLE_CHOICE' : 'MULTIPLE_CHOICE';
    // The PDF's response affordance is canonical, not the number of marked answers;
    // fail closed when the validated extraction explicitly disagrees with this format.
    insist(!['SINGLE_CHOICE','MULTIPLE_CHOICE','MULTI_CHOICE'].includes(tag) ||
      (tag === 'MULTI_CHOICE' ? 'MULTIPLE_CHOICE' : tag) === kind, 'SOURCE_INTERACTION_MISMATCH');
    return { display: { kind, options: opts.map(option) }, mapping: parts.map(({option_id}) => ({ optionId: option_id })) };
  }
  insist(targets.length > 0 && same(parts.map((x) => x.target_id), targets.map((x) => x.id)) &&
    parts.every((x, i) => {
      if (!text(x.source_label)) return false;
      const expected = norm(x.source_label), actual = norm(targets[i].source_label);
      return actual === expected || (row.QuestionType === 'Dropdown' && actual.endsWith(' ' + expected));
    }), 'SOURCE_TARGET_MAPPING_MISMATCH');
  const mapping = parts.map(({ target_id, option_id }) => ({ targetId: target_id, optionId: option_id }));
  if (row.QuestionType === 'Dropdown') {
    insist(['DROPDOWN','Dropdown','DROPDOWN_HOTSPOT','DIAGRAM_DEPENDENT_DROPDOWN','DIAGRAM_DEPENDENT'].includes(tag), 'SOURCE_INTERACTION_MISMATCH');
    const kind = tag === 'DROPDOWN_HOTSPOT' ? tag : 'DROPDOWN';
    const groups = targetLabels.map((x) => ({ ...x, label: row.DisplayTargets?.find((t)=>t.id===x.id)?.source_label
      ?? parts.find((p) => p.target_id === x.id).source_label, options: opts.filter((o) => o.id.startsWith(x.id + ':')).map(option) }));
    insist(groups.every((g, i) => text(g.label) && norm(g.label) === norm(parts[i].source_label) && g.options.length > 0 && g.options.some((o) => o.id === mapping[i].optionId)) &&
      groups.reduce((count, g) => count + g.options.length, 0) === opts.length, 'INVALID_DROPDOWN_OPTION_SCOPE');
    return { display: { kind, targets: groups }, mapping };
  }
  if (row.QuestionType === 'Statements') {
    insist(['STATEMENT','STATEMENT_INTERACTION'].includes(tag), 'SOURCE_INTERACTION_MISMATCH');
    return { display: { kind: 'STATEMENT', targets: targetLabels.map((x) => ({ ...x, options: opts.map(option) })) }, mapping };
  }
  insist(row.QuestionType === 'Drag Drop' && ['ORDERING','MATCHING','DRAG_DROP'].includes(tag), 'UNKNOWN_SOURCE_INTERACTION');
  if (tag === 'ORDERING') {
    insist(targetLabels.every((x, i) => norm(x.label) === 'step ' + (i + 1)), 'INVALID_SOURCE_ORDERING');
    return { display: { kind: tag, items: opts.map(option), positions: targetLabels }, mapping };
  }
  return { display: { kind: tag, targets: targetLabels, choices: opts.map(option) }, mapping };
}

export function indexSource(source, exact = false) {
  insist(object(source) && hash(source.pdf_sha256) && Number.isInteger(source.pages) && source.pages > 1 &&
    slug(source.extraction_version) && Array.isArray(source.rows), 'INVALID_SOURCE_MANIFEST');
  if (exact) insist(source.pdf_sha256 === SOURCE_SHA && source.pages === 358 && source.rows.length === 357, 'SOURCE_IDENTITY_MISMATCH');
  insist(source.rows.length === source.pages - 1, 'SOURCE_PAGE_COVERAGE_MISMATCH');
  const index = new Map();
  const counts = new Map();
  source.rows.forEach((row, i) => {
    insist(object(row) && row.SourcePage === i + 2 && Number.isSafeInteger(row.SourceQuestionId), 'INVALID_SOURCE_PAGE_OR_ID');
    const key = sourceKey(row.SourceQuestionId);
    insist(!index.has(key), 'DUPLICATE_SOURCE_ID');
    insist(Array.isArray(row.RawAnswerBlock) && row.RawAnswerBlock.length > 0 && row.RawAnswerBlock.every(text) &&
      text(row.RawQuestionAreaLayout) && text(row.RawExplanationLayout) && row.ExplanationPresent === true, 'MISSING_SOURCE_BLOCK');
    insist(row.MappingValidated === true && row.ValidationStatus === 'VALIDATED', 'SOURCE_REVIEW_REQUIRED');
    const { display, mapping } = sourceInteraction(row);
    counts.set(row.QuestionType, (counts.get(row.QuestionType) ?? 0) + 1);
    index.set(key, { row, display, mapping, prompt: sourcePrompt(row),sourceDigest: digest(row) });
  });
  if (exact) {
    const expected = Array.from({length:360},(_,i)=>i+1).filter((x)=>![33,110,121].includes(x)).map(sourceKey);
    insist(same([...index.keys()], expected), 'SOURCE_ID_SEQUENCE_MISMATCH');
    insist(counts.get('Multiple Choice') === 226 && counts.get('Dropdown') === 117 &&
      counts.get('Drag Drop') === 12 && counts.get('Statements') === 2, 'SOURCE_TYPE_COUNTS_MISMATCH');
  }
  return index;
}

export function verifyOracle(source, oracle) {
  insist(object(oracle) && oracle.pdf_sha256 === source.pdf_sha256 && Array.isArray(oracle.rows) &&
    oracle.rows.length === source.rows.length, 'ORACLE_SOURCE_MISMATCH');
  const keys = ['SourceQuestionId','SourcePage','QuestionType','RawAnswerBlock','ParsedAnswerDefinition','AnswerOptionIds','Options','Targets','RawQuestionAreaLayout','RawExplanationLayout'];
  const mismatches = source.rows.filter((r,i)=>!keys.every((k)=>same(r[k],oracle.rows[i]?.[k]))).length;
  insist(mismatches === 0, 'SOURCE_ORACLE_ANSWER_DIFFERENCE');
  return source.rows.length;
}

function projectAssets(manifest, index, sha, exact) {
  insist(object(manifest) && manifest.schemaVersion === 1 && manifest.sourceDocumentChecksum === sha &&
    Array.isArray(manifest.placements), 'INVALID_ASSET_MANIFEST');
  const found = new Set();
  const filenames = new Map();
  const projection = manifest.placements.map((a) => {
    insist(object(a) && slug(a.assetId) && !found.has(a.assetId) && id(a.sourceQuestionId) &&
      index.get(a.sourceQuestionId)?.row.SourcePage === a.sourcePage && bounds(a.sourceBounds) &&
      dimensions(a.originalDimensions) && Number.isInteger(a.sourceXref) && a.sourceXref > 0 &&
      text(a.classification) && text(a.relationshipType) && text(a.reviewStatus) &&
      typeof a.requiredForInteraction === 'boolean' && a.productionEligibility === false, 'MALFORMED_ASSET');
    found.add(a.assetId);
    if (a.path === null) {
      insist(a.checksum === null && a.outputDimensions === null && a.crop === null && !a.requiredForInteraction &&
        a.reviewStatus === 'SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT', 'INVALID_PLACEHOLDER');
    } else {
      insist(sanitAssetPath(a.path) && hash(a.checksum) && dimensions(a.outputDimensions) && object(a.crop) &&
        bounds(a.crop.bounds) && ['NATIVE_RASTER','SOURCE_PAGE_CROP'].includes(a.crop.mode), 'UNSAFE_ASSET_OR_CHECKSUM');
      insist(!filenames.has(a.path) || filenames.get(a.path) === a.checksum, 'ASSET_PATH_VERSION_CONFLICT');
      filenames.set(a.path, a.checksum);
    }
    return {
      assetId:a.assetId, sourceQuestionId:a.sourceQuestionId, sourcePage:a.sourcePage,
      sourceBounds:a.sourceBounds, originalDimensions:a.originalDimensions, sourceXref:a.sourceXref,
      classification:a.classification, relationshipType:a.relationshipType, requiredForInteraction:a.requiredForInteraction,
      reviewStatus:a.reviewStatus, crop:a.crop === null ? null : { mode:a.crop.mode, bounds:a.crop.bounds },
      outputDimensions:a.outputDimensions, checksum:a.checksum, path:a.path,
    };
  });
  if (exact) {
    insist(projection.length === 27, 'ASSET_PLACEMENT_COUNT_MISMATCH');
    insist(same(projection.filter((a)=>a.path === null).map((a)=>a.sourceQuestionId).sort(),['Q113','Q44']), 'ASSET_PLACEHOLDER_MISMATCH');
    for (const [key, {row}] of index) {
      const references = row.SourceAssetReferences;
      const placements=projection.filter((a)=>a.sourceQuestionId===key);
      insist(Array.isArray(references) && references.length===placements.length, 'SOURCE_ASSET_REFERENCE_MISMATCH');
      for (const ref of references) {
        insist(placements.some((asset)=>asset.sourceXref===ref.pdfXref &&
          same(asset.originalDimensions,[ref.originalDimensions?.width,ref.originalDimensions?.height]) &&
          ref.bounds?.length===4 && ref.bounds.every((p,i)=>Math.abs(p-asset.sourceBounds[i])<=0.02)),
        'SOURCE_ASSET_PLACEMENT_MISMATCH');
      }
    }
  }
  return projection.sort((a,b)=>a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}

function reviewMetadata(review, index, assets, exact) {
  insist(object(review) && slug(review.version) && Array.isArray(review.caseStudies) &&
    Array.isArray(review.questionReviews), 'INVALID_REVIEW_METADATA');
  const reviewMap = new Map();
  for (const r of review.questionReviews) {
    const key = sourceKey(r.sourceId);
    insist(index.has(key) && !reviewMap.has(key) && text(r.reviewStatus) &&
      (r.requiresDiagram === null || typeof r.requiresDiagram === 'boolean') && !r.productionEligible && !r.contentApproved,
    'UNAPPROVED_OR_MALFORMED_REVIEW');
    reviewMap.set(key, r);
  }
  if (exact) {
    insist(review.caseStudies.length === 7, 'CASE_FAMILY_COUNT_MISMATCH');
    for (const [k,status] of Object.entries({Q6:'SOURCE_CONTENT_INCONSISTENCY_REVIEW',Q44:'SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT',
      Q113:'SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT',Q360:'SOURCE_INTERACTION_REVIEW_REQUIRED'}))
      insist(reviewMap.get(k)?.reviewStatus === status, 'SPECIAL_REVIEW_STATUS_MISSING');
  }
  const seen = new Set();
  const idsInFamily = new Set();
  const cases = review.caseStudies.map((family) => {
    insist(object(family) && slug(family.id) && !seen.has(family.id) && text(family.title) &&
      ['VALIDATED_FOR_DEVELOPMENT','NEEDS_REVIEW'].includes(family.reviewStatus) && family.productionStatus === 'NOT_APPROVED', 'UNAPPROVED_OR_MALFORMED_CASE_FAMILY');
    seen.add(family.id);
    const q = list(family.sourceQuestionIds).map(sourceKey), v = list(family.validatedChildIds).map(sourceKey);
    const rejected = list(family.rejectedChildIds).map(sourceKey), held = list(family.heldChildIds).map(sourceKey);
    insist(q.length >= 3 && unique(q) && q.every((x)=>index.has(x) && !idsInFamily.has(x)) &&
      v.every((x)=>q.includes(x)) && held.every((x)=>q.includes(x)) && rejected.every((x)=>index.has(x)) &&
      unique([...v,...held,...rejected]) && (family.reviewStatus !== 'VALIDATED_FOR_DEVELOPMENT' || v.length >= 3),
    'DUPLICATE_OR_UNTRACED_CASE_CHILD');
    q.forEach((x)=>idsInFamily.add(x));
    const assetQuestions = list(family.sharedAssetQuestionIds).map(sourceKey);
    insist(assetQuestions.every((x)=>q.includes(x) && assets.some((a)=>a.sourceQuestionId===x && a.path)), 'UNTRACED_CASE_ASSET');
    const scenario = q.map((k)=>index.get(k).row.SourceScenarioLines);
    if (exact) insist(scenario.every((lines)=>Array.isArray(lines) && lines.length>0 && lines.every(text) &&
      whitespace(lines.join(' '))===whitespace(scenario[0].join(' '))), 'CASE_SCENARIO_NOT_TRACED');
    const scenarioText = list(scenario[0]).join('\n');
    return {
      id:family.id,title:family.title,scenarioText,sourceQuestionIds:q,validatedChildIds:v,rejectedChildIds:rejected,heldChildIds:held,
      scenarioSourcePages:q.map((x)=>index.get(x).row.SourcePage),
      sharedAssetIds:assets.filter((x)=>assetQuestions.includes(x.sourceQuestionId) && x.path).map((x)=>x.assetId),
      reviewStatus:family.reviewStatus,productionStatus:'NOT_APPROVED',
    };
  });
  return { cases, reviewMap };
}

const preset = ['CASE_STUDY_1','CASE_STUDY_2','STANDARD_BLOCK','FINAL_INTERACTIVE_BLOCK'];
export function verifyReference(reference, index, cases, exact = false) {
  insist(object(reference) && reference.fixtureId === 'REFERENCE-BATCH-001' && reference.scope === PRIVATE &&
    reference.contentApproved === false && reference.productionEligible === false &&
    reference.total === 59 && reference.uniqueSourceIds === 59 &&
    Array.isArray(reference.sections) && reference.sections.length === 4 &&
    same(reference.sectionOrder,preset), 'REFERENCE_MANIFEST_INVALID');
  const ids=[];
  reference.sections.forEach((s,i)=>{
    insist(object(s) && s.key===preset[i] && Array.isArray(s.sourceIds) && s.sourceIds.length===[3,3,49,4][i], 'REFERENCE_PARTITION_INVALID');
    const keys=s.sourceIds.map(sourceKey);
    insist(keys.every((k)=>index.has(k)), 'REFERENCE_ID_NOT_IN_SOURCE');
    if (i<2) insist(cases.some((c)=>c.id===s.familyId && c.reviewStatus==='VALIDATED_FOR_DEVELOPMENT' &&
      keys.every((k)=>c.validatedChildIds.includes(k))), 'REFERENCE_CASE_UNVALIDATED');
    if (i===3) insist(keys.every((k)=>['DROPDOWN_HOTSPOT','MATCHING'].includes(index.get(k).display.kind)), 'REFERENCE_INTERACTION_INVALID');
    ids.push(...keys);
  });
  insist(unique(ids) && reference.sections[0].familyId !== reference.sections[1].familyId, 'REFERENCE_SECTION_OVERLAP');
  if (exact) {
    insist(reference.sourcePdfSha256 === SOURCE_SHA && same(reference.sections.map((s)=>s.familyId??null),['CS-LITWARE','CS-FABRIKAM',null,null]), 'REFERENCE_PROVENANCE_MISMATCH');
  }
  return ids;
}

export function compileBank({source, assetManifest, review, reference, referenceDigest, exact = false}) {
  const index = indexSource(source, exact);
  const assets = projectAssets(assetManifest, index, source.pdf_sha256, exact);
  const { cases, reviewMap } = reviewMetadata(review, index, assets, exact);
  if (exact) insist(referenceDigest === REFERENCE_SHA, 'REFERENCE_DIGEST_MISMATCH');
  const developmentKeys = new Set(verifyReference(reference, index, cases, exact));
  const caseByQuestion = new Map(cases.flatMap((c)=>c.sourceQuestionIds.map((q)=>[q,c])));
  const questions=[];
  const answerDefinitions=[];
  const interactionCounts = {};
  for (const [sourceId, {row,display,mapping,prompt,sourceDigest}] of index) {
    const family=caseByQuestion.get(sourceId);
    const reviewRow=reviewMap.get(sourceId);
    const assetIds=assets.filter((a)=>a.sourceQuestionId===sourceId && a.path).map((a)=>a.assetId);
    const requiredAssets=assets.filter((a)=>a.sourceQuestionId===sourceId && a.requiredForInteraction && a.path);
    const requiresDiagram=reviewRow?.requiresDiagram ?? (requiredAssets.length>0);
    if (requiresDiagram) insist(requiredAssets.length>0, 'REQUIRED_ASSET_MISSING');
    interactionCounts[display.kind]=(interactionCounts[display.kind]??0)+1;
    const dev=developmentKeys.has(sourceId);
    questions.push({
      sourceId, internalId: sourceId, sourcePage: row.SourcePage,
      prompt, interaction: display, assetIds,
      requiresDiagram, requiredAssetIds:requiredAssets.map((a)=>a.assetId),
      caseStudyId:family?.id??null,
      sourceValidated:true, interactionValidated:reviewRow?.reviewStatus!=='SOURCE_INTERACTION_REVIEW_REQUIRED',
      caseStudyValidated:family?.validatedChildIds.includes(sourceId)??false,
      reviewStatus:reviewRow?.reviewStatus??(dev?'VALIDATED_FOR_DEVELOPMENT':'PRODUCTION_REVIEW_REQUIRED'),
      developmentOnly: dev, contentApproved:false, productionEligible:false,
      sourceDocumentChecksum:source.pdf_sha256, sourceDigest,
    });
    answerDefinitions.push({
      sourceId,sourcePage:row.SourcePage,sourceAnswerDigest:digest(row.RawAnswerBlock),
      normalizedMappingDigest:digest(mapping),mapping,
      explanation:row.RawExplanationLayout,
    });
  }
  const data = { questions, answerDefinitions, assets, caseStudies:cases };
  const buildIdentity=digest({schemaVersion:SCHEMA,source:source.pdf_sha256,extraction:source.extraction_version,
    metadata:review.version,reference:referenceDigest??digest(reference),data});
  const bankVersion='sc100-'+source.pdf_sha256.slice(0,12)+'-'+buildIdentity.slice(0,12);
  return {
    manifest:{schemaVersion:SCHEMA,bankVersion,scope:PRIVATE,sourceDocumentChecksum:source.pdf_sha256,buildIdentity,
      extractionVersion:source.extraction_version,reviewVersion:review.version,questionCount:questions.length,
      productionEligibleCount:0,publishedCount:0,developmentOnlyCount:developmentKeys.size,
      interactionCounts,caseStudyCount:cases.length,assetManifestVersion:assetManifest.schemaVersion},
    ...data,
  };
}

export function verifyBank({source, bank, context, exact = false}) {
  const index = indexSource(source, exact);
  const counters={sourceQuestions:index.size,sourceMappingsStructurallyValid:index.size,sourceMappingsRequiringReview:index.size,
    publishedQuestionsChecked:0,unauthorizedDifferences:0,missingMappings:0,result:'INCOMPLETE'};
  if (!bank) { counters.missingMappings=index.size; return counters; }
  const problems=[];
  const qIndex=new Map(),aIndex=new Map();
  const read = (obj, destination, name) => {
    if (!Array.isArray(obj)) {problems.push('INVALID_' + name);return;}
    for (const row of obj) {
      if (!object(row) || !id(row.sourceId) || !index.has(row.sourceId) || destination.has(row.sourceId)) {
        problems.push('UNTRACED_OR_DUPLICATE_' + name);continue;
      }
      destination.set(row.sourceId,row);
    }
  };
  read(bank.questions,qIndex,'QUESTION');
  read(bank.answerDefinitions,aIndex,'ANSWER');
  if (!object(bank.manifest) || bank.manifest.sourceDocumentChecksum!==source.pdf_sha256 ||
    bank.manifest.scope!==PRIVATE || bank.manifest.productionEligibleCount!==0 || bank.manifest.questionCount!==index.size)
    problems.push('INVALID_BANK_MANIFEST');
  for (const [sourceId,{row,display,mapping,prompt,sourceDigest}] of index) {
    const q=qIndex.get(sourceId), a=aIndex.get(sourceId);
    if (!q || !a) {counters.missingMappings++;continue;}
    counters.publishedQuestionsChecked++;
    const expected= !same(a.mapping,mapping) || a.sourceAnswerDigest!==digest(row.RawAnswerBlock) ||
      a.normalizedMappingDigest!==digest(mapping) || a.explanation!==row.RawExplanationLayout ||
      a.sourcePage!==row.SourcePage;
    if (expected) {counters.unauthorizedDifferences++;continue;}
    if (q.internalId!==sourceId || q.sourcePage!==row.SourcePage || q.sourceDocumentChecksum!==source.pdf_sha256 ||
      q.sourceDigest!==sourceDigest || !same(q.interaction,display) || q.prompt!==prompt ||
      q.productionEligible!==false || q.contentApproved!==false)
      problems.push('UNAPPROVED_OR_MUTATED_PROJECTION');
  }
  if (context) {
    const recomputed=compileBank({...context,source,exact});
    if (!same(bank,recomputed)) problems.push('BANK_BUILD_IDENTITY_OR_METADATA_MISMATCH');
  }
  counters.result=counters.unauthorizedDifferences || problems.length ? 'FAIL' : counters.missingMappings ? 'INCOMPLETE' : 'PASS';
  return {...counters, problems};
}

export function displayOnly(bank) {
  return {manifest:bank.manifest, questions:bank.questions.map(({sourceId,sourcePage,prompt,interaction,assetIds,requiresDiagram,
    caseStudyId,productionEligible,developmentOnly})=>({sourceId,sourcePage,prompt,interaction,assetIds,requiresDiagram,
    caseStudyId,productionEligible,developmentOnly})),
    assets:bank.assets.map(({assetId,path,outputDimensions,checksum})=>({assetId,path,outputDimensions,checksum})),
    caseStudies:bank.caseStudies.map(({id,title,scenarioText,sharedAssetIds})=>({id,title,scenarioText,sharedAssetIds}))};
}
