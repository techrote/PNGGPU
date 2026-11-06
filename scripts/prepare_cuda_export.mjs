/** Prepare font atlases/source receipts only. Never invokes a matcher. */
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';
import {createWorkbenchServer} from './serve.mjs';import {imagePreparationHtml,sha256} from './cuda_image_fixture.mjs';
import {EXPORT_SIZES,exportGeometry,exportCrop,exportFilter} from './cuda_export_plan.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
const [playwright,inputDirectory,output]=process.argv.slice(2);if(!output)throw Error('Usage: PLAYWRIGHT PNG_DIRECTORY OUTPUT_PLAN');
const root=resolve(import.meta.dirname,'..');process.chdir(root);const input=resolve(inputDirectory);
const names=(await readdir(input)).filter(n=>/^frame_\d{4}\.png$/.test(n)).sort();
if(!names.length||names.length>720||names.some((n,i)=>n!==`frame_${String(i+1).padStart(4,'0')}.png`))throw Error('Expected 1–720 contiguous frames');
const source=resolve(input,'agenticparkour.mp4'),probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',source],{encoding:'utf8',timeout:10000,windowsHide:true}));
const video=probe.streams.find(s=>s.codec_type==='video');if(video.avg_frame_rate!=='30/1'||Number(video.nb_frames)!==names.length)throw Error('Source/frame timing differs');
const plan={schema:'pnggpu-offline-export-v1',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  input,source,sourceVideoSha256:sha256(await readFile(source)),frameCount:names.length,fps:30,sourceWidth:video.width,sourceHeight:video.height,
  hasAudio:probe.streams.some(s=>s.codec_type==='audio'),mode:'float32-direct',sourceFrames:[],variants:[],
  bounds:{maxFrames:720,maxVariants:24,framesPerChunk:30,frameTimeoutMs:10000,chunkTimeoutMs:30000,memoryReserveBytes:2147483648,depth:1},
  ffmpegVersion:execFileSync('ffmpeg',['-version'],{encoding:'utf8',timeout:10000,windowsHide:true}).split('\n')[0],sourceFiles:{}};
for(const name of names){const b=await readFile(resolve(input,name));if(b.length>16*1024*1024)throw Error('Source PNG too large');plan.sourceFrames.push({name,bytes:b.length,sha256:sha256(b)});}
for(const name of ['scripts/prepare_cuda_export.mjs','scripts/cuda_export_plan.mjs','scripts/export_cuda_sequence.mjs','scripts/render_cuda_export.py','scripts/run_cuda_export.py','overlay/experiments/webgpu/photographic.html','overlay/src/gpu/cuda.js','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf'])plan.sourceFiles[name]=sha256(await readFile(name));
const server=createWorkbenchServer({appDirectory:resolve('PNG2ANSI')});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
  const {chromium}=await import(pathToFileURL(resolve(playwright)).href);browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});
  const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.route('**/experiments/webgpu/export-preparation.html',r=>r.fulfill({contentType:'text/html',body:imagePreparationHtmlTemplate}));
  const imagePreparationHtmlTemplate=imagePreparationHtml(await readFile('overlay/experiments/webgpu/photographic.html','utf8'));
  await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/export-preparation.html`);await page.waitForFunction(()=>globalThis.qualification);
  plan.browserVersion=browser.version();
  for(const [sw,sh] of [[4,8],[8,16]])for(const [columns,rows] of EXPORT_SIZES){
    const geometry=exportGeometry(columns,rows,sw,sh,names.length),layout=exportCrop(video.width,video.height,columns,rows);
    const atlas=await withTimeout(page.evaluate(async g=>{
      const config=qualification.makeConfig({columns:g.columns,rows:g.rows,sampleW:g.sampleWidth,sampleH:g.sampleHeight,foreground:6,background:5});
      const m=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary],config.canvas);
      return {config,masks:m.low.map(v=>Array.from(v)),codes:m.codes,palette:PNG2ANSI.PALETTE,
        highAtlas:{width:config.canvas.cell_width,height:config.canvas.cell_height,alpha:m.hi.flatMap(v=>Array.from(v,x=>Math.round(x*255)))}};
    },geometry),10000,()=>browser.close());
    atlas.highAtlas.alpha=Buffer.from(atlas.highAtlas.alpha).toString('base64');
    plan.variants.push({key:`${columns}x${rows}-samples${sw}x${sh}-fp32`,geometry,layout,filter:exportFilter(geometry,layout),...atlas});
  }
  plan.completed=true;await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(plan,null,2)+'\n');
  console.log(JSON.stringify({plan:output,variants:plan.variants.length,frames:plan.frameCount,totalFrames:plan.frameCount*plan.variants.length}));
}catch(error){plan.completed=false;plan.error=error.stack;process.exitCode=1;}
finally{
  plan.cleanupErrors=await cleanupSteps([['browser',()=>browser?.close()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000);
  if(plan.cleanupErrors.length){plan.completed=false;process.exitCode=1;}
  await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(plan,null,2)+'\n');
}
