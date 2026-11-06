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
  for(const mode of ['float32-direct','float16-mixed']) {
    const o=parseFixtureArgs([...args,'--cuda-mode',mode,'--allow-parity-differences']);
    assert.equal(o.cudaMode,mode);assert.equal(o.allowParityDifferences,true);
  }
  for(const value of ['float32','fast-math','--test-fault',undefined])assert.throws(()=>parseFixtureArgs([...args,'--cuda-mode',...(value?[value]:[])]));
  assert.throws(()=>parseFixtureArgs([...args,'--cuda-mode','binary64-direct','--cuda-mode','binary64-direct']));
  assert.throws(()=>parseFixtureArgs([...args,'--skip-cpu']));
  assert.equal(parseFixtureArgs([...args,'--skip-cpu','--allow-parity-differences']).skipCpu,true);
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
test('MiB tile budgets convert before GPU discovery and cannot bypass aggregate limits',()=>{
  const options=parseFixtureArgs([...args,'--tile-mib','16']);
  const plan=planFixtures([fixture],options);assert.equal(plan.runs[0].tileCells,Math.floor(16*1024*1024/(218*16)));
  assert.equal(plan.summary.tileMiB,16);
  assert.deepEqual(plan.summary.tiles,[Math.floor(16*1024*1024/(218*16))]);
  assert.throws(()=>parseFixtureArgs([...args,'--tile-mib','33']));
  assert.throws(()=>parseFixtureArgs([...args,'--tile-mib','16','--tiles','16']));
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
import {planFrames} from '../scripts/cuda_frame_plan.mjs';
import {videoGeometry,videoPlan,validateVideoManifest,VIDEO_SOURCE_FILES,pngDimensions,crop16x9} from '../scripts/cuda_video_plan.mjs';
import {checkedAfterInfo} from '../scripts/cuda_after_info.mjs';
import {videoTilePlan} from '../scripts/cuda_video_tile_plan.mjs';

test('warm frame plans cap the entire sequence and require immutable matching geometry before discovery',()=>{
  const data={columns:320,rows:160,sampleWidth:4,sampleHeight:8,foregroundCandidates:6,backgroundCandidates:5,
    masks:Array.from({length:218},()=>new Float32Array(32)),codes:Array.from({length:218},(_,i)=>i),palette:Array.from({length:16},()=>[0,0,0])};
  const plan={inputs:['a','b'],mode:'float32-direct',tileMiB:16,frameOrder:[0,1,0,1,0,1],
    limits:{maxFrames:6,maxCells:307200,maxWork:18000000000,timeoutMs:10000}};
  const summary=planFrames(plan,[data,data]);assert.equal(summary.runs,6);assert.equal(summary.cells,307200);assert.equal(summary.work,17971200000);
  for(const patch of [{frameOrder:Array(7).fill(0)},{frameOrder:[2]},{mode:'float16-mixed'},{tileMiB:64},
    {limits:{...plan.limits,maxFrames:5}},{limits:{...plan.limits,maxCells:307199}},
    {limits:{...plan.limits,maxWork:17971199999}},{limits:{...plan.limits,timeoutMs:10001}}])
    assert.throws(()=>planFrames({...plan,...patch},[data,data]));
  assert.throws(()=>planFrames(plan,[data,{...data,foregroundCandidates:5}]),/fixed bounded geometry/);
  assert.throws(()=>planFrames({...plan,requireColdReference:false},[data,data]),/512-cell smoke/);
});

test('video scope explicitly bounds 120-frame characterization and 30-frame comparisons before discovery',()=>{
  const a={columns:320,rows:160,sampleWidth:4,sampleHeight:8,foregroundCandidates:6,backgroundCandidates:5,
    masks:Array.from({length:218},()=>Array(32).fill(0)),codes:Array.from({length:218},(_,i)=>i),palette:Array.from({length:16},()=>[0,0,0])};
  assert.equal(videoPlan(a,120,'float32-direct',32).work,359424000000);
  assert.equal(videoPlan(a,30,'binary64-direct',16).cells,1536000);
  for(const n of [0,121,1.5])assert.throws(()=>videoGeometry(320,160,n));
  assert.throws(()=>videoGeometry(640,320,30));assert.throws(()=>videoPlan(a,30,'float16-mixed',32));
  const g=videoGeometry(320,160,1),digest='a'.repeat(64),bytes=320*160*32*4;
  const b={schema:'pnggpu-video-frames-v1',completed:true,cleanupErrors:[],fitMode:'contain-black',atlas:a,geometry:g,
    sourceCommit:'a'.repeat(40),started:new Date().toISOString(),sourceFiles:Object.fromEntries(VIDEO_SOURCE_FILES.map(p=>[p,digest])),
    frames:[{index:0,name:'frame_0001.png',rgbaOffset:0,rgbaBytes:bytes,rgbaSha256:digest,sourceSha256:digest}],rgbaBytes:bytes,rgbaSha256:digest};
  assert.equal(validateVideoManifest(b),a);
  for(const patch of [{sourceFiles:{}},{rgbaBytes:bytes-1},{completed:false},{frames:[]},{atlas:{...a,codes:Array(218).fill(0)}}])
    assert.throws(()=>validateVideoManifest({...b,...patch}));
});

test('PNG dimension caps reject oversized headers before browser decoding',()=>{
  const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(854,16);b.writeUInt32BE(480,20);
  assert.deepEqual(pngDimensions(b),{width:854,height:480});
  b.writeUInt32BE(4097,16);assert.throws(()=>pngDimensions(b),/dimensions/);
  assert.throws(()=>pngDimensions(Buffer.alloc(24)),/header/);
});

test('cropped video grids preserve the glyph display aspect with a small exact source crop',()=>{
  assert.deepEqual(crop16x9(854,480),{x:3,y:1,width:848,height:477});
  for(const [columns,rows] of [[160,45],[320,90]]){
    assert.equal(columns*8/(rows*16),16/9);assert.equal(videoGeometry(columns,rows,30).count,30);
  }
  assert.throws(()=>crop16x9(10,4));assert.throws(()=>videoGeometry(160,46,30));
});

test('larger CUDA video tiles preserve aggregate work and reject targets beyond the native experiment cap',()=>{
  const a={columns:320,rows:90,sampleWidth:4,sampleHeight:8,foregroundCandidates:6,backgroundCandidates:5,masks:Array(218)};
  const p=videoTilePlan(a,30,'float32-direct',32),q=videoTilePlan(a,30,'float32-direct',128);
  assert.equal(p.work,q.work);assert.equal(q.runs,30);assert.equal(q.tiles[0],38479);
  assert.equal(videoTilePlan(a,30,'binary64-direct',64).tiles[0],19239);
  assert.throws(()=>videoTilePlan(a,30,'float32-direct',256));
});

test('failed or changed post-cleanup device probes cannot silently allow another sequence',()=>{
  const M=1024**2,info={schema:'pnggpu-cuda-info-v1',available:true,backend:'cuda',protocolVersion:1,precision:'float32-direct',
    device:{index:0,name:'test',computeCapability:'7.5',totalMemoryBytes:4*1024**3,freeMemoryBytes:3*1024**3},
    limits:{maxMessageBytes:128*M,maxTileCells:65536,maxSamplesPerCell:2048,maxGlyphCount:65535,maxProjectionBytes:128*M,maxPixelBytes:64*M,maxRecoveryProjectionBytes:32*M,maxRecoveryCells:1024}};
  assert.equal(checkedAfterInfo(info,info,'float32-direct').available,true);
  assert.throws(()=>checkedAfterInfo({available:false,error:'probe failed'},info,'float32-direct'),/unavailable/);
  assert.throws(()=>checkedAfterInfo({...info,device:{...info.device,index:1}},info,'float32-direct'),/device changed/);
  assert.throws(()=>checkedAfterInfo(info,info,'binary64-direct'),/explicitly requested/);
});
