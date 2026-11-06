/** Explicitly bounded real-worker regression against the independent JS CPU. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {PhotographicCudaFitter} from '../overlay/src/gpu/cuda.js';
import {referencePhotoFit} from '../overlay/src/gpu/reference_photo.js';
import {compareCells,compareAnsi} from '../overlay/src/gpu/metrics.js';
import {parseFixtureArgs,planFixtures} from './cuda_fixture_plan.mjs';
import {loadCudaFixtures} from './cuda_fixtures.mjs';
import {verifyWorker} from './cuda_worker_provenance.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';
import {checkedAfterInfo} from './cuda_after_info.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
import {loadImageFixture} from './cuda_image_fixture.mjs';

const options=parseFixtureArgs(process.argv.slice(2));
if(options.help) {
  console.log(`Usage: node scripts/replay_cuda_fixtures.mjs WORKER OUTPUT_JSON --case EXACT_NAME [--case EXACT_NAME ...]
  --list                       List exact names without opening a worker
  --repeats N --tiles 1,3       Defaults: one repeat, tile 1
  --tile-mib N                 Explicit projection budget (1–32 MiB), alternative to --tiles
  --max-cells N --max-work N --max-runs N  Aggregate caps (defaults: 1 / 10000000 / 1)
  --timeout-ms N               Per request timeout, default 10000, maximum 30000
  --webgpu PLAYWRIGHT_MODULE   Also compare the same inputs in installed Chrome
  --fixture-file PATH         Use a validated prepare_cuda_image.mjs output; exact --case required
  --cuda-mode MODE            guarded default, binary64-direct, float32-direct, float16-mixed
  --allow-parity-differences  Record quality differences while benchmarking; parity/qualification still separate
  --skip-cpu                  Explicit benchmark-only skip; CPU comparisons are marked skipped
  --suite                     Explicitly select all fixtures; still requires sufficient caps
Preserve SOURCE_COMMIT.txt, worker-sha256.json and runtime licenses from the CI artifact.
No native self-test, cancellation workload, fault injection or hidden replay is run.
Scoped passes are not full qualification. Work units are logical visits, not a time guarantee.`);
  process.exit(0);
}
const root=resolve(import.meta.dirname,'..');
process.chdir(root);
await import('../PNG2ANSI/src/core.js');
const imageInput=options.fixtureFile?await loadImageFixture(resolve(options.fixtureFile),root,PNG2ANSI.PALETTE):null;
const fixtures=imageInput?[imageInput.data]:await loadCudaFixtures(PNG2ANSI.PALETTE);
if(options.list){console.log(fixtures.map(f=>f.name).join('\n'));process.exit(0);}
// All scope/aggregate validation happens before even a capability probe.
const {runs,summary}=planFixtures(fixtures,options);
const provenance=await verifyWorker(resolve(options.worker),root);
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const report={schema:'pnggpu-cuda-bounded-fixtures-v2',sourceCommit:git('rev-parse','HEAD'),sourceStatus:git('status','--porcelain'),
  workerSourceCommit:provenance.sourceCommit,workerSha256:provenance.sha256,workerReceipt:provenance.receipt,
  started:new Date().toISOString(),scope:summary,qualificationAccepted:false,benchmarkCompleted:false,cases:[],sourceFiles:{}};
report.requestedCudaMode=options.cudaMode;
report.parityDifferencesAllowed=options.allowParityDifferences===true;
if(imageInput)report.imageInput=imageInput.input;
report.driverSince=imageInput?.input.provenance.started??report.started;
for(const name of [...git('ls-files','scripts','overlay/src/gpu','qualification/turing-37706c3.json').split('\n'),
  ...git('ls-files','--others','--exclude-standard','scripts').split('\n'),'PNG2ANSI/src/core.js']) {
  if(!name)continue;
  report.sourceFiles[name]=createHash('sha256').update(await readFile(name)).digest('hex');
  if(name.startsWith('overlay/src/gpu/')&&!(await readFile(name)).equals(await readFile('PNG2ANSI/'+name.slice(8))))
    throw new Error(`Installed overlay differs: ${name}; run setup.bat`);
}
const server=createWorkbenchServer({appDirectory:'PNG2ANSI',cudaExecutable:resolve(options.worker),cudaDevice:0,
  cudaOptions:{operationTimeoutMs:options.timeoutMs,infoTimeoutMs:options.timeoutMs,arithmeticMode:options.cudaMode}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const fetchImpl=(url,opts)=>fetch(new URL(url,origin),{...opts,headers:{...opts?.headers,Origin:origin}});
let fitter,browser,page;
async function browserWork(operation) {
  return withTimeout(operation,options.timeoutMs,()=>browser?.close());
}
const started=performance.now();
try {
  report.driverBaseline=driverEventsSince(report.driverSince);
  if(report.driverBaseline.events.length)throw new Error('New GPU driver error; scope stopped before CUDA');
  fitter=await PhotographicCudaFitter.create({fetchImpl,infoTimeoutMs:options.timeoutMs,requestTimeoutMs:options.timeoutMs,expectedPrecision:options.cudaMode});
  report.workerInfo=fitter.info;
  if(options.webgpu) {
    const {chromium}=await import(pathToFileURL(resolve(options.webgpu)).href);
    browser=await chromium.launch({channel:'chrome',headless:true,timeout:options.timeoutMs,args:['--enable-unsafe-webgpu']});
    report.browserVersion=browser.version();page=await browser.newPage();
    page.setDefaultTimeout(options.timeoutMs);
    await page.route('**/bounded-fixture.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Bounded comparison</title>'}));
    await page.goto(origin+'/bounded-fixture.html');
  }
  for(const {data,tileCells,repeat} of runs) {
    const config={canvas:{columns:data.columns,rows:data.rows,sample_width:data.sampleWidth,sample_height:data.sampleHeight},
      fit:{foreground_candidates:data.foregroundCandidates,background_candidates:data.backgroundCandidates}};
    const cpuStart=performance.now();
    const expected=options.skipCpu?null:referencePhotoFit({pixels:data.pixels,masks:data.masks,palette:data.palette,config});
    const cpuMs=expected?performance.now()-cpuStart:null,cpuAnsi=expected?PNG2ANSI.ansiBytes({codes:data.codes},expected,config):null;
    const tuple=r=>Array.from(r.chosen,(g,i)=>[g,r.fg[i],r.bg[i]]);
    for(const backend of options.webgpu?['cuda','webgpu']:['cuda']) {
      const start=performance.now();
      const actual=backend==='cuda'?await withTimeout(fitter.fit({...data,preferredTileCells:tileCells,preferredTileMiB:options.tileMiB??null}),options.timeoutMs,()=>fitter.close()):await browserWork(page.evaluate(async ({data,tileCells})=>{
        const {PhotographicWebGpuFitter}=await import('/src/gpu/photographic.js');
        const gpu=await PhotographicWebGpuFitter.create(await (await fetch('/src/gpu/photographic.wgsl')).text());
        try {
          const r=await gpu.fit({...data,pixels:Uint8Array.from(data.pixels),masks:data.masks.map(m=>Float32Array.from(m)),
            preferredTileCells:tileCells,inFlightTiles:1,captureGpuTimestamps:true});
          return {chosen:Array.from(r.chosen),fg:Array.from(r.fg),bg:Array.from(r.bg),stats:r.stats};
        }finally{gpu.close();}
      },{data:{...data,pixels:Array.from(data.pixels),masks:data.masks.map(m=>Array.from(m))},tileCells}));
      const wallMs=performance.now()-start;
      const cellDiff=expected?compareCells(expected,actual):{skipped:true,changedCells:null};
      const ansiDiff=expected?compareAnsi(cpuAnsi,PNG2ANSI.ansiBytes({codes:data.codes},actual,config)):{skipped:true,mismatches:null};
      report.cases.push({name:data.name,backend,tileCells,repeat,columns:data.columns,rows:data.rows,
        sampleWidth:data.sampleWidth,sampleHeight:data.sampleHeight,glyphCount:data.masks.length,
        foregroundCandidates:data.foregroundCandidates,backgroundCandidates:data.backgroundCandidates,
        cpuMs,wallMs,cellDiff,ansiDiff,cpuTuples:expected?tuple(expected):null,actualTuples:tuple(actual),
        cpuAnsiBytes:cpuAnsi?.length??null,cpuAnsiSha256:cpuAnsi?createHash('sha256').update(cpuAnsi).digest('hex'):null,stats:actual.stats});
      if(backend==='cuda'&&!options.allowParityDifferences&&(cellDiff.changedCells||ansiDiff.mismatches))throw new Error(`CPU parity failed ${data.name}, tile ${tileCells}, repeat ${repeat}`);
      report.driverAfter=driverEventsSince(report.driverSince);
      if(report.driverAfter.events.length)throw new Error('New GPU driver error; scope stopped');
    }
  }
  report.scopedParityPassed=!options.skipCpu&&report.cases.length===summary.runs&&report.cases.every(c=>!c.cellDiff.changedCells&&!c.ansiDiff.mismatches);
  report.cudaScopedParityPassed=!options.skipCpu&&report.cases.length===summary.runs&&report.cases.filter(c=>c.backend==='cuda').every(c=>!c.cellDiff.changedCells&&!c.ansiDiff.mismatches);
  report.benchmarkCompleted=report.cases.length===summary.runs;
}catch(error){report.error=error.stack;report.scopedParityPassed=false;report.cudaScopedParityPassed=false;process.exitCode=1;}
finally {
  report.cleanupErrors=await cleanupSteps([
    ['fitter',()=>fitter?.close()],['native',()=>server.closeCuda()],['browser',()=>browser?.close()]
  ],options.timeoutMs);
  // A stall/error in conversion or cleanup forbids another device probe.
  if(report.workerInfo&&!report.error&&!report.cleanupErrors.length)report.cleanupErrors.push(...await cleanupSteps([
    ['after-info',async()=>{report.afterWorkerInfo=checkedAfterInfo(await (await fetchImpl('/api/cuda/info')).json(),report.workerInfo,options.cudaMode);}]
  ],options.timeoutMs));
  report.cleanupErrors.push(...await cleanupSteps([
    ['final-native',()=>server.closeCuda()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]
  ],options.timeoutMs));
  if(report.cleanupErrors.length){report.scopedParityPassed=false;report.cudaScopedParityPassed=false;report.benchmarkCompleted=false;process.exitCode=1;}
  report.wallTotalMs=performance.now()-started;report.finished=new Date().toISOString();
  await mkdir(dirname(resolve(options.output)),{recursive:true});await writeFile(options.output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({scopedParityPassed:report.scopedParityPassed,cudaScopedParityPassed:report.cudaScopedParityPassed,
    benchmarkCompleted:report.benchmarkCompleted,qualificationAccepted:false,cases:report.cases.length,error:report.error}));
  if(!report.scopedParityPassed&&!options.allowParityDifferences&&!process.exitCode)process.exitCode=2;
}
