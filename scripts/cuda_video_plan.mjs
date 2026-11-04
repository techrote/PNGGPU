import {planFixtures} from './cuda_fixture_plan.mjs';
export const VIDEO_SOURCE_FILES=['overlay/experiments/webgpu/photographic.html','PNG2ANSI/src/core.js','PNG2ANSI/assets/DejaVuSansMono.ttf',
  'scripts/cuda_image_fixture.mjs','scripts/prepare_cuda_video.mjs','scripts/cuda_video_plan.mjs'];
export function pngDimensions(bytes) {
  if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
    bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw new Error('Invalid PNG header');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<1||height<1||width>4096||height>4096)throw new Error('Source PNG dimensions exceed 1–4096');
  return {width,height};
}
export function videoGeometry(columns,rows,count) {
  if(!((columns===160&&rows===80)||(columns===320&&rows===160))||!Number.isSafeInteger(count)||count<1||count>120)
    throw new Error('Video scope is 160x80 or 320x160 and 1–120 consecutive frames');
  return {columns,rows,count,sampleWidth:4,sampleHeight:8};
}
export function videoPlan(atlas,count,mode,tileMiB) {
  videoGeometry(atlas.columns,atlas.rows,count);
  if(!['float32-direct','binary64-direct'].includes(mode)||![16,32].includes(tileMiB)||atlas.sampleWidth!==4||atlas.sampleHeight!==8||
    atlas.foregroundCandidates!==6||atlas.backgroundCandidates!==5)throw new Error('Invalid bounded video arithmetic/settings');
  const frames=Array.from({length:count},(_,i)=>({...atlas,name:`frame-${i}`}));
  return planFixtures(frames,{cases:frames.map(f=>f.name),repeats:1,tileMiB,maxRuns:count,
    maxCells:atlas.columns*atlas.rows*count,maxWork:360000000000,timeoutMs:10000}).summary;
}

export function validateVideoManifest(batch) {
  if(batch?.schema!=='pnggpu-video-frames-v1'||batch.completed!==true||batch.error||!Array.isArray(batch.cleanupErrors)||batch.cleanupErrors.length)
    throw new Error('Invalid completed video receipt');
  const a=batch.atlas,g=batch.geometry;videoGeometry(a?.columns,a?.rows,g?.count);
  const frameBytes=a.columns*a.rows*32*4;
  if(g.columns!==a.columns||g.rows!==a.rows||batch.fitMode!=='contain-black'||a.sampleWidth!==4||a.sampleHeight!==8||
    a.foregroundCandidates!==6||a.backgroundCandidates!==5||!Array.isArray(a.masks)||a.masks.length<1||a.masks.length>256||
    a.masks.some(m=>!Array.isArray(m)||m.length!==32||m.some(v=>!Number.isFinite(v)||v<0||v>1||Math.fround(v)!==v))||
    !Array.isArray(a.codes)||a.codes.length!==a.masks.length||new Set(a.codes).size!==a.codes.length||a.codes.some(v=>!Number.isInteger(v)||v<0||v>255)||
    !Array.isArray(a.palette)||a.palette.length!==16||a.palette.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255)))
    throw new Error('Invalid video geometry/atlas');
  const sha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
  if(!batch.sourceFiles||Object.keys(batch.sourceFiles).length!==VIDEO_SOURCE_FILES.length||VIDEO_SOURCE_FILES.some(n=>!sha(batch.sourceFiles[n]))||
    !/^[a-f0-9]{40}$/.test(batch.sourceCommit??'')||!Number.isFinite(Date.parse(batch.started))||!sha(batch.rgbaSha256)||
    !Array.isArray(batch.frames)||batch.frames.length!==g.count||batch.rgbaBytes!==g.count*frameBytes||
    batch.frames.some((f,i)=>f.index!==i||f.name!==`frame_${String(i+1).padStart(4,'0')}.png`||
      f.rgbaOffset!==i*frameBytes||f.rgbaBytes!==frameBytes||!sha(f.rgbaSha256)||!sha(f.sourceSha256)))
    throw new Error('Invalid video source/byte identities');
  return a;
}
