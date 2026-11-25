import { createCycleController } from '../../src/integration/cycle-controller'
import type { WritableCycle } from '../../src/integration/cycle-controller'
import { activeExamCycle } from '../../src/domain/cycle-lifecycle'
import type { BatchBank, BatchQuestion } from '../../src/domain/batch-engine'

const question = (sourceId:string, role:'case'|'standard'|'interactive'): BatchQuestion => ({
  sourceId,developmentValidated:true,productionEligible:false,interactionKind:role==='interactive'?'MATCHING':'SINGLE_CHOICE',
  standardEligible:role==='standard',interactiveEligible:role==='interactive',
})
const ids=(prefix:string,n:number)=>Array.from({length:n},(_,i)=>prefix+'-'+i)
const a=ids('example-case-a',7), b=ids('example-case-b',7)
const bank: BatchBank={version:'phase4-browser-synthetic-v1',
  questions:[...a,...b].map((q)=>question(q,'case')).concat(ids('example-standard',100).map((q)=>question(q,'standard')),
    ids('example-interactive',9).map((q)=>question(q,'interactive'))),
  caseStudies:[{id:'sample-family-a',childIds:a,developmentValidated:true,productionEligible:false},
    {id:'sample-family-b',childIds:b,developmentValidated:true,productionEligible:false}],
}
const c=createCycleController(bank)
const registry='phase4-browser-probe'
let session:WritableCycle|undefined
let latestBatch=''
const clock=()=>Date.now()
const errorCode=(e:unknown)=>e && typeof e==='object' && 'code'in e ? String(e.code):'STOPPED'
const current=()=>{ if(!session) throw new Error('No writer'); return session }
export async function invoke(action:string, actor='browser-first') {
  try {
    if(action==='initialize') session=await c.initialize({id:registry,cycleId:'example-cycle',eligibilityPolicy:'DEVELOPMENT',createdAt:clock()},actor)
    if(action==='acquire') session=await c.acquire(registry,actor)
    if(action==='read-only-generate') {
      const observed=await c.load(registry)
      if(!observed?.lease) throw new Error('No observed lease')
      await c.generate({state:observed.state,lease:observed.lease},11,clock())
    }
    if(action==='generate') {
      const outcome=await c.generate(current(),11,clock())
      if(!outcome.ok) return {ok:false,reason:'reason' in outcome ? outcome.reason : outcome.plan.reason}
      session=outcome.session
      latestBatch=outcome.plan.batch.id
    }
    if(action==='START'||action==='COMPLETE') {
      const result=await c.transition(current(),{type:action,batchId:latestBatch,at:clock()})
      if(!result.ok) return {ok:false,reason:result.reason}
      session=result.session
    }
    const state=(await c.load(registry))?.state
    if(!state) throw new Error('Missing state')
    const cycle=activeExamCycle(state)
    return {ok:true,reserved:cycle.reservedSourceIds.length,consumed:cycle.consumedSourceIds.length,
      batches:cycle.batches.length,revision:state.revision}
  } catch(e) {return{ok:false,reason:errorCode(e)}}
}
