import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function imageGeometry(columns,rows,sampleWidth=4,sampleHeight=8,maxPreparationCells=64) {
  if(!Number.isSafeInteger(maxPreparationCells)||maxPreparationCells<1||maxPreparationCells>3200)throw new Error('Preparation cell limit must be 1–3200');
  for(const [name,value,max] of [['columns',columns,80],['rows',rows,64],['sampleWidth',sampleWidth,8],['sampleHeight',sampleHeight,16]])
    if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`Invalid small-image ${name}`);
  if(columns*rows>maxPreparationCells||sampleWidth*sampleHeight>128)throw new Error('Image exceeds explicit preparation cell/sample limits (default 64 cells / 128 samples)');
  if(columns*rows>64&&!((sampleWidth===4&&sampleHeight===8)||(sampleWidth===8&&sampleHeight===16)))throw new Error('Larger bounded stages require 4x8 or 8x16 samples/cell');
  return {columns,rows,sampleWidth,sampleHeight};
}

export function parseImagePreparationArgs(args) {
  const positionals=[];let maxPreparationCells=64,seen=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--max-preparation-cells') {
      const value=args[++i];
      if(seen||!/^[1-9][0-9]*$/.test(value??''))throw new Error('Specify one positive --max-preparation-cells value');
      maxPreparationCells=Number(value);seen=true;
    }else if(args[i].startsWith('--'))throw new Error(`Unknown preparation flag ${args[i]}`);
    else positionals.push(args[i]);
  }
  if(positionals.length<5||positionals.length>7)throw new Error('Expected PLAYWRIGHT OUTPUT IMAGE COLUMNS ROWS [SAMPLE_WIDTH SAMPLE_HEIGHT]');
  const [playwright,output,image,c,r,sw='4',sh='8']=positionals;
  if([c,r,sw,sh].some(v=>!/^[1-9][0-9]*$/.test(v)))throw new Error('Image geometry must contain positive integers');
  return {playwright,output,image,maxPreparationCells,geometry:imageGeometry(Number(c),Number(r),Number(sw),Number(sh),maxPreparationCells)};
}

// Include only existing workbench preparation functions, with no UI, matcher,
// automatic memory estimate or backend/device initialization.
export function imagePreparationHtml(html) {
  const section=(start,end)=>{
    const from=html.indexOf(start),to=html.indexOf(end,from);
    if(from<0||to<=from)throw new Error('Workbench preparation source boundaries changed');
    return html.slice(from,to);
  };
  return `<!doctype html><meta charset="utf-8"><title>Bounded image preparation</title>
<script src="../../src/core.js"></script><script type="module">
let fontReady;const maskCache=new Map();const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
${section('async function font(){','function renderCells(')}
${section('function makeConfig(settings){','function cpuGeometrySupported(')}
globalThis.qualification={masksFor,makeConfig};</script>`;
}

export function validateImageFixture(document) {
  if(document?.schema!=='pnggpu-real-image-fixture-v1')throw new Error('Invalid real-image fixture schema');
  const f=document.fixture;
  if(!f||typeof f.name!=='string'||!/^image-[a-z0-9-]+$/.test(f.name))throw new Error('Invalid image fixture name');
  imageGeometry(f.columns,f.rows,f.sampleWidth,f.sampleHeight,document.provenance?.maxPreparationCells??64);
  if(f.foregroundCandidates!==6||f.backgroundCandidates!==5)throw new Error('Real-image scope preserves six/five candidates');
  const n=f.sampleWidth*f.sampleHeight;
  if(!Array.isArray(f.pixels)||f.pixels.length!==f.columns*f.rows*n*4||f.pixels.some(v=>!Number.isInteger(v)||v<0||v>255))throw new Error('Invalid image samples');
  if(!Array.isArray(f.masks)||f.masks.length<1||f.masks.length>256||f.masks.some(m=>!Array.isArray(m)||m.length!==n||m.some(v=>!Number.isFinite(v)||v<0||v>1||Math.fround(v)!==v)))throw new Error('Invalid float32 image masks');
  if(!Array.isArray(f.codes)||f.codes.length!==f.masks.length||new Set(f.codes).size!==f.codes.length||f.codes.some(v=>!Number.isInteger(v)||v<0||v>255))throw new Error('Invalid CP437 image codes');
  if(!Array.isArray(f.palette)||f.palette.length!==16||f.palette.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255)))throw new Error('Invalid image palette');
  if(document.fixtureSha256!==sha256(JSON.stringify(f)))throw new Error('Prepared image fixture hash mismatch');
  const p=document.provenance;
  if(p?.sourceSamplingMode!=='full-reference-canvas'||typeof p?.sourceFiles!=='object'||!p.sourceFiles||
    !/^[a-z0-9-]+\.png$/.test(p.image?.file??'')||!/^[a-f0-9]{40}$/.test(p.sourceCommit??'')||
    typeof p.started!=='string'||!Number.isFinite(Date.parse(p.started)))throw new Error('Missing real-image provenance');
  const required=['overlay/fixtures/hardmode/manifest.json','overlay/fixtures/hardmode/'+p.image.file,
    'overlay/experiments/webgpu/photographic.html','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf',
    'scripts/prepare_cuda_image.mjs','scripts/cuda_image_fixture.mjs'];
  if(Object.keys(p.sourceFiles).length!==required.length||required.some(name=>!/^[a-f0-9]{64}$/.test(p.sourceFiles[name]??''))||
    p.sourceFiles[required[1]]!==p.image.sha256)throw new Error('Missing real-image source hashes');
  return f;
}

export async function loadImageFixture(path,root,palette) {
  const bytes=await readFile(path);
  if(bytes.length>8*1024*1024)throw new Error('Prepared image fixture exceeds 8 MiB');
  const document=JSON.parse(bytes),f=validateImageFixture(document);
  if(JSON.stringify(f.palette)!==JSON.stringify(palette))throw new Error('Image palette differs from independent original CPU');
  for(const [name,hash] of Object.entries(document.provenance.sourceFiles)) {
    const file=resolve(root,name),rel=relative(root,file);
    if(isAbsolute(name)||rel.startsWith('..')||isAbsolute(rel)||!/^[0-9a-f]{64}$/.test(hash))throw new Error('Invalid image source identity');
    if(sha256(await readFile(file))!==hash)throw new Error(`Image preparation source differs: ${name}`);
  }
  return {data:{...f,pixels:Uint8Array.from(f.pixels),masks:f.masks.map(m=>Float32Array.from(m))},
    input:{sha256:sha256(bytes),fixtureSha256:document.fixtureSha256,provenance:document.provenance}};
}
