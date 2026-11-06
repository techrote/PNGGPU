/** Finite sequential benchmark: five original images, three settings, three modes. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';

const [worker,playwright,directory]=process.argv.slice(2);
if(!directory)throw new Error('Usage: node scripts/benchmark_cuda_precisions.mjs WORKER PLAYWRIGHT RAW_OUTPUT_DIRECTORY');
const root=resolve(import.meta.dirname,'..');process.chdir(root);
const provenance=await verifyWorker(resolve(worker),root);
const images=JSON.parse(await readFile('overlay/fixtures/hardmode/manifest.json','utf8')).images;
if(images.length!==5)throw new Error('This finite benchmark requires exactly the five original images');
const settings=[{columns:32,rows:16,sw:4,sh:8},{columns:80,rows:40,sw:4,sh:8},{columns:80,rows:40,sw:8,sh:16}];
const modes=['float32-direct','binary64-direct','float16-mixed'];
const output=resolve(directory);await mkdir(output,{recursive:true});
const manifest={schema:'pnggpu-precision-matrix-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),worker:provenance,
  started:new Date().toISOString(),plannedFits:45,plannedCells:103680,settings,modes,qualificationAccepted:false,cases:[]};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const checkDriver=()=>{const r=driverEventsSince(manifest.started);if(r.events.length)throw new Error('New driver event; matrix stopped');return r;};
const run=args=>execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true});
const save=()=>writeFile(resolve(output,'matrix.json'),JSON.stringify(manifest,null,2)+'\n');
try {
  manifest.driverBaseline=checkDriver();
  for(let i=0;i<images.length;i++)for(let j=0;j<settings.length;j++) {
    checkDriver();const image=images[i],s=settings[j],key=`${i}-${s.columns}x${s.rows}-${s.sw}x${s.sh}`;
    const input=resolve(output,key+'.input.json');
    run(['scripts/prepare_cuda_image.mjs',playwright,input,image.file,String(s.columns),String(s.rows),String(s.sw),String(s.sh),
      '--max-preparation-cells',String(s.columns*s.rows)]);
    const inputHash=hash(await readFile(input));
    // Rotate mode order to avoid giving one precision every first-run observation.
    const order=modes.map((_,k)=>modes[(i+j+k)%modes.length]);
    for(const mode of order) {
      checkDriver();const report=resolve(output,`${key}.${mode}.json`);
      run(['scripts/replay_cuda_fixtures.mjs',worker,report,'--fixture-file',input,'--case',
        `image-${image.file.slice(0,-4)}-${s.columns}x${s.rows}-${s.sw}x${s.sh}`,'--repeats','1','--tiles','16',
        '--max-runs','1','--max-cells',String(s.columns*s.rows),'--max-work','1000000000','--timeout-ms','10000',
        '--cuda-mode',mode,'--allow-parity-differences']);
      const bytes=await readFile(report),r=JSON.parse(bytes);
      if(!r.benchmarkCompleted||r.error||r.cleanupErrors.length||r.cases.length!==1)throw new Error('Incomplete precision case; matrix stopped');
      if(r.imageInput.sha256!==inputHash||r.workerSha256!==provenance.sha256||r.requestedCudaMode!==mode)throw new Error('Precision case provenance changed');
      manifest.cases.push({key,image:image.file,title:image.title,settings:s,mode,input,report,inputSha256:inputHash,reportSha256:hash(bytes)});
      manifest.driverAfter=checkDriver();await save();
      console.log(JSON.stringify({completed:manifest.cases.length,planned:45,image:image.file,settings:key,mode,
        fitMs:r.cases[0].wallMs,kernelMs:r.cases[0].stats.timing.gpuProjectionMs+r.cases[0].stats.timing.gpuSelectionMs,
        changedCells:r.cases[0].cellDiff.changedCells}));
    }
  }
  manifest.benchmarkCompleted=manifest.cases.length===45;
}catch(error){manifest.error=String(error.stack);manifest.benchmarkCompleted=false;process.exitCode=1;}
finally{manifest.finished=new Date().toISOString();await save();}
