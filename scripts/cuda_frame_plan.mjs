import {planFixtures} from './cuda_fixture_plan.mjs';

/** Validate the entire finite sequence before native discovery/allocation. */
export function planFrames(plan,inputs) {
  const integer=(n,max)=>Number.isSafeInteger(n)&&n>=1&&n<=max;
  if(!plan||!['float32-direct','binary64-direct'].includes(plan.mode)||![16,32].includes(plan.tileMiB)||
    !Array.isArray(plan.inputs)||plan.inputs.length<1||plan.inputs.length>5||
    plan.inputs.some(p=>typeof p!=='string'||!p)||inputs.length!==plan.inputs.length||
    !Array.isArray(plan.frameOrder)||!integer(plan.frameOrder.length,6)||
    plan.frameOrder.some(i=>!Number.isSafeInteger(i)||i<0||i>=inputs.length))throw new Error('Invalid bounded frame plan');
  const l=plan.limits;
  if(!l||!integer(l.maxFrames,6)||!integer(l.maxCells,307200)||!integer(l.maxWork,18000000000)||
    !integer(l.timeoutMs,10000)||plan.frameOrder.length>l.maxFrames)throw new Error('Invalid frame limits');
  const first=inputs[0],identity=d=>JSON.stringify([d.columns,d.rows,d.sampleWidth,d.sampleHeight,
    d.foregroundCandidates,d.backgroundCandidates,d.codes,d.palette,d.masks.map(m=>Array.from(m))]);
  if(first.columns*first.rows>51200||first.sampleWidth!==4||first.sampleHeight!==8||inputs.some(d=>identity(d)!==identity(first)))
    throw new Error('Frame session requires one fixed bounded geometry, atlas, palette and search');
  if(plan.requireColdReference===false&&first.columns*first.rows>512)throw new Error('Cold reference skip is limited to 512-cell smoke diagnostics');
  const sequence=plan.frameOrder.map((i,n)=>({...inputs[i],name:`frame-${n}`}));
  return planFixtures(sequence,{cases:sequence.map(d=>d.name),repeats:1,tileMiB:plan.tileMiB,
    maxRuns:l.maxFrames,maxCells:l.maxCells,maxWork:l.maxWork,timeoutMs:l.timeoutMs}).summary;
}
