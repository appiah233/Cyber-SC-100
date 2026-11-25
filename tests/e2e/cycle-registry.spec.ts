import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { build } from 'vite'
import type { invoke } from './cycle-probe'

let probe=''
test.beforeAll(async ()=>{
  // A disposable test-only executable; never part of app dist, a release artifact, or private input.
  const result=await build({configFile:false,logLevel:'silent',build:{
    write:false,minify:false,
    lib:{entry:fileURLToPath(new URL('cycle-probe.ts',import.meta.url)),name:'Phase4CycleProbe',formats:['iife']},
  }})
  if ('getOutput' in result || 'close' in result) throw new Error('Expected non-watching probe')
  const output=Array.isArray(result)?result[0]:result
  const js=output.output.find((item)=>item.type==='chunk')
  if(!js) throw new Error('Test probe not generated')
  probe=js.code
})
test('real IndexedDB registry survives reload and blocks another tab from generating',async({page,context})=>{
  type ProbeWindow=Window&typeof globalThis&{Phase4CycleProbe:{invoke:typeof invoke}}
  const call=async (target:typeof page,action:string,actor?:string)=>target.evaluate(
    ([command,identity])=>(window as ProbeWindow).Phase4CycleProbe.invoke(command!,identity),[action,actor],
  )
  await page.goto('./')
  await page.addScriptTag({content:probe})
  await expect(call(page,'initialize')).resolves.toMatchObject({ok:true,reserved:0,consumed:0,batches:0})
  await expect(call(page,'generate')).resolves.toMatchObject({ok:true,reserved:0,consumed:0,batches:1})
  await expect(call(page,'START')).resolves.toMatchObject({ok:true,reserved:59,consumed:0,batches:1})
  const other=await context.newPage()
  await other.goto('./')
  await other.addScriptTag({content:probe})
  await expect(call(other,'acquire','browser-second')).resolves.toMatchObject({ok:false,reason:'WRITER_ACTIVE'})
  await expect(call(other,'read-only-generate','browser-second')).resolves.toMatchObject({ok:false,reason:'LEASE_LOST'})
  await expect(call(page,'COMPLETE')).resolves.toMatchObject({ok:true,reserved:0,consumed:59,batches:1})
  await page.reload()
  await page.addScriptTag({content:probe})
  await expect(call(page,'acquire')).resolves.toMatchObject({ok:true,reserved:0,consumed:59,batches:1})
  await expect(call(page,'generate')).resolves.toMatchObject({ok:true,reserved:0,consumed:59,batches:2})
})
