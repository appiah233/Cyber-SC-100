import type { BatchBank, BatchQuestion } from '../domain/batch-engine'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v==='object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(v)
const sourceId = (v: unknown): v is string => typeof v==='string' && /^Q[1-9][0-9]{0,5}$/.test(v)
const fail = (): never => { throw new Error('Development inventory is invalid or untraced') }
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : fail()
const ids = (v: unknown): string[] => list(v).map((x)=>text(x)?x:fail())
const kinds = new Set(['SINGLE_CHOICE','MULTIPLE_CHOICE','DROPDOWN','MATCHING','ORDERING','DRAG_DROP','STATEMENT','DROPDOWN_HOTSPOT','IMAGE_HOTSPOT','DIAGRAM_DEPENDENT'])
const interactions = new Set(['MATCHING','ORDERING','DRAG_DROP','STATEMENT','DROPDOWN_HOTSPOT','IMAGE_HOTSPOT','DIAGRAM_DEPENDENT'])
const lockFields = new Set(['SOURCE_CONTENT_INCONSISTENCY_REVIEW','SOURCE_INTERACTION_REVIEW_REQUIRED','NEEDS_REVIEW','SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT'])
const layout = ['CASE_STUDY_1','CASE_STUDY_2','STANDARD_BLOCK','FINAL_INTERACTIVE_BLOCK']
const arity = [3,3,49,4]

/** Project only eligibility and identity metadata from a locally supplied, preverified private bank.
 * No answer, explanation, or question text is read or returned. Not part of the public entry graph. */
export function bindDevelopmentInventory(input: unknown, reference: unknown, expectedVersion: string): BatchBank {
  if (!object(input) || !object(input.manifest) || !text(expectedVersion) || input.manifest.bankVersion!==expectedVersion ||
      input.manifest.scope!=='PRIVATE_DEVELOPMENT_ONLY' || input.manifest.productionEligibleCount!==0 ||
      !object(reference) || reference.fixtureId!=='REFERENCE-BATCH-001' || reference.scope!=='PRIVATE_DEVELOPMENT_ONLY' || reference.productionEligible!==false ||
      reference.contentApproved!==false || reference.total!==59 || reference.uniqueSourceIds!==59 ||
      typeof input.manifest.sourceDocumentChecksum!=='string' ||
      !/^[a-f0-9]{64}$/.test(input.manifest.sourceDocumentChecksum) ||
      input.manifest.sourceDocumentChecksum!==reference.sourcePdfSha256) return fail()
  const refSections=list(reference.sections)
  if (refSections.length!==4 || JSON.stringify(reference.sectionOrder)!==JSON.stringify(layout)) return fail()
  const sectionIds=refSections.map((s,i)=>{
    if (!object(s) || s.key!==layout[i] || (i<2 && !text(s.familyId))) return fail()
    const members=list(s.sourceIds)
    if (members.length!==arity[i] || !members.every((id)=>Number.isSafeInteger(id) && Number(id)>0)) return fail()
    return members.map((id)=>'Q'+String(id))
  })
  const fixtureIds=new Set(sectionIds.flat())
  if (fixtureIds.size!==59) return fail()
  const standardIds=new Set(sectionIds[2])
  const interactiveIds=new Set(sectionIds[3])

  const byId=new Map<string, BatchQuestion>()
  for (const q of list(input.questions)) {
    if (!object(q) || !sourceId(q.sourceId) || byId.has(q.sourceId) ||
        typeof q.productionEligible!=='boolean' || q.productionEligible || q.contentApproved!==false ||
        typeof q.reviewStatus!=='string' || typeof q.developmentOnly!=='boolean' ||
        !object(q.interaction) || typeof q.interaction.kind!=='string' || !kinds.has(q.interaction.kind)) return fail()
    const authorized=q.developmentOnly===true && q.reviewStatus==='VALIDATED_FOR_DEVELOPMENT' &&
      q.sourceValidated===true && q.interactionValidated===true
    if (authorized!==fixtureIds.has(q.sourceId)) return fail()
    const kind=(q.requiresDiagram===true && q.interaction.kind!=='DROPDOWN_HOTSPOT'
      ? 'DIAGRAM_DEPENDENT' : q.interaction.kind) as BatchQuestion['interactionKind']
    if (interactiveIds.has(q.sourceId) && !interactions.has(kind)) return fail()
    const optionGroups: {id:string;optionIds:readonly string[];shuffle:boolean}[]=[]
    const capture = (id: string, options: unknown) => {
      const values=list(options).map((o)=>object(o)&&text(o.id)?o.id:fail())
      if (!values.length || new Set(values).size!==values.length) return fail()
      optionGroups.push(Object.freeze({id,optionIds:Object.freeze(values),shuffle:false}))
    }
    if ('options' in q.interaction) capture('options',q.interaction.options)
    if ('choices' in q.interaction) capture('choices',q.interaction.choices)
    if ('items' in q.interaction) capture('items',q.interaction.items)
    if ('targets' in q.interaction && !('choices' in q.interaction)) {
      let statementChoices: readonly string[] | undefined
      const targetIds=new Set<string>()
      for (const t of list(q.interaction.targets)) {
        if (!object(t)||!text(t.id)||targetIds.has(t.id)) return fail()
        targetIds.add(t.id)
        if (q.interaction.kind==='STATEMENT') {
          // The same source Yes/No choice IDs are intentionally shared by all statement targets.
          const incoming=list(t.options).map((o)=>object(o)&&text(o.id) ? o.id : fail())
          if (statementChoices && JSON.stringify(statementChoices)!==JSON.stringify(incoming)) return fail()
          if (!statementChoices) { capture('statement-choices',t.options); statementChoices=incoming }
        } else capture(t.id,t.options)
      }
    }
    byId.set(q.sourceId,Object.freeze({sourceId:q.sourceId,interactionKind:kind,
      developmentValidated:authorized,productionEligible:false,held:lockFields.has(q.reviewStatus),
      standardEligible:standardIds.has(q.sourceId),interactiveEligible:interactiveIds.has(q.sourceId),
      optionGroups:Object.freeze(optionGroups),
    }))
  }
  if (byId.size!==input.manifest.questionCount || [...fixtureIds].some((k)=>!byId.has(k))) return fail()

  const seen=new Set<string>()
  const families=list(input.caseStudies).map((f)=>{
    if (!object(f) || !text(f.id) || seen.has(f.id) || f.productionStatus!=='NOT_APPROVED' ||
        !['VALIDATED_FOR_DEVELOPMENT','NEEDS_REVIEW'].includes(String(f.reviewStatus))) return fail()
    seen.add(f.id)
    const childIds=ids(f.validatedChildIds)
    const members=ids(f.sourceQuestionIds)
    if (new Set(childIds).size!==childIds.length || childIds.some((x)=>!members.includes(x) || !byId.has(x))) return fail()
    return Object.freeze({id:f.id,childIds:Object.freeze(childIds),developmentValidated:f.reviewStatus==='VALIDATED_FOR_DEVELOPMENT',productionEligible:false})
  })
  for (const [i,s] of refSections.slice(0,2).entries()) {
    if (!object(s)) return fail()
    const f=families.find((g)=>g.id===s.familyId)
    if (!f?.developmentValidated || sectionIds[i].some((id)=>!f.childIds.includes(id))) return fail()
  }
  return Object.freeze({version:expectedVersion,questions:Object.freeze([...byId.values()]),caseStudies:Object.freeze(families)})
}
