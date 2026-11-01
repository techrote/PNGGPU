import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PhotographicWebGpuFitter} from '../src/gpu/photographic.js';
import {MiB,estimateGpuMemory,evaluateVramBudget} from '../src/gpu/memory.js';
import {tileSpans,requiresStreamedSamples,PREVIEW_MAX_PIXELS} from '../src/gpu/streamed_samples.js';
import {GPU_MAX_WORK_UNITS, photographicWorkUnits,validateGpuBudget} from '../src/gpu/workload.js';
const device={limits:{maxComputeWorkgroupsPerDimension:65535,maxStorageBufferBindingSize:128*MiB,maxBufferSize:256*MiB}};
const p={columns:1024,rows:1024,sampleWidth:32,sampleHeight:64,glyphCount:219,preferredTileMiB:1024,inFlightTiles:24};

test('GPU-007: 1 GiB requested projection target clamps at per-binding raster cap',()=>{
  const plan=PhotographicWebGpuFitter.tilePlan(device,p);
  assert.equal(plan.requestedTileMiB,1024);
  assert.ok(plan.tileCells<16385,'2048 samples × 4 bytes × tile must be within 128 MiB');
  assert.equal(plan.tileCount,Math.ceil(1024**2/plan.tileCells));
  assert.equal(plan.inFlightTiles,24);
  assert.ok(plan.projectionBufferBytes<=128*MiB);
  assert.ok(plan.rasterBufferBytes<=128*MiB);
  assert.ok(plan.projectWorkgroupsX<=65535&&plan.projectWorkgroupsY<=65535);
  assert.ok(plan.effectiveProjectionMiB<1024);
});
test('GPU-007: deep buffering multiplies resident buffers and is rejected on small declared VRAM',()=>{
  const full=PhotographicWebGpuFitter.tilePlan(device,p),single=PhotographicWebGpuFitter.tilePlan(device,{...p,inFlightTiles:1});
  const props={columns:p.columns,rows:p.rows,sampleWidth:p.sampleWidth,sampleHeight:p.sampleHeight,
    glyphCount:p.glyphCount,sourceWidth:2048,sourceHeight:2048,streamedSamples:true,previews:false};
  const a=estimateGpuMemory({...props,plan:single}),b=estimateGpuMemory({...props,plan:full});
  assert.ok(b.gpuBufferBytes>a.gpuBufferBytes);
  assert.ok(b.browserBackingEstimateBytes>a.browserBackingEstimateBytes);
  assert.ok(b.estimatedWorkingSetBytes>a.estimatedWorkingSetBytes);
  assert.equal(evaluateVramBudget(b,4).status,'blocked');
});
test('GPU-007: streamed image sampling avoids a full 8 GiB sample raster',()=>{
  assert.equal(requiresStreamedSamples({columns:1024,rows:1024,sampleW:32,sampleH:64}),true);
  assert.equal(requiresStreamedSamples({columns:80,rows:40,sampleW:4,sampleH:8}),false);
  const spans=tileSpans(1015,33,1024,1024,32,64,8192);
  assert.equal(spans.reduce((n,s)=>n+s.cells,0),33);
  assert.equal(spans[0].column,1015);
  assert.equal(spans[0].cells,9);
  assert.equal(spans[1].column,0);
  for(const span of spans)assert.ok(span.width<=8192);
  for(let i=0;i<33;i++)assert.equal(spans.filter(s=>1015+i>=s.startCell&&1015+i<s.startCell+s.cells).length,1);
  assert.equal(PREVIEW_MAX_PIXELS,16_777_216);
});
test('GPU-007: high output profile is valid and charged exact integer work units',()=>{
  const settings={columns:1024,rows:1024,sampleW:32,sampleH:64,foreground:12,background:8};
  assert.ok(photographicWorkUnits(settings,219)>125_000_000_000);
  assert.equal(validateGpuBudget(settings,219),photographicWorkUnits(settings,219));
  assert.equal(GPU_MAX_WORK_UNITS,Number.MAX_SAFE_INTEGER);
});
test('GPU-007: folder UI, ZIP outputs and cache busting are present',async()=>{
  const html=await readFile(new URL('../experiments/webgpu/photographic.html',import.meta.url),'utf8');
  assert.match(html,/id="folder-images"[^>]*webkitdirectory/);
  assert.match(html,/function runFolderBatch/);
  assert.match(html,/name:'timings.csv'/);
  assert.match(html,/returnAnsi:true,cpuEnabled:false/);
  assert.match(html,/function scheduleMemoryEstimate/);
  assert.match(html,/\?gpu007/);
});

test('streamed Canvas2D strips preserve per-cell sample order across row/column boundaries',async()=>{
  const {makeStreamedSampleProvider}=await import('../src/gpu/streamed_samples.js');
  const old=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {
    constructor(w,h){this.width=w;this.height=h;this.ctx={
      drawImage:(_bitmap,x,y)=>{this.dx=x;this.dy=y;},
      getImageData:()=>{const pixels=new Uint8ClampedArray(this.width*this.height*4);
        for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++){
          const p=(y*this.width+x)*4;
          pixels[p]=(x-this.dx)&255;pixels[p+1]=(y-this.dy)&255;pixels[p+3]=255;
        }return{data:pixels};}
    };}
    getContext(){return this.ctx;}
  };
  try{
    const settings={columns:6,rows:2,sampleW:2,sampleH:2};
    const provider=makeStreamedSampleProvider({width:12,height:4},settings,{yieldEvery:0});
    const data=await provider.getTile(4,5); // [row0,col4..5,row1,col0..2]
    assert.equal(data.length,5*2*2*4);
    for(let cell=0;cell<5;cell++){
      const absolute=4+cell,cx=absolute%6,cy=Math.floor(absolute/6);
      for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++){
        const at=(cell*4+sy*2+sx)*4;
        assert.equal(data[at],cx*2+sx);
        assert.equal(data[at+1],cy*2+sy);
      }
    }
  }finally{globalThis.OffscreenCanvas=old;}
});
