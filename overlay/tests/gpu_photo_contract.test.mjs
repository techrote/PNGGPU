import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PhotographicWebGpuFitter } from "../src/gpu/photographic.js";

const shader = await readFile(new URL("../src/gpu/photographic.wgsl", import.meta.url), "utf8");
const sample = {
  pixels: new Uint8Array([12,34,56,255, 1,2,3,255]),
  masks: [new Float32Array([0,1]),new Float32Array([1,0])],
  palette: Array.from({length:16},(_,i)=>[i,i*2,i*3]),
  columns:1, rows:1, sampleWidth:2, sampleHeight:1,
  foregroundCandidates:6, backgroundCandidates:5
};

test("shader implements two-pass projection + real palette selection",()=>{
  assert.match(shader,/@compute @workgroup_size\(64\)\s*fn project_glyphs/);
  assert.match(shader,/@compute @workgroup_size\(64\)\s*fn select_cells/);
  assert.match(shader,/array<u32, 32>/);
  assert.match(shader,/for \(var color = 0u; color < 16u;/);
  assert.match(shader,/for \(var color = 0u; color < 8u;/);
  assert.match(shader,/results\[cell\] = chosen/);
  assert.match(shader,/settings\.counts\.w/);
  assert.match(shader,/return cell \* \(settings\.geometry\.z \* settings\.geometry\.w\) \+ sample/);
});

test("WebGPU absence reported without touching global navigator",()=>{
  assert.equal(PhotographicWebGpuFitter.available(null), false);
  assert.equal(PhotographicWebGpuFitter.available({requestAdapter:()=>{}}), true);
});

test("invalid inputs fail before allocating GPU resources",async()=>{
  const device={limits:{maxComputeWorkgroupsPerDimension:65535},lost:new Promise(()=>{}),createBuffer:()=>{throw new Error("Unexpected GPU allocation")}};
  const fitter=new PhotographicWebGpuFitter(device,shader);fitter.pipelines={project:{},select:{}};
  await assert.rejects(fitter.fit({...sample,foregroundCandidates:13}),/candidate counts/);
  await assert.rejects(fitter.fit({...sample,masks:[new Float32Array([0])]}),/geometry mismatch/);
  await assert.rejects(fitter.fit({...sample,pixels:new Uint8Array(5)}),/geometry mismatch/);
  await assert.rejects(fitter.fit({...sample,columns:0}),/positive integer/);
  await assert.rejects(fitter.fit({...sample,sampleWidth:65535,columns:65535}),/geometry mismatch|dispatch limit/);
});

test("host-side packing, two dispatches, and result decoding obey ABI",async()=>{
  const oldUsage=globalThis.GPUBufferUsage,oldMap=globalThis.GPUMapMode;
  globalThis.GPUBufferUsage={UNIFORM:1,STORAGE:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16};
  globalThis.GPUMapMode={READ:1};
  try{
    const recorded=[],buffers=[];
    const device={
      limits:{maxComputeWorkgroupsPerDimension:65535},lost:new Promise(()=>{}),
      createBuffer(desc){
        const item={label:desc.label,data:new ArrayBuffer(desc.size),destroyed:false,
          destroy(){this.destroyed=true;},async mapAsync(){},getMappedRange(offset=0,size=this.data.byteLength){return this.data.slice(offset,offset+size);},unmap(){}};
        buffers.push(item);return item;
      },
      queue:{writeBuffer(buffer,offset,source){new Uint8Array(buffer.data).set(new Uint8Array(source.buffer,source.byteOffset,source.byteLength),offset);},submit(){recorded.push("submitted");}},
      createBindGroup({entries}){assert.equal(entries.length,7);return {};},
      createCommandEncoder(){return{
        beginComputePass(){return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(n){recorded.push(n);},end(){}};},
        copyBufferToBuffer(){const buf=buffers.find(x=>x.label==="PNG2ANSI tile readback");new Uint32Array(buf.data).set([1,3,2,0]);},finish(){return{};}
      };}
    };
    const fitter=new PhotographicWebGpuFitter(device,shader);fitter.pipelines={project:{},select:{}};fitter.layout={};
    const selection=await fitter.fit(sample);
    assert.deepEqual(Array.from(selection.chosen),[1]);assert.deepEqual(Array.from(selection.fg),[3]);assert.deepEqual(Array.from(selection.bg),[2]);
    assert.deepEqual(recorded,[1,1,"submitted"]);
    assert.equal(new Uint32Array(buffers.find(x=>x.label==="PNG2ANSI packed tile RGB8").data)[0],0x38220c);
    assert.equal(new Uint32Array(buffers.find(x=>x.label==="PNG2ANSI packed tile RGB8").data)[1],0x030201);
    assert.ok(buffers.every(b=>b.destroyed));
  }finally{globalThis.GPUBufferUsage=oldUsage;globalThis.GPUMapMode=oldMap;}
});


test("tiled host dispatch packs cells in reference order and stitches output without gaps", async () => {
  const oldUsage = globalThis.GPUBufferUsage, oldMap = globalThis.GPUMapMode;
  globalThis.GPUBufferUsage = {UNIFORM:1,STORAGE:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16};
  globalThis.GPUMapMode = {READ:1};
  try {
    const buffers=[], dispatch=[], copies=[];
    const cellCount=10, columns=5, sampleWidth=2;
    const pixels=new Uint8Array(cellCount*sampleWidth*4);
    for(let cell=0;cell<cellCount;cell++) {
      const x=cell%columns,y=Math.floor(cell/columns);
      for(let sx=0;sx<sampleWidth;sx++) {
        const at=(y*(columns*sampleWidth)+x*sampleWidth+sx)*4;
        pixels.set([cell+1,20+sx,30,255],at);
      }
    }
    const device={
      limits:{maxComputeWorkgroupsPerDimension:100,maxStorageBufferBindingSize:1024,maxBufferSize:2048},
      lost:new Promise(()=>{}),
      createBuffer(desc) {
        const buf={label:desc.label,data:new ArrayBuffer(desc.size),destroyed:false,
          destroy(){this.destroyed=true;},async mapAsync(){},
          getMappedRange(offset=0,size=this.data.byteLength){return this.data.slice(offset,offset+size);},unmap(){}};
        buffers.push(buf);return buf;
      },
      queue:{writeBuffer(buffer,offset,source){new Uint8Array(buffer.data).set(new Uint8Array(source.buffer,source.byteOffset,source.byteLength),offset);},submit(){dispatch.push('submit');}},
      createBindGroup(){return{};},
      createCommandEncoder(){return{
        beginComputePass(){return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(n){dispatch.push(n);},end(){}};},
        copyBufferToBuffer(from,_,to,__,n){
          const tileCount=new Uint32Array(buffers.find(x=>x.label==='PNG2ANSI settings').data)[7];
          const packed=new Uint32Array(buffers.find(x=>x.label==='PNG2ANSI packed tile RGB8').data);
          const out=new Uint32Array(to.data);
          for(let i=0;i<tileCount;i++){
            out[4*i] = packed[i*sampleWidth]&255;
            out[4*i+1]=3;out[4*i+2]=2;out[4*i+3]=0;
          }
          copies.push(n);
        },finish(){return{};}
      };}
    };
    const fitter=new PhotographicWebGpuFitter(device,shader);fitter.pipelines={project:{},select:{}};fitter.layout={};
    const events=[];
    const result=await fitter.fit({...sample,pixels,columns,rows:2,sampleWidth,sampleHeight:1,preferredTileCells:3,
      onProgress:event=>events.push(event)});
    assert.equal(result.stats.tileCells,3);assert.equal(result.stats.tileCount,4);
    assert.deepEqual([...result.chosen],[1,2,3,4,5,6,7,8,9,10]);
    assert.deepEqual([...result.fg],Array(10).fill(3));
    assert.deepEqual([...result.bg],Array(10).fill(2));
    assert.deepEqual(dispatch,[1,1,'submit',1,1,'submit',1,1,'submit',1,1,'submit']);
    assert.deepEqual(copies,[48,48,48,16]);
    assert.deepEqual(events.map(e=>e.completedCells),[3,6,9,10]);
    assert.deepEqual(events.map(e=>e.completedTiles),[1,2,3,4]);
    assert.ok(events.every(e=>e.totalCells===10&&e.totalTiles===4));
    assert.ok(buffers.every(b=>b.destroyed));
  } finally { globalThis.GPUBufferUsage=oldUsage;globalThis.GPUMapMode=oldMap; }
});

