import {withTimeout} from './qualification_lifecycle.mjs';

export function queuePlan(atlas,count) {
  const bytes=atlas.columns*atlas.rows*32*4*count;
  if(!Number.isSafeInteger(count)||count<2||count>30||!Number.isSafeInteger(bytes)||bytes<1||bytes>128*1024*1024)
    throw new Error('Continuous queue requires 2–30 frames and at most 128 MiB prepared input');
  return {frames:count,inputBytes:bytes,depth:1,frameTimeoutMs:10000,burstTimeoutMs:30000};
}

/** All inputs ready; retain outputs and serialize only after the finite burst. */
export async function runDepthOneQueue({inputs,fitFrame,check=()=>{},failure=new Promise(()=>{}),cancel=()=>{},frameTimeoutMs=10000,burstTimeoutMs=30000}) {
  if(inputs.length<2||inputs.length>30)throw new Error('Continuous queue frame bound exceeded');
  const records=[];let active=0,peak=0,stopped=false;
  const stop=()=>{stopped=true;return cancel();};
  const submit=index=>{
    check();if(stopped)throw new Error('Frame queue stopped');if(active)throw new Error('Concurrent frame refill');
    const submittedAt=performance.now();++active;peak=Math.max(peak,active);
    return Promise.race([withTimeout(Promise.resolve().then(()=>{check();if(stopped)throw new Error('Frame queue stopped');return fitFrame(inputs[index],index);}),frameTimeoutMs,stop),failure])
      .then(actual=>{--active;return {index,submittedAt,completedAt:performance.now(),actual};},e=>{--active;throw e;});
  };
  const run=async()=>{
    let pending=submit(0);
    for(let index=0;index<inputs.length;index++){
      const record=await pending;check();if(stopped)throw new Error('Frame queue stopped');records.push(record);
      if(index+1<inputs.length)pending=submit(index+1);
    }
    return {records,peakOutstandingFrames:peak,warmSequenceMs:records.at(-1).completedAt-records[1].submittedAt,
      refillGapsMs:records.slice(1).map((r,i)=>r.submittedAt-records[i].completedAt)};
  };
  try{return await withTimeout(run(),burstTimeoutMs,stop);}
  catch(e){stopped=true;Promise.resolve().then(cancel).catch(()=>{});throw e;}
}
