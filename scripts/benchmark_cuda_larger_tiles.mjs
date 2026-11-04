/** Finite adaptive exploration: 64 MiB, then 128 only on an observed improvement. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.cwd(),{driverEventsSince}=await import(pathToFileURL(resolve(root,'scripts/cuda_driver_events.mjs')));
const [worker,batch,matrixPath,directory]=process.argv.slice(2);
if(!directory||process.argv.length!==6)throw new Error('Usage from repo root: WORKER CROPPED320_BATCH MATRIX_JSON OUTPUT_DIRECTORY');
const m=JSON.parse(await readFile(matrixPath,'utf8'));if(!m.benchmarkCompleted||m.layout!=='cropped')throw new Error('Completed cropped baseline required');
const out=resolve(directory);await mkdir(out,{recursive:true});
const baseline={};for(const mode of ['float32-direct','binary64-direct']){
 const e=m.sessions.find(e=>e.key===`320x90-${mode}-32mib`);if(!e)throw new Error('Missing 320x90/32MiB baseline');
 const r=JSON.parse(await readFile(e.report,'utf8'));if(!r.benchmarkCompleted||r.frames.length!==30)throw new Error('Incomplete baseline');baseline[mode]=r;
}
const median=a=>{a=[...a].sort((a,b)=>a-b);return a[Math.floor(a.length/2)];};
function compare(now,prior){
 const ratios=now.frames.slice(1).map((f,i)=>f.fitMs/prior.frames[i+1].fitMs),samples=[];let seed=196503;
 for(let n=0;n<10000;n++){const a=[];for(let i=0;i<ratios.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;a.push(ratios[seed%ratios.length]);}samples.push(median(a));}
 samples.sort((a,b)=>a-b);const result={pairedMedianRatio:median(ratios),bootstrap95:[samples[250],samples[9750]],
  currentMedianMs:median(now.frames.slice(1).map(f=>f.fitMs)),priorMedianMs:median(prior.frames.slice(1).map(f=>f.fitMs))};
 result.exploreNext=result.pairedMedianRatio<=0.95&&result.bootstrap95[1]<1;return result;
}
const report={schema:'pnggpu-cuda-adaptive-tiles-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 started:new Date().toISOString(),criterion:'paired median fit ratio <=0.95 and exploratory bootstrap95 upper <1; adjacent-frame dependence/run-order not controlled',
 plannedMaximumFrames:120,qualificationAccepted:false,sessions:[]};
report.orchestratorSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const lastResults={...baseline};
const check=()=>{const r=driverEventsSince(report.started);if(r.events.length)throw new Error('New driver error; tile exploration stopped');return r;};
try{
 report.driverBaseline=check();let advance=true;
 for(const tileMiB of [64,128]){
  if(!advance)break;advance=false;
  for(const mode of ['float32-direct','binary64-direct']){
   check();const output=resolve(out,`${mode}-${tileMiB}mib.json`);
   execFileSync(process.execPath,['scripts/benchmark_cuda_video.mjs',worker,batch,mode,String(tileMiB),'30',output],{encoding:'utf8',windowsHide:true});
   const bytes=await readFile(output),r=JSON.parse(bytes);
   if(!r.benchmarkCompleted||r.error||r.cleanupErrors.length||r.frames.length!==30||r.mode!==mode||r.tileMiB!==tileMiB||
     r.batch.atlas.columns!==320||r.batch.atlas.rows!==90)throw new Error('Incomplete/mislabeled tile result');
   if(r.frames.some((f,i)=>f.tupleSha256!==baseline[mode].frames[i].tupleSha256))throw new Error('Larger tile changed same-mode outputs');
   const comparison={...compare(r,lastResults[mode]),priorTileMiB:lastResults[mode].tileMiB};lastResults[mode]=r;
   report.sessions.push({mode,tileMiB,output,reportSha256:createHash('sha256').update(bytes).digest('hex'),comparison,
     tileCells:r.frames[0].stats.tileCells,tileCount:r.frames[0].stats.tileCount,allocatedBytes:r.frames[0].stats.allocatedBytes});
   advance ||= comparison.exploreNext;report.driverAfter=check();
   await writeFile(resolve(out,'sweep.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.sessions.at(-1)));
  }
  if(tileMiB===128){report.stopReason='Full 28800-cell frame fits one tile (~95.8MiB projection); larger targets have no effective increase';break;}
  if(!advance)report.stopReason='64MiB did not meet the predeclared exploratory improvement criterion';
 }
 report.benchmarkCompleted=true;
}catch(error){report.error=error.stack;report.benchmarkCompleted=false;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await writeFile(resolve(out,'sweep.json'),JSON.stringify(report,null,2)+'\n');}
