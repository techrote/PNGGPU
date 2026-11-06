/** Ordinary one-factor 80x25 study. Three frames/case, depth1, original reserve. */
import {readFile,writeFile,mkdir,copyFile,stat} from 'node:fs/promises';import {resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {sha256} from './cuda_image_fixture.mjs';import {qualityVariants,QUALITY_FRAMES,validateQualityPreparation} from './cuda_quality_plan.mjs';
import {spawn} from 'node:child_process';import {checkedAfterInfo} from './cuda_after_info.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';import {createCudaDirectTransport} from './cuda_direct.mjs';
import {PhotographicCudaFitter,packTileRgba} from '../overlay/src/gpu/cuda.js';import {packRasterTileRgba} from './cuda_raster_packet.mjs';
import {createDriverMonitor} from './cuda_driver_monitor.mjs';import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';import {driverEventsSince} from './cuda_driver_events.mjs';
import '../PNG2ANSI/src/core.js';
const [worker,preparedDirectory,exportDirectory,output]=process.argv.slice(2);if(!output)throw Error('Usage: WORKER PREPARED ORIGINAL_EXPORT OUTPUT');
process.chdir(resolve(import.meta.dirname,'..'));const preparedPath=resolve(preparedDirectory,'preparation.json');if((await stat(preparedPath)).size>32*1024*1024)throw Error('Quality preparation receipt cap exceeded');const bytes=await readFile(preparedPath),p=JSON.parse(bytes);
if(p.schema!=='pnggpu-quality-preparation-v1'||!Number.isFinite(Date.parse(p.started))||!p.completed||p.error||p.cleanupErrors.length||JSON.stringify(p.selectedFrames)!==JSON.stringify(QUALITY_FRAMES)||p.variants.length!==qualityVariants().length)throw Error('Invalid quality preparation');
validateQualityPreparation(p,PNG2ANSI.PALETTE,PNG2ANSI.DEFAULTS);
const required=['scripts/cuda_quality_plan.mjs','scripts/prepare_cuda_quality.mjs','scripts/run_cuda_quality.mjs','scripts/cuda_image_fixture.mjs','scripts/cuda_video_plan.mjs','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf','overlay/experiments/webgpu/photographic.html'];if(Object.keys(p.sourceFiles??{}).length!==required.length||required.some(k=>!/^[a-f0-9]{64}$/.test(p.sourceFiles[k]??'')))throw Error('Quality source identities missing');
for(const [f,h] of Object.entries(p.sourceFiles))if(sha256(await readFile(f))!==h)throw Error(`Quality source differs: ${f}`);
if(p.sourceFiles['PNG2ANSI/src/core.js']!=='f38f4657798fdf095bee62905b337a3726dd2ea70d3b86e98a1f8fea093484e9')throw Error('Pinned core differs');
for(const [i,f] of p.sourceFrames.entries()){const n=QUALITY_FRAMES[i],name=`frame_${String(n).padStart(4,'0')}.png`;if(f.n!==n||f.name!==name||sha256(await readFile(resolve(p.inputDirectory,name)))!==f.sha256)throw Error('Original selected PNG differs');}if(p.sourceFrames.length!==3)throw Error('Source frame scope differs');
for(const v of p.variants)for(const f of v.frames){const path=resolve(preparedDirectory,v.key,`frame_${String(f.number).padStart(4,'0')}.rgba`),expected=80*25*v.geometry.sampleWidth*v.geometry.sampleHeight*4;if((await stat(path)).size!==expected||sha256(await readFile(path))!==f.pixelSha256)throw Error('Prepared RGBA preflight failed');}
const workerIdentity=await verifyWorker(resolve(worker),process.cwd()),settings={schema:'pnggpu-ansi-quality-pack-v1',frameCount:719,fps:30,selectedFrames:QUALITY_FRAMES,variants:[]};
const report={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),preparationSha256:sha256(bytes),worker:workerIdentity,started:new Date().toISOString(),cases:[],processes:[],sessions:[],completed:false,qualificationAccepted:false};
await mkdir(output,{recursive:true});
const originalBytes=await readFile(resolve(exportDirectory,'settings.json')),original=JSON.parse(originalBytes),originalManifest=JSON.parse(await readFile(resolve(exportDirectory,'manifest.json'),'utf8'));report.baselines=[];
for(const samples of ['4x8','8x16']){
  const key=`80x25-samples${samples}-fp32`,v=original.variants.find(v=>v.key===key);settings.variants.push({...v,label:`Original export · ${samples} · FFmpeg Lanczos`});await mkdir(resolve(output,key,'ansi'),{recursive:true});
  const raw=await readFile(resolve(exportDirectory,key,'report.json')),r=JSON.parse(raw),entry=originalManifest.variants.find(x=>x.key===key);if(!r.completed||r.planSha256!==originalManifest.planSha256||sha256(raw)!==entry.reportSha256)throw Error('Original export receipt differs');
  const baseline={key,reportSha256:sha256(raw),settingsSha256:sha256(originalBytes),frames:[]};report.baselines.push(baseline);
  for(const n of QUALITY_FRAMES){const name=`frame_${String(n).padStart(4,'0')}.ans`,b=await readFile(resolve(exportDirectory,key,'ansi',name));if(sha256(b)!==r.frames[n-1].ansiSha256)throw Error('Original ANSI baseline differs');await writeFile(resolve(output,key,'ansi',name),b);baseline.frames.push({index:n-1,ansiSha256:sha256(b)});}await writeFile(resolve(output,key,'report.json'),JSON.stringify(baseline,null,2)+'\n');
}
let fits=0;
try{
 for(const v of p.variants){
  const dir=resolve(output,v.key);await mkdir(resolve(dir,'ansi'),{recursive:true});let transport,fit,session,monitor;
  const evidence={key:v.key};report.sessions.push(evidence);
  try{
   if(v.style==='photographic'){
    monitor=createDriverMonitor(p.started);await monitor.ready;
    const spawnProcess=(exe,args,opts)=>{const child=spawn(exe,args,opts),entry={pid:child.pid,args,started:new Date().toISOString()};report.processes.push(entry);child.once('close',(code,signal)=>Object.assign(entry,{exited:new Date().toISOString(),code,signal}));return child;};
    transport=createCudaDirectTransport({executable:resolve(worker),device:0,arithmeticMode:'float32-direct',operationTimeoutMs:10000,spawnProcess});
    fit=await PhotographicCudaFitter.create({transport,expectedPrecision:'float32-direct',requestTimeoutMs:10000});
    if(fit.info.limits.memoryReserveBytes!==2147483648||fit.info.device.name!=='NVIDIA GeForce GTX 1650 SUPER')throw Error('Device/reserve differs');
    evidence.before=fit.info;
    session=fit.createFrameSession({...v.geometry,masks:v.masks,palette:v.palette,foregroundCandidates:v.config.fit.foreground_candidates,backgroundCandidates:v.config.fit.background_candidates,preferredTileMiB:16,inFlightTiles:1});
   }
   await withTimeout((async()=>{
    for(const f of v.frames){
     const pixels=await readFile(resolve(preparedDirectory,v.key,`frame_${String(f.number).padStart(4,'0')}.rgba`));if(sha256(pixels)!==f.pixelSha256)throw Error('Prepared bytes differ');
     let ansi,actual,fitMs=f.cpuFitMs;
     if(session){
      monitor.assertHealthy();if(++fits>88)throw Error('GPU fit work bound exceeded');const at=performance.now();
      actual=await Promise.race([withTimeout(session.fitFrame(pixels,{tilePacketProvider:({data,tileStart,tileCount})=>packRasterTileRgba(data,tileStart,tileCount)}),10000,()=>fit.close()),monitor.failure]);fitMs=performance.now()-at;
      if(f.number===1){if(++fits>88)throw Error('GPU fit work bound exceeded');const other=await Promise.race([withTimeout(session.fitFrame(pixels,{tilePacketProvider:({data,tileStart,tileCount})=>packTileRgba(data,tileStart,tileCount)}),10000,()=>fit.close()),monitor.failure]);for(const k of ['chosen','fg','bg'])if(!Buffer.from(other[k].buffer).equals(Buffer.from(actual[k].buffer)))throw Error('Packet parity differs');}
      monitor.assertHealthy();ansi=PNG2ANSI.ansiBytes({codes:v.codes},actual,v.config);
     }else{actual={chosen:f.chosen,fg:f.fg,bg:f.bg};ansi=Buffer.from(f.ansi,'base64');if(!Buffer.from(PNG2ANSI.ansiBytes({codes:v.codes},actual,v.config)).equals(ansi))throw Error('CPU ANSI differs');}
     await writeFile(resolve(dir,'ansi',`frame_${String(f.number).padStart(4,'0')}.ans`),ansi);
     report.cases.push({key:v.key,number:f.number,style:v.style,backend:session?'cuda-float32-direct':'original-industrial-cpu',fitMs,prepMs:f.prepMs,inputSha256:f.pixelSha256,ansiSha256:sha256(ansi),allocatedBytes:actual.stats?.allocatedBytes??null,chosen:Array.from(actual.chosen),fg:Array.from(actual.fg),bg:Array.from(actual.bg)});
    }
   })(),30000,()=>fit?.close());
   settings.variants.push({...v,frames:undefined,label:`${v.style==='industrial'?'CPU industrial (neutral image/NL)':'CUDA FP32'} · ${v.label}`});
   await writeFile(resolve(dir,'report.json'),JSON.stringify({key:v.key,frames:report.cases.filter(c=>c.key===v.key).map(c=>({index:c.number-1,ansiSha256:c.ansiSha256}))},null,2)+'\n');
    if(transport){await session.close();await fit.close();monitor.assertHealthy();evidence.after=checkedAfterInfo(await transport.request('/api/cuda/info'),evidence.before,'float32-direct');}
  }finally{const errors=await cleanupSteps([['session',()=>session?.close()],['fitter',()=>fit?.close()],['transport',()=>transport?.close()],['monitor',()=>monitor?.stop()]],10000);evidence.monitor=monitor?.snapshot();if(evidence.monitor?.error)errors.push({step:'driver-monitor',error:evidence.monitor.error});if(errors.length)throw Error(`Quality cleanup failed: ${JSON.stringify(errors)}`);}
  evidence.driverAfter=driverEventsSince(p.started);if(evidence.driverAfter.events.length)throw Error('New driver error; stopped');
  console.log(JSON.stringify({finished:settings.variants.length,key:v.key}));
 }
 report.gpuFrameFits=fits;report.driverFinal=driverEventsSince(p.started);if(report.driverFinal.events.length||report.processes.some(p=>!p.exited))throw Error('Driver/child cleanup qualification failed');report.completed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(resolve(output,'settings.json'),JSON.stringify(settings,null,2)+'\n');}
