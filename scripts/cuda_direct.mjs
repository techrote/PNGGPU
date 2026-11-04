import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {CUDA_LIMITS,MAX_JSON_BYTES,BridgeError,NativeSession,probeWorker,validateInitPacket,validateTilePacket} from './cuda_worker_session.mjs';

/** Private Node-to-child transport. Logical operations match the HTTP adapter;
 * no sockets, Response objects or browser privileges are involved. One owner,
 * one retained worker, one pending request; callers retain immutable input until
 * request completion. The shared session bounds its queued pipe writes.
 */
export function createCudaDirectTransport({executable,device=null,arithmeticMode='float32-guarded-binary64',spawnProcess=spawn,
  operationTimeoutMs=10000,infoTimeoutMs=10000,idleTimeoutMs=120000}={}) {
  if(typeof executable!=='string'||!executable||!(device===null||Number.isSafeInteger(device)&&device>=0)||
    !['float32-guarded-binary64','binary64-direct','float32-direct','float16-mixed'].includes(arithmeticMode)||
    ![operationTimeoutMs,infoTimeoutMs,idleTimeoutMs].every(x=>Number.isSafeInteger(x)&&x>0))throw new Error('Invalid direct CUDA transport options');
  let entry=null,closed=false,probeAbort=null,probePromise=null;
  const children=new Map();
  const trackedSpawn=(...args)=>{
    const child=spawnProcess(...args);
    const exit=new Promise(resolve=>child.once('close',()=>{children.delete(child);resolve();}));
    children.set(child,exit);return child;
  };
  const live=(e,signal)=>{if(closed||e.state==='closed'||signal?.aborted)throw signal?.reason??new Error('Direct CUDA session closed');};
  const closeEntry=(e,error)=>{
    if(!e)return Promise.resolve();if(e.closing)return e.closing;
    e.state='closed';clearTimeout(e.idle);
    e.closing=Promise.resolve(e.worker?.close(error)).then(()=>{if(entry===e)entry=null;});return e.closing;
  };
  const arm=e=>{clearTimeout(e.idle);e.idle=setTimeout(()=>closeEntry(e,new BridgeError(408,'Direct CUDA session expired')),idleTimeoutMs);e.idle.unref?.();};
  const buffer=body=>{
    if(!(body instanceof Uint8Array)||body.byteLength>CUDA_LIMITS.maxMessageBytes)throw new BridgeError(400,'Invalid CUDA binary payload');
    return Buffer.from(body.buffer,body.byteOffset,body.byteLength);
  };
  return {
    name:'direct-pipe',
    async request(path,{method='GET',body,signal,limit=MAX_JSON_BYTES,binary=false}={}) {
      if(closed)throw new Error('Direct CUDA transport is closed');
      if(signal?.aborted)throw signal.reason??new Error('Direct CUDA request cancelled');
      if(path==='/api/cuda/info'&&method==='GET'){
        if(probePromise)throw new Error('Direct CUDA probe already active');
        probeAbort=new AbortController();const abort=()=>probeAbort?.abort();signal?.addEventListener('abort',abort,{once:true});
        try{probePromise=probeWorker({executable,device,arithmeticMode,spawnProcess:trackedSpawn,timeoutMs:infoTimeoutMs,signal:probeAbort.signal});return await probePromise;}
        finally{signal?.removeEventListener('abort',abort);probeAbort=null;probePromise=null;}
      }
      if(path==='/api/cuda/session'&&method==='POST'){
        if(entry)throw new BridgeError(409,'Direct CUDA session is busy');
        const payload=buffer(body),config=validateInitPacket(payload),e={id:randomBytes(16).toString('base64url'),state:'initializing',config};entry=e;
        const abort=()=>{void closeEntry(e,new Error('Direct CUDA request cancelled'));};signal?.addEventListener('abort',abort,{once:true});
        try{
          e.worker=new NativeSession({executable,device,arithmeticMode,spawnProcess:trackedSpawn,timeoutMs:operationTimeoutMs,onFailure:error=>closeEntry(e,error)});
          const response=await e.worker.request(payload,8+MAX_JSON_BYTES);
          if(response.payload.length!==response.dataOffset)throw new Error('Unexpected CUDA initialization data');
          live(e,signal);e.state='ready';arm(e);return {...response.metadata,sessionId:e.id};
        }catch(error){await closeEntry(e,error);throw error;}finally{signal?.removeEventListener('abort',abort);}
      }
      const match=/^\/api\/cuda\/session\/([A-Za-z0-9_-]{16,128})(\/tile)?$/.exec(path);
      if(!match||entry&&entry.id!==match[1])throw new Error('Unknown direct CUDA session');
      if(!match[2]&&method==='DELETE'){await closeEntry(entry);return {ok:true};}
      if(!match[2]||method!=='POST'||!binary)throw new Error('Unknown direct CUDA operation');
      const e=entry;if(!e||e.state!=='ready')throw new BridgeError(409,'Direct CUDA session is closed or busy');
      e.state='busy';clearTimeout(e.idle);
      const abort=()=>{void closeEntry(e,new Error('Direct CUDA request cancelled'));};signal?.addEventListener('abort',abort,{once:true});
      try{
        const payload=buffer(body),count=validateTilePacket(payload,e.config);
        const response=await e.worker.request(payload,Math.min(limit,8+MAX_JSON_BYTES+count*16));
        if(response.metadata.cellCount!==count||response.payload.length-response.dataOffset!==count*16)throw new Error('Unexpected CUDA cell count');
        live(e,signal);e.state='ready';arm(e);return response.payload;
      }catch(error){await closeEntry(e,error);throw error;}finally{signal?.removeEventListener('abort',abort);}
    },
    async close(){closed=true;probeAbort?.abort();await closeEntry(entry);await probePromise?.catch(()=>{});await Promise.all([...children.values()]);}
  };
}
