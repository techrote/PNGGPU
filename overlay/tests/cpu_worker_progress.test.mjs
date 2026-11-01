import {test} from 'node:test';
import assert from 'node:assert/strict';
import {referencePhotoFit} from '../src/gpu/reference_photo.js';
import {runCpuReferenceInWorker} from '../src/gpu/cpu_worker_host.js';

test('reference worker posts a real progress event and returns the exact CPU glyph selection',async()=>{
  const before=globalThis.self;
  const messages=[];
  globalThis.self={postMessage:(message)=>messages.push(message)};
  try{
    await import('../src/gpu/reference_photo.worker.js?node-probe');
    const config={canvas:{columns:2,rows:1,sample_width:2,sample_height:1},fit:{foreground_candidates:3,background_candidates:3}};
    const pixels=Uint8Array.from([5,10,15,255, 30,35,40,255, 80,100,120,255, 200,210,220,255]);
    const masks=[new Float32Array([0,1]),new Float32Array([1,0])];
    const palette=Array.from({length:16},(_,i)=>[i*7,i*11,i*13]);
    const configData={type:'fit',pixels,masks,config,palette};
    globalThis.self.onmessage({data:configData});
    assert.equal(messages[0].type,'progress');
    assert.equal(messages[0].completedCells,0);
    const done=messages.at(-1);
    assert.equal(done.type,'done');
    assert.equal(done.completedCells,2);
    assert.ok(done.computeMs>=0);
    const expected=referencePhotoFit({pixels,masks,config,palette});
    for(const key of ['chosen','fg','bg'])assert.deepEqual([...done.cells[key]],[...expected[key]]);
  }finally{
    if(before===undefined)delete globalThis.self;else globalThis.self=before;
  }
});
test('CPU worker host relays progress and transfers results without modifying input buffers',async()=>{
  let destroyed=0;
  class FakeWorker{
    constructor(url,options){assert.equal(options.type,'module');}
    terminate(){destroyed++;}
    postMessage(data){
      assert.equal(data.type,'fit');
      assert.equal(data.pixels.byteLength,8);
      queueMicrotask(()=>{
        this.onmessage({data:{type:'progress',completedCells:1,totalCells:2,elapsedMs:5}});
        this.onmessage({data:{type:'done',cells:{chosen:Uint16Array.of(1,0),fg:Uint8Array.of(2,3),bg:Uint8Array.of(0,0)},computeMs:7,totalCells:2}});
      });
    }
  }
  const events=[];
  const pixels=new Uint8Array(8);
  const result=await runCpuReferenceInWorker({pixels,masks:[],config:{},palette:[],WorkerClass:FakeWorker,onProgress:e=>events.push(e.completedCells)});
  assert.deepEqual(events,[1,2]);
  assert.deepEqual([...result.cells.chosen],[1,0]);
  assert.equal(result.computeMs,7);
  assert.ok(result.wallMs>=0);
  assert.equal(pixels.byteLength,8);
  assert.equal(destroyed,1);
});
