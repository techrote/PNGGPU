/** Finite local motion experiment. No live capture, pressure or stress loop. */
import {readFile,writeFile,open,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {PhotographicCudaFitter} from '../overlay/src/gpu/cuda.js';
import {videoPlan,validateVideoManifest} from './cuda_video_plan.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {checkedAfterInfo} from './cuda_after_info.mjs';
import '../PNG2ANSI/src/core.js';
const [worker,batchDirectory,mode,tile,count,output]=process.argv.slice(2);
if(!output||process.argv.length!==8)throw new Error('Usage: node scripts/benchmark_cuda_video.mjs WORKER BATCH_DIRECTORY MODE TILE_MIB FRAME_COUNT OUTPUT_JSON');
const root=resolve(import.meta.dirname,'..');process.chdir(root);
const batchPath=resolve(batchDirectory,'manifest.json');if((await stat(batchPath)).size>4*1024*1024)throw new Error('Video receipt exceeds 4 MiB');
const hash=b=>createHash('sha256').update(b).digest('hex'),batchBytes=await readFile(batchPath),batch=JSON.parse(batchBytes);
validateVideoManifest(batch);
const scope=videoPlan(batch.atlas,Number(count),mode,Number(tile)),frameBytes=batch.atlas.columns*batch.atlas.rows*32*4;
if(batch.schema!=='pnggpu-video-frames-v1'||!batch.completed||batch.error||batch.cleanupErrors.length||batch.frames.length<Number(count)||
  batch.frames.length>120||batch.rgbaBytes!==batch.frames.length*frameBytes||batch.frames.some((f,i)=>f.index!==i||f.rgbaOffset!==i*frameBytes||f.rgbaBytes!==frameBytes||!/^[a-f0-9]{64}$/.test(f.rgbaSha256)))throw new Error('Invalid finite video preparation receipt');
const a=batch.atlas;
if(a.masks.length<1||a.masks.length>256||a.masks.some(m=>m.length!==32||m.some(v=>!Number.isFinite(v)||v<0||v>1||Math.fround(v)!==v))||
  a.codes.length!==a.masks.length||JSON.stringify(a.palette)!==JSON.stringify(PNG2ANSI.PALETTE))throw new Error('Invalid video atlas/palette');
for(const [name,digest] of Object.entries(batch.sourceFiles)){
  const rel=relative(root,resolve(root,name));if(isAbsolute(name)||rel.startsWith('..')||isAbsolute(rel)||hash(await readFile(name))!==digest)throw new Error('Video preparation source differs');
}
const rgbaPath=resolve(batchDirectory,'frames.rgba');if((await stat(rgbaPath)).size!==batch.rgbaBytes)throw new Error('RGBA file length differs');
const before=createHash('sha256');for await(const bytes of createReadStream(rgbaPath))before.update(bytes);
if(before.digest('hex')!==batch.rgbaSha256)throw new Error('RGBA batch hash differs');
const provenance=await verifyWorker(resolve(worker),root);
if(!(await readFile('overlay/src/gpu/cuda.js')).equals(await readFile('PNG2ANSI/src/gpu/cuda.js')))throw new Error('Installed CUDA adapter differs');
const report={schema:'pnggpu-cuda-video-latency-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),worker:provenance,started:new Date().toISOString(),
  batchPath,batchSha256:hash(batchBytes),batch,mode,tileMiB:Number(tile),scope,cpuComparison:{skipped:true},qualificationAccepted:false,
  frameDepth:1,frames:[],processes:[],benchmarkCompleted:false};
const check=()=>{const r=driverEventsSince(batch.started);if(r.events.length)throw new Error('New GPU driver error; video stopped');return r;};
const spawnProcess=(executable,args,options)=>{const child=spawn(executable,args,options),p={pid:child.pid,args,started:new Date().toISOString(),exited:null};report.processes.push(p);child.once('close',(code,signal)=>Object.assign(p,{exited:new Date().toISOString(),code,signal}));return child;};
const server=createWorkbenchServer({appDirectory:'PNG2ANSI',cudaExecutable:resolve(worker),cudaDevice:0,cudaOptions:{spawnProcess,arithmeticMode:mode,operationTimeoutMs:10000,infoTimeoutMs:10000}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const fetchImpl=(url,o)=>fetch(new URL(url,origin),{...o,headers:{...o?.headers,Origin:origin}});
let fitter,frames,input,tuplesFile;const outputHash=createHash('sha256');let offset=0;
await mkdir(dirname(resolve(output)),{recursive:true});const binary=resolve(output+'.bin');
try{
  report.driverBaseline=check();
  fitter=await PhotographicCudaFitter.create({fetchImpl,expectedPrecision:mode,infoTimeoutMs:10000,requestTimeoutMs:10000});report.deviceBefore=fitter.info;
  frames=fitter.createFrameSession({...a,masks:a.masks.map(m=>Float32Array.from(m)),preferredTileMiB:Number(tile),inFlightTiles:1});
  input=await open(rgbaPath,'r');tuplesFile=await open(binary,'w');
  const pixels=new Uint8Array(frameBytes);
  for(let index=0;index<Number(count);index++){
    const guard=performance.now();check();const driverGuardMs=performance.now()-guard,frameStart=performance.now();
    const read=await input.read(pixels,0,frameBytes,index*frameBytes);
    if(read.bytesRead!==frameBytes||hash(pixels)!==batch.frames[index].rgbaSha256)throw new Error('Frame bytes changed');
    const inputReadAndHashMs=performance.now()-frameStart,start=performance.now();
    const actual=await withTimeout(frames.fitFrame(pixels),10000,()=>fitter.close());const fitMs=performance.now()-start;
    const ansiStart=performance.now(),ansi=PNG2ANSI.ansiBytes({codes:a.codes},actual,batch.config),ansiMs=performance.now()-ansiStart;
    const preparedFrameToAnsiMs=performance.now()-frameStart,b=Buffer.alloc(actual.chosen.length*4);
    actual.chosen.forEach((g,i)=>{b.writeUInt16LE(g,i*4);b[i*4+2]=actual.fg[i];b[i*4+3]=actual.bg[i];});
    await tuplesFile.writeFile(b);outputHash.update(b);
    const workers=report.processes.filter(p=>p.args.includes('--stdio'));
    if(workers.length!==1||actual.stats.sessionReused!==(index>0)||actual.stats.frameIndex!==index)throw new Error('Worker/frame reuse differs');
    report.frames.push({index,fitMs,inputReadAndHashMs,ansiMs,preparedFrameToAnsiMs,driverGuardMs,offset,cells:actual.chosen.length,
      tupleSha256:hash(b),ansiSha256:hash(ansi),ansiBytes:ansi.length,workerPid:workers[0].pid,stats:actual.stats});offset+=b.length;
    report.driverAfter=check();if((index+1)%30===0)console.log(JSON.stringify({frames:index+1,mode,tileMiB:Number(tile),lastFitMs:fitMs}));
  }
  report.sequenceCleanup=await withTimeout(frames.close(),10000,()=>server.closeCuda());report.benchmarkCompleted=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  report.cleanupErrors=await cleanupSteps([['frames',()=>frames?.close()],['fitter',()=>fitter?.close()],['native',()=>server.closeCuda()],['input',()=>input?.close()],['output',()=>tuplesFile?.close()]],10000);
  if(!report.error&&!report.cleanupErrors.length)report.cleanupErrors.push(...await cleanupSteps([
    ['after-info',async()=>{report.deviceAfter=checkedAfterInfo(await(await fetchImpl('/api/cuda/info')).json(),report.deviceBefore,mode);}],['driver-final',()=>{report.driverFinal=check();}]],10000));
  report.cleanupErrors.push(...await cleanupSteps([['final-native',()=>server.closeCuda()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000));
  if(report.cleanupErrors.length){report.benchmarkCompleted=false;process.exitCode=1;}
  report.outputsPath=binary;report.outputsBytes=offset;report.outputsSha256=outputHash.digest('hex');report.finished=new Date().toISOString();
  await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({benchmarkCompleted:report.benchmarkCompleted,frames:report.frames.length,error:report.error,cleanupErrors:report.cleanupErrors}));
}
