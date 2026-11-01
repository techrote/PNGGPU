/**
 * GPU-003 CPU timing reference: the unmodified photographic glyph-matching
 * algorithm copied from techrote/PNG2ANSI src/core.js @ 67ae97295ab9a9ab32fdee5410c2371e4b21ce87.
 *
 * This operates on SHARED, already-preprocessed RGBA8 source samples and the
 * SAME low-resolution glyph masks as WebGPU. The original release core.js is
 * not modified. Equality tests compare this implementation with the original
 * private photoFit() function, extracted only inside the Node test sandbox.
 * Do not optimise or reorder its loops independently of the parity oracle.
 */
export function referencePhotoFit({pixels,masks,config,palette,progress=null}) {
  const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
  const nearest=(color,count,allowed=null)=>{
    const ids=allowed||palette.map((_,i)=>i);
    return ids.map(i=>[i,(color[0]-palette[i][0])**2+(color[1]-palette[i][1])**2+(color[2]-palette[i][2])**2])
      .sort((a,b)=>a[1]-b[1]).slice(0,count).map(x=>x[0]);
  };
  const GLYPH_SHORTLIST=32;
  const source={pixels,width:config.canvas.columns*config.canvas.sample_width};
  const cellPixels=(index)=>{
    const c=config.canvas,n=c.sample_width*c.sample_height,out=new Float32Array(n*3),cx=index%c.columns,cy=Math.floor(index/c.columns);let q=0;
    for(let y=0;y<c.sample_height;y++)for(let x=0;x<c.sample_width;x++){const at=((cy*c.sample_height+y)*source.width+cx*c.sample_width+x)*4;out[q++]=source.pixels[at];out[q++]=source.pixels[at+1];out[q++]=source.pixels[at+2];}return out;
  };
  const count=config.canvas.columns*config.canvas.rows,n=config.canvas.sample_width*config.canvas.sample_height,gc=masks.length;
  if(pixels.length!==count*n*4||gc<1||masks.some(m=>m.length!==n))throw new RangeError('CPU reference sample/mask geometry mismatch');
  const chosen=new Uint16Array(count),fg=new Uint8Array(count),bg=new Uint8Array(count);
  const meanM=new Float32Array(gc),ssM=new Float32Array(gc),sumM2=new Float32Array(gc);
  for(let g=0;g<gc;g++){let s=0,s2=0;for(const m of masks[g]){s+=m;s2+=m*m;}meanM[g]=s/n;sumM2[g]=s2;ssM[g]=Math.max(s2-s*s/n,1e-8);}
  for(let cell=0;cell<count;cell++){
    const p=cellPixels(cell),sum=[0,0,0],sumP2=p.reduce((a,x)=>a+x*x,0),dot=Array.from({length:gc},()=>[0,0,0]);
    for(let i=0;i<n;i++)for(let k=0;k<3;k++)sum[k]+=p[i*3+k];
    for(let g=0;g<gc;g++)for(let i=0;i<n;i++)for(let k=0;k<3;k++)dot[g][k]+=p[i*3+k]*masks[g][i];
    let bestSeed=Infinity,seedFg=[0,0,0],seedBg=[0,0,0];const shortlist=[];
    for(let g=0;g<gc;g++){
      let explained=0;const cov=[0,0,0];for(let k=0;k<3;k++){cov[k]=dot[g][k]-sum[k]*meanM[g];explained+=cov[k]*cov[k]/ssM[g];}const score=-explained;
      if(shortlist.length<GLYPH_SHORTLIST||score<shortlist[shortlist.length-1][1]){let at=shortlist.length;while(at>0&&(score<shortlist[at-1][1]||(score===shortlist[at-1][1]&&g<shortlist[at-1][0])))at--;shortlist.splice(at,0,[g,score]);if(shortlist.length>GLYPH_SHORTLIST)shortlist.pop();}
      if(score<bestSeed){bestSeed=score;const beta=cov.map(x=>x/ssM[g]);seedBg=sum.map((x,k)=>clamp(x/n-beta[k]*meanM[g],0,255));seedFg=seedBg.map((x,k)=>clamp(x+beta[k],0,255));}
    }
    const fgs=nearest(seedFg,config.fit.foreground_candidates),bgs=nearest(seedBg,config.fit.background_candidates,Array.from({length:8},(_,i)=>i));let best=Infinity;
    for(const fi of fgs)for(const bi of bgs){const f=palette[fi],b=palette[bi],d=f.map((x,k)=>x-b[k]);for(const [g] of shortlist){let e=sumP2;for(let k=0;k<3;k++)e+=n*b[k]*b[k]+2*b[k]*d[k]*meanM[g]*n+d[k]*d[k]*sumM2[g]-2*b[k]*sum[k]-2*d[k]*dot[g][k];if(e<best){best=e;chosen[cell]=g;fg[cell]=fi;bg[cell]=bi;}}}
    if(progress&&cell%80===0)progress(cell/count);
  }
  return {chosen,fg,bg};
}
