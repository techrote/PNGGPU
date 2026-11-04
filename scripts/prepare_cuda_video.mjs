/** CPU/browser preparation of a finite local PNG sequence; no CUDA or matching. */
import {readFile,writeFile,open,mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWorkbenchServer} from './serve.mjs';
import {imagePreparationHtml,decodeRgbaTransport,sha256} from './cuda_image_fixture.mjs';
import {videoGeometry,VIDEO_SOURCE_FILES,pngDimensions} from './cuda_video_plan.mjs';
import {withTimeout,cleanupSteps} from './qualification_lifecycle.mjs';
import {driverEventsSince} from './cuda_driver_events.mjs';
const [playwright,inputDirectory,c,r,n,output]=process.argv.slice(2);
if(!output||process.argv.length!==8)throw new Error('Usage: node scripts/prepare_cuda_video.mjs PLAYWRIGHT PNG_DIRECTORY COLUMNS ROWS COUNT OUTPUT_DIRECTORY');
const geometry=videoGeometry(Number(c),Number(r),Number(n));process.chdir(resolve(import.meta.dirname,'..'));
const out=resolve(output),input=resolve(inputDirectory);await mkdir(out,{recursive:true});
const paths=VIDEO_SOURCE_FILES;
const sourceFiles={};for(const path of paths)sourceFiles[path]=sha256(await readFile(path));
const report={schema:'pnggpu-video-frames-v1',geometry,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),sourceFiles,
  started:new Date().toISOString(),inputDirectory:input,fitMode:'contain-black',matchingRuns:0,frames:[],completed:false};
const check=()=>{const v=driverEventsSince(report.started);if(v.events.length)throw new Error('New driver error; preparation stopped');return v;};
const server=createWorkbenchServer({appDirectory:resolve('PNG2ANSI')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,file;const rgbaHash=createHash('sha256');let offset=0;
try {
  report.driverBaseline=check();
  const {chromium}=await import(pathToFileURL(resolve(playwright)).href);
  browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});report.browserVersion=browser.version();
  const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.route('**/experiments/webgpu/video-preparation.html',async route=>route.fulfill({contentType:'text/html',body:imagePreparationHtml(await readFile('overlay/experiments/webgpu/photographic.html','utf8'))}));
  await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/video-preparation.html`);await page.waitForFunction(()=>globalThis.qualification);
  const prepared=await withTimeout(page.evaluate(async geometry=>{
    const start=performance.now(),{columns,rows}=geometry,config=qualification.makeConfig({columns,rows,sampleW:4,sampleH:8,foreground:6,background:5});
    const masks=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary],config.canvas);
    return {config,masks:masks.low.map(m=>Array.from(m)),codes:masks.codes,palette:PNG2ANSI.PALETTE,fontMs:performance.now()-start,
      high:{width:config.canvas.cell_width,height:config.canvas.cell_height,alpha:masks.hi.flatMap(m=>Array.from(m,v=>Math.round(v*255)))}};
  },geometry),10000,()=>browser.close());
  report.atlas={columns:geometry.columns,rows:geometry.rows,sampleWidth:4,sampleHeight:8,masks:prepared.masks,codes:prepared.codes,
    palette:prepared.palette,foregroundCandidates:6,backgroundCandidates:5};
  report.config=prepared.config;report.fontMs=prepared.fontMs;
  report.highAtlas={...prepared.high,alpha:Buffer.from(prepared.high.alpha).toString('base64')};
  file=await open(resolve(out,'frames.rgba'),'w');
  for(let index=0;index<geometry.count;index++){
    check();const name=`frame_${String(index+1).padStart(4,'0')}.png`,start=performance.now(),path=resolve(input,name);
    if((await stat(path)).size>16*1024*1024)throw new Error('PNG exceeds 16 MiB frame cap');
    const png=await readFile(path);
    if(png.length>16*1024*1024)throw new Error('PNG exceeds 16 MiB frame cap');
    const dimensions=pngDimensions(png),sourceReadMs=performance.now()-start;
    const transportStart=performance.now();
    const f=await withTimeout(page.evaluate(async({png,geometry})=>{
      const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0)),begin=performance.now(),bitmap=await createImageBitmap(new Blob([bytes]));
      const decodeMs=performance.now()-begin;
      try{
        if(bitmap.width>4096||bitmap.height>4096)throw new Error('Source frame dimensions exceed 4096');
        const start=performance.now(),canvas=new OffscreenCanvas(geometry.columns*4,geometry.rows*8),ctx=canvas.getContext('2d',{willReadFrequently:true});
        ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
        const scale=Math.min(canvas.width/bitmap.width,canvas.height/bitmap.height),w=bitmap.width*scale,h=bitmap.height*scale;
        ctx.drawImage(bitmap,(canvas.width-w)/2,(canvas.height-h)/2,w,h);
        const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,resampleMs=performance.now()-start;
        const base64=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(new Blob([rgba]));});
        return {base64,decodeMs,resampleMs,width:bitmap.width,height:bitmap.height};
      }finally{bitmap.close();}
    },{png:png.toString('base64'),geometry}),10000,()=>browser.close());
    const rgba=decodeRgbaTransport(f.base64,geometry.columns*geometry.rows*32*4);
    if(f.width!==dimensions.width||f.height!==dimensions.height)throw new Error('Decoded PNG dimensions differ from header');
    const transportMs=performance.now()-transportStart;rgbaHash.update(rgba);await file.writeFile(rgba);
    report.frames.push({index,name,sourceSha256:sha256(png),sourceBytes:png.length,sourceReadMs,width:f.width,height:f.height,
      decodeMs:f.decodeMs,resampleMs:f.resampleMs,transportMs,rgbaOffset:offset,rgbaBytes:rgba.length,rgbaSha256:sha256(rgba)});offset+=rgba.length;
    report.driverAfter=check();if((index+1)%30===0)console.log(JSON.stringify({prepared:index+1,total:geometry.count,matchingRuns:0}));
  }
  report.rgbaBytes=offset;report.rgbaSha256=rgbaHash.digest('hex');report.completed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  report.cleanupErrors=await cleanupSteps([['file',()=>file?.close()],['browser',()=>browser?.close()],['server',()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}]],10000);
  if(report.cleanupErrors.length){report.completed=false;process.exitCode=1;}
  report.finished=new Date().toISOString();await writeFile(resolve(out,'manifest.json'),JSON.stringify(report,null,2)+'\n');
}
