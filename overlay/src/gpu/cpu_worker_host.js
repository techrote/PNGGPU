/** CPU oracle worker launch helper. Works with the locally served module worker.
 * Worker startup and input cloning are included in wallMs, not shared prep. */
export function runCpuReferenceInWorker({pixels,masks,config,palette,onProgress=()=>{},WorkerClass=globalThis.Worker,workerUrl=new URL('./reference_photo.worker.js?gpu005',import.meta.url)}) {
  if(!WorkerClass) return Promise.reject(new Error('A module Web Worker is required for live CPU progress'));
  const t=performance.now();
  return new Promise((resolve,reject)=>{
    let worker;
    try{worker=new WorkerClass(workerUrl,{type:'module'});}
    catch(error){reject(error);return;}
    let settled=false;
    const finish=(error,result)=>{
      if(settled)return;settled=true;
      worker.terminate();
      if(error)reject(error);
      else resolve({...result,wallMs:performance.now()-t});
    };
    worker.onmessage=({data})=>{
      if(data?.type==='progress'){
        try{onProgress(data);}catch(error){/* Reporting must never break the parity oracle. */}
      }else if(data?.type==='done'){
        try{onProgress({type:'progress',completedCells:data.totalCells,totalCells:data.totalCells,elapsedMs:data.computeMs});}catch{}
        finish(null,{cells:data.cells,computeMs:data.computeMs});
      }else if(data?.type==='error'){
        finish(new Error(`CPU oracle worker: ${data.message}${data.stack?'\n'+data.stack:''}`));
      }
    };
    worker.onerror=(event)=>finish(new Error(`CPU oracle worker failed: ${event.message||'unknown error'}`));
    worker.onmessageerror=()=>finish(new Error('CPU oracle worker failed to clone its result'));
    try{worker.postMessage({type:'fit',pixels,masks,config,palette});}
    catch(error){finish(error);}
  });
}
