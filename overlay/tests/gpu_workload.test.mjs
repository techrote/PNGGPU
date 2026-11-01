import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GPU_MAX_WORK_UNITS, CPU_REFERENCE_WORK_UNITS, photographicWorkUnits,
  validateWorkbenchInputs, validateGpuBudget } from '../src/gpu/workload.js';
const base = {columns:160, rows:80, sampleW:8, sampleH:32, foreground:8, background:8};
test('GPU work accounting supports huge research profiles, CPU ceiling unchanged', () => {
  assert.equal(GPU_MAX_WORK_UNITS, Number.MAX_SAFE_INTEGER);
  assert.equal(CPU_REFERENCE_WORK_UNITS, 125_000_000);
  assert.equal(photographicWorkUnits(base,219), 2_265_139_200);
  assert.equal(validateGpuBudget(base,219), 2_265_139_200);
  assert.throws(()=>validateGpuBudget(base,219,100), /exceeds the 100 work-unit/);
});
test('all UI bounds emit a parameter-specific error before CPU schema validation', () => {
  assert.deepEqual(validateWorkbenchInputs(base), base);
  for (const [key,value] of Object.entries({columns:1025,rows:1025,sampleW:33,sampleH:65,foreground:13,background:9})) {
    assert.throws(()=>validateWorkbenchInputs({...base,[key]:value}), /outside the supported/);
  }
  assert.throws(()=>validateWorkbenchInputs({...base,rows:'nonsense'}), /Rows: enter a whole number/);
  assert.throws(()=>validateWorkbenchInputs({...base,rows:''}), /Rows: enter a whole number/);
});
test('GPU maximum supports 1024² cells / 32×64 sampling without integer overflow', () => {
  const max = { columns:1024, rows:1024, sampleW:32, sampleH:64, foreground:12, background:8 };
  assert.ok(validateGpuBudget(max,224) < GPU_MAX_WORK_UNITS);
  assert.ok(validateGpuBudget(max,224) > 125_000_000_000);
  assert.equal(validateWorkbenchInputs(max).sampleH,64);
  assert.ok(validateGpuBudget(max,224) > CPU_REFERENCE_WORK_UNITS);
});
