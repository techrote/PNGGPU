import {test} from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkZip,crc32,csvRows} from '../src/gpu/benchmark_zip.js';

test('ZIP32 writer emits valid local headers, UTF-8 paths, CRCs, central directory and EOCD',async()=>{
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const entries=[{name:'README.txt',content:'GPU-006 benchmark\n'},
    {name:'runs/holo-épée.json',content:JSON.stringify({timeMs:12.5,compared:true})},
    {name:'results.csv',content:csvRows([['a','b'],['hello, world','"quoted"']])}];
  const blob=benchmarkZip(entries,new Date('2026-11-01T12:24:36Z'));
  assert.equal(blob.type,'application/zip');
  const bytes=new Uint8Array(await blob.arrayBuffer()),v=new DataView(bytes.buffer);
  const u16=(at)=>v.getUint16(at,true),u32=at=>v.getUint32(at,true);
  assert.equal(u32(0),0x04034b50);
  let off=0;
  for(const entry of entries){
    assert.equal(u32(off),0x04034b50);assert.equal(u16(off+8),0,'STORE method');
    const len=u16(off+26),name=new TextDecoder().decode(bytes.subarray(off+30,off+30+len));
    assert.equal(name,entry.name);
    const n=u32(off+18);const payload=bytes.subarray(off+30+len,off+30+len+n);
    assert.equal(new TextDecoder().decode(payload),entry.content);
    assert.equal(u32(off+14),crc32(payload));
    off+=30+len+n;
  }
  const centralOffset=off;
  for(const entry of entries){
    assert.equal(u32(off),0x02014b50);
    off+=46+u16(off+28);
  }
  assert.equal(u32(off),0x06054b50);
  assert.equal(u16(off+10),entries.length);
  assert.equal(u32(off+16),centralOffset);
  assert.equal(u32(off+12),off-centralOffset);
  assert.equal(off+22,bytes.length);
});

test('ZIP rejects duplicate, unsafe paths, invalid entries',()=>{
  assert.throws(()=>benchmarkZip([]),/entries/);
  assert.throws(()=>benchmarkZip([{name:'../secrets',content:''}]),/Unsafe/);
  assert.throws(()=>benchmarkZip([{name:'x',content:''},{name:'x',content:'duplicate'}]),/duplicate/);
  assert.throws(()=>benchmarkZip([{name:'/absolute',content:''}]),/Unsafe/);
});

test('GPU-007 UI includes power-of-two projection MiB choices, 5-image ZIP + tile sweep, and pipeline depth controls',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../experiments/webgpu/photographic.html',import.meta.url),'utf8');
  for(const n of [4,8,16,32,64,128,256,512,1024])
    assert.ok(html.includes(`<option value="${n}"`),`tile ${n}`);
  for(const id of ['in-flight','suite-zip','zip-scope','gpu-vram','compare-cpu','folder-images','batch-files','batch-run','batch-metrics'])
    assert.ok(html.includes(`id="${id}"`),id);
  assert.match(html,/benchmarkZip\(entries\)/);
  assert.match(html,/runZipBenchmarks/);
  assert.match(html,/preflightZipMemory/);
  assert.match(html,/zipSummaryCsv/);
  assert.match(html,/repeatDetails:runs/);
  assert.match(html,/<option value="24">24/);
  assert.match(html,/function runFolderBatch/);
});
