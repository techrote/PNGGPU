/** Diagnose captured parity failures with the original CPU and explicit float32 operations. */
import {readFile,writeFile} from 'node:fs/promises';
import {referencePhotoFit} from '../overlay/src/gpu/reference_photo.js';
const report=JSON.parse(await readFile(process.argv[2],'utf8'));
const f=Math.fround,add=(a,b)=>f(a+b),mul=(a,b)=>f(a*b),sub=(a,b)=>f(a-b);
const dot=(a,b)=>add(add(mul(a[0],b[0]),mul(a[1],b[1])),mul(a[2],b[2]));
const analysis=[];
for(const job of report.jobs.filter(j=>j.fixtures.length)) {
  const {masks,palette,codes}=job.fixtureAtlas,n=job.job.sampleW*job.job.sampleH;
  for(const fixture of job.fixtures) {
    const p=Array.from({length:n},(_,i)=>fixture.pixels.slice(i*4,i*4+3));
    const totals=[0,0,0];let cpuP2=0,cudaP2=0;
    for(const pixel of p){for(let k=0;k<3;k++){totals[k]+=pixel[k];cpuP2+=pixel[k]*pixel[k];}cudaP2=add(cudaP2,dot(pixel,pixel));}
    const projections=masks.map((mask,glyph)=>{
      let sum=0,sum2=0;const cpuDots=[0,0,0],cudaDots=[0,0,0];
      for(let i=0;i<n;i++) {
        sum+=mask[i];sum2+=mask[i]*mask[i];
        for(let k=0;k<3;k++){cpuDots[k]+=p[i][k]*mask[i];cudaDots[k]=add(cudaDots[k],mul(p[i][k],mask[i]));}
      }
      const mean=f(sum/n),squares=f(sum2),variance=f(Math.max(sum2-sum*sum/n,1e-8));
      const cpuCov=cpuDots.map((x,k)=>x-totals[k]*mean),cudaCov=cudaDots.map((x,k)=>sub(x,mul(totals[k],mean)));
      const cpuScore=-cpuCov.reduce((s,x)=>s+x*x/variance,0),cudaScore=-f(dot(cudaCov,cudaCov)/variance);
      return {glyph,code:codes[glyph],mean,squares,variance,cpuDots,cudaDots,cpuCov,cudaCov,cpuScore,cudaScore};
    });
    const shortlist=key=>projections.slice().sort((a,b)=>a[key]-b[key]||a.glyph-b.glyph).slice(0,32).map(x=>x.glyph);
    const cpuShortlist=shortlist('cpuScore'),cudaShortlist=shortlist('cudaScore');
    const pairs=[...new Set([fixture.cpu,fixture.cuda,fixture.webgpu].map(x=>`${x[1]},${x[2]}`))];
    const selected=new Set([fixture.cpu[0],fixture.cuda[0],fixture.webgpu[0]]);
    const rows=projections.filter(x=>selected.has(x.glyph)).map(projection=>{
      const errors=pairs.map(pair=>{
        const [foreground,background]=pair.split(',').map(Number),fg=palette[foreground],bg=palette[background],d=fg.map((x,k)=>x-bg[k]);
        let cpu=cpuP2;
        for(let k=0;k<3;k++)cpu+=n*bg[k]*bg[k]+2*bg[k]*d[k]*projection.mean*n+d[k]*d[k]*projection.squares-2*bg[k]*totals[k]-2*d[k]*projection.cpuDots[k];
        let cuda=add(cudaP2,mul(n,dot(bg,bg)));
        cuda=add(cuda,mul(mul(mul(2,dot(bg,d)),projection.mean),n));
        cuda=add(cuda,mul(dot(d,d),projection.squares));
        cuda=sub(cuda,mul(2,dot(bg,totals)));
        cuda=sub(cuda,mul(2,dot(d,projection.cudaDots)));
        return {foreground,background,cpuError:cpu,cudaError:cuda};
      });
      return {...projection,errors};
    });
    const cpu=referencePhotoFit({pixels:Uint8Array.from(fixture.pixels),masks:masks.map(m=>Float32Array.from(m)),palette,
      config:{canvas:{columns:1,rows:1,sample_width:job.job.sampleW,sample_height:job.job.sampleH},fit:{foreground_candidates:6,background_candidates:5}}});
    analysis.push({job:job.job,fixture,cpuReproduced:[cpu.chosen[0],cpu.fg[0],cpu.bg[0]],cpuShortlist,cudaShortlist,rows,
      note:'CPU reproduction runs every candidate. CUDA intermediates here are explicitly rounded JavaScript diagnostics of the no-FMA sequence, not instrumented GPU reads. Isolated real-device outputs are in fixture.isolated. WebGPU compiler arithmetic is not inferred from this model.'});
  }
}
if(!analysis.length)throw new Error('Report has no mismatch fixtures');
const result={schema:'pnggpu-cuda-arithmetic-diagnosis-v2',sourceCommit:report.sourceCommit,workerSourceCommit:report.workerSourceCommit,analysis};
if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');
else console.log(JSON.stringify(result,null,2));
