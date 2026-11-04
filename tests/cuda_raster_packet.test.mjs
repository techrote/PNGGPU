import test from 'node:test';import assert from 'node:assert/strict';
import {packRasterTileRgba} from '../scripts/cuda_raster_packet.mjs';
import {validateRasterTilePacket} from '../scripts/cuda_worker_session.mjs';
import {packTileRgba} from '../overlay/src/gpu/cuda.js';
function unpack(packet,sw,sh){
  const v=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),count=v.getUint32(4,true),cols=v.getUint32(8,true),start=v.getUint32(16,true),out=new Uint8Array(8+count*sw*sh*4),d=new DataView(out.buffer);
  d.setUint32(0,2,true);d.setUint32(4,count,true);
  // Independent destination-first mapping into the compact source bands.
  for(let local=0;local<count;local++){
    const cell=start+local,row=Math.floor(cell/cols),col=cell%cols,firstRow=Math.floor(start/cols),bandStart=Math.max(start,row*cols),bandEnd=Math.min(start+count,(row+1)*cols);
    const priorCells=bandStart-start,bandWidth=bandEnd-bandStart;
    for(let sy=0;sy<sh;sy++)for(let sx=0;sx<sw;sx++){
      const src=20+(priorCells*sw*sh+(sy*bandWidth+cell-bandStart)*sw+sx)*4,dest=8+((local*sh+sy)*sw+sx)*4;
      out.set(packet.subarray(src,src+3),dest);
    }
  }return out;
}
test('compact row bands retain canonical RGBX for partial rows, offsets and sample shapes',()=>{
  for(const [cols,rows,sw,sh] of [[1,1,1,1],[7,3,4,8],[5,4,2,3],[320,90,4,8]]){
    const data={columns:cols,rows,sampleWidth:sw,sampleHeight:sh,pixels:Uint8Array.from({length:cols*rows*sw*sh*4},(_,i)=>(i*37+19)%256)};
    for(const [start,count] of [[0,1],[0,Math.min(cols*rows,11)],[Math.max(0,cols-2),Math.min(cols*rows-Math.max(0,cols-2),9)],[cols*rows-1,1]]){
      const p=packRasterTileRgba(data,start,count);assert.equal(p.byteLength,20+count*sw*sh*4);
      assert.equal(validateRasterTilePacket(Buffer.from(p),{samples:sw*sh,maxTileCells:count}),count);
      assert.deepEqual(unpack(p,sw,sh),packTileRgba(data,start,count));
    }
  }
});
test('padded strides and nonzero backing offsets preserve the same samples',()=>{
  const base={columns:3,rows:2,sampleWidth:2,sampleHeight:2,pixels:Uint8Array.from({length:96},(_,i)=>i)},stride=32;
  const backing=new Uint8Array(7+4*stride),pixels=backing.subarray(7);
  for(let y=0;y<4;y++)pixels.set(base.pixels.subarray(y*24,y*24+24),y*stride);
  assert.deepEqual(packRasterTileRgba({...base,pixels,sourceStrideBytes:stride},1,4),packRasterTileRgba(base,1,4));
});
test('raster packet checks reject malformed lengths, extents and oversized dimensions',()=>{
  const d={columns:2,rows:2,sampleWidth:1,sampleHeight:1,pixels:new Uint8Array(16)};
  for(const patch of [{columns:0},{rows:1025},{sourceStrideBytes:1},{pixels:new Uint8Array(1)}])assert.throws(()=>packRasterTileRgba({...d,...patch},0,1));
  for(const [start,count] of [[-1,1],[0,0],[3,2],[0,65537]])assert.throws(()=>packRasterTileRgba(d,start,count));
  const p=Buffer.from(packRasterTileRgba(d,0,4));
  for(const [at,value] of [[0,2],[4,0],[8,0],[12,1025],[16,3]]){const bad=Buffer.from(p);bad.writeUInt32LE(value,at);assert.throws(()=>validateRasterTilePacket(bad,{samples:1,maxTileCells:4}));}
  assert.throws(()=>validateRasterTilePacket(p.subarray(0,-1),{samples:1,maxTileCells:4}));
});
