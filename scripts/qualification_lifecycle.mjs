export async function withTimeout(operation,timeoutMs,onTimeout=()=>{}) {
  let timer;
  try {return await Promise.race([operation,new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      // Cleanup may itself fail; the primary timeout must still be reported.
      Promise.resolve().then(onTimeout).catch(()=>{});
      reject(new Error('Qualification operation timed out; scope stopped'));
    },timeoutMs);
  })]);}finally{clearTimeout(timer);}
}
export async function cleanupSteps(steps,timeoutMs) {
  const errors=[];
  for(const [name,action] of steps)try{await withTimeout(Promise.resolve().then(action),timeoutMs);}
  catch(error){errors.push({step:name,error:error.message});}
  return errors;
}
