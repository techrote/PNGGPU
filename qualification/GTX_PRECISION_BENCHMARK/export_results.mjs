import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createWorkbenchServer} from '../../scripts/serve.mjs';
import {imagePreparationHtml} from '../../scripts/cuda_image_fixture.mjs';
import {withTimeout} from '../../scripts/qualification_lifecycle.mjs';
import {driverEventsSince} from '../../scripts/cuda_driver_events.mjs';
import '../../PNG2ANSI/src/core.js';
const root=resolve(import.meta.dirname,'../..');process.chdir(root);
const out=resolve('qualification/GTX_PRECISION_BENCHMARK');
await mkdir(resolve(out,'previews'),{recursive:true});await mkdir(resolve(out,'ansi'),{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const matrix=JSON.parse(await readFile('build/qualification/precision-matrix/matrix.json','utf8'));
const tiles=JSON.parse(await readFile('build/qualification/precision-matrix/tiles.json','utf8'));
const large=JSON.parse(await readFile('build/qualification/precision-large-packed/large.json','utf8'));
if(!matrix.benchmarkCompleted||!tiles.benchmarkCompleted||!large.benchmarkCompleted)throw new Error('Incomplete benchmark phases');
const images=JSON.parse(await readFile('overlay/fixtures/hardmode/manifest.json','utf8')).images;
const entries=[...matrix.cases,...tiles.cases,...large.cases];
entries.sort((a,b)=>a.image.localeCompare(b.image)||a.settings.columns-b.settings.columns||a.settings.sw-b.settings.sw||String(a.input).localeCompare(String(b.input)));
const settings=[],settingKeys=new Map(),cases=[],inputs=new Map(),buffers=[],previewKeys=new Map();
let offset=0,lastInputPath=null,lastInput;
for(const entry of entries) {
  const bytes=await readFile(entry.report),r=JSON.parse(bytes),c=r.cases[0];
  if(hash(bytes)!==entry.reportSha256||!r.benchmarkCompleted||r.error||r.cleanupErrors.length||r.sourceStatus||c.stats.precision!==entry.mode)throw new Error('Invalid completed evidence');
  if(entry.input!==lastInputPath){const b=await readFile(entry.input);if(hash(b)!==entry.inputSha256)throw new Error('Input hash changed');lastInput=JSON.parse(b);lastInputPath=entry.input;}
  const input=lastInput,f=input.fixture,image=images.findIndex(i=>i.file===entry.image),s=entry.settings;
  const key=`${s.columns}x${s.rows}-${s.sw}x${s.sh}-${entry.tileMiB?'m'+entry.tileMiB:'c'+(entry.tileCells??16)}`;
  if(!settingKeys.has(key)){settingKeys.set(key,settings.length);settings.push({...s,tileMiB:entry.tileMiB??null,tileCells:entry.tileCells??(entry.tileMiB?null:16),
    label:`${s.columns}x${s.rows} chars / ${s.sw}x${s.sh} samples / ${entry.tileMiB?entry.tileMiB+' MiB':'tile '+(entry.tileCells??16)}`});}
  const setting=settingKeys.get(key),id=`i${image}-s${setting}-${entry.mode}`,packed=Buffer.alloc(c.actualTuples.length*4);
  c.actualTuples.forEach(([g,fg,bg],i)=>{packed.writeUInt16LE(g,i*4);packed[i*4+2]=fg;packed[i*4+3]=bg;});
  const tupleSha256=hash(packed),previewKey=`${s.columns}x${s.rows}:${tupleSha256}`;
  const preview=previewKeys.get(previewKey)??`previews/${id}.png`;previewKeys.set(previewKey,preview);
  const ansi=PNG2ANSI.ansiBytes({codes:f.codes},{chosen:c.actualTuples.map(t=>t[0]),fg:c.actualTuples.map(t=>t[1]),bg:c.actualTuples.map(t=>t[2])},{});
  await writeFile(resolve(out,'ansi',id+'.ans'),ansi);const t=c.stats.timing;
  cases.push({id,image,setting,mode:entry.mode,offset,cells:c.actualTuples.length,tupleSha256,
    wallMs:c.wallMs,kernelMs:t.gpuProjectionMs+t.gpuSelectionMs,initMs:t.nativeInitMs,bridgeMs:t.bridgeRoundTripMs,prepMs:input.provenance.preparationMs,
    cleanupMs:t.cleanupMs,uploadMs:t.uploadMs,readbackMs:t.readbackMs,cpuMs:c.cpuMs,vsCpu:c.cellDiff,ansiVsCpu:c.ansiDiff,
    ansiBytes:ansi.length,ansiSha256:hash(ansi),ansi:`ansi/${id}.ans`,preview,sourceCommit:r.sourceCommit,workerSourceCommit:r.workerSourceCommit,workerSha256:r.workerSha256,
    directCells:c.stats.directCells,recoveredCells:c.stats.recoveredCells,certifiedCells:c.stats.certifiedCells,allocatedBytes:c.stats.allocatedBytes,
    effectiveProjectionMiB:c.stats.effectiveProjectionMiB,effectiveTileCells:c.stats.tileCells,effectiveDepth:c.stats.inFlightTiles,
    uploadedBytes:c.stats.uploadedBytes,readbackBytes:c.stats.readbackBytes,maxProjectionLaunchMs:t.maxProjectionLaunchMs,maxSelectionLaunchMs:t.maxSelectionLaunchMs,
    projectionSublaunches:c.stats.projectionSublaunches,selectionSublaunches:c.stats.selectionSublaunches,
    beforeDevice:r.workerInfo.device,afterDevice:r.afterWorkerInfo.device,driverAfter:r.driverAfter,scope:r.scope,
    rawInput:entry.input,rawInputSha256:entry.inputSha256,rawReport:entry.report,rawReportSha256:hash(bytes),
    preparationSourceCommit:input.provenance.sourceCommit,preparationSourceFiles:input.provenance.sourceFiles});
  buffers.push(packed);offset+=packed.length;
  inputs.set(id,{fixture:{masks:f.masks,codes:f.codes},provenance:{config:input.provenance.config}});
}
const packed=Buffer.concat(buffers);await writeFile(resolve(out,'outputs.bin'),packed);
for(const c of cases) {
  const s=settings[c.setting],ref=cases.find(r=>r.image===c.image&&r.mode==='binary64-direct'&&settings[r.setting].columns===s.columns&&settings[r.setting].rows===s.rows&&settings[r.setting].sw===s.sw&&settings[r.setting].sh===s.sh);
  let changed=0;for(let i=0;i<c.cells;i++)if(packed.readUInt32LE(c.offset+i*4)!==packed.readUInt32LE(ref.offset+i*4))changed++;
  c.vs64=changed;
}
const html=await readFile('overlay/experiments/webgpu/photographic.html','utf8');
const render=html.slice(html.indexOf('function renderCells('),html.indexOf('function currentSettings('));
const pageHtml=imagePreparationHtml(html).replace('globalThis.qualification={masksFor,makeConfig};',render+'\nglobalThis.qualification={masksFor,makeConfig,renderCells};');
const server=createWorkbenchServer({appDirectory:resolve('PNG2ANSI')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,atlas;const previewHashes=new Map();
try {
  const {chromium}=await import(pathToFileURL(resolve('build/qualification-tools/node_modules/playwright/index.mjs')).href);
  browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.route('**/experiments/webgpu/precision-render.html',route=>route.fulfill({contentType:'text/html',body:pageHtml}));
  await page.goto(`http://127.0.0.1:${server.address().port}/experiments/webgpu/precision-render.html`);await page.waitForFunction(()=>globalThis.qualification);
  for(const c of cases) {
    if(previewHashes.has(c.preview)){c.previewSha256=previewHashes.get(c.preview);continue;}
    const tuples=Array.from({length:c.cells},(_,i)=>{const p=c.offset+i*4;return [packed.readUInt16LE(p),packed[p+2],packed[p+3]];});
    const r=await withTimeout(page.evaluate(async ({input,tuples,needAtlas})=>{
      const config=input.provenance.config,masks=await qualification.masksFor(PNG2ANSI.vocabularies()[config.vocabulary],config.canvas);
      if(JSON.stringify(masks.codes)!==JSON.stringify(input.fixture.codes)||JSON.stringify(masks.low.map(m=>Array.from(m)))!==JSON.stringify(input.fixture.masks))throw new Error('Preview masks differ from measured masks');
      const blob=await qualification.renderCells(masks,{chosen:tuples.map(t=>t[0]),fg:tuples.map(t=>t[1]),bg:tuples.map(t=>t[2])},config.canvas);
      const png=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(blob);});
      return {png,atlas:needAtlas?{width:config.canvas.cell_width,height:config.canvas.cell_height,codes:masks.codes,alpha:masks.hi.flatMap(m=>Array.from(m,v=>Math.round(v*255)))}:null};
    },{input:inputs.get(c.id),tuples,needAtlas:!atlas}),10000,()=>browser.close());
    if(r.atlas)atlas={...r.atlas,alpha:Buffer.from(r.atlas.alpha).toString('base64')};
    const png=Buffer.from(r.png.split(',')[1],'base64');await writeFile(resolve(out,c.preview),png);c.previewSha256=hash(png);previewHashes.set(c.preview,c.previewSha256);
  }
}finally{await browser?.close();await server.closeCuda();server.closeAllConnections();await new Promise(r=>server.close(r));}
const summary={schema:'pnggpu-precision-visual-benchmark-v2',sourceCommits:[...new Set(cases.map(c=>c.sourceCommit))],worker:matrix.worker,settings,
  images:images.map(i=>({file:i.file,title:i.title,sha256:i.sha256})),started:matrix.started,finished:large.finished,
  benchmarkCompleted:true,qualificationAccepted:false,cases,outputsSha256:hash(packed),uniquePreviews:previewHashes.size,
  driverFinal:{since:matrix.started,recorded:new Date().toISOString(),...driverEventsSince(matrix.started)}};
if(summary.driverFinal.events.length)throw new Error('New driver event during presentation generation');
await writeFile(resolve(out,'atlas.json'),JSON.stringify(atlas)+'\n');summary.atlasSha256=hash(await readFile(resolve(out,'atlas.json')));
await writeFile(resolve(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
const columns=['image','setting','mode','wallMs','kernelMs','initMs','bridgeMs','prepMs','vs64','allocatedBytes'];
await writeFile(resolve(out,'results.csv'),[columns.join(','),...cases.map(c=>columns.map(k=>JSON.stringify(c[k])).join(','))].join('\n')+'\n');
// One FP64 base per image/geometry, sparse six-byte deltas for every other output.
const compact=[],baseByDataset=new Map(),deltaByHash=new Map(),rows=[];let compactOffset=0;
for(const c of cases.filter(c=>c.mode==='binary64-direct')) {
  const s=settings[c.setting],key=`${c.image}:${s.columns}:${s.rows}:${s.sw}:${s.sh}`;
  if(baseByDataset.has(key))continue;
  const b=packed.subarray(c.offset,c.offset+c.cells*4);baseByDataset.set(key,{offset:compactOffset,data:b});compact.push(b);compactOffset+=b.length;
}
for(const c of cases) {
  const s=settings[c.setting],key=`${c.image}:${s.columns}:${s.rows}:${s.sw}:${s.sh}`,base=baseByDataset.get(key);
  const deltaKey=key+':'+c.tupleSha256;let delta=deltaByHash.get(deltaKey);
  if(!delta){const parts=[];for(let i=0;i<c.cells;i++)if(packed.readUInt32LE(c.offset+i*4)!==base.data.readUInt32LE(i*4)){const b=Buffer.alloc(6);b.writeUInt16LE(i);packed.copy(b,2,c.offset+i*4,c.offset+i*4+4);parts.push(b);}
    const b=Buffer.concat(parts);delta={offset:compactOffset,count:parts.length};compact.push(b);compactOffset+=b.length;deltaByHash.set(deltaKey,delta);}
  rows.push({id:c.id,image:c.image,setting:c.setting,mode:c.mode,baseOffset:base.offset,deltaOffset:delta.offset,deltaCount:delta.count,
    wallMs:c.wallMs,kernelMs:c.kernelMs,initMs:c.initMs,bridgeMs:c.bridgeMs,prepMs:c.prepMs,vs64:c.vs64});
}
const data={images:summary.images,settings,atlas,palette:PNG2ANSI.PALETTE,encoding:'deflate-base-delta-v1',
  outputs:deflateSync(Buffer.concat(compact),{level:9}).toString('base64'),cases:rows};
await writeFile('build/qualification/precision-gallery-data-all.json',JSON.stringify(data));
console.log(JSON.stringify({cases:cases.length,outputBytes:packed.length,previews:previewHashes.size,galleryBytes:Buffer.byteLength(JSON.stringify(data)),driver:summary.driverFinal}));
