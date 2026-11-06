/** Source-bound original preprocessing/industrial CPU reference, three frames. */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';
import {createWorkbenchServer} from './serve.mjs';import {imagePreparationHtml,sha256} from './cuda_image_fixture.mjs';
import {qualityVariants,QUALITY_FRAMES,exposeOriginalPreprocessing} from './cuda_quality_plan.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';import {driverEventsSince} from './cuda_driver_events.mjs';
import {pngDimensions} from './cuda_video_plan.mjs';
const [playwright,inputDirectory,output]=process.argv.slice(2);if(!output)throw Error('Usage: PLAYWRIGHT PNG_DIRECTORY OUTPUT');
process.chdir(resolve(import.meta.dirname,'..'));await mkdir(output,{recursive:true});
const core=await readFile('PNG2ANSI/src/core.js','utf8'),coreHash=sha256(Buffer.from(core));
if(coreHash!=='f38f4657798fdf095bee62905b337a3726dd2ea70d3b86e98a1f8fea093484e9')throw Error('Original pinned core differs');
const settings={schema:'pnggpu-quality-preparation-v1',started:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceFiles:{},frameCount:719,fps:30,selectedFrames:QUALITY_FRAMES,variants:[],sourceFrames:[],completed:false};
settings.inputDirectory=resolve(inputDirectory);
for(const path of ['scripts/cuda_quality_plan.mjs','scripts/prepare_cuda_quality.mjs','scripts/run_cuda_quality.mjs','scripts/cuda_image_fixture.mjs','scripts/cuda_video_plan.mjs','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf','overlay/experiments/webgpu/photographic.html'])settings.sourceFiles[path]=sha256(await readFile(path));
const images=[];for(const n of QUALITY_FRAMES){const name=`frame_${String(n).padStart(4,'0')}.png`,path=resolve(inputDirectory,name);if((await stat(path)).size>16*1024*1024)throw Error('PNG cap');const b=await readFile(path),d=pngDimensions(b);if(b.length>16*1024*1024||d.width!==854||d.height!==480)throw Error('PNG size/dimension cap');images.push({n,png:b.toString('base64')});settings.sourceFrames.push({n,name,sha256:sha256(b)});}
const server=createWorkbenchServer({appDirectory:resolve('PNG2ANSI')});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
  const {chromium}=await import(pathToFileURL(resolve(playwright)).href);browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});
  const page=await browser.newPage();page.setDefaultTimeout(10000);const html=imagePreparationHtml(await readFile('overlay/experiments/webgpu/photographic.html','utf8'));
  await page.route('**/src/core.js',r=>r.fulfill({contentType:'text/javascript',body:exposeOriginalPreprocessing(core)}));
  await page.route('**/experiments/webgpu/quality.html',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/quality.html`);await page.waitForFunction(()=>globalThis.qualification);
  settings.browserVersion=browser.version();
  for(const choice of qualityVariants()){
    if(driverEventsSince(settings.started).events.length)throw Error('Driver error; stopped');
    const prepared=await withTimeout(page.evaluate(async({choice,images})=>{
      const config=qualification.makeConfig({columns:80,rows:25,sampleW:choice.sw,sampleH:choice.sh,foreground:6,background:5});config.style=choice.style;
      const update=(a,b)=>{for(const [k,v] of Object.entries(b))typeof v==='object'?update(a[k],v):a[k]=v;};update(config,choice.patch);PNG2ANSI.validateConfig(config);
      const masks=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary],config.canvas),frames=[];
      const base64=a=>{let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s);};
      for(const image of images){
        const bytes=Uint8Array.from(atob(image.png),c=>c.charCodeAt(0)),source=await createImageBitmap(new Blob([bytes]));let bitmap;
        try{
          if(source.width!==854||source.height!==480)throw Error('Source dimension differs');
          bitmap=await createImageBitmap(source,43,0,768,480); // Same 80x25 integral source crop as export.
          const at=performance.now(),sampled=PNG2ANSI.qualityPreprocess(bitmap,config),prepMs=performance.now()-at;
          const f={number:image.n,pixels:base64(sampled.pixels),prepMs};
          if(choice.style==='industrial'){
            const at=performance.now(),r=PNG2ANSI.qualityIndustrialFit(sampled,masks,config);
            f.cpuFitMs=performance.now()-at;f.ansi=base64(PNG2ANSI.ansiBytes(masks,r,config));f.chosen=Array.from(r.chosen);f.fg=Array.from(r.fg);f.bg=Array.from(r.bg);
          }frames.push(f);
        }finally{bitmap?.close();source.close();}
      }
      return {config,codes:masks.codes,masks:masks.low.map(m=>Array.from(m)),palette:PNG2ANSI.PALETTE,
        highAtlas:{width:8,height:16,alpha:base64(Uint8Array.from(masks.hi.flatMap(m=>Array.from(m,x=>Math.round(x*255)))))},frames};
    },{choice,images}),10000,()=>browser.close());
    const dir=resolve(output,choice.key);await mkdir(dir,{recursive:true});
    for(const f of prepared.frames){const p=Buffer.from(f.pixels,'base64');if(p.length!==80*25*choice.sw*choice.sh*4)throw Error('Prepared length differs');f.pixelSha256=sha256(p);await writeFile(resolve(dir,`frame_${String(f.number).padStart(4,'0')}.rgba`),p);delete f.pixels;}
    settings.variants.push({...choice,...prepared,geometry:{columns:80,rows:25,sampleWidth:choice.sw,sampleHeight:choice.sh,count:3},layout:{mode:'center-crop',crop:{x:43,y:0,width:768,height:480}},preparation:'original-pinned-core Canvas preprocessing'});
    console.log(JSON.stringify({prepared:settings.variants.length,key:choice.key}));
  }
  settings.completed=true;
}catch(e){settings.error=e.stack;process.exitCode=1;}
finally{
  settings.cleanupErrors=await cleanupSteps([['browser',()=>browser?.close()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000);
  if(settings.cleanupErrors.length){settings.completed=false;process.exitCode=1;}settings.finished=new Date().toISOString();await writeFile(resolve(output,'preparation.json'),JSON.stringify(settings,null,2)+'\n');
}
