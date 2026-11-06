import {videoPlan} from './cuda_video_plan.mjs';
/** Larger requested CUDA tile targets retain the same finite frame/work limits.
 * Native 128 MiB projection, tile-count and admission caps remain authoritative.
 */
export function videoTilePlan(atlas,count,mode,tileMiB) {
  if(![16,32,64,128].includes(tileMiB))throw new Error('CUDA video tile target must be 16/32/64/128 MiB');
  const scope=videoPlan(atlas,count,mode,Math.min(tileMiB,32));
  return {...scope,tileMiB,tiles:[Math.max(1,Math.floor(tileMiB*1024*1024/(atlas.masks.length*16)))]};
}
