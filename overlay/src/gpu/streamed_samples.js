/** GPU-007: bounded host-side resampling for enormous ANSI sample lattices.
 * The ordinary full-frame Canvas2D reference path is used whenever practical.
 * Oversize images are reprojected in small canvas strips, maintaining
 * cell-major sample order without allocating a multi-gigabyte raster.
 */
export const FULL_SAMPLE_RASTER_LIMIT_BYTES = 256 * 1024 * 1024;
export const MAX_SAMPLE_CANVAS_SIDE = 16_384;
export const MAX_SAMPLE_STRIP_PIXELS = 8_192;
export const PREVIEW_MAX_PIXELS = 16_777_216;

export function requiresStreamedSamples({columns,rows,sampleW,sampleH}) {
  const width=columns*sampleW,height=rows*sampleH;
  return width>MAX_SAMPLE_CANVAS_SIDE || height>MAX_SAMPLE_CANVAS_SIDE ||
    width*height*4>FULL_SAMPLE_RASTER_LIMIT_BYTES;
}
export function tileSpans(start,count,columns,rows,sampleW,sampleH,maxStripPixels=MAX_SAMPLE_STRIP_PIXELS){
  if(![start,count,columns,rows,sampleW,sampleH,maxStripPixels].every(Number.isSafeInteger) ||
     count<1 || start<0 || columns<1 || rows<1 || sampleW<1 || sampleH<1 ||
     maxStripPixels<sampleW || start+count>columns*rows)
    throw new RangeError('Invalid streamed tile geometry');
  const spans=[],maxCols=Math.max(1,Math.floor(maxStripPixels/sampleW));
  let index=start,remaining=count;
  while(remaining>0){
    const row=Math.floor(index/columns),column=index%columns;
    const cells=Math.min(remaining,columns-column,maxCols);
    spans.push({startCell:index,localCell:index-start,row,column,cells,width:cells*sampleW,height:sampleH});
    index+=cells;remaining-=cells;
  }
  return spans;
}
/** Source must be the original ImageBitmap (not preprocessed) in the neutral
 * photographic workbench. Canvas2D high-quality scaling remains authoritative.
 * At very large dimensions, source-crop rendering is a separate experimental
 * path: edge pixels may differ from an impossible full-size Canvas2D resize.
 */
export function makeStreamedSampleProvider(bitmap,{columns,rows,sampleW,sampleH},{yieldEvery=16}={}){
  const targetW=columns*sampleW,targetH=rows*sampleH;
  const sourceWidth=bitmap.width,sourceHeight=bitmap.height;
  const exactTransform=targetW<=MAX_SAMPLE_CANVAS_SIDE && targetH<=MAX_SAMPLE_CANVAS_SIDE;
  const getTile=async(start,count)=>{
    const spans=tileSpans(start,count,columns,rows,sampleW,sampleH);
    const out=new Uint8ClampedArray(count*sampleW*sampleH*4);
    const cv=new OffscreenCanvas(1,1),ctx=cv.getContext('2d',{willReadFrequently:true});
    if(!ctx)throw new Error('Canvas2D resampling unavailable');
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    for(let i=0;i<spans.length;i++){
      const span=spans[i];cv.width=span.width;cv.height=span.height;
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      if(exactTransform){
        ctx.drawImage(bitmap,-span.column*sampleW,-span.row*sampleH,targetW,targetH);
      }else{
        const sx=span.column*sampleW*sourceWidth/targetW;
        const sy=span.row*sampleH*sourceHeight/targetH;
        const sw=span.width*sourceWidth/targetW;
        const sh=span.height*sourceHeight/targetH;
        ctx.drawImage(bitmap,sx,sy,sw,sh,0,0,span.width,span.height);
      }
      const data=ctx.getImageData(0,0,span.width,span.height).data;
      for(let local=0;local<span.cells;local++){
        for(let sy=0;sy<sampleH;sy++){
          const src=(sy*span.width+local*sampleW)*4;
          const dst=((span.localCell+local)*sampleW*sampleH+sy*sampleW)*4;
          out.set(data.subarray(src,src+sampleW*4),dst);
        }
      }
      if(yieldEvery>0 && i>0 && i%yieldEvery===0)
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    return out;
  };
  return {getTile,exactTransform,sourceWidth,sourceHeight,targetW,targetH};
}
