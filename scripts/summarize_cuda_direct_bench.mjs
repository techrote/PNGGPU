/** Offline receipt audit; never starts a worker or submits GPU work. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {warmTimingBreakdown,packingTimingBreakdown} from './cuda_timing_breakdown.mjs';
import '../PNG2ANSI/src/core.js';
const [packed,live,blocked,output]=process.argv.slice(2);
if(!output)throw Error('Usage: PACKED_DIRECTORY LIVE_DIRECTORY BLOCKED_DIRECTORY OUTPUT_DIRECTORY');
const hash=b=>createHash('sha256').update(b).digest('hex');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const stats=a=>{const s=[...a].sort((a,b)=>a-b);return {mean:mean(a),median:s[Math.floor(s.length/2)],p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)};};
const summary={schema:'pnggpu-direct-path-audit-v1',qualificationAccepted:false,frames:0,cells:0,sessions:[]};
const rows=[];
for(const [phase,dir,expected] of [['packed',packed,12],['live',live,18],['blocked',blocked,6]]){
  const matrix=await load(resolve(dir,'matrix.json'));
  assert.equal(matrix.benchmarkCompleted,true);assert.equal(matrix.error,undefined);assert.equal(matrix.sessions.length,expected);
  assert.deepEqual(matrix.driverAfter.events,[]);
  for(const item of matrix.sessions){
    const p=resolve(dir,basename(item.output)),bytes=await readFile(p),v=JSON.parse(bytes);
    assert.equal(hash(bytes),item.sha256);assert.equal(v.benchmarkCompleted,true);assert.equal(v.error,undefined);
    assert.equal(v.sourceStatus,'');assert.deepEqual(v.cleanupErrors,[]);assert.equal(v.frames.length,30);
    assert.equal(v.frameDepth,1);assert.equal(v.queueTiming.peakOutstandingFrames,1);
    assert.equal(v.qualificationAccepted,false);
    if(phase!=='packed')assert.equal(v.packetAllocation,'retained-per-frame');
    else assert.equal(v.packing,'prepacked'); // Older receipt predates the explicit allocation label.
    assert.deepEqual(v.driverFinal.events,[]);assert.deepEqual(v.driverBaseline.events,[]);
    assert(v.driverMonitor.samples.length);for(const d of v.driverMonitor.samples){assert.equal(d.supported,true);assert.deepEqual(d.events,[]);}
    for(const d of [v.deviceBefore,v.deviceAfter]){assert.equal(d.device.name,'NVIDIA GeForce GTX 1650 SUPER');assert.equal(d.device.index,0);assert.equal(d.device.computeCapability,'7.5');assert.equal(d.limits.memoryReserveBytes,2147483648);assert.equal(d.device.kernelExecTimeoutEnabled,true);}
    assert(v.processes.every(p=>p.exited));assert.equal(v.processes.filter(p=>p.args.includes('--stdio')).length,1);
    const bin=await readFile(resolve(dir,basename(v.outputsPath)));assert.equal(hash(bin),v.outputsSha256);assert.equal(bin.length,v.outputsBytes);
    const ref=(await load(`qualification/gtx1650super-motion${item.geometry==='160x80'?'':'-cropped'}/summary.json`)).sessions.find(s=>s.key===`comparison-${item.geometry.split('x')[0]}-${v.mode}-32`);
    assert(ref);const warm=[];
    for(const f of v.frames){
      const b=bin.subarray(f.offset,f.offset+f.cells*4);assert.equal(hash(b),f.tupleSha256);
      assert.equal(f.tupleSha256,ref.frames[f.index].tupleSha256);assert.equal(f.ansiSha256,ref.frames[f.index].ansiSha256);
      const chosen=new Uint16Array(f.cells),fg=new Uint8Array(f.cells),bg=new Uint8Array(f.cells);
      for(let i=0;i<f.cells;i++){chosen[i]=b.readUInt16LE(i*4);fg[i]=b[i*4+2];bg[i]=b[i*4+3];}
      const ansi=PNG2ANSI.ansiBytes({codes:v.batch.atlas.codes},{chosen,fg,bg},v.batch.config);assert.equal(hash(ansi),f.ansiSha256);
      assert.equal(f.stats.sessionReused,f.index>0);assert.equal(f.stats.frameIndex,f.index);
      assert.equal(f.stats.inFlightTiles,1);assert.equal(f.stats.peakInFlightTiles,1);assert.equal(f.stats.allocatedBytes,f.stats.nativeBufferBytes);
      assert.equal(f.stats.recoveredCells,0);assert.equal(f.stats.directCells,f.cells);
      let t={};if(f.index){
        t=phase==='packed'?warmTimingBreakdown(f):packingTimingBreakdown(f);
        const closure=t.packingMs+t.nativeTotalMs+t.bridgeRemainderMs+t.decodeMs+t.otherFitMs-t.fitMs;
        assert(Math.abs(closure)<1e-8);warm.push(t);
      }
      rows.push({phase,geometry:item.geometry,mode:v.mode,route:item.route,index:f.index,fitMs:f.fitMs,...t,
        tupleSha256:f.tupleSha256,ansiSha256:f.ansiSha256,workerPid:f.workerPid});
      summary.frames++;summary.cells+=f.cells;
    }
    const [columns,cellRows]=item.geometry.split('x').map(Number),key=`${phase}-${item.geometry}-${v.mode}-${item.route}`;
    const session={key,phase,geometry:item.geometry,mode:v.mode,route:item.route,sourceCommit:v.sourceCommit,worker:v.worker,
      rawPath:p,rawSha256:hash(bytes),outputsSha256:v.outputsSha256,batchSha256:v.batchSha256,
      inputPacketDigest:v.inputPacketDigest,inputPackets:v.inputPackets,initPacketSha256:v.initPacketSha256,
      transport:v.transport,packing:v.packing,packetAllocation:v.packetAllocation,livePackControl:v.livePackControl,
      preparedHostBytes:v.preparedHostBytes,packetPreparationMs:v.packetPreparationMs,
      frameRgbaSha256:v.batch.frames.slice(0,30).map(f=>f.rgbaSha256),config:v.batch.config,
      deviceBefore:v.deviceBefore,deviceAfter:v.deviceAfter,driverMonitor:v.driverMonitor,processes:v.processes,
      tileMiB:v.tileMiB,tileCells:v.frames[0].stats.tileCells,nativeBufferBytes:v.frames[0].stats.nativeBufferBytes,
      peakOutstandingFrames:v.queueTiming.peakOutstandingFrames,warmFPS:v.queueTiming.warmFramesPerSecond,
      fit:stats(warm.map(t=>t.fitMs)),warmOver33_333ms:warm.filter(t=>t.fitMs>1000/30).length,
      maxRefillGapMs:Math.max(...v.queueTiming.refillGapsMs),mean:Object.fromEntries(Object.keys(warm[0]).map(k=>[k,mean(warm.map(t=>t[k]))])),
      nativePacking:phase==='packed'?null:stats(warm.map(t=>t.nativePackingMs)),
      frameCount:v.frames.length,cellCount:columns*cellRows*v.frames.length,outputArchiveMatch:true,independentAnsiReencodeMatch:true};
    summary.sessions.push(session);
  }
}
for(const s of summary.sessions){
  if(s.phase!=='blocked'&&s.route!=='native'){
    const peer=summary.sessions.find(p=>p.phase===s.phase&&p.geometry===s.geometry&&p.mode===s.mode&&p.route!==s.route&&p.route!=='native');
    assert(peer);for(const field of ['inputPacketDigest','initPacketSha256','batchSha256'])assert.equal(s[field],peer[field]);
    assert.deepEqual(s.inputPackets,peer.inputPackets);
    assert.deepEqual(s.frameRgbaSha256,peer.frameRgbaSha256);assert.deepEqual(s.worker,peer.worker);
  }
}
assert.equal(summary.frames,1080);assert.equal(summary.cells,17568000);
await mkdir(output,{recursive:true});
await writeFile(resolve(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];
await writeFile(resolve(output,'frames.csv'),headers.join(',')+'\n'+rows.map(r=>headers.map(k=>r[k]??'').join(',')).join('\n')+'\n');
for(const s of summary.sessions)console.log(JSON.stringify({key:s.key,FPS:s.warmFPS,fit:s.fit,mean:s.mean}));
console.log(`Audited ${summary.frames} frames / ${summary.cells} cells; packet controls and all tuple/ANSI archives match.`);
