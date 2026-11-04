import {PhotographicCudaFitter} from '../overlay/src/gpu/cuda.js';
/** Validate post-cleanup discovery; a failed probe must stop the outer matrix. */
export function checkedAfterInfo(info,before,precision) {
  const checked=new PhotographicCudaFitter(info,{expectedPrecision:precision}).info;
  for(const key of ['index','name','computeCapability','totalMemoryBytes'])
    if(checked.device[key]!==before.device[key])throw new Error('CUDA device changed during sequence');
  return checked;
}
