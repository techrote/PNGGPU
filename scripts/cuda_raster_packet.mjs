/** Compact RGBA row bands for direct-only native packing. Header fields are
 * command,count,columns,rows,firstCell. Copies row slices without pixel conversion.
 */
export function packRasterTileRgba(data,start,count) {
  const {pixels,columns,rows,sampleWidth:sw,sampleHeight:sh}=data;
  const integer=(x,max)=>Number.isSafeInteger(x)&&x>=1&&x<=max;
  if(!integer(columns,1024)||!integer(rows,1024)||!integer(sw,32)||!integer(sh,64)||!integer(count,65536)||
    !Number.isSafeInteger(start)||start<0||start+count>columns*rows||!(pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray))throw new Error('Invalid raster tile geometry');
  const widthBytes=columns*sw*4,height=rows*sh,stride=data.sourceStrideBytes??widthBytes;
  const required=(height-1)*stride+widthBytes,bytes=count*sw*sh*4;
  if(!Number.isSafeInteger(stride)||stride<widthBytes||!Number.isSafeInteger(required)||required>pixels.byteLength||bytes>64*1024*1024)throw new Error('Invalid raster stride/length or pixel bound');
  const out=new Uint8Array(20+bytes),view=new DataView(out.buffer);
  [3,count,columns,rows,start].forEach((v,i)=>view.setUint32(i*4,v,true));
  let consumed=0,dest=20;
  while(consumed<count){
    const cell=start+consumed,col=cell%columns,row=Math.floor(cell/columns),span=Math.min(count-consumed,columns-col),length=span*sw*4;
    for(let sy=0;sy<sh;sy++){
      const src=(row*sh+sy)*stride+col*sw*4;out.set(pixels.subarray(src,src+length),dest);dest+=length;
    }
    consumed+=span;
  }
  return out;
}
