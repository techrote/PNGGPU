/** Offline delivery scope; does not alter qualification/benchmark admission. */
export const EXPORT_SIZES=[[8,4],[16,8],[32,16],[40,12],[80,24],[80,25],[80,40],[120,34],[160,45],[160,80],[320,90],[320,160]];
export function exportGeometry(columns,rows,sw,sh,count){
  if(!EXPORT_SIZES.some(([c,r])=>c===columns&&r===rows)||![[4,8],[8,16]].some(([w,h])=>w===sw&&h===sh)||
    !Number.isSafeInteger(count)||count<1||count>720)throw Error('Export scope exceeds explicit geometry/sample/frame limits');
  return {columns,rows,sampleWidth:sw,sampleHeight:sh,count,frameBytes:columns*rows*sw*sh*4};
}
export function exportCrop(width,height,columns,rows){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>4096||height>4096)throw Error('Invalid source dimensions');
  if(columns===rows*2)return {mode:'contain-black',crop:null}; // Preserve earlier square/letterboxed exports.
  const gcd=(a,b)=>b?gcd(b,a%b):a,d=gcd(columns,rows*2),w=columns/d,h=rows*2/d,k=Math.floor(Math.min(width/w,height/h));
  if(k<1)throw Error('Source too small for integral aspect crop');
  return {mode:'center-crop',crop:{x:Math.floor((width-w*k)/2),y:Math.floor((height-h*k)/2),width:w*k,height:h*k}};
}
export function exportFilter(geometry,layout){
  const w=geometry.columns*geometry.sampleWidth,h=geometry.rows*geometry.sampleHeight;
  return layout.mode==='contain-black'?`scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgba`:
    `crop=${layout.crop.width}:${layout.crop.height}:${layout.crop.x}:${layout.crop.y},scale=${w}:${h}:flags=lanczos,format=rgba`;
}
