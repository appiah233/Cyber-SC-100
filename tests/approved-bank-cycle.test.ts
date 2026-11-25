import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { expect, it } from 'vitest'
import { bindDevelopmentInventory } from '../src/data/cycle-inventory'
import { generateBatch } from '../src/domain/batch-engine'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'

const enabled=Boolean(process.env.SC100_CYCLE_BANK && process.env.SC100_CYCLE_REFERENCE && process.env.SC100_CYCLE_VERSION && process.env.SC100_CYCLE_BANK_SHA)
it.skipIf(!enabled)('proves actual approved inventory without exposing source questions or answers',()=>{
  const repo=realpathSync(process.cwd())
  const protectedRead=(path: string)=>{
    const actual=realpathSync(path)
    if (actual===repo || actual.startsWith(repo+sep)) throw new Error('Protected input must stay outside the worktree')
    return readFileSync(actual)
  }
  const bankBytes=protectedRead(process.env.SC100_CYCLE_BANK!)
  const fixtureBytes=protectedRead(process.env.SC100_CYCLE_REFERENCE!)
  expect(createHash('sha256').update(bankBytes).digest('hex')).toBe(process.env.SC100_CYCLE_BANK_SHA)
  expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe('c69b4afef51b46ab28b937c9603573a1ebc8c86b1517a93c31c3fce92b26eb48')
  const fixture=JSON.parse(fixtureBytes.toString('utf8')) as {sections: {sourceIds: number[]}[]}
  const bank=bindDevelopmentInventory(JSON.parse(bankBytes.toString('utf8')),fixture,process.env.SC100_CYCLE_VERSION!)
  expect(bank.questions).toHaveLength(357)
  expect(bank.questions.filter((q)=>q.developmentValidated)).toHaveLength(59)
  const ids=fixture.sections.flatMap((s)=>s.sourceIds.map((id)=>'Q'+id))
  const boot={cycleId:'protected-review-cycle',bankVersion:bank.version,consumedSourceIds:[],reservedSourceIds:[]}
  const capacity=analyzeCycleCapacity({bank,cycleState:boot,eligibilityPolicy:'DEVELOPMENT'})
  if (!capacity.ok) throw new Error('Expected validated private capacity')
  expect(capacity.maximumFullBatches).toBe(1)
  expect(capacity.anticipatedRemainder.size).toBe(0)
  for (let seed=0;seed<128;seed++) {
    const params={bank,cycleState:boot,eligibilityPolicy:'DEVELOPMENT' as const,seed}
    const first=generateBatch(params)
    if (!first.ok || first.batch.kind!=='NORMAL_BATCH') throw new Error('Expected a protected normal batch')
    expect(first).toEqual(generateBatch(params))
    expect(first.batch.sections.map((s)=>s.questionIds.length)).toEqual([3,3,49,4])
    expect(new Set(first.batch.sourceIds)).toEqual(new Set(ids))
    expect(first.batch.sections[0].caseStudyId).not.toBe(first.batch.sections[1].caseStudyId)
    expect(generateBatch({...params,cycleState:{...boot,consumedSourceIds:first.batch.sourceIds}}).ok).toBe(false)
  }
  const prod=generateBatch({bank,cycleState:boot,eligibilityPolicy:'PRODUCTION',seed:0})
  expect(prod).toMatchObject({ok:false,reason:'INSUFFICIENT_PRODUCTION_CONTENT'})
  console.info('Protected capacity proof (counts only):', JSON.stringify({
    seeds:128, maximum:capacity.maximumFullBatches, limiting:capacity.limitingConstraints,
    independentBounds:capacity.independentBounds, remainder:capacity.anticipatedRemainder.size,
    sourceCount:bank.questions.length, developmentCount:ids.length,
    productionFull:0, productionResult:prod.ok ? 'UNEXPECTED_SUCCESS' : prod.reason,
  }))
})
