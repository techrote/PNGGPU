/**
 * GPU-007 memory estimator / admission policy.
 * Standard WebGPU does not expose dedicated physical VRAM or residency.
 * This is a conservative estimate of our declared buffers plus browser backing
 * images and an explicit uncertainty allowance; it is NOT actual free VRAM.
 */
export const MiB=1024**2;
export const GiB=1024**3;
export const GPU_WARNING_RESERVE_GIB=4;
export const GPU_HARD_RESERVE_GIB=2;
export const VRAM_UI_MIN_GIB=1;
export const VRAM_UI_MAX_GIB=128;

const finiteInteger=(value,name)=>{
  if(!Number.isSafeInteger(value)||value<0)throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
};
export function validateDeclaredVramGiB(input){
  const gib=typeof input==='number'?input:Number(String(input??'').trim());
  if(input===null||input===undefined||input===''||!Number.isFinite(gib)||gib<VRAM_UI_MIN_GIB||gib>VRAM_UI_MAX_GIB)
    throw new RangeError(`GPU VRAM: enter the actual installed GPU capacity, ${VRAM_UI_MIN_GIB}–${VRAM_UI_MAX_GIB} GiB. Standard WebGPU cannot read dedicated VRAM reliably.`);
  if(Math.abs(gib*2-Math.round(gib*2))>1e-9)
    throw new RangeError('GPU VRAM: use whole or half-GiB steps (e.g. 4, 8, 24).');
  return gib;
}

/** Mirrors createBuffer() sizes used in PhotographicWebGpuFitter.fit().
 * Physical tile size is auto-clamped to WebGPU device limits.
 * There is one reusable tile buffer set per in-flight slot; do NOT multiply by tileCount.
 */
export function estimateGpuMemory({plan,columns,rows,sampleWidth,sampleHeight,glyphCount,
    sourceWidth,sourceHeight,streamedSamples=false,previews=true,captureGpuTimestamps=false,timestampsAvailable=false,maxQuerySetSize=8192}){
  if(!plan||!Number.isSafeInteger(plan.tileCells)||plan.tileCells<1)throw new RangeError('Valid GPU tile plan required for VRAM estimation');
  for(const [key,value] of Object.entries({columns,rows,sampleWidth,sampleHeight,glyphCount,sourceWidth,sourceHeight}))
    if(!Number.isSafeInteger(value)||value<1)throw new RangeError(`Invalid ${key} for VRAM estimate`);
  const samples=sampleWidth*sampleHeight;
  const timestampCount=plan.tileCount*4;
  const timestampEnabled=Boolean(captureGpuTimestamps&&timestampsAvailable&&timestampCount<=maxQuerySetSize);
  const depth=plan.inFlightTiles??1;
  const components={
    uniforms:32*depth,
    tileRaster:plan.rasterBufferBytes*depth,
    glyphMasks:glyphCount*samples*4,
    glyphStats:glyphCount*16,
    ansiPalette:16*16,
    projection:plan.projectionBufferBytes*depth,
    tileSelections:plan.tileCells*16*depth,
    tileReadback:plan.tileCells*16*depth,
    timestampResolve:timestampEnabled?timestampCount*8:0,
    timestampReadback:timestampEnabled?timestampCount*8:0
  };
  Object.entries(components).forEach(([key,value])=>finiteInteger(value,key));
  const gpuBufferBytes=Object.values(components).reduce((a,b)=>a+b,0);
  const fullImageBytes=sourceWidth*sourceHeight*4;
  const sampledImageBytes=streamedSamples?
    // Streamed raster allocates at most one RGBA image and one per-slot packed
    // staging image; never a full (columns*sampleWidth)*(rows*sampleHeight) canvas.
    plan.tileCells*sampleWidth*sampleHeight*4*depth:
    columns*sampleWidth*rows*sampleHeight*4;
  const previewPixels=columns*8*rows*16;
  const previewImageBytes=previews && previewPixels<=16_777_216?previewPixels*4:0;
  // Browser canvas2D may be GPU-backed or CPU-backed; assume two copies of
  // source, sampled working data and the bounded preview.
  const browserBackingEstimateBytes=2*(fullImageBytes+sampledImageBytes+previewImageBytes);
  // Extra headroom for opaque implementation allocations and alignment; this
  // is NOT a measurement of browser/driver memory or other applications.
  const uncertaintyAllowanceBytes=Math.max(64*MiB,Math.ceil((gpuBufferBytes+browserBackingEstimateBytes)*0.25));
  const estimatedWorkingSetBytes=gpuBufferBytes+browserBackingEstimateBytes+uncertaintyAllowanceBytes;
  for(const [key,value] of Object.entries({gpuBufferBytes,browserBackingEstimateBytes,
    uncertaintyAllowanceBytes,estimatedWorkingSetBytes}))finiteInteger(value,key);
  return {schema:'png2ansi-memory-estimate-v1',components,gpuBufferBytes,fullImageBytes,
    browserBackingEstimateBytes,uncertaintyAllowanceBytes,estimatedWorkingSetBytes,
    streamedSamples,previews:previewImageBytes>0,tilePlan:plan,inFlightTiles:depth,timestampEnabled,notes:'Estimate of this workbench only; not actual VRAM residency or free VRAM. Includes unverified browser image backing and an uncertainty allowance.'};
}

/** Hard gate: > (declared VRAM - 2 GiB) cannot be overridden.
 * Warning gate: > (declared VRAM - 4 GiB) requires explicit confirmation.
 * At exactly 4 GiB, every positive workload triggers a warning, as requested.
 */
export function evaluateVramBudget(estimate, declaredVramGiB){
  const gib=validateDeclaredVramGiB(declaredVramGiB);
  const needed=estimate?.estimatedWorkingSetBytes;
  if(!Number.isSafeInteger(needed)||needed<0)throw new RangeError('Missing valid GPU working-set estimate');
  const totalBytes=Math.round(gib*GiB);
  const warningThresholdBytes=Math.max(0,totalBytes-GPU_WARNING_RESERVE_GIB*GiB);
  const hardThresholdBytes=Math.max(0,totalBytes-GPU_HARD_RESERVE_GIB*GiB);
  const status=needed>hardThresholdBytes?'blocked':needed>warningThresholdBytes?'warning':'safe';
  return {status,neededBytes:needed,declaredVramGiB:gib,totalBytes,warningThresholdBytes,hardThresholdBytes,
    projectedFreeBytes:Math.max(0,totalBytes-needed),
    // This is free capacity against the *declared* total, not actual OS free VRAM.
    source:'manual VRAM capacity; estimated application allocations; not live GPU telemetry'};
}

export function vramDecisionMessage(budget){
  const mib=n=>(n/MiB).toFixed(1)+' MiB';
  if(budget.status==='blocked')return `BLOCKED: estimated GPU working set ${mib(budget.neededBytes)} exceeds the hard limit ${mib(budget.hardThresholdBytes)} (declared ${budget.declaredVramGiB} GiB minus 2 GiB). Reduce parameters/tile size. Override is not available.`;
  if(budget.status==='warning')return `CAUTION: estimated GPU working set ${mib(budget.neededBytes)} exceeds the warning threshold ${mib(budget.warningThresholdBytes)} (declared ${budget.declaredVramGiB} GiB minus 4 GiB). Confirm this job to proceed.`;
  return `WITHIN ESTIMATED BUDGET: ${mib(budget.neededBytes)}; warning threshold ${mib(budget.warningThresholdBytes)}, hard limit ${mib(budget.hardThresholdBytes)}.`;
}
