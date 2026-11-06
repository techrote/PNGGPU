import {readFile} from 'node:fs/promises';
export async function loadCudaFixtures(palette) {
  const historical=JSON.parse(await readFile(new URL('../qualification/turing-37706c3.json',import.meta.url),'utf8'));
  const fixtures=[];
  for(const job of historical.jobs)for(const fixture of job.fixtures)
    fixtures.push({name:`historical-${job.job.sampleW}x${job.job.sampleH}-cell-${fixture.cell}`,pixels:Uint8Array.from(fixture.pixels),
      masks:job.fixtureAtlas.masks.map(m=>Float32Array.from(m)),palette:job.fixtureAtlas.palette,codes:job.fixtureAtlas.codes,
      sampleWidth:job.job.sampleW,sampleHeight:job.job.sampleH,columns:1,rows:1,foregroundCandidates:6,backgroundCandidates:5});
  let seed=0xdeadbeef;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(const [sw,sh] of [[1,1],[2,2],[4,8],[8,16],[16,32],[32,64]])for(const [nf,nb] of [[1,1],[6,5],[12,8]]) {
    const n=sw*sh,columns=17;
    const pixels=Uint8Array.from({length:columns*n*4},()=>random()>>>24);
    const masks=Array.from({length:40},(_,g)=>Float32Array.from({length:n},(_,i)=>
      g===0?0:g===1?1:g===2?0.5:g===3?Math.fround(0.5000000596046448):g===4?i%2:(random()>>>24)/255));
    fixtures.push({name:`random-${sw}x${sh}-${nf}-${nb}`,pixels,masks,palette,codes:Array.from({length:40},(_,i)=>i+32),
      sampleWidth:sw,sampleHeight:sh,columns,rows:1,foregroundCandidates:nf,backgroundCandidates:nb});
  }
  return fixtures;
}
