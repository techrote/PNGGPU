import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {parseFixtureArgs,planFixtures} from '../scripts/cuda_fixture_plan.mjs';
import {verifyWorker} from '../scripts/cuda_worker_provenance.mjs';
import {withTimeout,cleanupSteps} from '../scripts/qualification_lifecycle.mjs';
const args=['absent-worker','out.json','--case','saved'];
const fixture={name:'saved',columns:1,rows:1,masks:Array(218),sampleWidth:4,sampleHeight:8,foregroundCandidates:6,backgroundCandidates:5};
test('default exact single-cell scope and conservative full-recovery work',()=>{
  const plan=planFixtures([fixture],parseFixtureArgs(args));
  assert.equal(plan.summary.runs,1);assert.equal(plan.summary.cells,1);
  assert.equal(plan.summary.work,2*(218*32*3+32+218*33+16*6+8*5+32*6*5));
  assert.equal(plan.runs[0].data,fixture);
});
test('only explicit supported CUDA modes are admitted before GPU discovery',()=>{
  assert.equal(parseFixtureArgs(args).cudaMode,'float32-guarded-binary64');
  assert.equal(parseFixtureArgs([...args,'--cuda-mode','binary64-direct']).cudaMode,'binary64-direct');
  for(const value of ['float32','fast-math','--test-fault',undefined])assert.throws(()=>parseFixtureArgs([...args,'--cuda-mode',...(value?[value]:[])]));
  assert.throws(()=>parseFixtureArgs([...args,'--cuda-mode','binary64-direct','--cuda-mode','binary64-direct']));
});
test('reject invalid numbers, flags, duplicated or ambiguous scope',()=>{
  for(const suffix of [['--repeats','0'],['--max-work','-1'],['--max-cells','1.5'],['--max-runs','9007199254740992'],
    ['--tiles','1,1'],['--tiles','65537'],['--tiles',''],['--timeout-ms','30001'],['--repeats','101'],['--wat'],
    ['--case','saved'],['--suite'],['--max-runs'],['--max-runs','1','--max-runs','2']])
    assert.throws(()=>parseFixtureArgs([...args,...suffix]),undefined,suffix.join(' '));
  assert.throws(()=>parseFixtureArgs(['worker','out']));
  assert.throws(()=>planFixtures([fixture],parseFixtureArgs(['worker','out','--case','sav'])));
});
test('aggregate budgets include repeats, tiles and both backends, without unsafe arithmetic',()=>{
  const expanded=[...args,'--repeats','2','--tiles','1,3','--webgpu','playwright','--max-runs','8','--max-cells','8'];
  const options=parseFixtureArgs(expanded),plan=planFixtures([fixture],options);
  assert.equal(plan.summary.runs,8);assert.equal(plan.summary.cells,8);
  assert.equal(plan.summary.work,planFixtures([fixture],parseFixtureArgs(args)).summary.work*8);
  for(const key of ['maxRuns','maxCells','maxWork'])assert.throws(()=>planFixtures([fixture],{...options,[key]:1}));
  assert.throws(()=>planFixtures([{...fixture,columns:Number.MAX_SAFE_INTEGER,rows:Number.MAX_SAFE_INTEGER}],options));
});
test('legacy complete suite still explicitly plans all 81 fits',()=>{
  const fixtures=Array.from({length:27},(_,i)=>({...fixture,name:String(i)}));
  const plan=planFixtures(fixtures,parseFixtureArgs(['worker','out','--suite','--tiles','1,3,64','--max-runs','81','--max-cells','81','--max-work','100000000']));
  assert.equal(plan.summary.runs,81);
});
test('CLI over-budget plan fails before reading or launching absent worker',()=>{
  const child=spawnSync(process.execPath,['scripts/replay_cuda_fixtures.mjs','absent-worker','unused.json',
    '--case','historical-4x8-cell-105420','--max-work','1'],{encoding:'utf8'});
  assert.notEqual(child.status,0);assert.match(child.stderr,/Planned aggregate exceeds/);assert.doesNotMatch(child.stderr,/ENOENT/);
});
test('changed binary or inconsistent source receipt is rejected before execution',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'pnggpu-provenance-'));
  try {
    const worker=resolve(dir,'pnggpu_cuda_worker.exe');
    await writeFile(worker,'never execute');await writeFile(resolve(dir,'SOURCE_COMMIT.txt'),'a'.repeat(40));
    await writeFile(resolve(dir,'worker-sha256.json'),JSON.stringify({sourceCommit:'b'.repeat(40),worker:'pnggpu_cuda_worker.exe',sha256:'0'.repeat(64)}));
    await assert.rejects(verifyWorker(worker,process.cwd()),/source\/hash receipt mismatch/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('stalled work stops and failing cleanup does not skip subsequent resource disposal',async()=>{
  let timeoutCleanup=false,disposed=false;
  await assert.rejects(withTimeout(new Promise(()=>{}),5,()=>{timeoutCleanup=true;throw new Error('close failed');}),/timed out/);
  assert.equal(timeoutCleanup,true);
  const errors=await cleanupSteps([
    ['browser',()=>{throw new Error('protocol closed');}],
    ['stalled',()=>new Promise(()=>{})],
    ['native',()=>{disposed=true;}]
  ],5);
  assert.equal(disposed,true);assert.equal(errors.length,2);assert.equal(errors[0].step,'browser');
});
