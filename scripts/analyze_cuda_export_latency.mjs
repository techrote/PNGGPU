/** Offline analysis of already-delivered FP32 receipts. No GPU or browser work. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const [input='build/exports/agenticparkour-fp32-delivery',output='qualification/gtx1650super-sample-latency']=process.argv.slice(2);
const root=resolve(input),out=resolve(output);
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
async function fileHash(p){const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');}
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
function stats(a,{fps=false}={}){
  assert(a.length&&a.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0));
  const s=[...a].sort((a,b)=>a-b),m=mean(a),middle=(s.length-1)/2;
  return {count:a.length,mean:m,median:(s[Math.floor(middle)]+s[Math.ceil(middle)])/2,p95:s[Math.ceil(s.length*.95)-1],min:s[0],max:s.at(-1),
    ...(fps&&m>0?{inferredConversionFPS:1000/m}:{})};
}
const manifestBytes=await readFile(resolve(root,'manifest.json')),manifest=JSON.parse(manifestBytes),settings=await read(resolve(root,'settings.json'));
assert.equal(manifest.completed,true);assert.equal(manifest.arithmetic,'float32-direct');assert.equal(manifest.frameCount,719);assert.equal(manifest.variants.length,24);
assert.equal(new Set(manifest.variants.map(v=>v.key)).size,24);
assert.equal(settings.completed,true);assert.equal(settings.mode,'float32-direct');assert.equal(settings.frameCount,719);
const result={schema:'pnggpu-export-sample-latency-v1',analysisScope:'offline existing export receipts; no new GPU run',
  manifestPath:resolve(root,'manifest.json'),manifestSha256:hash(manifestBytes),sourceCommit:manifest.sourceCommit,
  planSha256:manifest.planSha256,sourceVideoSha256:settings.sourceVideoSha256,frameCount:719,
  timingDefinition:'fitMs spans frames.fitFrame only, including JS tile packing, direct-pipe requests, native work and result decode. Excludes nextFrame source read/decode, worker info probes, between-chunk driver queries, ANSI/file writing and video encoding.',
  warmDefinition:'Exclude each chunks.first frame: 24 INIT/context-first frame fits, leaving 695 warm delivered frames per variant. The extra command-2 comparison after frame 0 has no stored fitMs and is not a latency observation.',
  fpsDefinition:'inferredConversionFPS = 1000 / arithmetic mean fitMs. Conversion-only reciprocal, not measured continuous queue throughput, actual export FPS or end-to-end realtime rate.',
  distributionDefinition:'Median averages the middle values for even N; p95 is nearest rank. No independence/confidence interval claim for temporally adjacent frames.',
  orderCaveat:'All 4x8 variants ran before all 8x16 variants, with a fresh context each chunk. Single sequence per arm; paired source frames do not remove drift, JIT, driver or scheduling confounds.',
  variants:[],pairs:[]};
const framesByKey=new Map(),settingsByKey=new Map(settings.variants.map(v=>[v.key,v]));
for(const entry of manifest.variants){
  const dir=resolve(root,entry.key),bytes=await readFile(resolve(dir,'report.json')),r=JSON.parse(bytes),v=settingsByKey.get(entry.key),render=await read(resolve(dir,'render.json'));
  assert(v);assert.equal(hash(bytes),entry.reportSha256);assert.equal(hash(bytes),render.reportSha256);
  assert.equal(r.completed,true);assert.equal(r.error,undefined);assert.deepEqual(r.cleanupErrors,[]);assert.equal(r.sourceStatus,'');
  assert.equal(r.sourceCommit,result.sourceCommit);assert.equal(r.key,entry.key);assert.deepEqual(r.geometry,entry.geometry);assert.deepEqual(r.geometry,v.geometry);
  assert.equal(r.planSha256,result.planSha256);assert.equal(render.planSha256,result.planSha256);assert.equal(render.key,r.key);assert.equal(render.completed,true);
  assert.equal(render.frames,719);assert.equal(render.fps,30);assert.equal(render.videoSha256,entry.render.videoSha256);
  assert.equal(await fileHash(resolve(dir,render.video)),render.videoSha256);
  assert.equal(render.tuplesSha256,r.tuplesSha256);assert.equal(await fileHash(resolve(dir,'tuples.bin')),r.tuplesSha256);
  assert.equal(r.chunks.length,24);assert.equal(r.frames.length,719);assert.deepEqual(r.driverFinal.events,[]);assert(r.processes.every(p=>p.exited));
  const cold=new Set();let next=0;
  for(const ch of r.chunks){
    assert.equal(ch.first,next);assert(ch.count+(ch.first===0?1:0)<=30);cold.add(ch.first);next+=ch.count;
    assert.deepEqual(ch.driverAfter.events,[]);assert.equal(ch.driverMonitor.error,undefined);assert(ch.driverMonitor.samples.every(s=>s.events.length===0));
  }
  assert.equal(next,719);assert.equal(cold.size,24);
  const rows=r.frames.map((f,index)=>{assert.equal(f.index,index);assert.equal(f.recoveredCells,0);assert(Number.isFinite(f.fitMs)&&f.fitMs>0);return {...f,cold:cold.has(index)};});
  const warm=rows.filter(f=>!f.cold),coldFrames=rows.filter(f=>f.cold);
  assert.equal(warm.length,695);
  const durationMs=Date.parse(r.finished)-Date.parse(r.started);assert(durationMs>0);
  result.variants.push({key:r.key,geometry:r.geometry,layout:r.layout,reportSha256:hash(bytes),tuplesSha256:r.tuplesSha256,videoSha256:render.videoSha256,
    worker:r.worker,allFitMs:stats(rows.map(f=>f.fitMs),{fps:true}),warmFitMs:stats(warm.map(f=>f.fitMs),{fps:true}),coldFitMs:stats(coldFrames.map(f=>f.fitMs),{fps:true}),
    warmNativePackingMs:stats(warm.map(f=>f.nativePackingMs)),warmFramesOver30FPSBudget:warm.filter(f=>f.fitMs>1000/30).length,
    conversionStageWallMs:durationMs,observedConversionStageFPS:719*1000/durationMs,
    conversionStageDefinition:'report.finished - report.started: includes chunk startup/info, source IO, driver monitoring, ANSI/file work and cleanup; excludes subsequent MP4 encoding and earlier source/provenance validation.',
    videoBytes:render.videoBytes,ansiBytes:rows.reduce((s,f)=>s+f.ansiBytes,0),coldFrameIndices:[...cold]});
  framesByKey.set(r.key,rows);
}
assert(result.variants.every(v=>JSON.stringify(v.worker)===JSON.stringify(result.variants[0].worker)),'Different worker between export arms');
for(const a of result.variants.filter(v=>v.geometry.sampleWidth===4)){
  const g=a.geometry,b=result.variants.find(v=>v.geometry.columns===g.columns&&v.geometry.rows===g.rows&&v.geometry.sampleWidth===8);assert(b);
  assert.deepEqual(a.layout,b.layout);assert.equal(hash(JSON.stringify(settingsByKey.get(a.key).highAtlas)),hash(JSON.stringify(settingsByKey.get(b.key).highAtlas)));
  const x=framesByKey.get(a.key),y=framesByKey.get(b.key),warm=x.filter(f=>!f.cold),ratios=warm.map(f=>y[f.index].fitMs/f.fitMs),deltas=warm.map(f=>y[f.index].fitMs-f.fitMs);
  assert(x.every((f,i)=>f.cold===y[i].cold));
  result.pairs.push({columns:g.columns,rows:g.rows,smallKey:a.key,largeKey:b.key,warmMean4x8Ms:a.warmFitMs.mean,warmMean8x16Ms:b.warmFitMs.mean,
    warmFPS4x8:a.warmFitMs.inferredConversionFPS,warmFPS8x16:b.warmFitMs.inferredConversionFPS,
    ratioOfWarmMeans:b.warmFitMs.mean/a.warmFitMs.mean,latencyIncreasePercent:(b.warmFitMs.mean/a.warmFitMs.mean-1)*100,
    inferredFPSChangePercent:(b.warmFitMs.inferredConversionFPS/a.warmFitMs.inferredConversionFPS-1)*100,
    pairedSameFrameLatencyRatio:stats(ratios),pairedSameFrameDeltaMs:{mean:mean(deltas),min:Math.min(...deltas),max:Math.max(...deltas)},
    videoBytes4x8:a.videoBytes,videoBytes8x16:b.videoBytes,ansiBytes4x8:a.ansiBytes,ansiBytes8x16:b.ansiBytes});
}
// Exact tuple differences are useful for navigation, not a perceptual-quality score.
const aKey='80x25-samples4x8-fp32',bKey='80x25-samples8x16-fp32';
const [a,b]=await Promise.all([readFile(resolve(root,aKey,'tuples.bin')),readFile(resolve(root,bKey,'tuples.bin'))]);
const diffs=[];assert.equal(a.length,719*2000*4);assert.equal(b.length,a.length);
for(let index=0;index<719;index++){
  let changedTuples=0,glyphChanges=0,foregroundChanges=0,backgroundChanges=0;
  for(let cell=0;cell<2000;cell++){const p=(index*2000+cell)*4,g=a.readUInt16LE(p)!==b.readUInt16LE(p),f=a[p+2]!==b[p+2],bg=a[p+3]!==b[p+3];
    changedTuples+=g||f||bg?1:0;glyphChanges+=g?1:0;foregroundChanges+=f?1:0;backgroundChanges+=bg?1:0;}
  diffs.push({frame:index+1,cold:framesByKey.get(aKey)[index].cold,fit4x8Ms:framesByKey.get(aKey)[index].fitMs,fit8x16Ms:framesByKey.get(bKey)[index].fitMs,
    changedTuples,glyphChanges,foregroundChanges,backgroundChanges,changedTuplePercent:changedTuples/20});
}
result.focus80x25={cellsPerFrame:2000,tupleChanges:stats(diffs.map(f=>f.changedTuples)),
  totalChangedTuples:diffs.reduce((s,f)=>s+f.changedTuples,0),totalCells:719*2000,
  maximumChangeFrame:diffs.reduce((a,b)=>a.changedTuples>=b.changedTuples?a:b).frame,
  caveat:'Tuple differences identify changed decisions, not visual improvement. Duplicated glyph shapes, blank glyph colors and near-equal renderings can differ in tuples without a comparable perceptual change.'};
await mkdir(out,{recursive:true});
await writeFile(resolve(out,'summary.json'),JSON.stringify(result,null,2)+'\n');
const pairFields=['columns','rows','warmMean4x8Ms','warmFPS4x8','warmMean8x16Ms','warmFPS8x16','ratioOfWarmMeans','latencyIncreasePercent','inferredFPSChangePercent'];
await writeFile(resolve(out,'pairs.csv'),pairFields.join(',')+'\n'+result.pairs.map(p=>pairFields.map(k=>p[k]).join(',')).join('\n')+'\n');
const frameFields=Object.keys(diffs[0]);await writeFile(resolve(out,'frames-80x25.csv'),frameFields.join(',')+'\n'+diffs.map(f=>frameFields.map(k=>f[k]).join(',')).join('\n')+'\n');
for(const p of result.pairs)console.log(`${p.columns}x${p.rows}: ${p.warmMean4x8Ms.toFixed(4)} ms / ${p.warmFPS4x8.toFixed(2)} FPS -> ${p.warmMean8x16Ms.toFixed(4)} ms / ${p.warmFPS8x16.toFixed(2)} FPS (${p.latencyIncreasePercent.toFixed(1)}% latency)`);
console.log(JSON.stringify({focus80x25:result.focus80x25,variants:result.variants.length,warmObservationsPerVariant:695,coldObservationsPerVariant:24}));