test('tile plan respects per-device workgroup and storage-buffer maxima', () => {
  const data={columns:512,rows:512,sampleWidth:16,sampleHeight:32,glyphCount:219};
  const device={limits:{maxComputeWorkgroupsPerDimension:65535,maxStorageBufferBindingSize:128*1024*1024,maxBufferSize:256*1024*1024}};
  const plan=PhotographicWebGpuFitter.tilePlan(device,data);
  assert.ok(plan.tileCells<=16_384);
  assert.ok(Math.ceil(plan.tileCells*219/64)<=65_535);
  assert.ok(plan.projectionBufferBytes<=device.limits.maxStorageBufferBindingSize);
  assert.ok(plan.rasterBufferBytes<=device.limits.maxStorageBufferBindingSize);
  assert.equal(plan.tileCount,Math.ceil(512*512/plan.tileCells));
  const small=PhotographicWebGpuFitter.tilePlan({limits:{maxComputeWorkgroupsPerDimension:200,maxStorageBufferBindingSize:4096,maxBufferSize:8192}},
    {columns:160,rows:80,sampleWidth:8,sampleHeight:32,glyphCount:2});
  assert.ok(small.tileCells<=4); // 4096 bytes / (256 samples × 4 bytes)
  assert.throws(()=>PhotographicWebGpuFitter.tilePlan({limits:{maxComputeWorkgroupsPerDimension:1,maxStorageBufferBindingSize:1024,maxBufferSize:2048}},
    {...data,preferredTileCells:500}),/No valid GPU tile|Glyph atlas exceeds/);
});
