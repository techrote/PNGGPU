// CPU-only synthetic protocol child, never a CUDA worker.
export const MOCK_WORKER = `
const mode = process.env.PNGGPU_MOCK_MODE || 'normal';
const device = Number(process.argv[process.argv.indexOf('--device') + 1]) || 0;
const arithmetic = process.argv.includes('--arithmetic-mode') ? process.argv[process.argv.indexOf('--arithmetic-mode')+1] : 'float32-guarded-binary64';
const info = {schema:'pnggpu-cuda-info-v1',backend:'cuda',protocolVersion:1,available:true,
 precision:arithmetic,device:{name:'test fixture (not a GPU)',index:device,
 computeCapability:'7.5',totalMemoryBytes:24*1024**3,freeMemoryBytes:20*1024**3},
 limits:{maxMessageBytes:134217728,maxTileCells:65536,maxSamplesPerCell:2048,maxGlyphCount:65535,
 maxProjectionBytes:134217728,maxPixelBytes:67108864,maxProjectionWork:16777216,maxRecoveryProjectionBytes:33554432,maxRecoveryCells:1024}};
if (process.argv.includes('--info')) {
 if (mode==='info-stall') { setInterval(()=>{},1000); }
 else if (mode==='info-overflow') process.stdout.write('x'.repeat(70000));
 else if (mode==='info-invalid') console.log(JSON.stringify({...info,protocolVersion:42}));
 else console.log(JSON.stringify(info));
} else {
 let input=Buffer.alloc(0), config;
 function reply(metadata, binary=Buffer.alloc(0), status=0) {
  const json=Buffer.from(JSON.stringify(metadata));
  const payload=Buffer.alloc(8+json.length+binary.length);
  payload.writeUInt32LE(status,0); payload.writeUInt32LE(json.length,4);
  json.copy(payload,8); binary.copy(payload,8+json.length);
  const outer=Buffer.alloc(4); outer.writeUInt32LE(payload.length);
  const frame=Buffer.concat([outer,payload]);
  if(mode==='truncated') {process.stdout.write(frame.subarray(0,frame.length-2));process.exitCode=1;process.stdin.destroy();return;}
  if(mode==='oversized') {outer.writeUInt32LE(0xffffffff);process.stdout.write(outer);return;}
  if(mode==='extra') {process.stdout.write(Buffer.concat([frame,Buffer.from([1,2,3])]));return;}
  if(mode==='invalid-json') {frame[12]=0xff;process.stdout.write(frame);return;}
  // Split prefix and payload into distinct writes, including an odd JSON size.
  process.stdout.write(frame.subarray(0,1));
  setTimeout(()=>{process.stdout.write(frame.subarray(1,3));
   setTimeout(()=>process.stdout.write(frame.subarray(3)),1);},1);
 }
 function handle(body) {
  if(body.readUInt32LE(0)===1) {
   config={samples:body.readUInt32LE(8)*body.readUInt32LE(12),glyphs:body.readUInt32LE(16)};
   if(mode==='init-error') {reply({ok:false,error:'test initialization rejection'},Buffer.alloc(0),1);return;}
   const init=()=>reply({ok:true,device:info.device,precision:arithmetic,allocatedBytes:4096});
   if(mode==='slow-init') setTimeout(init,250); else init();
  } else {
   if(mode==='tile-stall') return;
   const tile=()=>{
    const count=body.readUInt32LE(4),out=Buffer.alloc(count*16);
    for(let i=0;i<count;i++) {
     out.writeUInt32LE(body.readUInt32LE(8+i*config.samples*4)%config.glyphs,i*16);
     out.writeUInt32LE(3,i*16+4);out.writeUInt32LE(2,i*16+8);
    }
    reply({ok:true,cellCount:mode==='wrong-count'?count+1:count,
      directCells:arithmetic!=='float32-guarded-binary64'?count:0,recoveredCells:arithmetic!=='float32-guarded-binary64'?0:count,certifiedCells:0,deviceReadbackBytes:count*(arithmetic!=='float32-guarded-binary64'?16:32),
      timing:{gpuProjectionMs:1.25,gpuSelectionMs:2.5,uploadMs:0.1,readbackMs:0.2,
        gpuGuardMs:arithmetic!=='float32-guarded-binary64'?0:0.1,gpuRecoveryProjectionMs:arithmetic!=='float32-guarded-binary64'?0:0.2,gpuRecoverySelectionMs:arithmetic!=='float32-guarded-binary64'?0:0.3,
        gpuDirectProjectionMs:arithmetic!=='float32-guarded-binary64'?1.25:0,gpuDirectSelectionMs:arithmetic!=='float32-guarded-binary64'?2.5:0,
        maxProjectionLaunchMs:1,maxSelectionLaunchMs:0.3},allocatedBytes:4096},out);
   };
   if(mode==='slow-tile') setTimeout(tile,250);else tile();
  }
 }
 process.stdin.on('data',chunk=>{
  input=Buffer.concat([input,chunk]);
  while(input.length>=4 && input.length>=4+input.readUInt32LE(0)) {
   const length=input.readUInt32LE(0),body=input.subarray(4,4+length);
   input=input.subarray(4+length);handle(body);
  }
 });
}
`;
