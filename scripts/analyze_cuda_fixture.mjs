/** Diagnose 1-sample cancellation using the original CPU and explicit float32 operations. */
import {readFile,writeFile} from 'node:fs/promises';
import {referencePhotoFit} from '../overlay/src/gpu/reference_photo.js';
const report=JSON.parse(await readFile(process.argv[2],'utf8'));
const job=report.jobs.find(j=>j.job.sampleW===1&&j.job.sampleH===1&&j.fixtures.length);
if(!job)throw new Error('Report has no 1x1 mismatch fixture');
const {masks,palette,codes}=job.fixtureAtlas;
const f=Math.fround,add=(a,b)=>f(a+b),mul=(a,b)=>f(a*b),sub=(a,b)=>f(a-b);
const dot=(a,b)=>add(add(mul(a[0],b[0]),mul(a[1],b[1])),mul(a[2],b[2]));
const analysis=job.fixtures.map(fixture=>{
  const p=fixture.pixels.slice(0,3),foreground=fixture.cuda[1],background=fixture.cuda[2];
  const fg=palette[foreground],bg=palette[background],d=fg.map((x,k)=>x-bg[k]);
  const rows=masks.slice(0,32).map(([mean],glyph)=>{
    const squares=f(mean*mean),dots=p.map(x=>mul(x,mean));
    let cpu=p.reduce((s,x)=>s+x*x,0);
    for(let k=0;k<3;k++)cpu+=bg[k]*bg[k]+2*bg[k]*d[k]*mean+d[k]*d[k]*squares-2*bg[k]*p[k]-2*d[k]*(p[k]*mean);
    let cuda=add(dot(p,p),dot(bg,bg));
    cuda=add(cuda,mul(mul(2,dot(bg,d)),mean));
    cuda=add(cuda,mul(dot(d,d),squares));
    cuda=sub(cuda,mul(2,dot(bg,p)));
    cuda=sub(cuda,mul(2,dot(d,dots)));
    return {glyph,code:codes[glyph],mean,sumSquares:squares,cpuError:cpu,cudaError:cuda,
      cpuCovariance:p.map(x=>x*mean-x*mean),cudaCovariance:dots.map((x,k)=>sub(x,mul(p[k],mean)))};
  });
  const cpu=referencePhotoFit({pixels:Uint8Array.from(fixture.pixels),masks:masks.map(m=>Float32Array.from(m)),
    palette,config:{canvas:{columns:1,rows:1,sample_width:1,sample_height:1},fit:{foreground_candidates:6,background_candidates:5}}});
  return {fixture,cpuReproduced:[cpu.chosen[0],cpu.fg[0],cpu.bg[0]],foreground,background,
    note:'One sample makes every projection covariance exactly zero. First 32 glyphs tie. Float32 projection dots and subtractive SSE scoring change the winner; no tile/index difference is needed. Error rows hold the observed CUDA palette pair fixed; the full CPU reproduction evaluates every candidate.',rows};
});
const result={schema:'pnggpu-cuda-arithmetic-diagnosis-v1',sourceCommit:report.sourceCommit,workerSourceCommit:report.workerSourceCommit,analysis};
if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');
else console.log(JSON.stringify(result,null,2));
