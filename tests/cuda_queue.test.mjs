import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {queuePlan,runDepthOneQueue} from '../scripts/cuda_frame_queue.mjs';
import {createDriverMonitor} from '../scripts/cuda_driver_monitor.mjs';

test('finite queue accepts requested geometries and rejects excessive count/storage',()=>{
  for(const [columns,rows] of [[160,45],[320,90],[160,80]])assert.equal(queuePlan({columns,rows},30).depth,1);
  for(const count of [0,1,31,1.5])assert.throws(()=>queuePlan({columns:160,rows:45},count));
  assert.throws(()=>queuePlan({columns:1000,rows:1000},30),/128 MiB/);
});
test('refill waits for completion, preserves order and reports whole warm span',async()=>{
  let active=0,peak=0;const calls=[];
  const r=await runDepthOneQueue({inputs:[10,20,30,40],fitFrame:async(p,i)=>{
    ++active;peak=Math.max(peak,active);calls.push(i);await delay(2);--active;return p+1;
  }});
  assert.equal(peak,1);assert.equal(r.peakOutstandingFrames,1);assert.deepEqual(calls,[0,1,2,3]);
  assert.deepEqual(r.records.map(x=>x.actual),[11,21,31,41]);assert.ok(r.refillGapsMs.every(x=>x>=0));
  assert.equal(r.warmSequenceMs,r.records[3].completedAt-r.records[1].submittedAt);
});
test('fit error stops later refills and requests cancellation',async()=>{
  const calls=[];let cancelled=0;
  await assert.rejects(runDepthOneQueue({inputs:[0,1,2],fitFrame:async(_,i)=>{calls.push(i);if(i===1)throw Error('bad frame');},cancel:()=>++cancelled}),/bad frame/);
  await delay(0);assert.deepEqual(calls,[0,1]);assert.equal(cancelled,1);
});
test('deadline poisons the queue even when a late fit eventually resolves',async()=>{
  const calls=[];let cancelled=0;
  await assert.rejects(runDepthOneQueue({inputs:[0,1,2],fitFrame:async(_,i)=>{calls.push(i);await delay(40);},cancel:()=>++cancelled,
    frameTimeoutMs:1000,burstTimeoutMs:10}),/timed out/);
  await delay(60);assert.deepEqual(calls,[0]);assert.ok(cancelled>=1);
});
test('driver error aborts an active queue before subsequent refill',async()=>{
  let polls=0,cancelled=0;const calls=[];
  const monitor=createDriverMonitor(new Date().toISOString(),{pollMs:10,query:async()=>({supported:true,events:++polls===1?[]:[{Id:153}]})});
  try{
    await monitor.ready;
    await assert.rejects(runDepthOneQueue({inputs:[0,1,2],fitFrame:async(_,i)=>{calls.push(i);await delay(40);},
      check:monitor.assertHealthy,failure:monitor.failure,cancel:()=>++cancelled}),/driver error/);
    await delay(50);assert.deepEqual(calls,[0]);assert.equal(cancelled,1);assert.match(monitor.snapshot().error,/driver error/);
  }finally{await monitor.stop();}
});
test('monitor never overlaps queries and stop aborts active query',async()=>{
  let active=0,peak=0,aborted=false,polls=0;
  const monitor=createDriverMonitor(new Date().toISOString(),{pollMs:10,query:async(_, {signal})=>{
    ++active;peak=Math.max(peak,active);++polls;
    try{await delay(polls===1?1:1000,undefined,{signal});return {supported:true,events:[]};}
    catch(e){aborted=true;throw e;}finally{--active;}
  }});
  await monitor.ready;await delay(20);await monitor.stop();assert.equal(peak,1);assert.equal(active,0);assert.equal(aborted,true);
});
test('stale monitor stops refills even if no event response arrives',async()=>{
  let polls=0;
  const monitor=createDriverMonitor(new Date().toISOString(),{pollMs:10,maxAgeMs:100,query:async(_, {signal})=>{
    if(++polls>1)await delay(1000,undefined,{signal});return {supported:true,events:[]};
  }});
  try{await monitor.ready;await assert.rejects(monitor.failure,/stale/);assert.throws(monitor.assertHealthy,/stale/);}
  finally{await monitor.stop();}
});
