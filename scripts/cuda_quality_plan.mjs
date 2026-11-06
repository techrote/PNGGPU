/** First 80x25 one-factor quality study; no full-video or stress loop. */
export const QUALITY_FRAMES=[1,360,719];
export function qualityVariants(){
  const list=[];
  const add=(key,patch={},sw=4,sh=8,style='photographic')=>list.push({key:`80x25-${key}`,label:key,style,sw,sh,patch});
  for(const [w,h] of [[4,8],[8,8],[4,16],[8,16]])add(`photo-samples${w}x${h}`,{},w,h);
  for(const r of ['nearest','bilinear','bicubic'])for(const [w,h] of [[4,8],[8,16]])add(`photo-${r}-${w}x${h}`,{canvas:{resampler:r}},w,h);
  for(const [fg,bg] of [[3,3],[12,8]])for(const [w,h] of [[4,8],[8,16]])add(`photo-candidates${fg}-${bg}-${w}x${h}`,{fit:{foreground_candidates:fg,background_candidates:bg}},w,h);
  for(const [p,value] of [['contrast',1.2],['sharpness',1.5],['gamma',1.2],['saturation',1.25]])add(`photo-${p}-${value}`,{image:{[p]:value}});
  for(const mode of ['edge-enhancement','optimal-estimation','alpha-trimmed-mean'])add(`photo-nl-${mode}`,{nl_filter:{enabled:true,mode,radius:1,alpha:.5}});
  add('photo-webapp-defaults',{image:{brightness:1,contrast:.85,saturation:1.8,gamma:1,sharpness:1.2},nl_filter:{enabled:true,mode:'edge-enhancement',radius:1,alpha:.9}});
  add('industrial-reference',{},4,8,'industrial');
  for(const [p,value] of [['structure_blur',0],['texture_blur',3],['edge_threshold',5],['edge_range',100],['texture_threshold',8],['texture_range',100],['highlight_threshold',90],['highlight_range',180],['highlight_exponent',3],['accent_luminance_scale',80]])add(`industrial-${p}-${value}`,{industrial:{[p]:value}},4,8,'industrial');
  if(list.length>36||new Set(list.map(v=>v.key)).size!==list.length)throw Error('Quality variant bound/identity violation');
  return list;
}
export function exposeOriginalPreprocessing(core){
  const anchor='scope.PNG2ANSI={DEFAULTS,';
  if(core.split(anchor).length!==2)throw Error('Pinned core export boundary changed');
  return core.replace(anchor,'scope.PNG2ANSI={qualityPreprocess:preprocess,qualityIndustrialFit:industrialFit,DEFAULTS,');
}
export function validateQualityPreparation(p,palette,defaults){
  const choices=qualityVariants();
  if(!p?.completed||p.error||!Array.isArray(p.cleanupErrors)||p.cleanupErrors.length||JSON.stringify(p.selectedFrames)!==JSON.stringify(QUALITY_FRAMES)||p.variants?.length!==choices.length)throw Error('Invalid completed quality preparation');
  for(let i=0;i<choices.length;i++){
    const v=p.variants[i],c=choices[i],g=v.geometry,n=c.sw*c.sh;
    const expected=JSON.parse(JSON.stringify(defaults));Object.assign(expected.canvas,{columns:80,rows:25,sample_width:c.sw,sample_height:c.sh});expected.style=c.style;
    expected.image={brightness:1,contrast:1,saturation:1,gamma:1,sharpness:1};expected.nl_filter.enabled=false;expected.derez.enabled=false;
    const merge=(a,b)=>{for(const [k,x] of Object.entries(b))typeof x==='object'?merge(a[k],x):a[k]=x;};merge(expected,c.patch);
    if(JSON.stringify(expected)!==JSON.stringify(v.config)||JSON.stringify(c.patch)!==JSON.stringify(v.patch))throw Error('Quality parameter configuration differs');
    if(v.key!==c.key||v.style!==c.style||g?.columns!==80||g.rows!==25||g.sampleWidth!==c.sw||g.sampleHeight!==c.sh||g.count!==3||
      v.config?.style!==c.style||v.config.fit?.foreground_candidates!==(c.patch.fit?.foreground_candidates??6)||v.config.fit?.background_candidates!==(c.patch.fit?.background_candidates??5)||
      !Array.isArray(v.codes)||v.codes.length<32||v.codes.length>256||new Set(v.codes).size!==v.codes.length||v.codes.some(x=>!Number.isInteger(x)||x<32||x>255)||
      v.masks?.length!==v.codes.length||v.masks.some(m=>!Array.isArray(m)||m.length!==n||m.some(x=>!Number.isFinite(x)||x<0||x>1||Math.fround(x)!==x))||JSON.stringify(v.palette)!==JSON.stringify(palette)||
      v.frames?.length!==3||v.frames.some((f,j)=>f.number!==QUALITY_FRAMES[j]||!/^[a-f0-9]{64}$/.test(f.pixelSha256)))throw Error('Quality geometry/atlas/candidate/frame scope differs');
    if(c.style==='industrial')for(const f of v.frames)for(const k of ['chosen','fg','bg'])if(f[k]?.length!==2000||f[k].some(x=>!Number.isInteger(x)||x<0||x>=(k==='chosen'?v.codes.length:16)))throw Error('Invalid industrial tuples');
  }
  return p;
}
