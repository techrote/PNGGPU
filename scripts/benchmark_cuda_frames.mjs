/** Finite queue-depth-one context reuse experiment; no video decode/render timing. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {PhotographicCudaFitter} from '../overlay/src/gpu/cuda.js';
import {verifyWorker} from './cuda_worker_provenance.mjs';
import {loadImageFixture} from './cuda_image_fixture.mjs';
import {planFrames} from './cuda_frame_plan.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {checkedAfterInfo} from './cuda_after_info.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
import '../PNG2ANSI/src/core.js';
const [worker,planPath,output]=process.argv.slice(2);
if(!output||process.argv.length!==5)throw new Error('Usage: node scripts/benchmark_cuda_frames.mjs WORKER PLAN_JSON OUTPUT_JSON');
const root=resolve(import.meta.dirname,'..');process.chdir(root);
const hash=b=>createHash('sha256').update(b).digest('hex'),git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const planBytes=await readFile(planPath),plan=JSON.parse(planBytes);
if(!Array.isArray(plan.inputs)||plan.inputs.length>5)throw new Error('Expected at most five prepared inputs');
const loaded=[];for(const path of plan.inputs)loaded.push(await loadImageFixture(resolve(path),root,PNG2ANSI.PALETTE));
const scope=planFrames(plan,loaded.map(i=>i.data));
const workerInfo=await verifyWorker(resolve(worker),root);
if(!(await readFile('overlay/src/gpu/cuda.js')).equals(await readFile('PNG2ANSI/src/gpu/cuda.js')))
  throw new Error('Installed CUDA adapter differs; run setup.bat');
const referencePath='qualification/GTX_PRECISION_BENCHMARK',ref=JSON.parse(await readFile(referencePath+'/summary.json','utf8'));
const referenceBytes=await readFile(referencePath+'/outputs.bin');if(hash(referenceBytes)!==ref.outputsSha256)throw new Error('Cold output archive hash changed');
const baselines=loaded.map(input=>ref.cases.find(c=>c.rawInputSha256===input.input.sha256&&c.mode===plan.mode));
// New small preparation files may lack a historical baseline; an explicit false
// marks that diagnostic. Large warm benchmarks require independently saved cold output.
if(plan.requireColdReference!==false&&baselines.some(b=>!b))throw new Error('Missing matching cold baseline');
for(const b of baselines.filter(Boolean))if(hash(referenceBytes.subarray(b.offset,b.offset+b.cells*4))!==b.tupleSha256)throw new Error('Cold tuple hash changed');
const report={schema:'pnggpu-cuda-warm-frames-v1',sourceCommit:git('rev-parse','HEAD'),sourceStatus:git('status','--porcelain'),
  sourceFiles:{},worker:workerInfo,plan,planSha256:hash(planBytes),scope,inputs:loaded.map(i=>i.input),started:new Date().toISOString(),
  qualificationAccepted:false,cpuComparison:{skipped:true},frameDepth:1,frames:[],processes:[],benchmarkCompleted:false};
for(const name of ['overlay/src/gpu/cuda.js','scripts/cuda_frame_plan.mjs','scripts/benchmark_cuda_frames.mjs','scripts/cuda_bridge.mjs','PNG2ANSI/src/core.js'])
  report.sourceFiles[name]=hash(await readFile(name));
const checkDriver=()=>{const r=driverEventsSince(report.started);if(r.events.length)throw new Error('New GPU driver error; sequence stopped');return r;};
const spawnProcess=(executable,args,options)=>{
  const child=spawn(executable,args,options),record={pid:child.pid,args,started:new Date().toISOString(),exited:null};
  report.processes.push(record);child.once('close',(code,signal)=>Object.assign(record,{exited:new Date().toISOString(),code,signal}));return child;
};
const server=createWorkbenchServer({appDirectory:'PNG2ANSI',cudaExecutable:resolve(worker),cudaDevice:0,
  cudaOptions:{spawnProcess,arithmeticMode:plan.mode,operationTimeoutMs:scope.limits.timeoutMs,infoTimeoutMs:scope.limits.timeoutMs}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const fetchImpl=(url,o)=>fetch(new URL(url,origin),{...o,headers:{...o?.headers,Origin:origin}});
let fitter,frames;
try {
  report.driverBaseline=checkDriver();
  fitter=await PhotographicCudaFitter.create({fetchImpl,expectedPrecision:plan.mode,infoTimeoutMs:10000,requestTimeoutMs:10000});
  report.deviceBefore=fitter.info;
  frames=fitter.createFrameSession({...loaded[0].data,preferredTileMiB:plan.tileMiB,inFlightTiles:1});
  for(let index=0;index<plan.frameOrder.length;index++){
    const guardStart=performance.now();checkDriver();const guardMs=performance.now()-guardStart;
    const inputIndex=plan.frameOrder[index],data=loaded[inputIndex].data,started=performance.now();
    const actual=await withTimeout(frames.fitFrame(data.pixels),scope.limits.timeoutMs,()=>fitter.close());
    const wallMs=performance.now()-started,tuples=Buffer.alloc(actual.chosen.length*4);
    actual.chosen.forEach((g,i)=>{tuples.writeUInt16LE(g,i*4);tuples[i*4+2]=actual.fg[i];tuples[i*4+3]=actual.bg[i];});
    const tupleSha256=hash(tuples),b=baselines[inputIndex],launches=report.processes.filter(p=>p.args.includes('--stdio'));
    const row={index,inputIndex,phase:index?'warm':'cold',wallMs,driverGuardMs:guardMs,tupleSha256,coldReference:b?.id??null,
      coldTupleSha256:b?.tupleSha256??null,equivalentToColdBaseline:b?tupleSha256===b.tupleSha256:null,workerPid:launches[0]?.pid,
      actualTuples:Array.from(actual.chosen,(g,i)=>[g,actual.fg[i],actual.bg[i]]),stats:actual.stats};
    report.frames.push(row);
    const prior=report.frames.find(r=>r.inputIndex===inputIndex&&r.index<index);
    if(prior&&prior.tupleSha256!==tupleSha256)throw new Error('Repeated input changed in retained context');
    if(launches.length!==1||actual.stats.sessionReused!==(index>0)||actual.stats.frameIndex!==index||row.equivalentToColdBaseline===false)
      throw new Error('Frame reuse/provenance/output differs from expected session or cold baseline');
    report.driverAfter=checkDriver();
    console.log(JSON.stringify({index,phase:row.phase,wallMs,kernelMs:actual.stats.timing.gpuProjectionMs+actual.stats.timing.gpuSelectionMs}));
  }
  report.sequenceCleanup=await withTimeout(frames.close(),10000,()=>server.closeCuda());
  report.benchmarkCompleted=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally {
  report.cleanupErrors=await cleanupSteps([['frames',()=>frames?.close()],['fitter',()=>fitter?.close()],['native',()=>server.closeCuda()]],10000);
  if(!report.error&&!report.cleanupErrors.length)report.cleanupErrors.push(...await cleanupSteps([
    ['after-info',async()=>{report.deviceAfter=checkedAfterInfo(await (await fetchImpl('/api/cuda/info')).json(),report.deviceBefore,plan.mode);}],
    ['driver-final',()=>{report.driverFinal=checkDriver();}]
  ],10000));
  report.cleanupErrors.push(...await cleanupSteps([['final-native',()=>server.closeCuda()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000));
  if(report.cleanupErrors.length){report.benchmarkCompleted=false;process.exitCode=1;}
  report.finished=new Date().toISOString();await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({benchmarkCompleted:report.benchmarkCompleted,frames:report.frames.length,error:report.error,cleanupErrors:report.cleanupErrors}));
}
