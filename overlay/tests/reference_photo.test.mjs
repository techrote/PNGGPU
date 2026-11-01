import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {referencePhotoFit} from '../src/gpu/reference_photo.js';

let reference=null;
try{
  const upstream=await readFile(new URL('../src/core.js',import.meta.url),'utf8');
  assert.match(upstream,/function photoFit\(source,masks,config,progress\)/);
  const patched=upstream.replace('scope.PNG2ANSI={','scope.PNG2ANSI={__testPhotoFit:photoFit,');
  const context={console};context.globalThis=context;
  vm.runInNewContext(patched,context,{filename:'src/core.js'});
  reference=context.PNG2ANSI;
}catch(error){if(error?.code!=='ENOENT')throw error;}

test('timed CPU matcher is bit-exact against pinned original private photoFit, not a lower-quality rewrite',
  {skip:!reference&&'Original upstream src/core.js is downloaded by setup.bat'},()=>{
    const profiles=[
      {sampleW:4,sampleH:8,foreground:6,background:5,glyphs:7},
      {sampleW:8,sampleH:16,foreground:8,background:8,glyphs:40},
      {sampleW:16,sampleH:8,foreground:12,background:8,glyphs:19},
    ];
    for(const p of profiles){
      const config=reference.configFrom({canvas:{columns:16,rows:8,sample_width:p.sampleW,sample_height:p.sampleH},
        fit:{foreground_candidates:p.foreground,background_candidates:p.background}});
      const samples=p.sampleW*p.sampleH,pixels=new Uint8ClampedArray(16*8*samples*4);
      for(let i=0;i<pixels.length;i+=4){pixels[i]=(i*13+97)%256;pixels[i+1]=(i*7+31)%256;
        pixels[i+2]=(i*19+103)%256;pixels[i+3]=255;}
      const masks=Array.from({length:p.glyphs},(_,g)=>Float32Array.from({length:samples},(_,i)=>
        ((g*17+i*29+((i*g)%13))%103)/102));
      const upstream=reference.__testPhotoFit({width:16*p.sampleW,height:8*p.sampleH,pixels},{low:masks},config);
      const timed=referencePhotoFit({pixels,masks,config,palette:reference.PALETTE});
      for(const key of ['chosen','fg','bg'])assert.deepEqual([...timed[key]],[...upstream[key]],`${key}: ${JSON.stringify(p)}`);
    }
  });
