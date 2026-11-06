/** Neutral original preprocessing, intermediate samples and explicit orientation controls. */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';
import {createWorkbenchServer} from './serve.mjs';import {imagePreparationHtml,sha256} from './cuda_image_fixture.mjs';import {exposeOriginalPreprocessing} from './cuda_quality_plan.mjs';
import {samplingAdditions,SAMPLING_FRAMES,rotateClockwise} from './cuda_sampling_plan.mjs';import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';import {driverEventsSince} from './cuda_driver_events.mjs';
const [playwright,oldPrepared,oldExport,output]=process.argv.slice(2);if(!output)throw Error('Usage: PLAYWRIGHT OLD_PREPARED OLD_EXPORT OUTPUT');process.chdir(resolve(import.meta.dirname,'..'));await mkdir(output,{recursive:true});
const oldPrepBytes=await readFile(resolve(oldPrepared,'preparation.json')),old=JSON.parse(oldPrepBytes),seedBytes=await readFile(resolve(oldExport,'settings.json')),seed=JSON.parse(seedBytes),seedReportBytes=await readFile(resolve(oldExport,'report.json')),seedReport=JSON.parse(seedReportBytes);
if(!old.completed||old.error||!seedReport.completed||seedReport.error||sha256(oldPrepBytes)!==seedReport.preparationSha256)throw Error('Seed receipts incomplete or preparation differs');
for(const [f,h] of Object.entries(old.sourceFiles))if(sha256(await readFile(f))!==h)throw Error('Seed source differs');
const core=await readFile('PNG2ANSI/src/core.js','utf8');if(sha256(Buffer.from(core))!=='f38f4657798fdf095bee62905b337a3726dd2ea70d3b86e98a1f8fea093484e9')throw Error('Pinned core differs');
const p={schema:'pnggpu-sampling-preparation-v1',started:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceFiles:{},selectedFrames:SAMPLING_FRAMES,frameCount:719,fps:30,variants:[],seed:{preparationSha256:sha256(oldPrepBytes),settingsSha256:sha256(seedBytes),reportSha256:sha256(seedReportBytes)},completed:false};
for(const f of ['scripts/cuda_sampling_plan.mjs','scripts/prepare_cuda_sampling.mjs','scripts/run_cuda_sampling.mjs','scripts/cuda_quality_plan.mjs','scripts/cuda_image_fixture.mjs','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf','overlay/experiments/webgpu/photographic.html'])p.sourceFiles[f]=sha256(await readFile(f));
const images=[];for(const f of old.sourceFrames){const path=resolve(old.inputDirectory,f.name);if((await stat(path)).size>16*1024*1024)throw Error('PNG size bound');const b=await readFile(path);if(sha256(b)!==f.sha256)throw Error('Source PNG differs');images.push({number:f.n,png:b.toString('base64')});}
const server=createWorkbenchServer({appDirectory:resolve('PNG2ANSI')});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 const {chromium}=await import(pathToFileURL(resolve(playwright)).href);browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});const page=await browser.newPage();page.setDefaultTimeout(10000);
 await page.route('**/src/core.js',r=>r.fulfill({contentType:'text/javascript',body:exposeOriginalPreprocessing(core)}));const html=imagePreparationHtml(await readFile('overlay/experiments/webgpu/photographic.html','utf8'));
 await page.route('**/experiments/webgpu/sampling.html',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/sampling.html`);await page.waitForFunction(()=>globalThis.qualification);p.browserVersion=browser.version();
 for(const c of samplingAdditions()){
  if(driverEventsSince(p.started).events.length)throw Error('Driver error; stopped');let v;
  if(c.kind==='normal'||c.kind==='upright-refit'){
   v=await withTimeout(page.evaluate(async({c,images})=>{
    const portrait=c.kind==='upright-refit',config=qualification.makeConfig({columns:portrait?25:80,rows:portrait?80:25,sampleW:c.sw,sampleH:c.sh,foreground:6,background:5});
    if(portrait)Object.assign(config.canvas,{cell_width:16,cell_height:8,font_size:7});
    const m=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary],config.canvas),b64=a=>{let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s);},frames=[];
    if(!portrait)for(const image of images){const src=await createImageBitmap(new Blob([Uint8Array.from(atob(image.png),c=>c.charCodeAt(0))]));let cropped;try{cropped=await createImageBitmap(src,43,0,768,480);frames.push({number:image.number,pixels:b64(PNG2ANSI.qualityPreprocess(cropped,config).pixels)});}finally{cropped?.close();src.close();}}
    return {config,codes:m.codes,masks:m.low.map(x=>Array.from(x)),palette:PNG2ANSI.PALETTE,highAtlas:{width:config.canvas.cell_width,height:config.canvas.cell_height,alpha:b64(Uint8Array.from(m.hi.flatMap(a=>Array.from(a,x=>Math.round(x*255)))))},frames};
   },{c,images}),10000,()=>browser.close());
  }else{
   const a=seed.variants.find(v=>v.key===c.anchor);v=structuredClone(a);v.config.canvas={...v.config.canvas,columns:25,rows:80,cell_width:16,cell_height:8,sample_width:c.sw,sample_height:c.sh};
   v.highAtlas={width:16,height:8,alpha:Buffer.concat(Array.from({length:a.codes.length},(_,g)=>Buffer.from(rotateClockwise(Buffer.from(a.highAtlas.alpha,'base64').subarray(g*128,(g+1)*128),8,16)))).toString('base64')};
   const sw=a.geometry.sampleWidth,sh=a.geometry.sampleHeight;v.masks=a.masks.map(m=>Array.from(rotateClockwise(Float32Array.from(m),sw,sh)));v.frames=[];
  }
  if(c.kind!=='normal'){
   const a=old.variants.find(v=>v.key===c.anchor);
   v.frames=[];for(const f of a.frames){const b=await readFile(resolve(oldPrepared,c.anchor,`frame_${String(f.number).padStart(4,'0')}.rgba`));if(sha256(b)!==f.pixelSha256||f.pixelSha256!==seedReport.cases.find(c=>c.key===a.key&&c.number===f.number)?.inputSha256)throw Error('Anchor sample bytes differ');v.frames.push({number:f.number,pixels:Buffer.from(rotateClockwise(b,80*a.geometry.sampleWidth,25*a.geometry.sampleHeight,4)).toString('base64')});}
   Object.assign(v,{displayRotationDegrees:270,comparisonGroup:'80x25',sourceRotationDegrees:90,fontPolicy:c.kind==='upright-refit'?'upright DejaVu 7px in 16x8 cells':'exact 90-degree permutation of saved glyph pixels and low samples'});
  }
  Object.assign(v,c,{style:'photographic',geometry:{columns:c.kind==='normal'?80:25,rows:c.kind==='normal'?25:80,sampleWidth:c.sw,sampleHeight:c.sh,count:3},label:c.kind==='normal'?`CUDA FP32 · samples ${c.sw}×${c.sh}`:`25×80 · ${c.kind} · ${c.sw}×${c.sh} · ${c.kind==='upright-refit'?'upright font 7px':'rotated original atlas'}`,
   layout:{cropBeforeRotation:{x:43,y:0,width:768,height:480},sourceRotationDegrees:c.kind==='normal'?0:90},preparation:'Original neutral preprocessing; original overlapping/unweighted glyph-bin averaging for non-divisor grids'});
  const dir=resolve(output,c.key);await mkdir(dir,{recursive:true});for(const f of v.frames){const b=Buffer.from(f.pixels,'base64');if(b.length!==2000*c.sw*c.sh*4)throw Error('Sample byte length differs');f.pixelSha256=sha256(b);await writeFile(resolve(dir,`frame_${String(f.number).padStart(4,'0')}.rgba`),b);delete f.pixels;}
  v.highAtlasSha256=sha256(Buffer.from(v.highAtlas.alpha,'base64'));v.lowAtlasSha256=sha256(JSON.stringify(v.masks));p.variants.push(v);console.log(JSON.stringify({prepared:p.variants.length,key:c.key}));
 }
 p.completed=true;
}catch(e){p.error=e.stack;process.exitCode=1;}
finally{p.cleanupErrors=await cleanupSteps([['browser',()=>browser?.close()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000);if(p.cleanupErrors.length){p.completed=false;process.exitCode=1;}await writeFile(resolve(output,'preparation.json'),JSON.stringify(p,null,2)+'\n');}
