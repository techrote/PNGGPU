/** Offline FP32 delivery: sequential frames, <=30 per context, no stress loop. */
import {readFile,writeFile,mkdir,open,stat} from 'node:fs/promises';import {resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {PhotographicCudaFitter,packTileRgba} from '../overlay/src/gpu/cuda.js';
import {packRasterTileRgba} from './cuda_raster_packet.mjs';import {createCudaDirectTransport} from './cuda_direct.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';import {createDriverMonitor} from './cuda_driver_monitor.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';import {withTimeout} from './qualification_lifecycle.mjs';
import {exportGeometry,exportCrop,exportFilter} from './cuda_export_plan.mjs';import '../PNG2ANSI/src/core.js';
const [worker,planPath,key,directory]=process.argv.slice(2);if(!directory)throw Error('Usage: WORKER PLAN KEY OUTPUT_DIRECTORY');
const root=resolve(import.meta.dirname,'..');process.chdir(root);const sha=b=>createHash('sha256').update(b).digest('hex');
const planBytes=await readFile(planPath),plan=JSON.parse(planBytes),v=plan.variants.find(v=>v.key===key);if(!v||plan.schema!=='pnggpu-offline-export-v1'||!plan.completed||plan.mode!=='float32-direct'||plan.variants.length>24)throw Error('Invalid export plan');
const g=exportGeometry(v.geometry.columns,v.geometry.rows,v.geometry.sampleWidth,v.geometry.sampleHeight,plan.frameCount);
assert.deepEqual(v.geometry,g);assert.deepEqual(v.layout,exportCrop(plan.sourceWidth,plan.sourceHeight,g.columns,g.rows));assert.equal(v.filter,exportFilter(g,v.layout));assert.equal(plan.fps,30);
assert.equal(plan.sourceFrames.length,g.count);assert.equal(plan.bounds.memoryReserveBytes,2147483648);
for(const [name,digest] of Object.entries(plan.sourceFiles))assert.equal(sha(await readFile(resolve(root,name))),digest,`Changed export source: ${name}`);
for(const [i,f] of plan.sourceFrames.entries()){assert.equal(f.name,`frame_${String(i+1).padStart(4,'0')}.png`);assert.equal(sha(await readFile(resolve(plan.input,f.name))),f.sha256);}
assert.equal(sha(await readFile(plan.source)),plan.sourceVideoSha256);
const provenance=await verifyWorker(resolve(worker),root),out=resolve(directory);await mkdir(resolve(out,'ansi'),{recursive:true});
try{await stat(resolve(out,'report.json'));throw Error('Export receipt already exists; runner must validate/resume it');}catch(e){if(e.code!=='ENOENT')throw e;}
const report={schema:'pnggpu-offline-sequence-v1',key,started:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),worker:provenance,planSha256:sha(planBytes),geometry:g,layout:v.layout,frames:[],chunks:[],processes:[],completed:false};
const baseline=driverEventsSince(report.started);if(baseline.events.length)throw Error('Driver error at export start');report.driverBaseline=baseline;
const decoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-threads','2','-filter_threads','1','-framerate','30','-start_number','1','-i',resolve(plan.input,'frame_%04d.png'),'-frames:v',String(g.count),'-vf',v.filter,'-threads','2','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr='';decoder.stderr.on('data',b=>{stderr=(stderr+b).slice(-16384);});
const decoderDone=new Promise((res,rej)=>{decoder.once('error',rej);decoder.once('close',code=>code===0?res():rej(Error(`Decoder failed ${code}: ${stderr}`)));});decoderDone.catch(()=>{});
const iter=decoder.stdout[Symbol.asyncIterator]();let pending=Buffer.alloc(0);
async function nextFrame(){const b=Buffer.allocUnsafe(g.frameBytes);let at=0;while(at<b.length){if(!pending.length){const n=await iter.next();if(n.done)throw Error('Unexpected source EOF');pending=n.value;}const n=Math.min(pending.length,b.length-at);pending.copy(b,at,0,n);pending=pending.subarray(n);at+=n;}return b;}
const packed=await open(resolve(out,'tuples.bin'),'w'),tupleHash=createHash('sha256');let transport,fit,frames,monitor;
try{
  for(let start=0;start<g.count;){
    const limit=Math.min(g.count,start+(start===0?29:30)); // One extra command-2 comparison in the first context.
    monitor=createDriverMonitor(report.started);await monitor.ready;
    const spawnProcess=(exe,args,opts)=>{const child=spawn(exe,args,opts),p={pid:child.pid,args,started:new Date().toISOString()};report.processes.push(p);child.once('close',(code,signal)=>Object.assign(p,{exited:new Date().toISOString(),code,signal}));return child;};
    transport=createCudaDirectTransport({executable:resolve(worker),device:0,arithmeticMode:'float32-direct',operationTimeoutMs:10000,spawnProcess});
    fit=await PhotographicCudaFitter.create({transport,expectedPrecision:'float32-direct',requestTimeoutMs:10000});
    assert.equal(fit.info.nativeRasterPacking,'rgba-row-bands-v1');assert.equal(fit.info.limits.memoryReserveBytes,2147483648);assert.equal(fit.info.device.name,'NVIDIA GeForce GTX 1650 SUPER');
    const data={...g,masks:v.masks.map(m=>Float32Array.from(m)),palette:v.palette,foregroundCandidates:6,backgroundCandidates:5,preferredTileMiB:g.columns>=320?64:32,inFlightTiles:1};
    frames=fit.createFrameSession(data);const began=performance.now(),first=start;
    const chunk={first,count:limit-start,device:fit.info.device};report.chunks.push(chunk);
    await withTimeout((async()=>{
      for(let index=start;index<limit;index++){
        monitor.assertHealthy();const pixels=await withTimeout(nextFrame(),10000,()=>decoder.kill());
        const go=performance.now();const actual=await Promise.race([withTimeout(frames.fitFrame(pixels,{tilePacketProvider:({data,tileStart,tileCount})=>packRasterTileRgba(data,tileStart,tileCount)}),10000,()=>fit.close()),monitor.failure]);
        const fitMs=performance.now()-go;monitor.assertHealthy();
        // First exported frame in each geometry also checks both packet formats.
        if(index===0){const canonical=await Promise.race([withTimeout(frames.fitFrame(pixels,{tilePacketProvider:({data,tileStart,tileCount})=>{const p=new Uint8Array(8+tileCount*g.sampleWidth*g.sampleHeight*4);packTileRgba(data,tileStart,tileCount,p);return p;}}),10000,()=>fit.close()),monitor.failure]);monitor.assertHealthy();assert.deepEqual(actual.chosen,canonical.chosen);assert.deepEqual(actual.fg,canonical.fg);assert.deepEqual(actual.bg,canonical.bg);report.packetEquivalenceFirstFrame=true;}
        const b=Buffer.alloc(actual.chosen.length*4);for(let i=0;i<actual.chosen.length;i++){b.writeUInt16LE(actual.chosen[i],i*4);b[i*4+2]=actual.fg[i];b[i*4+3]=actual.bg[i];}
        const ansi=PNG2ANSI.ansiBytes({codes:v.codes},actual,v.config),name=`frame_${String(index+1).padStart(4,'0')}.ans`;
        await packed.writeFile(b);tupleHash.update(b);await writeFile(resolve(out,'ansi',name),ansi);
        report.frames.push({index,inputRgbaSha256:sha(pixels),tupleSha256:sha(b),ansiSha256:sha(ansi),ansiBytes:ansi.length,fitMs,
          allocatedBytes:actual.stats.allocatedBytes,recoveredCells:actual.stats.recoveredCells,nativePackingMs:actual.stats.timing.nativePackingMs,
          maxProjectionLaunchMs:actual.stats.timing.maxProjectionLaunchMs,maxSelectionLaunchMs:actual.stats.timing.maxSelectionLaunchMs});
      }
    })(),30000,()=>fit.close());
    await frames.close();await fit.close();await transport.close();frames=fit=transport=null;
    monitor.assertHealthy();await monitor.stop();chunk.driverMonitor=monitor.snapshot();monitor=null;
    chunk.elapsedMs=performance.now()-began;const d=driverEventsSince(report.started);if(d.events.length)throw Error('New driver error; export stopped');chunk.driverAfter=d;
    console.log(JSON.stringify({key,converted:report.frames.length,total:g.count}));
    start=limit;
  }
  assert.equal(pending.length,0);assert.equal((await withTimeout(iter.next(),10000,()=>decoder.kill())).done,true);await withTimeout(decoderDone,10000,()=>decoder.kill());
  report.tuplesSha256=tupleHash.digest('hex');report.tuplesBytes=g.count*g.columns*g.rows*4;
  report.driverFinal=driverEventsSince(report.started);if(report.driverFinal.events.length)throw Error('New driver error');assert(report.processes.every(p=>p.exited));report.completed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{
  const errors=[];for(const f of [()=>frames?.close(),()=>fit?.close(),()=>transport?.close(),()=>monitor?.stop(),()=>packed.close()])try{await withTimeout(Promise.resolve().then(f),10000);}catch(e){errors.push(e.message);}
  if(decoder.exitCode===null){decoder.kill();await withTimeout(decoderDone.catch(()=>{}),10000,()=>decoder.kill('SIGKILL')).catch(e=>errors.push(e.message));}
  report.cleanupErrors=errors;if(errors.length){report.completed=false;process.exitCode=1;}report.finished=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
