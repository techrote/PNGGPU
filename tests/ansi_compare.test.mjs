import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import '../overlay/experiments/ansi-compare/parser.js';import '../PNG2ANSI/src/core.js';
const api=globalThis.AnsiCompare;
const sgr=s=>Buffer.from(`\x1b[${s}m`),frame=(bytes,codes,columns=bytes.length,rows=1)=>api.decodeAnsi(Uint8Array.from([...sgr('22;37;40'),...bytes,...sgr('0')]),{columns,rows,codes});
test('CP437 table matches pinned original and raw high bytes are one glyph each',()=>{
  assert.equal(api.CP437,PNG2ANSI.CP437);const f=frame([219,233,155],[219,233,155]);assert.deepEqual([...f.glyph],[219,233,155]);assert.equal(api.CP437[233],'Θ');assert.equal(api.CP437[155],'¢');
  assert.throws(()=>frame(Buffer.from('█','utf8'),[219],1),/atlas/);
});
test('actual original ANSI encoder round-trips all 16 foreground and 8 background colors',()=>{
  const codes=[32,219,233,255],chosen=Uint16Array.from({length:128},(_,i)=>i%4),fg=Uint8Array.from({length:128},(_,i)=>i%16),bg=Uint8Array.from({length:128},(_,i)=>Math.floor(i/16));
  const bytes=PNG2ANSI.ansiBytes({codes},{chosen,fg,bg},{}),f=api.decodeAnsi(bytes,{columns:16,rows:8,codes});
  assert.deepEqual([...f.fg],[...fg]);assert.deepEqual([...f.bg],[...bg]);assert.deepEqual([...f.glyph],[...chosen].map(i=>codes[i]));
});
test('decoder rejects cursor/OSC/truecolor controls, truncation, wrong counts and missing closing reset',()=>{
  for(const bytes of [Buffer.from('\x1b[2JA\x1b[0m'),Buffer.from('\x1b]0;title\x07A\x1b[0m'),Buffer.from('\x1b[38;2;1;2;3mA\x1b[0m'),Buffer.from('\x1b[22;37;40'),Buffer.from('AA\x1b[0m'),Buffer.from('\x1b[0mA')])assert.throws(()=>api.decodeAnsi(bytes,{columns:1,rows:1,codes:[65]}));
  assert.throws(()=>frame([65],[65],2),/cell count/);assert.throws(()=>api.decodeAnsi(new Uint8Array(api.LIMITS.maxFrameBytes+1),{columns:1,rows:1,codes:[65]}),/2 MiB/);
});
test('row delimiters are optional but cannot split a row; C1 byte is never executed',()=>{
  const bytes=Buffer.from([...sgr('22;37;40'),65,66,13,10,65,66,...sgr('0')]);assert.equal(api.decodeAnsi(bytes,{columns:2,rows:2,codes:[65,66]}).glyph.length,4);
  assert.throws(()=>api.decodeAnsi(Buffer.from([65,10,66,...sgr('0')]),{columns:2,rows:1,codes:[65,66]}),/line break/);assert.equal(frame([155],[155]).glyph[0],155);
});
test('atlas rendering respects CP437 ordering, raster geometry and original float32 coverage',()=>{
  const v={geometry:{columns:2,rows:1},codes:[32,219],palette:PNG2ANSI.PALETTE,highAtlas:{width:2,height:2,alpha:Buffer.from([0,0,0,0,255,128,0,255]).toString('base64')}};
  const bytes=Uint8Array.from([...sgr('22;31;42'),32,...sgr('1;37;40'),219,...sgr('0')]),f=api.decodeAnsi(bytes,{...v.geometry,codes:v.codes}),r=api.renderRgba(f,api.decodeAtlas(v));
  assert.deepEqual([r.width,r.height],[4,2]);assert.deepEqual([...r.pixels],[19,161,14,255,19,161,14,255,242,242,242,255,127,127,127,255,19,161,14,255,19,161,14,255,12,12,12,255,242,242,242,255]);
  assert.throws(()=>api.decodeAtlas({...v,highAtlas:{...v.highAtlas,alpha:''}}),/byte count/);
});
test('cell comparison includes glyph, foreground and background and preserves cell alignment',()=>{
  const a=frame([65,66],[65,66]),b=frame([65,65],[65,66]);let d=api.compare(a,b);assert.equal(d.changed,1);assert.deepEqual([...d.mask],[0,1]);b.fg[0]=1;d=api.compare(a,b);assert.equal(d.changed,2);
  assert.throws(()=>api.compare(a,{...b,columns:1,rows:2}),/same character grid/);
});
test('saved 80x25 export ANSI decodes to every original packed tuple when local delivery is present',async t=>{
  let plan,bytes,tuples;try{plan=JSON.parse(await readFile('build/exports/agenticparkour-fp32-delivery/settings.json','utf8'));bytes=await readFile('build/exports/agenticparkour-fp32-delivery/80x25-samples4x8-fp32/ansi/frame_0001.ans');tuples=await readFile('build/exports/agenticparkour-fp32-delivery/80x25-samples4x8-fp32/tuples.bin');}catch(e){if(e.code==='ENOENT'){t.skip('Local full export is not part of Git');return;}throw e;}
  const v=plan.variants.find(v=>v.key==='80x25-samples4x8-fp32'),f=api.decodeAnsi(bytes,{...v.geometry,codes:v.codes});for(let i=0;i<2000;i++){assert.equal(f.glyph[i],v.codes[tuples.readUInt16LE(i*4)]);assert.equal(f.fg[i],tuples[i*4+2]);assert.equal(f.bg[i],tuples[i*4+3]);}
  const rgba=api.renderRgba(f,api.decodeAtlas(v)),rgb=Buffer.alloc(rgba.width*rgba.height*3);for(let i=0;i<rgba.pixels.length/4;i++){rgb[i*3]=rgba.pixels[i*4];rgb[i*3+1]=rgba.pixels[i*4+1];rgb[i*3+2]=rgba.pixels[i*4+2];}
  const rendered=JSON.parse(await readFile('build/exports/agenticparkour-fp32-delivery/80x25-samples4x8-fp32/render.json','utf8'));
  assert.equal(createHash('sha256').update(rgb).digest('hex'),rendered.previews.find(p=>p.file==='preview_0001.png').rgbSha256);
});
