import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PhotographicWebGpuFitter} from '../src/gpu/photographic.js';
import {estimateGpuMemory} from '../src/gpu/memory.js';

const input=()=>{
  const pixels=new Uint8Array(6*4);
  for(let i=0;i<6;i++)pixels.set([i+1,50,80,255],i*4);
  return {pixels,masks:[new Float32Array([0]),new Float32Array([1])],
    palette:Array.from({length:16},(_,i)=>[i,i,i]),columns:6,rows:1,
    sampleWidth:1,sampleHeight:1,foregroundCandidates:3,backgroundCandidates:2,
    preferredTileCells:2,captureGpuTimestamps:false,inFlightTiles:2};
};

function mockDevice({deferred=false}={}){
  const buffers=[],submissions=[],maps=[];
  const device={limits:{maxComputeWorkgroupsPerDimension:64,maxStorageBufferBindingSize:1024*1024,maxBufferSize:1024*1024},
    features:new Set(),lost:new Promise(()=>{}),
    createBuffer(desc){
      const b={...desc,data:new ArrayBuffer(desc.size),destroyed:false,
        destroy(){this.destroyed=true;},
        mapAsync(){return deferred?new Promise(resolve=>maps.push({buffer:this,resolve})):Promise.resolve();},
        getMappedRange(offset=0,len=this.data.byteLength){return this.data.slice(offset,offset+len);},unmap(){}};
      buffers.push(b);return b;
    },
    queue:{writeBuffer(buffer,offset,bytes){new Uint8Array(buffer.data).set(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength),offset);},
      submit(items){submissions.push(items);}},
    createBindGroup(){return{};},
    createCommandEncoder(){return{
      beginComputePass(){return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};},
      copyBufferToBuffer(src,sourceOffset,dst,targetOffset,size){
        if(!dst.label.startsWith('PNG2ANSI tile readback'))return;
        const slot=dst.label.match(/\[slot \d+\]/)?.[0]??'';
        const raster=buffers.find(b=>b.label==='PNG2ANSI packed tile RGB8'+(slot?' '+slot:''));
        const words=new Uint32Array(raster.data),result=new Uint32Array(dst.data);
        for(let i=0;i<size/16;i++){
          result[i*4]=words[i]&255;result[i*4+1]=1;result[i*4+2]=2;
        }
      },finish(){return{};}
    };}
  };
  return {device,buffers,submissions,maps};
}

test('multiple independent GPU slots are submitted before first readback and stitched correctly out of order',async()=>{
  const oldUsage=globalThis.GPUBufferUsage,oldMap=globalThis.GPUMapMode;
  globalThis.GPUBufferUsage={UNIFORM:1,STORAGE:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16};
  globalThis.GPUMapMode={READ:1};
  try{
    const env=mockDevice({deferred:true});const fitter=new PhotographicWebGpuFitter(env.device,'');
    fitter.pipelines={project:{},select:{}};fitter.layout={};
    const events=[];const running=fitter.fit({...input(),onProgress:x=>events.push(x)});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(env.submissions.length,2,'two GPU tiles submitted before first map completes');
    assert.equal(env.maps.length,2);
    assert.notEqual(env.maps[0].buffer,env.maps[1].buffer,'unique mapping buffers per in-flight slot');
    assert.equal(events.length,0,'no progress until GPU readback');
    env.maps[1].resolve();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(env.submissions.length,3,'a finished slot admits a third tile');
    assert.equal(env.maps.length,3);
    env.maps[2].resolve();env.maps[0].resolve();
    const out=await running;
    assert.deepEqual([...out.chosen],[1,2,3,4,5,6]);
    assert.deepEqual([...out.fg],Array(6).fill(1));
    assert.deepEqual([...out.bg],Array(6).fill(2));
    assert.equal(out.stats.inFlightTiles,2);
    assert.equal(out.stats.peakInFlightTiles,2);
    assert.deepEqual(events.map(e=>e.completedCells),[2,4,6]);
    assert.deepEqual(out.stats.tileMeasurements.map(m=>m.index),[1,2,3]);
    assert.ok(env.buffers.every(b=>b.destroyed));
  }finally{globalThis.GPUBufferUsage=oldUsage;globalThis.GPUMapMode=oldMap;}
});

test('VRAM admission counts each concurrent tile buffer set, not just one tile',()=>{
  const device={limits:{maxComputeWorkgroupsPerDimension:65535,maxStorageBufferBindingSize:128*1024*1024,maxBufferSize:256*1024*1024}};
  const props={columns:512,rows:512,sampleWidth:16,sampleHeight:32,glyphCount:219,preferredTileCells:32768};
  const a=PhotographicWebGpuFitter.tilePlan(device,{...props,inFlightTiles:1});
  const b=PhotographicWebGpuFitter.tilePlan(device,{...props,inFlightTiles:3});
  const common={columns:512,rows:512,sampleWidth:16,sampleHeight:32,glyphCount:219,
    sourceWidth:2048,sourceHeight:2048,captureGpuTimestamps:false};
  const x=estimateGpuMemory({...common,plan:a}),y=estimateGpuMemory({...common,plan:b});
  const slot=a.rasterBufferBytes+a.projectionBufferBytes+a.tileCells*32+32;
  assert.equal(b.inFlightTiles,3);
  assert.equal(y.gpuBufferBytes-x.gpuBufferBytes,slot*2);
  assert.ok(y.estimatedWorkingSetBytes>x.estimatedWorkingSetBytes);
});
