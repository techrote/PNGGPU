/** Physical faults and sustained bounded execution. Never changes Windows TDR. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {PhotographicCudaFitter} from '../overlay/src/gpu/cuda.js';
import {referencePhotoFit} from '../overlay/src/gpu/reference_photo.js';
import {compareCells,compareAnsi} from '../overlay/src/gpu/metrics.js';
import '../PNG2ANSI/src/core.js';
const [normal,fault,output,duration='180000']=process.argv.slice(2);
if(!process.argv.includes('--acknowledge-desktop-disruption'))throw new Error('Disabled by default: fault/pressure tests caused desktop stalls on the display GPU. Use an isolated test machine and explicitly pass --acknowledge-desktop-disruption.');
if(!output||!Number.isSafeInteger(+duration)||+duration<1000)throw new Error('Usage: node scripts/qualify_cuda_resilience.mjs NORMAL_WORKER FAULT_WORKER OUTPUT_JSON [DURATION_MS>=1000]');
await mkdir(dirname(resolve(output)),{recursive:true});
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const report={schema:'pnggpu-cuda-resilience-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),started:new Date().toISOString(),
  workerSha256:await hash(normal),faultWorkerSha256:await hash(fault),faults:[],runs:[],children:[]};
let nextFault=null;const live=new Set();
const server=createWorkbenchServer({appDirectory:'PNG2ANSI',cudaExecutable:resolve(normal),cudaDevice:0,
  cudaOptions:{operationTimeoutMs:120000,spawnProcess:(_exe,args,options)=>{
    const injected=args.includes('--stdio')?nextFault:null;if(injected)nextFault=null;
    const child=spawn(resolve(injected?fault:normal),[...args,...(injected?['--test-fault',injected]:[])],options);
    const record={pid:child.pid,fault:injected,stderr:''};report.children.push(record);live.add(child);
    child.stderr?.on('data',chunk=>{if(record.stderr.length<4096)record.stderr+=chunk.toString().slice(0,4096-record.stderr.length);});
    child.once('close',(code,signal)=>{record.exitCode=code;record.signal=signal;live.delete(child);});return child;
  }}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const fetchImpl=(url,options)=>fetch(new URL(url,origin),{...options,headers:{...options.headers,Origin:origin}});
const info=()=>JSON.parse(execFileSync(resolve(normal),['--info','--device','0'],{encoding:'utf8'}));
let fitter;
try {
  report.before=info();fitter=await PhotographicCudaFitter.create({fetchImpl});
  const saved=JSON.parse(await readFile('overlay/fixtures/cuda/shortlist-cutoff.json','utf8'));
  const masks=saved.atlas.masks.map(m=>Float32Array.from(m)),palette=saved.atlas.palette,n=32,unique=17,columns=512,rows=512;
  let seed=0x18371acd;const pattern=Uint8Array.from({length:unique*n*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
  const reference=referencePhotoFit({pixels:pattern,masks,palette,
    config:{canvas:{columns:unique,rows:1,sample_width:4,sample_height:8},fit:{foreground_candidates:12,background_candidates:8}}});
  const pixels=new Uint8Array(columns*rows*n*4),expected={chosen:new Uint16Array(columns*rows),fg:new Uint8Array(columns*rows),bg:new Uint8Array(columns*rows)};
  for(let cell=0;cell<columns*rows;cell++) {
    const index=cell%unique;for(const key of ['chosen','fg','bg'])expected[key][cell]=reference[key][index];
    for(let y=0;y<8;y++)for(let x=0;x<4;x++) {
      const dest=((Math.floor(cell/columns)*8+y)*columns*4+(cell%columns)*4+x)*4;
      pixels.set(pattern.subarray(((y*unique*4+index*4+x)*4),((y*unique*4+index*4+x)*4)+4),dest);
    }
  }
  const config={canvas:{columns,rows}},expectedAnsi=PNG2ANSI.ansiBytes({codes:saved.atlas.codes},expected,config);
  const data={pixels,masks,palette,columns,rows,sampleWidth:4,sampleHeight:8,foregroundCandidates:12,backgroundCandidates:8,preferredTileCells:16384};
  const validate=result=>{
    const cells=compareCells(expected,result),ansi=compareAnsi(expectedAnsi,PNG2ANSI.ansiBytes({codes:saved.atlas.codes},result,config));
    if(cells.changedCells||ansi.mismatches)throw new Error('Resilience conversion lost CPU tuple/ANSI parity');
    return {cells,ansi};
  };
  for(const mode of ['context','oom','pressure']) {
    nextFault=mode;const freeBefore=info().device.freeMemoryBytes;let error=null;
    try{await fitter.fit(data);}catch(e){error=e.message;}
    const required={context:/Injected CUDA context fault.*(illegal|assert|launch)/i,oom:/Injected impossible allocation.*(memory|allocation)/i,pressure:/free memory minus 2 GiB/i};
    if(!error||!required[mode].test(error))throw new Error(`Fault ${mode} was not detected as expected: ${error}`);
    const recovered=await fitter.fit(data),parity=validate(recovered);
    report.faults.push({mode,error,freeBefore,freeAfter:info().device.freeMemoryBytes,recovered:true,parity});
    await writeFile(output,JSON.stringify(report,null,2)+'\n');
  }
  const start=performance.now();report.stressStarted=new Date().toISOString();
  do {
    const at=performance.now(),result=await fitter.fit(data);const parity=validate(result);
    report.runs.push({wallMs:performance.now()-at,parity,timing:result.stats.timing,allocatedBytes:result.stats.allocatedBytes,
      recoveredCells:result.stats.recoveredCells,projectionSublaunches:result.stats.projectionSublaunches,selectionSublaunches:result.stats.selectionSublaunches});
    console.log(JSON.stringify({run:report.runs.length,elapsedMs:performance.now()-start,maxSelectionLaunchMs:result.stats.timing.maxSelectionLaunchMs}));
    await writeFile(output,JSON.stringify(report,null,2)+'\n');
  }while(performance.now()-start<+duration);
  report.stressElapsedMs=performance.now()-start;report.after=info();report.accepted=true;
}catch(e){report.accepted=false;report.error=e.stack;process.exitCode=1;}
finally {
  fitter?.close();await server.closeCuda();server.closeAllConnections();await new Promise(r=>server.close(r));
  report.liveChildrenAfterCleanup=live.size;report.finished=new Date().toISOString();
  await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({accepted:report.accepted,faults:report.faults.length,runs:report.runs.length,error:report.error}));
}
