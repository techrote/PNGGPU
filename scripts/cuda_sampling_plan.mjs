/** Bounded additions to the three-frame quality study; never a video/stress loop. */
export const SAMPLING_FRAMES=[1,360,719];
export function samplingAdditions(){
  const list=[[4,10],[4,12],[5,10],[6,8],[6,10],[6,12],[6,16],[7,14],[8,12]].map(([sw,sh])=>({key:`80x25-photo-samples${sw}x${sh}`,sw,sh,kind:'normal'}));
  for(const [sw,sh] of [[4,8],[8,16]])for(const kind of ['literal','rotated-refit','upright-refit'])list.push({key:`25x80-${kind}-samples${sh}x${sw}`,sw:sh,sh:sw,kind,anchor:`80x25-photo-samples${sw}x${sh}`});
  return list;
}
export function rotateClockwise(values,width,height,channels=1){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>262144||!Number.isInteger(channels)||channels<1||channels>4||values.length!==width*height*channels)throw Error('Invalid bounded rotation shape');
  const out=new values.constructor(values.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let k=0;k<channels;k++)out[(x*height+height-1-y)*channels+k]=values[(y*width+x)*channels+k];
  return out;
}
export function validateSamplingPreparation(p,palette){
  const expected=samplingAdditions();
  if(p?.schema!=='pnggpu-sampling-preparation-v1'||!p.completed||p.error||!Array.isArray(p.cleanupErrors)||p.cleanupErrors.length||!Number.isFinite(Date.parse(p.started))||JSON.stringify(p.selectedFrames)!==JSON.stringify(SAMPLING_FRAMES)||p.variants?.length!==15)throw Error('Invalid sampling preparation');
  for(let i=0;i<expected.length;i++){
    const v=p.variants[i],e=expected[i],g=v.geometry,portrait=e.kind!=='normal',cw=portrait?16:8,ch=portrait?8:16,n=e.sw*e.sh;
    if(v.key!==e.key||v.kind!==e.kind||g.columns!==(portrait?25:80)||g.rows!==(portrait?80:25)||g.sampleWidth!==e.sw||g.sampleHeight!==e.sh||g.count!==3||
      v.highAtlas.width!==cw||v.highAtlas.height!==ch||v.config.fit.foreground_candidates!==6||v.config.fit.background_candidates!==5||v.config.style!=='photographic'||
      v.codes.length<32||v.codes.length>256||new Set(v.codes).size!==v.codes.length||v.codes.some(x=>!Number.isInteger(x)||x<32||x>255)||v.masks.length!==v.codes.length||
      v.masks.some(m=>m.length!==n||m.some(x=>!Number.isFinite(x)||x<0||x>1||Math.fround(x)!==x))||JSON.stringify(v.palette)!==JSON.stringify(palette)||
      v.frames.length!==3||v.frames.some((f,j)=>f.number!==SAMPLING_FRAMES[j]||!/^[a-f0-9]{64}$/.test(f.pixelSha256)))throw Error('Sampling matrix/atlas/frame bounds differ');
    if(v.anchor!==e.anchor||JSON.stringify(v.layout)!==JSON.stringify({cropBeforeRotation:{x:43,y:0,width:768,height:480},sourceRotationDegrees:portrait?90:0}))throw Error('Sampling crop/anchor differs');
    if(portrait&&(v.displayRotationDegrees!==270||v.comparisonGroup!=='80x25'||v.sourceRotationDegrees!==90||v.fontPolicy!==(e.kind==='upright-refit'?'upright DejaVu 7px in 16x8 cells':'exact 90-degree permutation of saved glyph pixels and low samples')))throw Error('Portrait registration differs');
    const c=v.config.canvas;if(c.columns!==g.columns||c.rows!==g.rows||c.sample_width!==e.sw||c.sample_height!==e.sh||c.cell_width!==cw||c.cell_height!==ch||c.font_size!==(e.kind==='upright-refit'?7:14)||c.resampler!=='lanczos'||v.config.nl_filter.enabled||v.config.derez.enabled||Object.values(v.config.image).some(x=>x!==1))throw Error('Sampling preparation parameters differ');
  }
  return p;
}
