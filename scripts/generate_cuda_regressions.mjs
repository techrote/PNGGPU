/** Generate native regression frames from independent JS CPU fixture winners. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {referencePhotoFit} from '../overlay/src/gpu/reference_photo.js';
const packets=[];
const frame=body=>{const size=Buffer.alloc(4);size.writeUInt32LE(body.length);return Buffer.concat([size,body]);};
for(const name of ['precision-cutoff','shortlist-cutoff']) {
  const {fixture,atlas,job}=JSON.parse(await readFile(`overlay/fixtures/cuda/${name}.json`,'utf8'));
  const n=job.sampleW*job.sampleH,gc=atlas.masks.length;
  const init=Buffer.alloc(32+gc*n*4+gc*16+256);
  [1,1,job.sampleW,job.sampleH,gc,6,5,1].forEach((x,i)=>init.writeUInt32LE(x,i*4));
  let at=32;
  for(const mask of atlas.masks)for(const x of mask){init.writeFloatLE(x,at);at+=4;}
  for(const mask of atlas.masks) {
    let sum=0,squares=0;for(const x of mask){sum+=x;squares+=x*x;}
    for(const x of [sum/n,squares,Math.max(squares-sum*sum/n,1e-8),0]){init.writeFloatLE(x,at);at+=4;}
  }
  for(const color of atlas.palette)for(const x of [...color,0]){init.writeFloatLE(x,at);at+=4;}
  const tile=Buffer.alloc(8+n*4);tile.writeUInt32LE(2);tile.writeUInt32LE(1,4);
  for(let i=0;i<n;i++)tile.writeUInt32LE(fixture.pixels[i*4]|fixture.pixels[i*4+1]<<8|fixture.pixels[i*4+2]<<16,8+i*4);
  const cpu=referencePhotoFit({pixels:Uint8Array.from(fixture.pixels),masks:atlas.masks.map(m=>Float32Array.from(m)),palette:atlas.palette,
    config:{canvas:{columns:1,rows:1,sample_width:job.sampleW,sample_height:job.sampleH},fit:{foreground_candidates:6,background_candidates:5}}});
  const expected=Buffer.alloc(16);[cpu.chosen[0],cpu.fg[0],cpu.bg[0],0].forEach((x,i)=>expected.writeUInt32LE(x,i*4));
  packets.push(frame(init),frame(tile),frame(expected));
}
const path='native/cuda/tests/fixtures/cpu-parity.bin',output=Buffer.concat(packets);
if(process.argv.includes('--check')) {
  if(!output.equals(await readFile(path)))throw new Error('Native CPU fixture frames are stale');
  console.log('Native regression frames match independent JS CPU fixture winners');
}else {await mkdir('native/cuda/tests/fixtures',{recursive:true});await writeFile(path,output);}
