/** Pure comparison/formatting helpers for the GPU-003 benchmark and JSON report. */
export const elapsed=(start,end)=>end-start;
export const milliseconds=n=>n===null||n===undefined?'—':`${n.toFixed(1)} ms`;
export const decimal=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:1}):'—';
export const bytes=n=>{
  if(n===null||n===undefined)return '—';
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${(n/1024).toFixed(1)} KiB`;
  return `${(n/(1024*1024)).toFixed(2)} MiB`;
};
export const ratio=(numerator,denominator)=>
  numerator!==null&&Number.isFinite(numerator)&&Number.isFinite(denominator)&&denominator>0?numerator/denominator:null;
export const median=values=>{
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  const mid=sorted.length>>1;
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
};
export function compareCells(cpu,gpu){
  if(!cpu)return {glyph:null,foreground:null,background:null,changedCells:null,firstChangedCell:null};
  const n=Math.max(cpu.chosen.length,gpu.chosen.length);
  let glyph=0,foreground=0,background=0,changedCells=0,firstChangedCell=null;
  for(let i=0;i<n;i++){
    const a=cpu.chosen[i]!==gpu.chosen[i],b=cpu.fg[i]!==gpu.fg[i],c=cpu.bg[i]!==gpu.bg[i];
    if(a)glyph++;if(b)foreground++;if(c)background++;
    if(a||b||c){changedCells++;if(firstChangedCell===null)firstChangedCell=i;}
  }
  return {glyph,foreground,background,changedCells,firstChangedCell};
}
export function compareAnsi(cpu,gpu){
  if(!cpu)return {mismatches:null,firstMismatch:null};
  let mismatches=0,firstMismatch=null;
  for(let i=0;i<Math.max(cpu.length,gpu.length);i++){
    if(cpu[i]!==gpu[i]){mismatches++;if(firstMismatch===null)firstMismatch=i;}
  }
  return {mismatches,firstMismatch};
}
/** Shared preparation is measured once, then charged identically to both paths. */
export function summarizeTimings({prepMs,cpuFitMs,gpuFitMs,cpuOutputMs,gpuOutputMs,gpuRuns=[]}){
  const cpuTotalMs=cpuFitMs===null?null:prepMs+cpuFitMs+cpuOutputMs;
  const gpuTotalMs=prepMs+gpuFitMs+gpuOutputMs;
  return {cpuPrepMs:cpuFitMs===null?null:prepMs,gpuPrepMs:prepMs,cpuFitMs,gpuFitMs,
    cpuOutputMs:cpuFitMs===null?null:cpuOutputMs,gpuOutputMs,cpuTotalMs,gpuTotalMs,
    fitSpeedup:cpuFitMs===null?null:ratio(cpuFitMs,gpuFitMs),
    totalSpeedup:cpuTotalMs===null?null:ratio(cpuTotalMs,gpuTotalMs),
    gpuRepeatTimesMs:gpuRuns,gpuMedianMs:median(gpuRuns)};
}

/** Tolerate older/cached GPU-002 profiler results with no stage timing object. */
export const gpuProfileStages=result=>result?.gpuStats?.timing??result?.gpuRender?.stageTimings??{};
