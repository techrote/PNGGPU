/** Real-browser/real-worker acceptance runner. No mock fallback; see --help. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length < 3) {
  console.log('Usage: node scripts/qualify_cuda.mjs WORKER PLAYWRIGHT_MODULE OUTPUT_JSON [CHROME_EXE] [--large] [--worker-commit SHA]\nRun setup.bat first. Install playwright into build/qualification-tools; pass its index.mjs.\nExit 2 means parity/acceptance failure; reports and minimal shared-input fixtures are retained.');
  process.exit(args.includes('--help') ? 0 : 1);
}
const positionals=[];
for(let i=0;i<args.length;i++) {
  if(args[i]==='--worker-commit'){i++;continue;}
  if(args[i]==='--large')continue;
  if(args[i].startsWith('--'))throw new Error(`Unknown flag: ${args[i]}`);
  positionals.push(args[i]);
}
if(positionals.length<3||positionals.length>4)throw new Error('Expected WORKER PLAYWRIGHT_MODULE OUTPUT_JSON [CHROME_EXE]');
const [worker, playwrightModule, output, chrome] = positionals;
const root = resolve(import.meta.dirname, '..');
const git = (...a) => execFileSync('git', a, {cwd:root, encoding:'utf8'}).trim();
const workerCommitIndex=args.indexOf('--worker-commit');
const workerSourceCommit=workerCommitIndex<0 ? (await readFile(resolve(dirname(worker),'SOURCE_COMMIT.txt'),'utf8')).trim() : args[workerCommitIndex+1];
if(!/^[a-f0-9]{40}$/.test(workerSourceCommit||''))throw new Error('Supply --worker-commit SHA, or retain SOURCE_COMMIT.txt beside the CI worker.');
if(git('diff',workerSourceCommit,'--','native/cuda'))throw new Error('Native sources differ from the supplied worker source commit; build a matching worker.');
const report = {schema:'pnggpu-physical-qualification-v1', sourceCommit:git('rev-parse','HEAD'),
  workerSourceCommit,
  sourceStatus:git('status','--porcelain'), started:new Date().toISOString(),
  workerSha256:createHash('sha256').update(await readFile(worker)).digest('hex'),
  workerInfo:JSON.parse(execFileSync(resolve(worker), ['--info','--device','0'], {encoding:'utf8'})),
  selfTest:JSON.parse(execFileSync(resolve(worker), ['--self-test','--device','0'], {encoding:'utf8'})), jobs:[]};
report.sourceFiles={};
for(const name of git('ls-files','overlay').split('\n')) {
  const source=await readFile(resolve(root,name));
  const installed=await readFile(resolve(root,'PNG2ANSI',name.slice('overlay/'.length)));
  if(!source.equals(installed))throw new Error(`Installed overlay differs from source: ${name}; run setup.bat.`);
  report.sourceFiles[name]=createHash('sha256').update(source).digest('hex');
}
const corpusManifest=JSON.parse(await readFile(resolve(root,'overlay/fixtures/hardmode/manifest.json'),'utf8'));
for(const item of corpusManifest.images) {
  const bytes=await readFile(resolve(root,'overlay/fixtures/hardmode',item.file));
  if(createHash('sha256').update(bytes).digest('hex')!==item.sha256||bytes.length!==item.size_bytes)
    throw new Error(`Hardmode fixture integrity failed: ${item.file}`);
}
const invalidDevice=spawnSync(resolve(worker),['--info','--device','2147483647'],{encoding:'utf8'});
report.invalidDevice={status:invalidDevice.status,stdout:invalidDevice.stdout,passed:invalidDevice.status===1&&JSON.parse(invalidDevice.stdout).available===false};
try { report.nvidiaSmi = execFileSync('nvidia-smi', ['--query-gpu=name,uuid,driver_version,pstate,clocks.sm,clocks.mem,power.draw,power.limit,memory.used,memory.total', '--format=csv'], {encoding:'utf8'}); }
catch (e) { report.nvidiaSmiError = e.message; }
await mkdir(dirname(resolve(output)), {recursive:true});
const server = createWorkbenchServer({appDirectory:resolve(root,'PNG2ANSI'),cudaExecutable:resolve(worker),cudaDevice:0});
await new Promise(r => server.listen(0,'127.0.0.1',r));
let browser;
try {
  const {chromium} = await import(pathToFileURL(resolve(playwrightModule)).href);
  browser = await chromium.launch({headless:true, ...(chrome ? {executablePath:resolve(chrome)} : {}), args:['--enable-unsafe-webgpu']});
  report.browserVersion = browser.version();
  const page = await browser.newPage();
  // Expose existing workbench preparation functions only in this intercepted test page.
  await page.route('**/experiments/webgpu/photographic.html', async route => {
    const html = await readFile(resolve(root,'PNG2ANSI/experiments/webgpu/photographic.html'),'utf8');
    await route.fulfill({contentType:'text/html',body:html.replace(/<\/script>\s*$/, '</script>')
      .replace(/<\/script>(?![^]*<\/script>)/, 'globalThis.qualification = {masksFor, makeConfig};\n</script>')});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/photographic.html`);
  await page.waitForFunction(() => globalThis.qualification);
  const corpus = JSON.parse(await readFile(resolve(root,'overlay/fixtures/hardmode/manifest.json'),'utf8'));
  const jobs = corpus.images.map(i => ({image:i.file,columns:80,rows:40,sampleW:4,sampleH:8,tileCells:1023}));
  jobs.push({...jobs[0],columns:17,rows:9,tileCells:64});
  if (args.includes('--large')) {
    jobs.push({...jobs[0],columns:512,rows:512,sampleW:1,sampleH:1,tileCells:16384});
    jobs.push({...jobs[0],columns:512,rows:512,tileCells:16384});
  }
  for (const job of jobs) {
    console.log(JSON.stringify({starting:job}));
    const result = await page.evaluate(async job => {
      const {PhotographicCudaFitter} = await import('/src/gpu/cuda.js');
      const {PhotographicWebGpuFitter} = await import('/src/gpu/photographic.js');
      const {referencePhotoFit} = await import('/src/gpu/reference_photo.js');
      const {compareCells,compareAnsi} = await import('/src/gpu/metrics.js');
      const config=qualification.makeConfig({...job,foreground:6,background:5});
      const start=performance.now();
      const masks=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary], config.canvas);
      const bitmap=await createImageBitmap(await (await fetch('/fixtures/hardmode/'+job.image)).blob());
      const canvas=new OffscreenCanvas(job.columns*job.sampleW,job.rows*job.sampleH);
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const preparationMs=performance.now()-start;
      const data={pixels,masks:masks.low,palette:PNG2ANSI.PALETTE,columns:job.columns,rows:job.rows,
        sampleWidth:job.sampleW,sampleHeight:job.sampleH,foregroundCandidates:6,backgroundCandidates:5,
        preferredTileCells:job.tileCells,inFlightTiles:1,captureGpuTimestamps:true};
      const cpuStart=performance.now();
      const cpu=referencePhotoFit({pixels,masks:masks.low,config,palette:PNG2ANSI.PALETTE});
      const cpuMs=performance.now()-cpuStart;
      const ansi=x=>PNG2ANSI.ansiBytes(masks,x,config);
      const cpuAnsi=ansi(cpu), outputs={}, runs={}, parity={};
      for (const backend of ['cuda','webgpu']) {
        let fitter;
        try {
          fitter=backend==='cuda'?await PhotographicCudaFitter.create():await PhotographicWebGpuFitter.create(await (await fetch('/src/gpu/photographic.wgsl')).text());
          runs[backend]=[];
          for(let repeat=0;repeat<3;repeat++) {
            const t=performance.now(), result=await fitter.fit({...data,preferredTileCells:repeat===2?64:job.tileCells});
            const wallMs=performance.now()-t,encodeStart=performance.now(),encoded=ansi(result),ansiMs=performance.now()-encodeStart;
            runs[backend].push({wallMs,ansiMs,totalMs:preparationMs+wallMs+ansiMs,cellsPerSecond:job.columns*job.rows*1000/wallMs,
              projectionSampleRgbWork:job.columns*job.rows*masks.low.length*job.sampleW*job.sampleH*3,stats:result.stats,
              vsCpu:compareCells(cpu,result),ansiVsCpu:compareAnsi(cpuAnsi,ansi(result)),
              vsFirst:repeat?compareCells(outputs[backend],result):null});
            if(!repeat) outputs[backend]=result;
          }
          parity[backend]={cells:compareCells(cpu,outputs[backend]),ansi:compareAnsi(cpuAnsi,ansi(outputs[backend]))};
        } catch(e) { parity[backend]={error:e.stack}; }
        finally {fitter?.close();}
      }
      if(outputs.cuda&&outputs.webgpu) parity.cudaVsWebgpu={cells:compareCells(outputs.webgpu,outputs.cuda),ansi:compareAnsi(ansi(outputs.webgpu),ansi(outputs.cuda))};
      const fixtures=[];
      let crossBackendFixture=false;
      for(let cell=0;cell<cpu.chosen.length;cell++) {
        if(!Object.values(outputs).some(o=>o.chosen[cell]!==cpu.chosen[cell]||o.fg[cell]!==cpu.fg[cell]||o.bg[cell]!==cpu.bg[cell]))continue;
        const cross=outputs.cuda&&outputs.webgpu&&['chosen','fg','bg'].some(k=>outputs.cuda[k][cell]!==outputs.webgpu[k][cell]);
        if(fixtures.length>=4&&(!cross||crossBackendFixture))continue;
        if(cross)crossBackendFixture=true;
        const sample=[];
        for(let y=0;y<job.sampleH;y++)for(let x=0;x<job.sampleW;x++) {
          const at=(((Math.floor(cell/job.columns)*job.sampleH+y)*canvas.width)+(cell%job.columns)*job.sampleW+x)*4;
          sample.push(...pixels.subarray(at,at+4));
        }
        const tuple=o=>[o.chosen[cell],o.fg[cell],o.bg[cell]];
        fixtures.push({cell,pixels:sample,cpu:tuple(cpu),...Object.fromEntries(Object.entries(outputs).map(([k,v])=>[k,tuple(v)]))});
      }
      if(fixtures.length)for(const backend of ['cuda','webgpu']) {
        const fitter=backend==='cuda'?await PhotographicCudaFitter.create():await PhotographicWebGpuFitter.create(await (await fetch('/src/gpu/photographic.wgsl')).text());
        try{for(const fixture of fixtures){
          const result=await fitter.fit({...data,pixels:Uint8Array.from(fixture.pixels),columns:1,rows:1,preferredTileCells:1});
          (fixture.isolated??={})[backend]=[result.chosen[0],result.fg[0],result.bg[0]];
        }}finally{fitter.close();}
      }
      return {job,preparationMs,cpuMs,glyphCount:masks.low.length,parity,runs,
        fixtureAtlas:fixtures.length?{masks:masks.low.map(m=>Array.from(m)),codes:masks.codes,palette:PNG2ANSI.PALETTE}:null,fixtures};
    }, job);
    report.jobs.push(result);
    console.log(JSON.stringify({completed:job,parity:result.parity}));
    await writeFile(output,JSON.stringify(report,null,2)+'\n');
  }
  report.cancellation=await page.evaluate(async()=>{
    const {PhotographicCudaFitter}=await import('/src/gpu/cuda.js');
    const controller=new AbortController();let tileRequested=false;
    const fetchImpl=(url,options)=>{
      if(url.endsWith('/tile')&&!tileRequested){tileRequested=true;setTimeout(()=>controller.abort(),1);}
      return fetch(url,options);
    };
    const fitter=await PhotographicCudaFitter.create({fetchImpl});
    const before=(await (await fetch('/api/cuda/info')).json()).device.freeMemoryBytes;
    const data={pixels:new Uint8Array(128*4),columns:128,rows:1,sampleWidth:1,sampleHeight:1,
      masks:[Float32Array.of(0),Float32Array.of(1)],palette:PNG2ANSI.PALETTE,
      foregroundCandidates:6,backgroundCandidates:5,preferredTileCells:64};
    let error=null;
    try{await fitter.fit({...data,signal:controller.signal});}catch(e){error=e.name;}
    const recovered=await fitter.fit(data);fitter.close();
    const after=(await (await fetch('/api/cuda/info')).json()).device.freeMemoryBytes;
    return {tileRequested,error,recoveredCells:recovered.chosen.length,beforeFreeBytes:before,afterFreeBytes:after,
      passed:tileRequested&&error==='AbortError'&&recovered.chosen.length===128};
  });
} catch(e) {report.error=e.stack;process.exitCode=1;}
finally {
  await browser?.close(); await server.closeCuda(); server.closeAllConnections(); await new Promise(r=>server.close(r));
  report.finished=new Date().toISOString();
  report.accepted=!report.error&&report.invalidDevice.passed&&report.cancellation?.passed===true&&report.jobs.length>0&&report.jobs.every(j=>['cuda','webgpu'].every(b=>
    j.parity[b]?.cells?.changedCells===0&&j.parity[b]?.ansi?.mismatches===0&&
    j.runs[b]?.length===3&&j.runs[b].every(r=>r.vsFirst===null||r.vsFirst.changedCells===0)));
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(!report.accepted&&!process.exitCode)process.exitCode=2;
}
