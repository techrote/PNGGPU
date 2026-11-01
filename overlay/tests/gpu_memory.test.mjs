import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PhotographicWebGpuFitter} from '../src/gpu/photographic.js';
import {GiB,MiB,estimateGpuMemory,evaluateVramBudget,validateDeclaredVramGiB,vramDecisionMessage} from '../src/gpu/memory.js';

const normal={columns:320,rows:160,sampleWidth:16,sampleHeight:16,glyphCount:219};
const limits={maxComputeWorkgroupsPerDimension:65535,maxStorageBufferBindingSize:128*MiB,maxBufferSize:256*MiB};
const plan=PhotographicWebGpuFitter.tilePlan({limits},{...normal,preferredTileCells:262_144});
const createEstimate=(p=plan,timestamps=false)=>estimateGpuMemory({plan:p,...normal,sourceWidth:2048,sourceHeight:2048,
  captureGpuTimestamps:timestamps,timestampsAvailable:timestamps});

test('workbench requires user-declared VRAM, never infers physical capacity from GPU limits',()=>{
  for(const invalid of ['',null,undefined,0,'abc',129,2.25])assert.throws(()=>validateDeclaredVramGiB(invalid),/VRAM/);
  for(const gib of [1,2,4,6,8,16,24,128,3.5])assert.equal(validateDeclaredVramGiB(String(gib)),gib);
});

test('requested 262144 tile target is preserved; actual tile is bounded by storage/dispatch limits',()=>{
  assert.equal(plan.requestedTileCells,262_144);
  assert.ok(plan.tileCells<=normal.columns*normal.rows);
  assert.ok(plan.tileCells<262_144);
  assert.ok(plan.tileCells>19_151,'2D dispatch should beat former 1D 19151 cell limit');
  assert.ok(plan.projectWorkgroupsX<=65_535&&plan.projectWorkgroupsY<=65_535);
  assert.ok(plan.projectWorkgroupsY>1,'projection must actually use two dimensions for this case');
  assert.ok(plan.projectionBufferBytes<=128*MiB);
  assert.ok(plan.rasterBufferBytes<=128*MiB);
  assert.ok(plan.tileCount>=1);
});

test('VRAM estimate matches actual GPU buffer categories and reuses buffers across tiles',()=>{
  const full=createEstimate();
  assert.equal(full.components.uniforms,32);
  assert.equal(full.components.projection,plan.tileCells*normal.glyphCount*16);
  assert.equal(full.components.tileRaster,plan.tileCells*normal.sampleWidth*normal.sampleHeight*4);
  assert.equal(full.components.tileSelections,plan.tileCells*16);
  assert.equal(full.components.tileReadback,plan.tileCells*16);
  assert.equal(full.components.glyphMasks,normal.glyphCount*normal.sampleWidth*normal.sampleHeight*4);
  assert.equal(full.gpuBufferBytes,Object.values(full.components).reduce((a,b)=>a+b,0));
  assert.equal(full.estimatedWorkingSetBytes,full.gpuBufferBytes+full.browserBackingEstimateBytes+full.uncertaintyAllowanceBytes);
  const moreTiles=createEstimate({...plan,tileCount:100});
  assert.equal(full.gpuBufferBytes,moreTiles.gpuBufferBytes);
  const queried=createEstimate(plan,true);
  assert.ok(queried.gpuBufferBytes>full.gpuBufferBytes);
  assert.equal(queried.components.timestampResolve,plan.tileCount*4*8);
});

test('warning and block thresholds are exactly manual VRAM minus 4 and 2 GiB',()=>{
  const e=(n)=>({estimatedWorkingSetBytes:n});
  assert.equal(evaluateVramBudget(e(1),4).status,'warning','4 GiB device warns on every positive workload');
  assert.equal(evaluateVramBudget(e(2*GiB),4).status,'warning','at 2GiB limit, do not block');
  assert.equal(evaluateVramBudget(e(2*GiB+1),4).status,'blocked');
  assert.equal(evaluateVramBudget(e(20*GiB),24).status,'safe');
  assert.equal(evaluateVramBudget(e(20*GiB+1),24).status,'warning');
  assert.equal(evaluateVramBudget(e(22*GiB),24).status,'warning');
  assert.equal(evaluateVramBudget(e(22*GiB+1),24).status,'blocked');
  assert.equal(evaluateVramBudget(e(1),1).status,'blocked');
  assert.match(vramDecisionMessage(evaluateVramBudget(e(23*GiB),24)),/BLOCKED.*Override is not available/);
});

test('GPU-007 workbench preflights memory before CPU fitting, warns with confirmation, and defaults CPU comparison off',async()=>{
  const html=await readFile(new URL('../experiments/webgpu/photographic.html',import.meta.url),'utf8');
  assert.match(html,/id="gpu-vram"/);
  assert.match(html,/id="estimate-memory"/);
  assert.match(html,/<select id="tileMiB"/);
  assert.match(html,/<option value="1024">1024 MiB/);
  assert.match(html,/<input id="compare-cpu" type="checkbox">/);
  assert.ok(html.indexOf('memoryGate(estimate,budget,plan,approvalScope)')<html.indexOf('const cpuResult=await runCpuReferenceInWorker'));
  assert.match(html,/globalThis\.confirm/);
  assert.match(html,/if\(budget\.status==='blocked'\)throw/);
  assert.match(html,/getItem\('png2ansi-gpu-vram-gib'\)/);
});

