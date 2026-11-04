import {setTimeout as delay} from 'node:timers/promises';
import {driverEventsSinceAsync} from './cuda_driver_events.mjs';

/** One bounded asynchronous log query at a time; no GPU/settings operations. */
export function createDriverMonitor(since,{query=driverEventsSinceAsync,pollMs=250,maxAgeMs=12000}={}) {
  if(!Number.isFinite(Date.parse(since))||pollMs<10||maxAgeMs<100)throw new Error('Invalid driver monitor limits');
  const abort=new AbortController(),samples=[];let stopped=false,error,lastChecked=Date.now(),rejectFailure,readyResolve,readyReject;
  const failure=new Promise((_,reject)=>{rejectFailure=reject;});failure.catch(()=>{});
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  const fail=e=>{if(!error&&!stopped){error=e;rejectFailure(e);readyReject(e);abort.abort();}};
  const assertHealthy=()=>{if(error)throw error;if(Date.now()-lastChecked>maxAgeMs){fail(new Error('Driver monitor stale; queue stopped'));throw error;}};
  const watchdog=setInterval(()=>{try{assertHealthy();}catch{}},Math.min(pollMs,250));
  const loop=(async()=>{
    try {while(!stopped){
      const started=Date.now(),result=await query(since,{signal:abort.signal});
      if(stopped)break;
      if(!result||!Array.isArray(result.events))throw new Error('Invalid driver monitor response');
      lastChecked=Date.now();samples.push({started:new Date(started).toISOString(),checkedAt:new Date(lastChecked).toISOString(),queryMs:lastChecked-started,...result});
      if(samples.length>512)throw new Error('Driver monitor sample bound exceeded');
      if(result.events.length)throw new Error('New GPU driver error; queue stopped');
      readyResolve(result);await delay(pollMs,undefined,{signal:abort.signal});
    }}catch(e){if(!stopped)fail(e);}finally{clearInterval(watchdog);}
  })();
  return {ready,failure,assertHealthy,snapshot:()=>({pollMs,maxAgeMs,samples:[...samples],error:error?.message}),
    async stop(){stopped=true;abort.abort();clearInterval(watchdog);await loop;}};
}
