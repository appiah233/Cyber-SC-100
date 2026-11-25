import { expect, it } from 'vitest'
import { generateBatch } from '../src/domain/batch-engine'
import type { BatchBank, BatchQuestion } from '../src/domain/batch-engine'
import { generateCycleBatch } from '../src/domain/cycle-plan'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'

const ids=(key:string,n:number)=>Array.from({length:n},(_,i)=>key+'-'+i)
const question=(sourceId:string,role:'case'|'standard'|'interactive'):BatchQuestion=>({sourceId,
  developmentValidated:true,productionEligible:false,standardEligible:role==='standard',interactiveEligible:role==='interactive',
  interactionKind:role==='interactive'?'MATCHING':'SINGLE_CHOICE',
})
it('keeps the proven cycle maximum even when a seeded locally valid case pairing would strand another normal batch',()=>{
  const a=ids('case-a',6),b=ids('case-b',3),c=ids('case-c',3)
  const bank:BatchBank={version:'synthetic-stranded-roles-v1',
    questions:[...a,...b,...c].map((id)=>question(id,'case'))
      .concat(ids('standard',98).map((id)=>question(id,'standard')),ids('interactive',8).map((id)=>question(id,'interactive'))),
    caseStudies:[a,b,c].map((childIds,i)=>({id:'family-'+i,childIds,developmentValidated:true,productionEligible:false})),
  }
  const cycleState={cycleId:'test-cycle',bankVersion:bank.version,consumedSourceIds:[],reservedSourceIds:[]}
  const params={bank,cycleState,eligibilityPolicy:'DEVELOPMENT' as const}
  const capacity=analyzeCycleCapacity(params)
  expect(capacity).toMatchObject({ok:true,maximumFullBatches:2})
  const seed=ids('seed',128).find((seed)=>{
    const b=generateBatch({...params,seed})
    return b.ok && b.batch.kind==='NORMAL_BATCH' && !b.batch.sections.some((s)=>s.caseStudyId==='family-0')
  })
  expect(seed).toBeDefined()
  const first=generateCycleBatch({...params,seed:seed!})
  if(!first.ok || first.batch.kind!=='NORMAL_BATCH') throw new Error('A proven witness must produce a normal batch')
  expect(first).toEqual(generateCycleBatch({...params,seed:seed!}))
  expect(first.batch.sections.some((s)=>s.caseStudyId==='family-0')).toBe(true)
  const next=generateCycleBatch({...params,seed:seed!,cycleState:{...cycleState,consumedSourceIds:[...first.batch.sourceIds]}})
  if(!next.ok || next.batch.kind!=='NORMAL_BATCH') throw new Error('Second normal batch must remain feasible')
  expect(new Set([...first.batch.sourceIds,...next.batch.sourceIds]).size).toBe(118)
})
