import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {imageGeometry,parseImagePreparationArgs,imagePreparationHtml,validateImageFixture,loadImageFixture,sha256} from '../scripts/cuda_image_fixture.mjs';
import {parseFixtureArgs,planFixtures} from '../scripts/cuda_fixture_plan.mjs';
const makeDocument=()=>{
  const fixture={name:'image-test-1x1-1x1',columns:1,rows:1,sampleWidth:1,sampleHeight:1,pixels:[1,2,3,255],
    masks:[[0],[1]],codes:[32,219],palette:Array.from({length:16},()=>[0,0,0]),foregroundCandidates:6,backgroundCandidates:5};
  const sourceFiles=Object.fromEntries(['overlay/fixtures/hardmode/manifest.json','overlay/fixtures/hardmode/test.png',
    'overlay/experiments/webgpu/photographic.html','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf',
    'scripts/prepare_cuda_image.mjs','scripts/cuda_image_fixture.mjs'].map(p=>[p,'a'.repeat(64)]));
  return {schema:'pnggpu-real-image-fixture-v1',fixture,fixtureSha256:sha256(JSON.stringify(fixture)),
    provenance:{sourceSamplingMode:'full-reference-canvas',sourceFiles,sourceCommit:'a'.repeat(40),started:'2026-11-04T14:00:00.000Z',image:{file:'test.png',sha256:'a'.repeat(64)}}};
};
test('small real-image geometry rejects oversized, unsafe and non-integer requests',()=>{
  assert.deepEqual(imageGeometry(8,4),{columns:8,rows:4,sampleWidth:4,sampleHeight:8});
  for(const dims of [[8,9],[0,1],[1,1,9,8],[1,1,8,17],[1.5,1],[Number.MAX_SAFE_INTEGER,1]])assert.throws(()=>imageGeometry(...dims));
});
test('larger preparation requires an explicit bounded limit before any browser starts',()=>{
  const base=['playwright','output','holo-stealth-cloak-1024.png'];
  for(const [columns,rows] of [[16,8],[32,16],[80,40]]) {
    assert.throws(()=>parseImagePreparationArgs([...base,String(columns),String(rows)]));
    const p=parseImagePreparationArgs([...base,String(columns),String(rows),'--max-preparation-cells',String(columns*rows)]);
    assert.equal(p.maxPreparationCells,columns*rows);assert.equal(p.geometry.columns,columns);
    const fixture={name:'image-larger',...p.geometry,masks:Array(218),foregroundCandidates:6,backgroundCandidates:5};
    const options=parseFixtureArgs(['worker','out','--case','image-larger','--webgpu','playwright',
      '--max-runs','2','--max-cells',String(2*columns*rows),'--max-work',String(117000*columns*rows)]);
    assert.equal(planFixtures([fixture],options).summary.work,117000*columns*rows);
    assert.throws(()=>planFixtures([fixture],{...options,maxCells:2*columns*rows-1}));
  }
  for(const value of ['51201','9007199254740992','0','-1','1.5'])assert.throws(()=>parseImagePreparationArgs([...base,'80','40','--max-preparation-cells',value]));
  assert.throws(()=>parseImagePreparationArgs([...base,'1','1','--max-preparation-cells','64','--max-preparation-cells','128']));
  assert.throws(()=>imageGeometry(321,1,4,8,51200));assert.throws(()=>imageGeometry(80,41,4,8,3200));
  assert.equal(imageGeometry(80,40,8,16,3200).sampleHeight,16);
  assert.throws(()=>imageGeometry(80,40,8,8,3200));
  assert.equal(imageGeometry(160,80,4,8,12800).columns,160);
  assert.equal(imageGeometry(320,160,4,8,51200).rows,160);
  assert.throws(()=>imageGeometry(320,160,8,16,51200));
});
test('prepared larger inputs must retain a valid preparation limit when replayed',()=>{
  const d=makeDocument();
  Object.assign(d.fixture,{columns:16,rows:8,sampleWidth:4,sampleHeight:8,
    pixels:Array(16*8*4*8*4).fill(255),masks:[Array(32).fill(0),Array(32).fill(1)]});
  d.fixtureSha256=sha256(JSON.stringify(d.fixture));d.provenance.maxPreparationCells=128;
  assert.equal(validateImageFixture(d),d.fixture);
  delete d.provenance.maxPreparationCells;assert.throws(()=>validateImageFixture(d),/preparation cell/);
  d.provenance.maxPreparationCells=64;assert.throws(()=>validateImageFixture(d));
  d.provenance.maxPreparationCells=51201;assert.throws(()=>validateImageFixture(d));
});
test('preparation page uses existing font/mask/config functions without matcher or UI preflight',async()=>{
  const source=await readFile('overlay/experiments/webgpu/photographic.html','utf8'),html=imagePreparationHtml(source);
  assert.match(html,/async function masksFor/);assert.match(html,/function makeConfig/);assert.match(html,/DejaVuSansMono.ttf/);
  assert.doesNotMatch(html,/createGpuFitter|scheduleMemoryEstimate|PhotographicWebGpuFitter|\.fit\(/);
  assert.throws(()=>imagePreparationHtml('changed source'),/boundaries changed/);
});
test('prepared bytes, float32 masks, code order, candidate counts and source hashes are validated',()=>{
  const d=makeDocument();assert.equal(validateImageFixture(d),d.fixture);
  for(const mutate of [d=>d.fixture.pixels[0]=256,d=>d.fixture.masks[0][0]=0.1,d=>d.fixture.codes[1]=32,
    d=>d.fixture.foregroundCandidates=1,d=>delete d.provenance.sourceFiles['PNG2ANSI/src/core.js']]) {
    const changed=makeDocument();mutate(changed);changed.fixtureSha256=sha256(JSON.stringify(changed.fixture));
    assert.throws(()=>validateImageFixture(changed));
  }
  d.fixture.pixels[0]=9;assert.throws(()=>validateImageFixture(d),/hash mismatch/);
});
test('prepared image selection preserves aggregate bounds for repeats, tiles and both backends',()=>{
  const args=['worker','out','--fixture-file','input.json','--case','image-test-1x1-1x1','--webgpu','playwright','--max-cells','2','--max-runs','2'];
  const options=parseFixtureArgs(args),plan=planFixtures([makeDocument().fixture],options);
  assert.equal(options.fixtureFile,'input.json');assert.equal(plan.summary.cells,2);
  assert.throws(()=>parseFixtureArgs(['worker','out','--suite','--fixture-file','input.json']));
  assert.throws(()=>parseFixtureArgs([...args,'--fixture-file','input2.json']));
  assert.throws(()=>planFixtures([makeDocument().fixture],{...options,maxCells:1}));
});
test('bad preparation/source receipts reject before worker discovery',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'pnggpu-image-'));
  try {
    const path=resolve(dir,'input.json'),d=makeDocument();await writeFile(path,JSON.stringify(d));
    await assert.rejects(loadImageFixture(path,process.cwd(),d.fixture.palette),/source differs/);
    d.fixture.pixels[0]=15;await writeFile(path,JSON.stringify(d));
    const child=spawnSync(process.execPath,['scripts/replay_cuda_fixtures.mjs','absent-worker','unused.json',
      '--fixture-file',path,'--case',d.fixture.name],{encoding:'utf8'});
    assert.notEqual(child.status,0);assert.match(child.stderr,/fixture hash mismatch/);assert.doesNotMatch(child.stderr,/ENOENT/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
