/** Self-contained frozen optional-FP32 regressions; not the binary64 CPU oracle. */
import {readFile,writeFile} from 'node:fs/promises';
const path='native/cuda/tests/fixtures/fp32-seed.json',f=JSON.parse(await readFile(path,'utf8')),frames=[];
const frame=b=>{const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);};
for(const c of f.cases){
 const n=32,gc=f.atlas.masks.length,init=Buffer.alloc(32+gc*n*4+gc*16+256);
 [1,1,4,8,gc,6,5,1].forEach((v,i)=>init.writeUInt32LE(v,i*4));let at=32;
 for(const m of f.atlas.masks)for(const x of m){init.writeFloatLE(x,at);at+=4;}
 for(const m of f.atlas.masks){let sum=0,sq=0;for(const v of m){sum+=v;sq+=v*v;}for(const v of [sum/n,sq,Math.max(sq-sum*sum/n,1e-8),0]){init.writeFloatLE(v,at);at+=4;}}
 for(const color of f.atlas.palette)for(const v of [...color,0]){init.writeFloatLE(v,at);at+=4;}
 const tile=Buffer.alloc(8+n*4);tile.writeUInt32LE(2);tile.writeUInt32LE(1,4);
 for(let i=0;i<n;i++)tile.writeUInt32LE(c.pixels[i*4]|c.pixels[i*4+1]<<8|c.pixels[i*4+2]<<16,8+i*4);
 const expected=Buffer.alloc(16);[...c.expected,0].forEach((v,i)=>expected.writeUInt32LE(v,i*4));
 frames.push(frame(init),frame(tile),frame(expected));
}
const out=Buffer.concat(frames),binary=path.replace('.json','.bin');
if(process.argv.includes('--check')){if(!out.equals(await readFile(binary)))throw new Error('Frozen FP32 regression packet differs');}
else await writeFile(binary,out);
console.log(`Frozen FP32 seed packets: ${f.cases.length} cases`);
