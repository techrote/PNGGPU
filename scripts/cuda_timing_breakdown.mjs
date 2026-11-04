/** Warm-frame interval accounting. Signed residuals are not pure CPU/HTTP time. */
export function warmTimingBreakdown(frame) {
  const t=frame?.stats?.timing;
  if(frame?.stats?.sessionReused!==true||t?.nativeInitMs!==0||t?.atlasUploadMs!==0)
    throw new Error('Overhead accounting requires a warm reused frame');
  const number=(value,name)=>{
    if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`Unavailable/invalid ${name}`);
    return value;
  };
  const fitMs=number(frame.fitMs,'fitMs'),packingMs=number(t.tilePackMs,'tilePackMs'),decodeMs=number(t.decodeCellsMs,'decodeCellsMs');
  const nativeTotalMs=number(t.nativeTotalMs,'nativeTotalMs'),bridgeMs=number(t.bridgeRoundTripMs,'bridgeRoundTripMs');
  const projectionMs=number(t.gpuProjectionMs,'gpuProjectionMs'),selectionMs=number(t.gpuSelectionMs,'gpuSelectionMs');
  const transferMs=number(t.uploadMs,'uploadMs')+number(t.readbackMs,'readbackMs');
  return {fitMs,packingMs,projectionMs,selectionMs,transferMs,decodeMs,nativeTotalMs,bridgeMs,
    nativeResidualMs:nativeTotalMs-projectionMs-selectionMs-transferMs,
    bridgeRemainderMs:bridgeMs-nativeTotalMs,
    otherFitMs:fitMs-packingMs-bridgeMs-decodeMs};
}
