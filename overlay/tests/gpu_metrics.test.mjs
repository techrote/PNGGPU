import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTimings,compareAnsi,compareCells,bytes,median,ratio} from '../src/gpu/metrics.js';

test('single-run comparable wall totals include same shared CPU prep and output on each side',()=>{
  const s=summarizeTimings({prepMs:65,cpuFitMs:49_365,gpuFitMs:849,
    cpuOutputMs:120,gpuOutputMs:110,gpuRuns:[849,810,801]});
  assert.equal(s.cpuTotalMs,49_550);
  assert.equal(s.gpuTotalMs,1024);
  assert.equal(s.cpuPrepMs,s.gpuPrepMs);
  assert.equal(s.fitSpeedup,49_365/849);
  assert.equal(s.totalSpeedup,49_550/1024);
  assert.equal(s.gpuMedianMs,810);
  assert.equal(s.gpuRepeatTimesMs.length,3);
});
test('CPU disabled is not misreported as a speedup or a zero-duration CPU run',()=>{
  const s=summarizeTimings({prepMs:10,cpuFitMs:null,gpuFitMs:7,cpuOutputMs:null,gpuOutputMs:3});
  assert.equal(s.cpuTotalMs,null);assert.equal(s.fitSpeedup,null);assert.equal(s.totalSpeedup,null);
  assert.equal(s.gpuTotalMs,20);
  assert.equal(ratio(20,0),null);
});
test('ANSI byte and component-level mismatch reporting is independent and exact',()=>{
  const a={chosen:Uint16Array.from([1,2,3,4]),fg:Uint8Array.from([1,2,3,4]),bg:Uint8Array.from([0,0,0,0])};
  const b={chosen:Uint16Array.from([1,5,3,4]),fg:Uint8Array.from([1,2,9,4]),bg:Uint8Array.from([0,0,8,0])};
  assert.deepEqual(compareCells(a,b),{glyph:1,foreground:1,background:1,changedCells:2,firstChangedCell:1});
  assert.deepEqual(compareAnsi(Uint8Array.from([1,2,3]),Uint8Array.from([1,2,4])),{mismatches:1,firstMismatch:2});
  assert.deepEqual(compareAnsi(Uint8Array.from([1,2,3]),Uint8Array.from([1,2,3])),{mismatches:0,firstMismatch:null});
  assert.equal(compareAnsi(null,Uint8Array.of(1)).mismatches,null);
  assert.equal(compareCells(null,b).glyph,null);
});
test('metric helpers preserve binary byte units and stable medians',()=>{
  assert.equal(bytes(1024*1024),'1.00 MiB');assert.equal(bytes(1023),'1023 B');
  assert.equal(median([]),null);assert.equal(median([4,1,5,2]),3);
});
