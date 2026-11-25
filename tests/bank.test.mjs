import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBank, displayOnly, indexSource, verifyBank, verifyOracle, verifyReference } from '../scripts/question-bank/bank.mjs';

// Deliberately synthetic. Real source and answer options are never present here.
const sha='f'.repeat(64);
const kinds=['CASE_STUDY_1','CASE_STUDY_2','STANDARD_BLOCK','FINAL_INTERACTIVE_BLOCK'];
const range=(start,len)=>Array.from({length:len},(_,i)=>start+i);
const choice=(n)=>({
  SourceQuestionId:n,SourcePage:n+1,QuestionType:'Multiple Choice',
  NormalizedInteractionType:'SINGLE_CHOICE',RawQuestionAreaLayout:'Synthetic prompt for '+n,
  PromptText:'Synthetic prompt for '+n,RawAnswerBlock:['A — Candidate sample choice'],
  RawExplanationLayout:'Synthetic reviewer text',ExplanationPresent:true,
  Options:[{id:'A',text:'Candidate sample choice'},{id:'B',text:'Alternate sample choice'}],
  Targets:[],AnswerOptionIds:['A','B'],
  ParsedAnswerDefinition:[{source_value:'Candidate sample choice',option_id:'A'}],
  MappingValidated:true,ValidationStatus:'VALIDATED',
});
function interactive(n, kind) {
  const dropdown=kind==='DROPDOWN_HOTSPOT';
  const mapped=dropdown?'T1:A':'A';
  return {...choice(n),QuestionType:dropdown?'Dropdown':'Drag Drop',NormalizedInteractionType:kind,
    Options:[{id:mapped,text:'Candidate sample choice'},{id:dropdown?'T1:B':'B',text:'Alternate sample choice'}],
    AnswerOptionIds:[mapped,dropdown?'T1:B':'B'],Targets:[{id:'T1',source_label:'First sample target'}],
    ParsedAnswerDefinition:[{option_id:mapped,source_value:'Candidate sample choice',target_id:'T1',source_label:'First sample target'}],
  };
}
function setup() {
  const sections=[range(1,3),range(4,3),range(7,49),range(56,4)];
  const source={pdf_sha256:sha,pages:60,extraction_version:'synthetic-v1',rows:range(1,59).map((n)=>n<56?choice(n):interactive(n,n<58?'DROPDOWN_HOTSPOT':'MATCHING'))};
  const caseStudies=['case-a','case-b'].map((id,i)=>({
    id,title:'Synthetic family '+i,sourceQuestionIds:sections[i],validatedChildIds:sections[i],heldChildIds:[],
    rejectedChildIds:[],sharedAssetQuestionIds:[],reviewStatus:'VALIDATED_FOR_DEVELOPMENT',productionStatus:'NOT_APPROVED',
  }));
  const review={version:'synthetic-review',caseStudies,questionReviews:[]};
  const reference={fixtureId:'REFERENCE-BATCH-001',scope:'PRIVATE_DEVELOPMENT_ONLY',contentApproved:false,productionEligible:false,
    total:59,uniqueSourceIds:59,sectionOrder:kinds,sections:sections.map((sourceIds,i)=>({sourceIds,key:kinds[i],...(i<2?{familyId:caseStudies[i].id}:{})}))};
  return {source,context:{assetManifest:{schemaVersion:1,sourceDocumentChecksum:sha,placements:[]},review,reference}};
}
function compile(data) { return compileBank({source:data.source,...data.context}); }
test('compiles reproducibly; preserves 59 distinct IDs and independent nonproduction statuses',()=>{
  const data=setup(), bank=compile(data);
  assert.deepEqual(bank,compile(data));
  assert.equal(bank.manifest.productionEligibleCount,0);
  assert.equal(bank.manifest.questionCount,59);
  assert.equal(bank.manifest.developmentOnlyCount,59);
  assert.deepEqual(verifyBank({...data,bank}).result,'PASS');
  assert.equal(verifyReference(data.context.reference,indexSource(data.source),bank.caseStudies).length,59);
});
test('changes to source answer identity, projection, or approved options fail',()=>{
  const data=setup(), bank=compile(data);
  bank.answerDefinitions[0].mapping[0].optionId='B';
  const result=verifyBank({...data,bank});
  assert.equal(result.result,'FAIL');
  assert.equal(result.unauthorizedDifferences,1);
  data.source.rows[0].ParsedAnswerDefinition[0].option_id='B';
  assert.throws(()=>compile(data),/LABEL_MISMATCH/);
});
test('duplicate source or target IDs and untraceable candidate questions fail closed',()=>{
  const data=setup(), bank=compile(data);
  bank.questions[1].sourceId='Q99';
  assert.equal(verifyBank({...data,bank}).result,'FAIL');
  data.source.rows[1].SourceQuestionId=data.source.rows[0].SourceQuestionId;
  assert.throws(()=>compile(data),/DUPLICATE_SOURCE_ID/);
  const next=setup();
  next.source.rows[57].Targets.push(next.source.rows[57].Targets[0]);
  assert.throws(()=>compile(next),/INVALID_SOURCE_TARGETS/);
});
test('unapproved production booleans, metadata and swaps cannot pass',()=>{
  const data=setup();
  const bank=compile(data);
  bank.questions[0].productionEligible=true;
  assert.equal(verifyBank({...data,bank}).result,'FAIL');
  data.context.review.caseStudies[0].productionStatus='PRODUCTION_APPROVED';
  assert.throws(()=>compile(data),/UNAPPROVED/);
});
test('a missing candidate bank does not pass, and a missing answer definition is counted',()=>{
  const data=setup(), bank=compile(data);
  assert.equal(verifyBank({...data,bank:null}).result,'INCOMPLETE');
  bank.answerDefinitions.pop();
  assert.equal(verifyBank({...data,bank}).missingMappings,1);
  assert.notEqual(verifyBank({...data,bank}).result,'PASS');
});
test('known oracle checks immutable prompt, explanation, options and mappings without object-key-order dependence',()=>{
  const data=setup(), oracle=structuredClone(data.source);
  oracle.rows[0].ParsedAnswerDefinition=[{option_id:'A',source_value:'Candidate sample choice'}];
  assert.equal(verifyOracle(data.source,oracle),59);
  for(const field of ['RawQuestionAreaLayout','RawExplanationLayout','RawAnswerBlock','AnswerOptionIds']){
    const other=structuredClone(oracle);
    other.rows[0][field]='Synthetic modified input';
    assert.throws(()=>verifyOracle(data.source,other),/ORACLE/);
  }
});
test('reference rejects substitution or repeated IDs spanning blocks and invalid interactive shape',()=>{
  const data=setup();
  data.context.reference.sections[2].sourceIds[0]=1;
  assert.throws(()=>compile(data),/OVERLAP/);
  data.context.reference.sections[2].sourceIds[0]=99;
  assert.throws(()=>compile(data),/NOT_IN_SOURCE/);
  data.context.reference.sections[2].sourceIds[0]=7;
  data.context.reference.sections[3].sourceIds[0]=9;
  assert.throws(()=>compile(data),/INTERACTION_INVALID/);
});
test('display DTO excludes answer/trace digests and reviewed scoring material',()=>{
  const data=setup(), view=displayOnly(compile(data));
  assert.equal(view.questions.length,59);
  assert.equal(view.answerDefinitions,undefined);
  assert.equal(view.questions[0].sourceDigest,undefined);
  assert.equal(view.questions[0].rawAnswer,undefined);
  assert.equal(view.questions[0].interaction.kind,'SINGLE_CHOICE');
});
test('placeholder placements have no crop; traversal or fabricated production approval fails',()=>{
  const data=setup();
  const safe={assetId:'synthetic-asset',sourceQuestionId:'Q1',sourcePage:2,sourceBounds:[0,0,4,4],
    originalDimensions:[4,4],sourceXref:22,classification:'SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT',
    relationshipType:'SOURCE_PLACEHOLDER',requiredForInteraction:false,productionEligibility:false,
    reviewStatus:'SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT',crop:null,outputDimensions:null,checksum:null,path:null};
  data.context.assetManifest.placements=[safe];
  assert.equal(compile(data).assets[0].crop,null);
  safe.path='assets/../synthetic.png';
  safe.checksum=sha;safe.outputDimensions=[4,4];safe.crop={mode:'NATIVE_RASTER',bounds:[0,0,4,4]};
  assert.throws(()=>compile(data),/UNSAFE_ASSET/);
});
test('proposed prompt must have literal provenance in the original source area',()=>{
  const data=setup();
  data.source.rows[0].PromptText='Synthetic injected transformation';
  assert.throws(()=>compile(data),/UNTRACED_SOURCE_PROMPT/);
});
