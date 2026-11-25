import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectProtectedScoring } from '../scripts/question-bank/local-score-projection.mjs';

function packet() {
  const option = id => ({id, label: 'Fictional choice ' + id});
  const options = ['a', 'b'].map(option);
  const targets = ['first', 'second'].map(id => ({id, label: 'Example slot ' + id, options}));
  const interaction = (n) => n === 0 ? {kind:'DROPDOWN_HOTSPOT',targets}
    : n === 1 ? {kind:'ORDERING',items:options,positions:targets.map(({id,label})=>({id,label}))}
      : {kind:'SINGLE_CHOICE',options};
  const found = Array.from({length:60},(_,n)=>{
    const id='example-'+(n+1);
    const item=interaction(n);
    const mapping=n===0 || n===1 ? [{targetId:'second',optionId:'b'},{targetId:'first',optionId:'a'}] : [{optionId:'b'}];
    return {question:{id,interaction:item},definition:{sourceId:id,sourceAnswerDigest:'c'.repeat(64),
      normalizedMappingDigest:'d'.repeat(64),mapping,explanation:'Not carried into candidate scorer'}};
  });
  const selected=found.slice(0,59);
  const bankVersion='synthetic-projection-test';
  const payload={
    batch:{sourceIds:selected.map(row=>row.question.id),contentVersion:bankVersion,
      interactionKinds:Object.fromEntries(selected.map(row=>[row.question.id,row.question.interaction.kind]))},
    questions:Object.fromEntries(selected.map(row=>[row.question.id,row.question])),
  };
  const aggregate={manifest:{bankVersion},answerDefinitions:found.map(row=>structuredClone(row.definition))};
  const scoring={scope:'PRIVATE_DEVELOPMENT_ONLY',bankVersion,answerDefinitions:found.map(row=>structuredClone(row.definition))};
  return {payload,aggregate,scoring};
}
test('projects only selected digest-matched definitions, without explanations or display indexing',()=>{
  const {payload,aggregate,scoring}=packet();
  const bank=projectProtectedScoring(payload,aggregate,scoring);
  assert.equal(Object.keys(bank.definitions).length,59);
  assert.equal(Object.hasOwn(bank.definitions,'example-60'),false);
  assert.deepEqual(bank.definitions['example-1'],{kind:'DROPDOWN_HOTSPOT',selections:{second:'b',first:'a'}});
  assert.deepEqual(bank.definitions['example-2'],{kind:'ORDERING',optionIds:['a','b']});
  assert.deepEqual(bank.definitions['example-3'],{kind:'SINGLE_CHOICE',optionId:'b'});
  assert.doesNotMatch(JSON.stringify(bank),/explanation|Digest|sourceAnswer/);
});
test('fails closed on mismatched, malformed, missing, or duplicated protected rows',()=>{
  for (const mutation of [
    s=>{s.scoring.answerDefinitions[0].normalizedMappingDigest='a'.repeat(64);},
    s=>{s.scoring.answerDefinitions.splice(0,1);},
    s=>{s.scoring.answerDefinitions.push(structuredClone(s.scoring.answerDefinitions[0]));},
    s=>{s.scoring.answerDefinitions[0].mapping[0].optionId='not-in-exhibit';s.aggregate.answerDefinitions[0].mapping[0].optionId='not-in-exhibit';},
    s=>{s.scoring.bankVersion='another-version';},
  ]) {
    const s=packet();mutation(s);
    assert.throws(()=>projectProtectedScoring(s.payload,s.aggregate,s.scoring));
  }
});
