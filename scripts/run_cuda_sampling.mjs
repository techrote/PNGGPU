/** 15 additions: nine sample grids, two literal controls and four portrait refits. */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';import {resolve} from 'node:path';import {execFileSync,spawn} from 'node:child_process';
import {samplingAdditions,SAMPLING_FRAMES,rotateClockwise,validateSamplingPreparation} from './cuda_sampling_plan.mjs';import {sha256} from './cuda_image_fixture.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';import {createCudaDirectTransport} from './cuda_direct.mjs';import {PhotographicCudaFitter,packTileRgba} from '../overlay/src/gpu/cuda.js';import {packRasterTileRgba} from './cuda_raster_packet.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';import {createDriverMonitor} from './cuda_driver_monitor.mjs';import {driverEventsSince} from './cuda_driver_events.mjs';import {checkedAfterInfo} from './cuda_after_info.mjs';import '../PNG2ANSI/src/core.js';
const [worker,prepared,oldExport,output]=process.argv.slice(2);if(!output)throw Error('Usage: WORKER PREPARED OLD_EXPORT OUTPUT');process.chdir(resolve(import.meta.dirname,'..'));
const receipt=resolve(prepared,'preparation.json');if((await stat(receipt)).size>32*1024*1024)throw Error('Preparation cap');const prepBytes=await readFile(receipt),p=JSON.parse(prepBytes);validateSamplingPreparation(p,PNG2ANSI.PALETTE);
const required=['scripts/cuda_sampling_plan.mjs','scripts/prepare_cuda_sampling.mjs','scripts/run_cuda_sampling.mjs','scripts/cuda_quality_plan.mjs','scripts/cuda_image_fixture.mjs','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf','overlay/experiments/webgpu/photographic.html'];
if(Object.keys(p.sourceFiles??{}).length!==required.length||required.some(k=>!/^[a-f0-9]{64}$/.test(p.sourceFiles[k]??'')))throw Error('Missing source identities');for(const [f,h] of Object.entries(p.sourceFiles))if(sha256(await readFile(f))!==h)throw Error(`Source differs: ${f}`);
if(p.sourceFiles['PNG2ANSI/src/core.js']!=='f38f4657798fdf095bee62905b337a3726dd2ea70d3b86e98a1f8fea093484e9')throw Error('Pinned core differs');
for(const v of p.variants)for(const f of v.frames){const path=resolve(prepared,v.key,`frame_${String(f.number).padStart(4,'0')}.rgba`);if((await stat(path)).size!==2000*v.sw*v.sh*4||sha256(await readFile(path))!==f.pixelSha256)throw Error('Prepared pixels differ');}
const seedBytes=await readFile(resolve(oldExport,'settings.json')),seed=JSON.parse(seedBytes),oldBytes=await readFile(resolve(oldExport,'report.json')),old=JSON.parse(oldBytes);
if(sha256(seedBytes)!==p.seed.settingsSha256||sha256(oldBytes)!==p.seed.reportSha256||p.seed.preparationSha256!==old.preparationSha256||!old.completed||old.error||seed.variants.length!==35)throw Error('Seed differs');
for(const v of p.variants){
 const alpha=Buffer.from(v.highAtlas.alpha,'base64');if(alpha.length!==v.codes.length*128||alpha.toString('base64')!==v.highAtlas.alpha||sha256(alpha)!==v.highAtlasSha256||sha256(JSON.stringify(v.masks))!==v.lowAtlasSha256)throw Error('Atlas integrity differs');
 if(v.kind==='literal'||v.kind==='rotated-refit'){
  const a=seed.variants.find(x=>x.key===v.anchor);if(!a||JSON.stringify(a.codes)!==JSON.stringify(v.codes))throw Error('Rotated code order differs');
  const high=Buffer.concat(a.codes.map((_,i)=>Buffer.from(rotateClockwise(Buffer.from(a.highAtlas.alpha,'base64').subarray(i*128,(i+1)*128),8,16))));
  const low=a.masks.map(m=>Array.from(rotateClockwise(Float32Array.from(m),a.geometry.sampleWidth,a.geometry.sampleHeight)));
  if(!alpha.equals(high)||JSON.stringify(low)!==JSON.stringify(v.masks))throw Error('Rotated atlas is not an exact permutation');
 }
}
const expectedAnsi=(key,n)=>old.cases.find(c=>c.key===key&&c.number===n)?.ansiSha256??old.baselines.find(b=>b.key===key)?.frames.find(f=>f.index===n-1)?.ansiSha256;
for(const v of seed.variants){if(!/^[-A-Za-z0-9_.]+$/.test(v.key)||v.geometry.columns*v.geometry.rows!==2000)throw Error('Seed key/grid differs');for(const n of SAMPLING_FRAMES){const b=await readFile(resolve(oldExport,v.key,'ansi',`frame_${String(n).padStart(4,'0')}.ans`));if(sha256(b)!==expectedAnsi(v.key,n))throw Error('Seed ANSI differs');}}
const identity=await verifyWorker(resolve(worker),process.cwd()),settings={...seed,variants:structuredClone(seed.variants)},report={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),started:new Date().toISOString(),preparationSha256:sha256(prepBytes),seed:p.seed,worker:identity,cases:[],sessions:[],processes:[],completed:false,qualificationAccepted:false};
await mkdir(output,{recursive:true});for(const v of seed.variants){await mkdir(resolve(output,v.key,'ansi'),{recursive:true});for(const n of SAMPLING_FRAMES){const name=`frame_${String(n).padStart(4,'0')}.ans`;await writeFile(resolve(output,v.key,'ansi',name),await readFile(resolve(oldExport,v.key,'ansi',name)));}await writeFile(resolve(output,v.key,'report.json'),await readFile(resolve(oldExport,v.key,'report.json')));}
let fits=0;
try{
 for(const v of p.variants){
  const dir=resolve(output,v.key);await mkdir(resolve(dir,'ansi'),{recursive:true});let transport,fit,session,monitor;const evidence={key:v.key,kind:v.kind};report.sessions.push(evidence);
  try{
   if(v.kind!=='literal'){
    monitor=createDriverMonitor(p.started);await monitor.ready;const spawnProcess=(exe,args,opts)=>{const child=spawn(exe,args,opts),entry={pid:child.pid,args,started:new Date().toISOString()};report.processes.push(entry);child.once('close',(code,signal)=>Object.assign(entry,{exited:new Date().toISOString(),code,signal}));return child;};
    transport=createCudaDirectTransport({executable:resolve(worker),device:0,arithmeticMode:'float32-direct',operationTimeoutMs:10000,spawnProcess});fit=await PhotographicCudaFitter.create({transport,expectedPrecision:'float32-direct',requestTimeoutMs:10000});
    if(fit.info.limits.memoryReserveBytes!==2147483648||fit.info.device.name!=='NVIDIA GeForce GTX 1650 SUPER')throw Error('Device/reserve differs');evidence.before=fit.info;
    session=fit.createFrameSession({...v.geometry,masks:v.masks,palette:v.palette,foregroundCandidates:6,backgroundCandidates:5,preferredTileMiB:16,inFlightTiles:1});
   }
   await withTimeout((async()=>{
    for(const f of v.frames){let actual,fitMs=0;
     if(v.kind==='literal'){
      const base=old.cases.find(c=>c.key===v.anchor&&c.number===f.number);if(!base)throw Error('Literal anchor missing');actual={};for(const k of ['chosen','fg','bg'])actual[k]=rotateClockwise(k==='chosen'?Uint16Array.from(base[k]):Uint8Array.from(base[k]),80,25);
     }else{
      const pixels=await readFile(resolve(prepared,v.key,`frame_${String(f.number).padStart(4,'0')}.rgba`));if(sha256(pixels)!==f.pixelSha256)throw Error('Pixels changed');monitor.assertHealthy();if(++fits>52)throw Error('Fit bound');const at=performance.now();
      actual=await Promise.race([withTimeout(session.fitFrame(pixels,{tilePacketProvider:({data,tileStart,tileCount})=>packRasterTileRgba(data,tileStart,tileCount)}),10000,()=>fit.close()),monitor.failure]);fitMs=performance.now()-at;
      if(f.number===1){if(++fits>52)throw Error('Fit bound');const other=await Promise.race([withTimeout(session.fitFrame(pixels,{tilePacketProvider:({data,tileStart,tileCount})=>packTileRgba(data,tileStart,tileCount)}),10000,()=>fit.close()),monitor.failure]);for(const k of ['chosen','fg','bg'])if(!Buffer.from(actual[k].buffer).equals(Buffer.from(other[k].buffer)))throw Error('Packet equivalence differs');}monitor.assertHealthy();
     }
     const ansi=PNG2ANSI.ansiBytes({codes:v.codes},actual,v.config);await writeFile(resolve(dir,'ansi',`frame_${String(f.number).padStart(4,'0')}.ans`),ansi);
     report.cases.push({key:v.key,number:f.number,kind:v.kind,backend:v.kind==='literal'?'render-only-cell-and-atlas-permutation':'cuda-float32-direct',inputSha256:f.pixelSha256,ansiSha256:sha256(ansi),fitMs,allocatedBytes:actual.stats?.allocatedBytes??null,chosen:Array.from(actual.chosen),fg:Array.from(actual.fg),bg:Array.from(actual.bg)});
    }
   })(),30000,()=>fit?.close());
   if(transport)await withTimeout((async()=>{await session.close();await fit.close();monitor.assertHealthy();evidence.after=checkedAfterInfo(await transport.request('/api/cuda/info'),evidence.before,'float32-direct');})(),10000,()=>transport.close());
   settings.variants.push({...v,frames:undefined});await writeFile(resolve(dir,'report.json'),JSON.stringify({key:v.key,frames:report.cases.filter(c=>c.key===v.key).map(c=>({index:c.number-1,ansiSha256:c.ansiSha256}))},null,2)+'\n');
  }finally{const errors=await cleanupSteps([['session',()=>session?.close()],['fitter',()=>fit?.close()],['transport',()=>transport?.close()],['monitor',()=>monitor?.stop()]],10000);evidence.monitor=monitor?.snapshot();if(evidence.monitor?.error)errors.push({step:'monitor',error:evidence.monitor.error});if(errors.length)throw Error(`Cleanup failed ${JSON.stringify(errors)}`);}
  evidence.driverAfter=driverEventsSince(p.started);if(evidence.driverAfter.events.length)throw Error('Driver error; stopped');console.log(JSON.stringify({done:settings.variants.length,key:v.key}));
 }
 report.gpuFrameFits=fits;report.driverFinal=driverEventsSince(p.started);if(report.driverFinal.events.length||report.processes.some(p=>!p.exited)||fits!==52||settings.variants.length!==50)throw Error('Final scope/driver/cleanup differs');report.completed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await writeFile(resolve(output,'settings.json'),JSON.stringify(settings,null,2)+'\n');await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
