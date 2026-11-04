import test from 'node:test';
import assert from 'node:assert/strict';
import {warmTimingBreakdown} from '../scripts/cuda_timing_breakdown.mjs';
const frame=()=>({fitMs:440,stats:{sessionReused:true,timing:{nativeInitMs:0,atlasUploadMs:0,
  nativeTotalMs:300,bridgeRoundTripMs:400,tilePackMs:30,decodeCellsMs:5,
  gpuProjectionMs:100,gpuSelectionMs:100,uploadMs:6,readbackMs:4}}});
test('warm interval accounting separates nested spans without counting them twice',()=>{
  const r=warmTimingBreakdown(frame());assert.equal(r.nativeResidualMs,90);assert.equal(r.bridgeRemainderMs,100);assert.equal(r.otherFitMs,5);
  assert.equal(r.packingMs+r.projectionMs+r.selectionMs+r.transferMs+r.decodeMs+r.nativeResidualMs+r.bridgeRemainderMs+r.otherFitMs,r.fitMs);
});
test('unavailable or malformed measurements cannot become apparently measured zero',()=>{
  for(const value of [null,undefined,NaN,Infinity,-1,'3']){const f=frame();f.stats.timing.nativeTotalMs=value;assert.throws(()=>warmTimingBreakdown(f),/nativeTotalMs/);}
});
test('cold initialization and atlas transfers are excluded rather than misattributed',()=>{
  for(const mutate of [f=>f.stats.sessionReused=false,f=>f.stats.timing.nativeInitMs=4,f=>f.stats.timing.atlasUploadMs=1]){
    const f=frame();mutate(f);assert.throws(()=>warmTimingBreakdown(f),/warm reused/);
  }
});
test('clock/interval residuals retain their sign for diagnosis',()=>{
  const f=frame();f.stats.timing.nativeTotalMs=500;
  assert.equal(warmTimingBreakdown(f).bridgeRemainderMs,-100);
});
