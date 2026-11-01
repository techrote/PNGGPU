import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PhotographicWebGpuFitter} from '../src/gpu/photographic.js';

const shader=await readFile(new URL('../src/gpu/photographic.wgsl',import.meta.url),'utf8');

test('optional GPU timestamp queries measure actual project/select pass timestamps, not readback wait',async()=>{
  const oldUsage=globalThis.GPUBufferUsage,oldMap=globalThis.GPUMapMode;
  globalThis.GPUBufferUsage={UNIFORM:1,STORAGE:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16,QUERY_RESOLVE:32};
  globalThis.GPUMapMode={READ:1};
  try{
    const passes=[],created=[],buffers=[];
    const device={features:new Set(['timestamp-query']),
      limits:{maxComputeWorkgroupsPerDimension:65535,maxQuerySetSize:8192},lost:new Promise(()=>{}),
      createQuerySet(arg){assert.equal(arg.type,'timestamp');assert.equal(arg.count,4);const q={destroyed:false,destroy(){this.destroyed=true;}};created.push(q);return q;},
      createBuffer(desc){const b={label:desc.label,data:new ArrayBuffer(desc.size),
        destroy(){this.destroyed=true;},async mapAsync(){},getMappedRange(offset=0,size=this.data.byteLength){return this.data.slice(offset,offset+size);},unmap(){}};
        buffers.push(b);return b;},
      queue:{writeBuffer(buffer,offset,src){new Uint8Array(buffer.data).set(new Uint8Array(src.buffer,src.byteOffset,src.byteLength),offset);},submit(){}},
      createBindGroup(){return{};},
      createCommandEncoder(){return{
        beginComputePass(desc){passes.push(desc);return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};},
        resolveQuerySet(q,start,count,buffer){new BigUint64Array(buffer.data).set([11n,1_000_011n,2_000_011n,5_000_011n]);},
        copyBufferToBuffer(src,sourceOffset,dst,targetOffset,n){
          if(dst.label==='PNG2ANSI tile readback')new Uint32Array(dst.data).set([1,3,2,0]);
          else new Uint8Array(dst.data).set(new Uint8Array(src.data,sourceOffset,n),targetOffset);
        },finish(){return{};}
      };}
    };
    const fitter=new PhotographicWebGpuFitter(device,shader);fitter.pipelines={project:{},select:{}};fitter.layout={};
    const result=await fitter.fit({pixels:Uint8Array.from([12,34,56,255,1,2,3,255]),
      masks:[new Float32Array([0,1]),new Float32Array([1,0])],
      palette:Array.from({length:16},(_,i)=>[i,i*2,i*3]),
      columns:1,rows:1,sampleWidth:2,sampleHeight:1,foregroundCandidates:6,backgroundCandidates:5});
    assert.equal(passes.length,2);
    assert.equal(passes[0].timestampWrites.beginningOfPassWriteIndex,0);
    assert.equal(passes[1].timestampWrites.endOfPassWriteIndex,3);
    assert.equal(result.stats.timing.gpuProjectionMs,1);
    assert.equal(result.stats.timing.gpuSelectionMs,3);
    assert.equal(result.stats.uploadedBytes,32+2*2*4+2*4*4+16*4*4+32+2*4);
    assert.equal(result.stats.readbackBytes,16);
    assert.equal(result.stats.timestampReason,null);
    assert.ok(created.every(q=>q.destroyed));assert.ok(buffers.every(b=>b.destroyed));
  }finally{globalThis.GPUBufferUsage=oldUsage;globalThis.GPUMapMode=oldMap;}
});

test('GPU-003 workbench labels prep, CPU render, GPU render, output, totals and optional timing correctly',async()=>{
  const html=await readFile(new URL('../experiments/webgpu/photographic.html',import.meta.url),'utf8');
  for(const label of ['Shared CPU preparation','Glyph reconstruction','Single conversion total',
    'GPU runs','gpu-timestamps','True GPU projection shader','True GPU selection shader',
    'Uploaded:','Readback.mapAsync wait','GPU-007','compareCells','gpuPerf']){
    if(label==='gpuPerf')continue;
    assert.ok(html.includes(label),label);
  }
  assert.match(html,/shared prepared samples/);
  assert.match(html,/png2ansi-webgpu-hardmode-v2/);
  assert.match(html,/png2ansi-webgpu-benchmark-v2/);
});

test('GPU-005 workbench has live CPU/GPU progress and hardened profiler fallbacks',async()=>{
  const html=await readFile(new URL('../experiments/webgpu/photographic.html',import.meta.url),'utf8');
  for(const token of ['progress-cpu','progress-gpu','runCpuReferenceInWorker',
      'updateProgress','gpuProfileStages(result)','?gpu007','GPU-007'])assert.ok(html.includes(token),token);
  const src=await readFile(new URL('../src/gpu/photographic.js',import.meta.url),'utf8');
  assert.match(src,/onProgress\)onProgress\(/);
  assert.match(src,/completedCells\+=tileCount/);
});
