/** Executable real-worker regressions against the independent original JS CPU. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {PhotographicCudaFitter} from '../overlay/src/gpu/cuda.js';
import {referencePhotoFit} from '../overlay/src/gpu/reference_photo.js';
import {compareCells,compareAnsi} from '../overlay/src/gpu/metrics.js';
import '../PNG2ANSI/src/core.js';
const [worker,output]=process.argv.slice(2);
if(!worker||!output)throw new Error('Usage: node scripts/replay_cuda_fixtures.mjs WORKER OUTPUT_JSON (run setup.bat first)');
const report={schema:'pnggpu-cuda-recovery-fixtures-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
  workerSha256:createHash('sha256').update(await readFile(worker)).digest('hex'),cases:[]};
const server=createWorkbenchServer({appDirectory:'PNG2ANSI',cudaExecutable:resolve(worker),cudaDevice:0});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const fetchImpl=(url,options)=>fetch(new URL(url,origin),{...options,headers:{...options.headers,Origin:origin}});
let fitter;
try {
  fitter=await PhotographicCudaFitter.create({fetchImpl});report.workerInfo=fitter.info;
  const historical=JSON.parse(await readFile('qualification/turing-37706c3.json','utf8'));
  const fixtures=[];
  for(const job of historical.jobs)for(const fixture of job.fixtures)
    fixtures.push({name:`historical-${job.job.sampleW}x${job.job.sampleH}-cell-${fixture.cell}`,pixels:Uint8Array.from(fixture.pixels),
      masks:job.fixtureAtlas.masks.map(m=>Float32Array.from(m)),palette:job.fixtureAtlas.palette,codes:job.fixtureAtlas.codes,
      sampleWidth:job.job.sampleW,sampleHeight:job.job.sampleH,columns:1,rows:1,foregroundCandidates:6,backgroundCandidates:5});
  let seed=0xdeadbeef;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(const [sw,sh] of [[1,1],[2,2],[4,8],[8,16],[16,32],[32,64]])for(const [nf,nb] of [[1,1],[6,5],[12,8]]) {
    const n=sw*sh,columns=17;
    const pixels=Uint8Array.from({length:columns*n*4},()=>random()>>>24);
    const masks=Array.from({length:40},(_,g)=>Float32Array.from({length:n},(_,i)=>
      g===0?0:g===1?1:g===2?0.5:g===3?Math.fround(0.5000000596046448):g===4?i%2:(random()>>>24)/255));
    fixtures.push({name:`random-${sw}x${sh}-${nf}-${nb}`,pixels,masks,palette:PNG2ANSI.PALETTE,codes:Array.from({length:40},(_,i)=>i+32),
      sampleWidth:sw,sampleHeight:sh,columns,rows:1,foregroundCandidates:nf,backgroundCandidates:nb});
  }
  for(const data of fixtures) {
    const config={canvas:{columns:data.columns,rows:data.rows,sample_width:data.sampleWidth,sample_height:data.sampleHeight},
      fit:{foreground_candidates:data.foregroundCandidates,background_candidates:data.backgroundCandidates}};
    const expected=referencePhotoFit({pixels:data.pixels,masks:data.masks,palette:data.palette,config});
    const cpuAnsi=PNG2ANSI.ansiBytes({codes:data.codes},expected,config);
    for(const tileCells of [1,3,64]) {
      const actual=await fitter.fit({...data,preferredTileCells:tileCells});
      const cellDiff=compareCells(expected,actual),ansiDiff=compareAnsi(cpuAnsi,PNG2ANSI.ansiBytes({codes:data.codes},actual,config));
      report.cases.push({name:data.name,tileCells,cellDiff,ansiDiff,stats:actual.stats});
      if(cellDiff.changedCells||ansiDiff.mismatches)throw new Error(`Precise recovery failed ${data.name}, tile ${tileCells}`);
    }
  }
  report.accepted=true;
}catch(error){report.error=error.stack;report.accepted=false;process.exitCode=1;}
finally {
  fitter?.close();await server.closeCuda();server.closeAllConnections();await new Promise(r=>server.close(r));
  await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({accepted:report.accepted,cases:report.cases.length,error:report.error}));
}
