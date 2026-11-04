import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {MOCK_WORKER} from './fixtures/cuda_worker_source.mjs';
import {createCudaDirectTransport} from '../scripts/cuda_direct.mjs';
import {PhotographicCudaFitter,packInit} from '../overlay/src/gpu/cuda.js';

const data=()=>({columns:3,rows:1,sampleWidth:1,sampleHeight:1,pixels:Uint8Array.from([1,2,3,255,2,4,6,128,3,6,9,0]),
  masks:[new Float32Array([0]),new Float32Array([1])],palette:Array.from({length:16},()=>[0,0,0]),
  foregroundCandidates:6,backgroundCandidates:5,preferredTileCells:2,inFlightTiles:1});
async function fixture(t,mode='normal',options={}){
  const dir=await mkdtemp(join(tmpdir(),'pnggpu-direct-')),file=join(dir,'worker.cjs');await writeFile(file,MOCK_WORKER);
  const children=new Set(),launches=[];
  const transport=createCudaDirectTransport({executable:'not-a-gpu-worker',operationTimeoutMs:1000,infoTimeoutMs:1000,...options,
    spawnProcess:(exe,args,opts)=>{launches.push({args,opts});const child=spawn(process.execPath,[file,...args],{...opts,env:{...process.env,PNGGPU_MOCK_MODE:mode}});
      children.add(child);child.once('close',()=>children.delete(child));return child;}});
  t.after(async()=>{await transport.close();assert.equal(children.size,0);await rm(dir,{recursive:true,force:true});});
  return {transport,children,launches};
}
test('direct fitter reuses one framed child, partial tiles, buffers and cleanup',async t=>{
  const f=await fixture(t),fit=await PhotographicCudaFitter.create({transport:f.transport}),session=fit.createFrameSession(data());
  const a=await session.fitFrame(data().pixels),b=await session.fitFrame(data().pixels);
  assert.deepEqual([...a.chosen],[1,0,1]);assert.deepEqual([...a.chosen],[...b.chosen]);assert.equal(b.stats.sessionReused,true);
  assert.equal(f.launches.filter(x=>x.args.includes('--stdio')).length,1);assert.ok(f.launches.every(x=>x.opts.shell===false));
  await session.close();assert.equal(f.children.size,0);
});
test('direct init reserves slot and simultaneous requests cannot queue allocations',async t=>{
  const {transport}=await fixture(t,'slow-init'),packet=packInit(data(),{tileCells:2},2,1);
  const pending=transport.request('/api/cuda/session',{method:'POST',body:packet});
  await assert.rejects(transport.request('/api/cuda/session',{method:'POST',body:packet}),/busy/);await pending;
  await transport.request('/api/cuda/session/direct_cuda_session',{method:'DELETE'});
});
test('direct cancellation kills the active child before releasing ownership',async t=>{
  const f=await fixture(t,'slow-tile'),fit=await PhotographicCudaFitter.create({transport:f.transport}),session=fit.createFrameSession(data());
  const pending=session.fitFrame(data().pixels);const rejected=assert.rejects(pending,{name:'AbortError'});await delay(100);await session.close();await rejected;
  assert.equal(f.children.size,0);
});
for(const mode of ['truncated','oversized','extra','invalid-json','wrong-count','tile-stall'])test(`direct ${mode} poisons and cleans up`,async t=>{
  const f=await fixture(t,mode),fit=await PhotographicCudaFitter.create({transport:f.transport}),session=fit.createFrameSession(data());
  await assert.rejects(session.fitFrame(data().pixels));await session.close();assert.equal(f.children.size,0);
  await assert.rejects(session.fitFrame(data().pixels),/closed/);
});
test('direct probe close aborts detection and waits for process exit',async t=>{
  const f=await fixture(t,'info-stall');const pending=f.transport.request('/api/cuda/info');const rejected=assert.rejects(pending);
  await delay(30);await f.transport.close();await rejected;assert.equal(f.children.size,0);
});
test('direct invalid init fails before spawning and idle expiry releases child',async t=>{
  const f=await fixture(t,'normal',{idleTimeoutMs:20});
  await assert.rejects(f.transport.request('/api/cuda/session',{method:'POST',body:new Uint8Array(4)}));assert.equal(f.launches.length,0);
  await f.transport.request('/api/cuda/session',{method:'POST',body:packInit(data(),{tileCells:2},2,1)});await delay(100);assert.equal(f.children.size,0);
});
