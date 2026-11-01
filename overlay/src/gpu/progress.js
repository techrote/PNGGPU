/** Pure, testable elapsed-throughput and ETA reporting. All rates are derived
 * from completed terminal cells; no speculative in-flight work is counted. */
export function progressSnapshot({completedCells,totalCells,elapsedMs,glyphCount=0,workUnits=null}){
  if (!Number.isFinite(totalCells) || totalCells<=0) throw new RangeError('totalCells must be positive');
  const done=Math.min(totalCells,Math.max(0,Number.isFinite(completedCells)?completedCells:0));
  const duration=Math.max(0,Number.isFinite(elapsedMs)?elapsedMs:0);
  const cellsPerSecond=duration>0&&done>0?done*1000/duration:null;
  const remainingMs=cellsPerSecond&&done<totalCells?(totalCells-done)*1000/cellsPerSecond:done===totalCells?0:null;
  const estimatedWorkUnitsPerSecond=cellsPerSecond&&Number.isFinite(workUnits)?cellsPerSecond*workUnits/totalCells:null;
  const glyphTestsPerSecond=cellsPerSecond&&glyphCount>0?cellsPerSecond*glyphCount:null;
  return {completedCells:done,totalCells,elapsedMs:duration,percent:done*100/totalCells,
    cellsPerSecond,remainingMs,estimatedWorkUnitsPerSecond,glyphTestsPerSecond};
}
export function humanRate(n){
  if(!Number.isFinite(n)||n===null)return '—';
  if(n>=1e12)return (n/1e12).toFixed(2)+'T';
  if(n>=1e9)return (n/1e9).toFixed(2)+'B';
  if(n>=1e6)return (n/1e6).toFixed(2)+'M';
  if(n>=1e3)return (n/1e3).toFixed(1)+'K';
  return n.toFixed(1);
}
export function etaText(ms){
  if(!Number.isFinite(ms)||ms===null)return 'ETA —';
  if(ms<=0)return 'Done';
  const seconds=Math.round(ms/1000);
  return seconds>=60?`ETA ${Math.floor(seconds/60)}m ${seconds%60}s`:`ETA ${seconds}s`;
}