test('2-D linear projection indices cover every cell/glyph exactly once across X and Y rows',async()=>{
  const example=PhotographicWebGpuFitter.tilePlan({limits:{maxComputeWorkgroupsPerDimension:2,
    maxStorageBufferBindingSize:2*MiB,maxBufferSize:2*MiB}},
    {columns:128,rows:1,sampleWidth:1,sampleHeight:1,glyphCount:2,preferredTileCells:262144});
  assert.equal(example.tileCells,128);
  assert.equal(example.projectWorkgroupsX,2);
  assert.equal(example.projectWorkgroupsY,2);
  const total=example.tileCells*2,visited=new Uint8Array(total);
  for(let y=0;y<example.projectWorkgroupsY;y++)for(let x=0;x<example.projectWorkgroupsX*64;x++){
    const linear=x+y*(example.projectWorkgroupsX*64);
    if(linear<total)visited[linear]++;
  }
  assert.ok(visited.every(n=>n===1));
  const shader=await readFile(new URL('../src/gpu/photographic.wgsl',import.meta.url),'utf8');
  assert.match(shader,/let linear = id\.x \+ id\.y \* \(settings\.geometry\.x \* 64u\);/);
  const host=await readFile(new URL('../src/gpu/photographic.js',import.meta.url),'utf8');
  assert.match(host,/pass\.dispatchWorkgroups\(dispatchX,dispatchY\)/);
  assert.match(host,/tileMeasurements\[tileIndex\]=tileStats/);
  assert.match(host,/completedCells\+=tileCount/);
});

test('runtime 2-D dispatch packs >1-D-limit tile and decodes without reordering',async()=>{
  const oldUsage=globalThis.GPUBufferUsage,oldMap=globalThis.GPUMapMode;
  globalThis.GPUBufferUsage={UNIFORM:1,STORAGE:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16};
  globalThis.GPUMapMode={READ:1};
  try{
    const buffers=[],dispatches=[],uploads=[];
    const source=new Uint8Array(128*4);
    for(let i=0;i<128;i++)source.set([i,9,3,255],i*4);
    const device={limits:{maxComputeWorkgroupsPerDimension:2,maxStorageBufferBindingSize:2*MiB,maxBufferSize:2*MiB},lost:new Promise(()=>{}),
      createBuffer(desc){const b={label:desc.label,size:desc.size,data:new ArrayBuffer(desc.size),destroy(){this.destroyed=true;},
        async mapAsync(){},getMappedRange(start=0,size=this.data.byteLength){return this.data.slice(start,start+size);},unmap(){}};
        buffers.push(b);return b;},
      queue:{writeBuffer(buffer,offset,src){new Uint8Array(buffer.data).set(new Uint8Array(src.buffer,src.byteOffset,src.byteLength),offset);uploads.push(buffer.label);},submit(){}},
      createBindGroup(){return{};},createCommandEncoder(){return{
        beginComputePass(){return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(...dim){dispatches.push(dim);},end(){}};},
        copyBufferToBuffer(src,so,dst,doff,size){
          if(dst.label==='PNG2ANSI tile readback'){
            const settings=new Uint32Array(buffers.find(b=>b.label==='PNG2ANSI settings').data);
            assert.equal(settings[0],2,'2-D row stride encoded in geometry.x');
            const packed=new Uint32Array(buffers.find(b=>b.label==='PNG2ANSI packed tile RGB8').data);
            const output=new Uint32Array(dst.data);
            for(let i=0;i<128;i++){output[i*4]=packed[i]&255;output[i*4+1]=1;output[i*4+2]=0;}
          }
        },finish(){return{};}};}};
    const shader=await readFile(new URL('../src/gpu/photographic.wgsl',import.meta.url),'utf8');
    const fitter=new PhotographicWebGpuFitter(device,shader);fitter.pipelines={project:{},select:{}};fitter.layout={};
    const result=await fitter.fit({pixels:source,masks:[new Float32Array([0]),new Float32Array([1])],
      palette:Array.from({length:16},(_,i)=>[i,i,i]),columns:128,rows:1,sampleWidth:1,sampleHeight:1,
      foregroundCandidates:2,backgroundCandidates:2,preferredTileCells:262144});
    assert.deepEqual(dispatches,[[2,2],[2]]);
    assert.deepEqual([...result.chosen],Array.from({length:128},(_,i)=>i));
    assert.equal(result.stats.tileCells,128);
    assert.equal(result.stats.tileMeasurements.length,1);
    assert.ok(result.stats.tileMeasurements[0].wallMs>=0);
    assert.ok(buffers.every(b=>b.destroyed));
  }finally{globalThis.GPUBufferUsage=oldUsage;globalThis.GPUMapMode=oldMap;}
});
