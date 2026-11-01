import {test} from 'node:test';
import assert from 'node:assert/strict';
import {progressSnapshot,humanRate,etaText} from '../src/gpu/progress.js';
import {gpuProfileStages} from '../src/gpu/metrics.js';

test('real completed-cell counters derive correct elapsed throughput and remaining work',()=>{
  const p=progressSnapshot({completedCells:12_800,totalCells:51_200,elapsedMs:1_000,glyphCount:219,workUnits:9_060_556_800});
  assert.equal(p.percent,25);
  assert.equal(p.cellsPerSecond,12_800);
  assert.equal(p.remainingMs,3_000);
  assert.equal(p.glyphTestsPerSecond,2_803_200);
  assert.ok(p.estimatedWorkUnitsPerSecond>2e9);
  assert.equal(etaText(p.remainingMs),'ETA 3s');
  assert.match(humanRate(p.estimatedWorkUnitsPerSecond),/B/);
});
test('progress clamps invalid inputs and does not fabricate throughput before completion',()=>{
  assert.equal(progressSnapshot({completedCells:0,totalCells:100,elapsedMs:0}).cellsPerSecond,null);
  assert.equal(progressSnapshot({completedCells:1000,totalCells:100,elapsedMs:1500}).percent,100);
  assert.equal(progressSnapshot({completedCells:1000,totalCells:100,elapsedMs:1500}).remainingMs,0);
  assert.equal(progressSnapshot({completedCells:-20,totalCells:100,elapsedMs:100}).completedCells,0);
  assert.throws(()=>progressSnapshot({completedCells:1,totalCells:0,elapsedMs:10}),/positive/);
  assert.equal(etaText(null),'ETA —');
});
test('GPU profiler render remains safe when a stale but valid older fitter has no timings',()=>{
  const old={gpuStats:{tileCells:64},gpuRender:{fitMs:25}};
  assert.deepEqual(gpuProfileStages(old),{});
  assert.deepEqual(gpuProfileStages({}),{});
  const fallback={atlasPackMs:3};
  assert.deepEqual(gpuProfileStages({gpuRender:{stageTimings:fallback}}),fallback);
  assert.deepEqual(gpuProfileStages({gpuStats:{timing:{tilePackMs:5}},gpuRender:{stageTimings:fallback}}),{tilePackMs:5});
});
