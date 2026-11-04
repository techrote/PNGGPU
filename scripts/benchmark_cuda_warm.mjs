/** Eight finite sessions: 2 geometries x 2 precisions x 2 tile targets. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {driverEventsSince} from './cuda_driver_events.mjs';
const [worker,inputDirectory,outputDirectory]=process.argv.slice(2);
if(!outputDirectory||process.argv.length!==5)throw new Error('Usage: node scripts/benchmark_cuda_warm.mjs WORKER PRIOR_PREPARED_INPUT_DIRECTORY OUTPUT_DIRECTORY');
process.chdir(resolve(import.meta.dirname,'..'));const out=resolve(outputDirectory);await mkdir(out,{recursive:true});
const report={schema:'pnggpu-cuda-warm-matrix-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  started:new Date().toISOString(),plannedSessions:8,plannedFrames:48,plannedCells:1536000,qualificationAccepted:false,sessions:[]};
const check=()=>{const r=driverEventsSince(report.started);if(r.events.length)throw new Error('New GPU driver event; matrix stopped');return r;};
try {
  report.driverBaseline=check();
  for(const [columns,rows] of [[160,80],[320,160]])for(const tileMiB of [16,32])
    for(const mode of tileMiB===16?['float32-direct','binary64-direct']:['binary64-direct','float32-direct']){
      check();const key=`${columns}x${rows}-${mode}-${tileMiB}mib`,planPath=resolve(out,key+'.plan.json'),resultPath=resolve(out,key+'.json');
      const plan={mode,tileMiB,inputs:Array.from({length:5},(_,i)=>resolve(inputDirectory,`${i}-${columns}x${rows}-4x8.input.json`)),
        frameOrder:[0,1,2,3,4,0],requireColdReference:true,
        limits:{maxFrames:6,maxCells:columns*rows*6,maxWork:18000000000,timeoutMs:10000}};
      await writeFile(planPath,JSON.stringify(plan,null,2)+'\n');
      execFileSync(process.execPath,['scripts/benchmark_cuda_frames.mjs',worker,planPath,resultPath],{encoding:'utf8',windowsHide:true});
      const bytes=await readFile(resultPath),r=JSON.parse(bytes);
      if(!r.benchmarkCompleted||r.error||r.cleanupErrors.length||r.frames.length!==6||r.frames.some(f=>f.equivalentToColdBaseline!==true))throw new Error('Incomplete or different frame results; matrix stopped');
      report.sessions.push({key,plan:planPath,report:resultPath,reportSha256:createHash('sha256').update(bytes).digest('hex')});
      report.driverAfter=check();await writeFile(resolve(out,'matrix.json'),JSON.stringify(report,null,2)+'\n');
      console.log(JSON.stringify({completed:report.sessions.length,key,coldWallMs:r.frames[0].wallMs,warmWallMs:r.frames.slice(1).map(f=>f.wallMs)}));
    }
  report.benchmarkCompleted=true;
}catch(error){report.error=error.stack;report.benchmarkCompleted=false;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await writeFile(resolve(out,'matrix.json'),JSON.stringify(report,null,2)+'\n');}
