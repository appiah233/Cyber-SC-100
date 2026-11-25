import { analyzeCycleCapacity } from './cycle-capacity'
import { generateBatch } from './batch-engine'
import type { BatchDiagnostics, BatchGenerationInput, BatchGenerationResult } from './batch-engine'
import { NORMAL_SECTIONS } from './model'
import { seededQuestionOrder } from './random'

export type CycleBatchResult = BatchGenerationResult | {readonly ok:false;readonly reason:'CAPACITY_WITNESS_INVARIANT';readonly diagnostics:BatchDiagnostics}

/** Keep the seeded first choice unless it would strand an otherwise feasible full batch.
 * The exact analyzer supplies a proven fallback partition. It is rechecked by the
 * same generator; no new data, eligibility, or source identity is created. */
export function generateCycleBatch(input: BatchGenerationInput): CycleBatchResult {
  const first=generateBatch(input)
  if (!first.ok || first.batch.kind!=='NORMAL_BATCH') return first
  const before=analyzeCycleCapacity(input)
  if (!before.ok || before.maximumFullBatches<=1) return first
  const left=analyzeCycleCapacity({...input,cycleState:{...input.cycleState,
    consumedSourceIds:[...input.cycleState.consumedSourceIds,...first.batch.sourceIds],
  }})
  if (left.ok && left.maximumFullBatches+1>=before.maximumFullBatches) return first

  // Every witness batch can be first. Seed-stable choice limits bias without
  // letting preference or a locally feasible case pairing reduce the cycle count.
  const witnessKeys=before.witness.map((_,i)=>'plan-'+i)
  const selectedKey=seededQuestionOrder(witnessKeys,input.seed,input.bank.version)[0]
  const witness=before.witness[witnessKeys.indexOf(selectedKey)]
  if (!witness) return {ok:false,reason:'CAPACITY_WITNESS_INVARIANT',diagnostics:first.diagnostics}
  const witnessIds=new Set(witness.flatMap((s)=>s.questionIds))
  const standard=new Set(witness.find((s)=>s.kind===NORMAL_SECTIONS[2].kind)?.questionIds ?? [])
  const interactive=new Set(witness.find((s)=>s.kind===NORMAL_SECTIONS[3].kind)?.questionIds ?? [])
  const allowed=new Map(witness.flatMap((s)=>s.caseStudyId ? [[s.caseStudyId,s.questionIds] as const] : []))
  const constrained={
    ...input.bank,
    questions:input.bank.questions.map((q)=>({...q,held:q.held===true || !witnessIds.has(q.sourceId),
      standardEligible:standard.has(q.sourceId),interactiveEligible:interactive.has(q.sourceId),
    })),
    caseStudies:input.bank.caseStudies.map((f)=>({...f,childIds:allowed.get(f.id)??[]})),
  }
  const planned=generateBatch({...input,bank:constrained})
  if (!planned.ok || planned.batch.kind!=='NORMAL_BATCH') return {ok:false,reason:'CAPACITY_WITNESS_INVARIANT',diagnostics:first.diagnostics}
  return {...planned,diagnostics:first.diagnostics}
}
