/** Finite large-output sweep: 5 images × 2 sizes × 5 tile budgets × 3 modes. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';
const [worker,playwright,directory]=process.argv.slice(2);
if(!directory)throw new Error('Usage: node scripts/benchmark_cuda_large.mjs WORKER PLAYWRIGHT RAW_OUTPUT_DIRECTORY');
const root=resolve(import.meta.dirname,'..');process.chdir(root);
const provenance=await verifyWorker(resolve(worker),root);
const images=JSON.parse(await readFile('overlay/fixtures/hardmode/manifest.json','utf8')).images;
if(images.length!==5)throw new Error('Exactly five original images are required');
const output=resolve(directory);await mkdir(output,{recursive:true});
const settings=[{columns:160,rows:80,sw:4,sh:8},{columns:320,rows:160,sw:4,sh:8}],budgets=[1,4,8,16,32];
const modes=['float32-direct','binary64-direct','float16-mixed'];
const report={schema:'pnggpu-large-precision-sweep-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),worker:provenance,started:new Date().toISOString(),
  plannedFits:150,settings,budgets,modes,requestedDepth:1,effectiveDepth:1,cpuComparison:'skipped',qualificationAccepted:false,cases:[]};
const hash=b=>createHash('sha256').update(b).digest('hex');
const checkDriver=()=>{const r=driverEventsSince(report.started);if(r.events.length)throw new Error('Driver event; sweep stopped');return r;};
const run=args=>execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true});
const save=()=>writeFile(resolve(output,'large.json'),JSON.stringify(report,null,2)+'\n');
try {
  report.driverBaseline=checkDriver();
  for(let i=0;i<images.length;i++)for(let j=0;j<settings.length;j++) {
    checkDriver();const image=images[i],s=settings[j],key=`${i}-${s.columns}x${s.rows}-4x8`,input=resolve(output,key+'.input.json');
    run(['scripts/prepare_cuda_image.mjs',playwright,input,image.file,String(s.columns),String(s.rows),'4','8',
      '--max-preparation-cells',String(s.columns*s.rows)]);
    const inputHash=hash(await readFile(input));
    for(let b=0;b<budgets.length;b++)for(let k=0;k<modes.length;k++) {
      checkDriver();const mode=modes[(i+j+b+k)%modes.length],tileMiB=budgets[b],result=resolve(output,`${key}.${mode}.mib${tileMiB}.json`);
      run(['scripts/replay_cuda_fixtures.mjs',worker,result,'--fixture-file',input,'--case',
        `image-${image.file.slice(0,-4)}-${s.columns}x${s.rows}-4x8`,'--repeats','1','--tile-mib',String(tileMiB),
        '--max-runs','1','--max-cells',String(s.columns*s.rows),'--max-work','3000000000','--timeout-ms','10000',
        '--cuda-mode',mode,'--allow-parity-differences','--skip-cpu']);
      const bytes=await readFile(result),r=JSON.parse(bytes);
      if(!r.benchmarkCompleted||r.error||r.cleanupErrors.length||r.cases.length!==1||!r.cases[0].cellDiff.skipped||r.scopedParityPassed)
        throw new Error('Incomplete or mislabeled large case; sweep stopped');
      if(r.imageInput.sha256!==inputHash||r.workerSha256!==provenance.sha256||r.requestedCudaMode!==mode)throw new Error('Large-case provenance changed');
      report.cases.push({key,image:image.file,title:image.title,settings:s,mode,tileMiB,input,report:result,inputSha256:inputHash,reportSha256:hash(bytes)});
      report.driverAfter=checkDriver();await save();
      console.log(JSON.stringify({completed:report.cases.length,planned:150,image:image.file,size:key,mode,tileMiB,
        fitMs:r.cases[0].wallMs,kernelMs:r.cases[0].stats.timing.gpuProjectionMs+r.cases[0].stats.timing.gpuSelectionMs}));
    }
  }
  report.benchmarkCompleted=report.cases.length===150;
}catch(error){report.error=error.stack;report.benchmarkCompleted=false;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await save();}
