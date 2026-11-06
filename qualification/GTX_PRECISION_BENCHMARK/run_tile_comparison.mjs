import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {driverEventsSince} from '../../scripts/cuda_driver_events.mjs';
const base=resolve('build/qualification/precision-matrix');
const original=JSON.parse(await readFile(resolve(base,'matrix.json'),'utf8'));
if(!original.benchmarkCompleted)throw new Error('Original matrix must complete before tile comparison');
const out={schema:'pnggpu-precision-tile-comparison-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),preparationSourceCommit:original.sourceCommit,
  started:new Date().toISOString(),plannedFits:15,cases:[]};
try {
  for(const prior of original.cases.filter(c=>c.settings.columns===80&&c.settings.sw===4)) {
    const events=driverEventsSince(original.started);if(events.events.length)throw new Error('Driver event; tile comparison stopped');
    const report=resolve(base,`${prior.key}.${prior.mode}.tile256.json`);
    execFileSync(process.execPath,['scripts/replay_cuda_fixtures.mjs','build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe',report,
      '--fixture-file',prior.input,'--case',`image-${prior.image.slice(0,-4)}-80x40-4x8`,'--repeats','1','--tiles','256',
      '--max-runs','1','--max-cells','3200','--max-work','1000000000','--timeout-ms','10000','--cuda-mode',prior.mode,'--allow-parity-differences'],
      {encoding:'utf8',windowsHide:true});
    const bytes=await readFile(report),r=JSON.parse(bytes);if(!r.benchmarkCompleted||r.error||r.cleanupErrors.length)throw new Error('Incomplete tile comparison');
    out.cases.push({...prior,key:prior.key+'-tile256',report,reportSha256:createHash('sha256').update(bytes).digest('hex'),tileCells:256});
    out.driverAfter=driverEventsSince(original.started);if(out.driverAfter.events.length)throw new Error('Driver event; tile comparison stopped');
    await writeFile(resolve(base,'tiles.json'),JSON.stringify(out,null,2)+'\n');
  }
  out.benchmarkCompleted=out.cases.length===15;
}catch(error){out.error=error.stack;out.benchmarkCompleted=false;process.exitCode=1;}
finally{out.finished=new Date().toISOString();await writeFile(resolve(base,'tiles.json'),JSON.stringify(out,null,2)+'\n');}
