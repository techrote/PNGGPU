/** Canvas/font preparation only: no CUDA worker and no matching backend. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createWorkbenchServer} from './serve.mjs';
import {parseImagePreparationArgs,imagePreparationHtml,validateImageFixture,sha256} from './cuda_image_fixture.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';

const args=process.argv.slice(2);
if(args.includes('--help')||!args.length) {
  console.log('Usage: node scripts/prepare_cuda_image.mjs PLAYWRIGHT_MODULE OUTPUT_JSON EXACT_IMAGE COLUMNS ROWS [SAMPLE_WIDTH SAMPLE_HEIGHT] [--max-preparation-cells N]\nPreparation only; default 64 cells, explicit cap up to 51200 (320x160). Above 3200 cells requires 4x8 samples. Six/five candidates. Run setup.bat first.');
  process.exit(args.includes('--help')?0:1);
}
const {playwright,output,image,geometry,maxPreparationCells}=parseImagePreparationArgs(args);
const root=resolve(import.meta.dirname,'..');process.chdir(root);
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',cwd:root}).trim();
const manifestPath='overlay/fixtures/hardmode/manifest.json';
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const item=manifest.images.find(i=>i.file===image);
if(!item||!/^[a-z0-9-]+\.png$/.test(image))throw new Error('Choose an exact image name from the hardmode manifest');
const imagePath='overlay/fixtures/hardmode/'+image;
const imageBytes=await readFile(imagePath);
if(imageBytes.length!==item.size_bytes||sha256(imageBytes)!==item.sha256)throw new Error('Hardmode image integrity failed');
const paths=[manifestPath,imagePath,'overlay/experiments/webgpu/photographic.html','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf',
  'scripts/prepare_cuda_image.mjs','scripts/cuda_image_fixture.mjs'];
const sourceFiles={};
for(const path of paths) {
  const bytes=await readFile(path);sourceFiles[path]=sha256(bytes);
  if(path.startsWith('overlay/')&&!bytes.equals(await readFile('PNG2ANSI/'+path.slice(8))))throw new Error(`Installed preparation file differs: ${path}; run setup.bat`);
}
const html=imagePreparationHtml(await readFile('overlay/experiments/webgpu/photographic.html','utf8'));
const started=new Date().toISOString();
const provenance={sourceCommit:git('rev-parse','HEAD'),sourceStatus:git('status','--porcelain'),sourceFiles,started,
  geometry,maxPreparationCells,image:item,sourceSamplingMode:'full-reference-canvas',matchingRuns:0};
const server=createWorkbenchServer({appDirectory:resolve(root,'PNG2ANSI')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,document,error;
try {
  provenance.driverBaseline=driverEventsSince(started);
  if(provenance.driverBaseline.events.length)throw new Error('New GPU driver error; preparation stopped');
  const {chromium}=await import(pathToFileURL(resolve(playwright)).href);
  browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});
  provenance.browserVersion=browser.version();
  const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.route('**/experiments/webgpu/bounded-preparation.html',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/bounded-preparation.html`);
  await page.waitForFunction(()=>globalThis.qualification);
  const prepared=await withTimeout(page.evaluate(async ({image,geometry})=>{
    const {columns,rows,sampleWidth:sampleW,sampleHeight:sampleH}=geometry;
    const config=qualification.makeConfig({columns,rows,sampleW,sampleH,foreground:6,background:5});
    const start=performance.now();
    const masks=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary],config.canvas);
    const bitmap=await createImageBitmap(await (await fetch('/fixtures/hardmode/'+image)).blob());
    try {
      const canvas=new OffscreenCanvas(columns*sampleW,rows*sampleH),ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      return {pixels:Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data),masks:masks.low.map(m=>Array.from(m)),
        palette:PNG2ANSI.PALETTE,codes:masks.codes,config,sourceWidth:bitmap.width,sourceHeight:bitmap.height,preparationMs:performance.now()-start};
    }finally{bitmap.close();}
  },{image,geometry}),10000,()=>browser.close());
  const fixture={name:`image-${image.slice(0,-4)}-${geometry.columns}x${geometry.rows}-${geometry.sampleWidth}x${geometry.sampleHeight}`,
    ...geometry,pixels:prepared.pixels,masks:prepared.masks,palette:prepared.palette,codes:prepared.codes,foregroundCandidates:6,backgroundCandidates:5};
  Object.assign(provenance,{preparationMs:prepared.preparationMs,config:prepared.config,
    image:{...item,sourceWidth:prepared.sourceWidth,sourceHeight:prepared.sourceHeight},driverAfter:driverEventsSince(started)});
  document={schema:'pnggpu-real-image-fixture-v1',fixture,fixtureSha256:sha256(JSON.stringify(fixture)),provenance};
  if(provenance.driverAfter.events.length)throw new Error('New GPU driver error; preparation stopped');
  validateImageFixture(document);
}catch(e){error=e;}
finally {
  provenance.cleanupErrors=await cleanupSteps([['browser',()=>browser?.close()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000);
  if(provenance.cleanupErrors.length)error??=new Error(JSON.stringify(provenance.cleanupErrors));
  try {provenance.driverFinal=driverEventsSince(started);if(provenance.driverFinal.events.length)error??=new Error('New GPU driver error; preparation stopped');}
  catch(e){provenance.driverFinalError=e.message;error??=e;}
  provenance.finished=new Date().toISOString();
}
await mkdir(dirname(resolve(output)),{recursive:true});
if(error){await writeFile(output,JSON.stringify({schema:'pnggpu-real-image-preparation-error-v1',provenance,error:error.stack},null,2)+'\n');throw error;}
await writeFile(output,JSON.stringify(document)+'\n');
console.log(JSON.stringify({name:document.fixture.name,cells:geometry.columns*geometry.rows,glyphs:document.fixture.masks.length,matchingRuns:0}));
