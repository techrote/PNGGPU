/** Finite local motion experiment. No live capture, pressure or stress loop. */
import {readFile,writeFile,open,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {PhotographicCudaFitter,packTileRgba,packInit,cudaRequest} from '../overlay/src/gpu/cuda.js';
import {createCudaDirectTransport} from './cuda_direct.mjs';
import {packRasterTileRgba} from './cuda_raster_packet.mjs';
import {validateVideoManifest,crop16x9} from './cuda_video_plan.mjs';
import {videoTilePlan} from './cuda_video_tile_plan.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {checkedAfterInfo} from './cuda_after_info.mjs';
import {createDriverMonitor} from './cuda_driver_monitor.mjs';
import {queuePlan,runDepthOneQueue} from './cuda_frame_queue.mjs';
import '../PNG2ANSI/src/core.js';
const [worker,batchDirectory,mode,tile,count,output,...flags]=process.argv.slice(2);
const allowed=['--continuous','--direct','--prepacked','--native-pack','--live-pack'];
if(!output||new Set(flags).size!==flags.length||flags.some(f=>!allowed.includes(f)))throw new Error('Usage: WORKER BATCH MODE TILE COUNT OUT [--continuous] [--direct] [--prepacked|--native-pack|--live-pack]');
const continuous=flags.includes('--continuous'),direct=flags.includes('--direct'),prepacked=flags.includes('--prepacked'),nativePack=flags.includes('--native-pack');
const livePack=flags.includes('--live-pack');
if((direct||prepacked||nativePack||livePack)&&!continuous||prepacked&&(nativePack||livePack)||nativePack&&(!direct||livePack))throw new Error('Prototype packing/transport requires continuous mode; native packing is direct-only');
const root=resolve(import.meta.dirname,'..');process.chdir(root);
const batchPath=resolve(batchDirectory,'manifest.json');if((await stat(batchPath)).size>4*1024*1024)throw new Error('Video receipt exceeds 4 MiB');
const hash=b=>createHash('sha256').update(b).digest('hex'),batchBytes=await readFile(batchPath),batch=JSON.parse(batchBytes);
validateVideoManifest(batch);
if(batch.fitMode==='crop-16:9'&&batch.frames.some(f=>JSON.stringify(f.crop)!==JSON.stringify(crop16x9(f.width,f.height))))throw new Error('Declared video crop differs');
const scope=videoTilePlan(batch.atlas,Number(count),mode,Number(tile)),frameBytes=batch.atlas.columns*batch.atlas.rows*32*4;
if(batch.schema!=='pnggpu-video-frames-v1'||!batch.completed||batch.error||batch.cleanupErrors.length||batch.frames.length<Number(count)||
  batch.frames.length>120||batch.rgbaBytes!==batch.frames.length*frameBytes||batch.frames.some((f,i)=>f.index!==i||f.rgbaOffset!==i*frameBytes||f.rgbaBytes!==frameBytes||!/^[a-f0-9]{64}$/.test(f.rgbaSha256)))throw new Error('Invalid finite video preparation receipt');
const a=batch.atlas;
const queueScope=continuous?queuePlan(a,Number(count)):null;
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
report.transport=direct?'direct-pipe':'http';report.packing=prepacked?'prepacked':nativePack?'native-raster':'js-raster';
report.packetAllocation=(direct||prepacked||nativePack||livePack)?'retained-per-frame':'reused-tile-buffer';report.livePackControl=livePack;
report.queueMode=continuous?'continuously-refilled':'diagnostic-gaps';report.queueScope=queueScope;
const check=()=>{const r=driverEventsSince(batch.started);if(r.events.length)throw new Error('New GPU driver error; video stopped');return r;};
const spawnProcess=(executable,args,options)=>{const child=spawn(executable,args,options),p={pid:child.pid,args,started:new Date().toISOString(),exited:null};report.processes.push(p);child.once('close',(code,signal)=>Object.assign(p,{exited:new Date().toISOString(),code,signal}));return child;};
const directTransport=direct?createCudaDirectTransport({executable:resolve(worker),device:0,arithmeticMode:mode,spawnProcess,operationTimeoutMs:10000,infoTimeoutMs:10000}):null;
const server=direct?null:createWorkbenchServer({appDirectory:'PNG2ANSI',cudaExecutable:resolve(worker),cudaDevice:0,cudaOptions:{spawnProcess,arithmeticMode:mode,operationTimeoutMs:10000,infoTimeoutMs:10000}});
if(server)await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=server?`http://127.0.0.1:${server.address().port}`:null;
const fetchImpl=directTransport??((url,o)=>fetch(new URL(url,origin),{...o,headers:{...o?.headers,Origin:origin}}));
let fitter,frames,input,tuplesFile,monitor;const outputHash=createHash('sha256');let offset=0;
await mkdir(dirname(resolve(output)),{recursive:true});const binary=resolve(output+'.bin');
try{
  report.driverBaseline=check();
  if(continuous){monitor=createDriverMonitor(batch.started);await monitor.ready;}
  fitter=await PhotographicCudaFitter.create({fetchImpl,expectedPrecision:mode,infoTimeoutMs:10000,requestTimeoutMs:10000});report.deviceBefore=fitter.info;
  if(nativePack&&fitter.info.nativeRasterPacking!=='rgba-row-bands-v1')throw new Error('Matching native raster packing support is required');
  frames=fitter.createFrameSession({...a,masks:a.masks.map(m=>Float32Array.from(m)),preferredTileMiB:Number(tile),inFlightTiles:1});
  input=await open(rgbaPath,'r');tuplesFile=await open(binary,'w');
  if(continuous){
    const preloadStart=performance.now(),pixels=Buffer.alloc(queueScope.inputBytes);
    const read=await input.read(pixels,0,pixels.length,0);if(read.bytesRead!==pixels.length)throw new Error('Incomplete queue preload');
    const prepared=Array.from({length:Number(count)},(_,i)=>pixels.subarray(i*frameBytes,(i+1)*frameBytes));
    prepared.forEach((p,i)=>{if(hash(p)!==batch.frames[i].rgbaSha256)throw new Error('Preloaded frame bytes changed');});
    report.preloadMs=performance.now()-preloadStart;
    const plan=framesPlan(),packetSets=Array.from({length:Number(count)},()=>[]);
    report.initPacketSha256=hash(packInit(a,plan,a.masks.length,32));
    function framesPlan(){return fitter.tilePlan({...a,glyphCount:a.masks.length,preferredTileMiB:Number(tile),inFlightTiles:1});}
    report.preparedHostBytes=queueScope.inputBytes*2+Number(count)*plan.tileCount*20+8+plan.tileCells*32*4;
    if(report.preparedHostBytes>256*1024*1024)throw new Error('Prototype retained input/packet host budget exceeds256MiB');
    const packetIndex=start=>Math.floor(start/plan.tileCells),prepareStart=performance.now();
    if(prepacked)for(let i=0;i<prepared.length;i++)for(let start=0;start<a.columns*a.rows;start+=plan.tileCells){
      const n=Math.min(plan.tileCells,a.columns*a.rows-start);packetSets[i].push(packTileRgba({...a,pixels:prepared[i]},start,n));
    }
    report.packetPreparationMs=performance.now()-prepareStart;
    const provider=index=>(direct||prepacked||nativePack||livePack)?(({data,tileStart,tileCount})=>{
      if(prepacked)return packetSets[index][packetIndex(tileStart)];
      const packet=nativePack?packRasterTileRgba(data,tileStart,tileCount):packTileRgba(data,tileStart,tileCount);packetSets[index].push(packet);return packet;
    }):undefined;

    const queued=await runDepthOneQueue({inputs:prepared,fitFrame:(p,index)=>frames.fitFrame(p,{tilePacketProvider:provider(index)}),check:()=>monitor.assertHealthy(),
      failure:monitor.failure,cancel:()=>fitter.close(),frameTimeoutMs:queueScope.frameTimeoutMs,burstTimeoutMs:queueScope.burstTimeoutMs});
    report.queueTiming={peakOutstandingFrames:queued.peakOutstandingFrames,warmSequenceMs:queued.warmSequenceMs,
      warmFrames:Number(count)-1,warmFramesPerSecond:(Number(count)-1)*1000/queued.warmSequenceMs,refillGapsMs:queued.refillGapsMs,
      note:'Prepared inputs preloaded/hashed; tuple/ANSI serialization is after burst. No live decode, display, paced arrivals or dropped-frame policy.'};
    report.inputPackets=packetSets.map(packets=>packets.map(p=>({bytes:p.byteLength,sha256:hash(p)})));
    report.inputPacketDigest=hash(Buffer.from(JSON.stringify(report.inputPackets)));
    const drainStart=performance.now();
    for(const record of queued.records){
      const {index,actual,submittedAt,completedAt}=record,ansiStart=performance.now(),ansi=PNG2ANSI.ansiBytes({codes:a.codes},actual,batch.config),ansiMs=performance.now()-ansiStart;
      const b=Buffer.alloc(actual.chosen.length*4);actual.chosen.forEach((g,i)=>{b.writeUInt16LE(g,i*4);b[i*4+2]=actual.fg[i];b[i*4+3]=actual.bg[i];});
      await tuplesFile.writeFile(b);outputHash.update(b);
      const workers=report.processes.filter(p=>p.args.includes('--stdio'));
      if(workers.length!==1||actual.stats.sessionReused!==(index>0)||actual.stats.frameIndex!==index)throw new Error('Queue worker/frame reuse differs');
      report.frames.push({index,fitMs:completedAt-submittedAt,submittedAt,completedAt,ansiMs,inputReadAndHashMs:null,preparedFrameToAnsiMs:null,
        driverGuardMs:0,offset,cells:actual.chosen.length,tupleSha256:hash(b),ansiSha256:hash(ansi),ansiBytes:ansi.length,workerPid:workers[0].pid,stats:actual.stats});offset+=b.length;
    }
    report.postBurstOutputMs=performance.now()-drainStart;monitor.assertHealthy();
  }else{
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
  }
  report.sequenceCleanup=await withTimeout(frames.close(),10000,()=>directTransport?fitter?.close():server.closeCuda());report.benchmarkCompleted=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  report.cleanupErrors=await cleanupSteps([['frames',()=>frames?.close()],['fitter',()=>fitter?.close()],['native',()=>server?.closeCuda()],['input',()=>input?.close()],['output',()=>tuplesFile?.close()],
    ['monitor',async()=>{if(monitor){await monitor.stop();report.driverMonitor=monitor.snapshot();if(report.driverMonitor.error)throw new Error(report.driverMonitor.error);}}]],10000);
  if(!report.error&&!report.cleanupErrors.length)report.cleanupErrors.push(...await cleanupSteps([
    ['after-info',async()=>{report.deviceAfter=checkedAfterInfo(await cudaRequest(fetchImpl,'/api/cuda/info',{timeoutMs:10000}),report.deviceBefore,mode);}],['driver-final',()=>{report.driverFinal=check();}]],10000));
  report.cleanupErrors.push(...await cleanupSteps([['final-native',()=>directTransport?directTransport.close():server.closeCuda()],['server',()=>{if(!server)return;server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000));
  if(report.cleanupErrors.length){report.benchmarkCompleted=false;process.exitCode=1;}
  report.outputsPath=binary;report.outputsBytes=offset;report.outputsSha256=outputHash.digest('hex');report.finished=new Date().toISOString();
  await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({benchmarkCompleted:report.benchmarkCompleted,frames:report.frames.length,error:report.error,cleanupErrors:report.cleanupErrors}));
}
