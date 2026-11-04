/** Requested finite comparison: 8 configurations, exactly 30 frames each. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {validateVideoManifest} from './cuda_video_plan.mjs';
const [worker,batch160,batch320,directory]=process.argv.slice(2);
if(!directory||process.argv.length!==6)throw new Error('Usage: node scripts/benchmark_cuda_video_matrix.mjs WORKER BATCH160 BATCH320 OUTPUT_DIRECTORY');
process.chdir(resolve(import.meta.dirname,'..'));const out=resolve(directory);await mkdir(out,{recursive:true});
for(const [width,path] of [[160,batch160],[320,batch320]]){
  const batch=JSON.parse(await readFile(resolve(path,'manifest.json'),'utf8'));validateVideoManifest(batch);
  if(batch.atlas.columns!==width||batch.atlas.rows!==width/2||batch.frames.length<30)throw new Error('Matrix batch geometry/count differs from its label');
}
const report={schema:'pnggpu-cuda-video-matrix-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  started:new Date().toISOString(),plannedSessions:8,plannedFrames:240,qualificationAccepted:false,sessions:[]};
const check=()=>{const r=driverEventsSince(report.started);if(r.events.length)throw new Error('New driver error; matrix stopped');return r;};
try{
  report.driverBaseline=check();
  for(const [width,batch] of [[160,batch160],[320,batch320]])for(const tile of [16,32])for(const mode of tile===16?['float32-direct','binary64-direct']:['binary64-direct','float32-direct']){
    check();const key=`${width}x${width/2}-${mode}-${tile}mib`,output=resolve(out,key+'.json');
    execFileSync(process.execPath,['scripts/benchmark_cuda_video.mjs',worker,batch,mode,String(tile),'30',output],{encoding:'utf8',windowsHide:true});
    const bytes=await readFile(output),r=JSON.parse(bytes);
    if(!r.benchmarkCompleted||r.error||r.cleanupErrors.length||r.frames.length!==30||r.batch.atlas.columns!==width||
      r.batch.atlas.rows!==width/2||r.mode!==mode||r.tileMiB!==tile||r.scope.runs!==30)throw new Error('Incomplete or mislabeled video sequence; matrix stopped');
    report.sessions.push({key,report:output,reportSha256:createHash('sha256').update(bytes).digest('hex')});
    report.driverAfter=check();await writeFile(resolve(out,'matrix.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({completed:report.sessions.length,key,warmFitMs:r.frames.slice(1).map(f=>f.fitMs)}));
  }
  report.benchmarkCompleted=true;
}catch(error){report.error=error.stack;report.benchmarkCompleted=false;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await writeFile(resolve(out,'matrix.json'),JSON.stringify(report,null,2)+'\n');}
