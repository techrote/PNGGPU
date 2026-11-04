import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PhotographicCudaFitter} from '../src/gpu/cuda.js';
import {estimateGpuMemory,evaluateVramBudget,validateDeclaredVramGiB} from '../src/gpu/memory.js';
import {requiresStreamedSamples,PREVIEW_MAX_PIXELS} from '../src/gpu/streamed_samples.js';
import {validateWorkbenchInputs,WORKBENCH_LIMITS} from '../src/gpu/workload.js';
import {milliseconds,bytes,gpuProfileStages,compareCells,compareAnsi} from '../src/gpu/metrics.js';

const html=await readFile(new URL('../experiments/webgpu/photographic.html',import.meta.url),'utf8');
function declaration(name){
  const found=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(found,`workbench function ${name}`);return found[0];
}
function element(value=''){
  return {value,checked:false,disabled:false,textContent:'',hidden:true,children:[],
    replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}};
}
const info={schema:'pnggpu-cuda-info-v1',available:true,backend:'cuda',protocolVersion:1,
  precision:'float32-no-fma',device:{name:'Test Turing',computeCapability:'7.5',index:0,
    totalMemoryBytes:24*1024**3,freeMemoryBytes:22*1024**3},limits:{
    maxMessageBytes:128*1024**2,maxTileCells:65536,maxSamplesPerCell:2048,maxGlyphCount:65535,
    maxProjectionBytes:128*1024**2,maxPixelBytes:64*1024**2,maxProjectionWork:16777216}};

function conversionContext(fit){
  const config={canvas:{columns:1,rows:1,sample_width:1,sample_height:1,cell_width:8,cell_height:16},vocabulary:'test'};
  const bitmap={width:1,height:1,closed:false,close(){this.closed=true;}};
  const controls={};
  const gpu={fit};
  const context=vm.createContext({performance,AbortController,DOMException,Uint8Array,
    activeConversion:null,stopping:false,maskCache:new Map(),backendName:()=> 'CUDA',status:{},
    byId:id=>controls[id]??(controls[id]={checked:false}),makeConfig:()=>config,
    PNG2ANSI:{vocabularies:()=>({test:[32,65]}),PALETTE:[],ansiBytes:(_m,c)=>Uint8Array.of(c.chosen[0],c.fg[0],c.bg[0])},
    createImageBitmap:async()=>bitmap,masksFor:async()=>({codes:[32,65],low:[[0],[1]]}),
    validateGpuBudget:()=>1,createGpuFitter:async()=>gpu,makeMemoryEstimate:()=>({plan:{},estimate:{},budget:{}}),
    memoryGate(){},resetProgress(){},updateProgress(){},requiresStreamedSamples:()=>false,
    PREVIEW_MAX_PIXELS:0,format:String,currentWorkUnits:null,currentGlyphCount:0,
    OffscreenCanvas:class{getContext(){return {drawImage(){},getImageData(){return {data:new Uint8Array(4)};}};}},
    summarizeTimings:()=>({}),compareCells,compareAnsi});
  vm.runInContext(declaration('compareImage')+'\n'+declaration('stopConversion')+'\n'+declaration('metricText'),context);
  return {context,bitmap,settings:{backend:'cuda',columns:1,rows:1,sampleW:1,sampleH:1,gpuRepeats:2}};
}
const selection=(glyph=0)=>({chosen:Uint16Array.of(glyph),fg:Uint8Array.of(0),bg:Uint8Array.of(0),stats:{timing:{}}});

test('Stop aborts an active CUDA conversion, releases it, and permits a subsequent conversion',async()=>{
  let signal,started;
  const ready=new Promise(r=>started=r);
  const fixture=conversionContext(async data=>{
    signal=data.signal;started();
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  const {context,settings,bitmap}=fixture;
  const pending=context.compareImage({},settings,{previews:false,cpuEnabled:false});
  await ready;context.stopConversion();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(signal.aborted,true);assert.equal(bitmap.closed,true);assert.equal(context.activeConversion,null);
  context.stopping=false;
  context.createGpuFitter=async()=>({fit:async()=>selection()});
  const result=await context.compareImage({},settings,{previews:false,cpuEnabled:false});
  assert.equal(result.repeatability.deterministic,true);
});

test('changed repeated tuples and ANSI bytes are reported while the first run stays canonical',async()=>{
  let calls=0;
  const {context,settings}=conversionContext(async()=>selection(calls++));
  const result=await context.compareImage({},settings,{previews:false,cpuEnabled:false,returnAnsi:true});
  assert.equal(result.repeatability.deterministic,false);
  assert.equal(result.repeatability.comparedRuns,1);
  assert.equal(result.gpuRender.repeatDetails[1].repeatCellDiff.glyph,1);
  assert.equal(result.gpuRender.repeatDetails[1].repeatAnsiDiff.mismatches,1);
  assert.equal(result.ansiBytes[0],0);
  assert.match(context.metricText(result),/FAILED.*repeated GPU runs/);
});

test('ZIP summary and repeated-run CSV preserve nondeterminism failures',()=>{
  const context=vm.createContext({csvRows:rows=>rows});
  vm.runInContext(declaration('zipSummaryCsv')+'\n'+declaration('zipRepeatsCsv'),context);
  const job={image:'test.png',result:{mismatches:0,repeatability:{deterministic:false},
    gpuRender:{repeatDetails:[{repeatCellDiff:{changedCells:1},repeatAnsiDiff:{mismatches:2}}]}}};
  const summary=context.zipSummaryCsv([job]);
  assert.equal(summary[1][summary[0].indexOf('status')],'NONDETERMINISTIC');
  const repeats=context.zipRepeatsCsv([job]);
  assert.equal(repeats[1][repeats[0].indexOf('repeat_changed_cells')],1);
  assert.equal(repeats[1][repeats[0].indexOf('repeat_ansi_mismatches')],2);
});

test('CUDA memory preflight works without a navigator.gpu or fake WebGPU device',()=>{
  const context=vm.createContext({estimateGpuMemory,evaluateVramBudget,requiresStreamedSamples,
    PREVIEW_MAX_PIXELS,PhotographicWebGpuFitter:{tilePlan(){throw new Error('Wrong backend');}}});
  vm.runInContext(declaration('makeMemoryEstimate'),context);
  const gpu={tilePlan:options=>PhotographicCudaFitter.tilePlan(info,options)};
  Object.defineProperty(gpu,'device',{get(){throw new Error('CUDA has no WebGPU device');}});
  const settings={backend:'cuda',columns:1024,rows:1024,sampleW:32,sampleH:64,
    tileMiB:1024,inFlightTiles:24,captureGpuTimestamps:true,declaredVramGiB:24};
  const {plan,estimate,budget}=context.makeMemoryEstimate(gpu,settings,219,2048,2048);
  assert.equal(plan.backend,'cuda');assert.equal(plan.inFlightTiles,1);
  assert.equal(plan.requestedInFlightTiles,24);assert.equal(estimate.timestampEnabled,false);
  assert.equal(estimate.components.projection,plan.projectionBufferBytes);
  assert.equal(budget.status,'safe');
});

test('backend capabilities are cached concurrently and failed CUDA detection is retryable',async()=>{
  let calls=0,fail=true;
  const ready={backend:'cuda'};
  const context=vm.createContext({byId:()=>({value:'cuda'}),fitterCache:new Map(),fitter:null,
    PhotographicCudaFitter:{async create(){calls++;if(fail)throw new Error('Worker absent');return ready;}},
    fetch(){throw new Error('CUDA must not request a WGSL shader');}});
  vm.runInContext(declaration('createGpuFitter'),context);
  await assert.rejects(context.createGpuFitter('cuda'),/Worker absent/);
  fail=false;
  const [a,b]=await Promise.all([context.createGpuFitter('cuda'),context.createGpuFitter('cuda')]);
  assert.equal(a,ready);assert.equal(b,ready);assert.equal(calls,2);
});

test('backend selection persists in captured settings and incompatible controls are disabled only for CUDA',()=>{
  const fields={backend:'cuda',columns:'80',rows:'40',sampleW:'4',sampleH:'8',foreground:'6',background:'5',
    tileMiB:'32','in-flight':'24','gpu-repeats':'1','gpu-vram':'24'};
  const elements=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,element(v)]));
  for(const id of ['gpu-timestamps','gpu-progress-name','gpu-output-title','backend-help'])elements[id]=element();
  const context=vm.createContext({byId:id=>elements[id],WORKBENCH_LIMITS,validateWorkbenchInputs,
    validateDeclaredVramGiB,TILE_TARGETS_MIB:[4,8,16,32,64,128,256,512,1024],
    backendName:backend=>backend==='cuda'?'CUDA':'WebGPU'});
  vm.runInContext(declaration('currentSettings')+'\n'+declaration('updateBackendControls'),context);
  const captured=context.currentSettings();
  assert.equal(captured.backend,'cuda');assert.equal(captured.inFlightTiles,24);
  context.updateBackendControls();
  assert.equal(elements['in-flight'].disabled,true);assert.equal(elements['gpu-timestamps'].disabled,true);
  assert.equal(elements['gpu-progress-name'].textContent,'CUDA');
  elements.backend.value='webgpu';context.updateBackendControls();
  assert.equal(elements['in-flight'].disabled,false);assert.equal(elements['gpu-timestamps'].disabled,false);
  assert.equal(captured.backend,'cuda','settings must be a snapshot');
});

test('CUDA profiling keeps native startup and bridge overhead separate from measured kernels',()=>{
  const elements=Object.fromEntries(['metric-rows','metric-note','metric-profile','metrics'].map(id=>[id,element()]));
  const context=vm.createContext({byId:id=>elements[id],document:{createElement:()=>element()},
    milliseconds,bytes,gpuProfileStages});
  vm.runInContext(declaration('presentMetrics'),context);
  const result={backend:'cuda',timings:{cpuPrepMs:null,gpuPrepMs:1,cpuFitMs:null,gpuFitMs:50,
    cpuOutputMs:null,gpuOutputMs:1,cpuTotalMs:null,gpuTotalMs:52,gpuMedianMs:50},
    gpuRender:{pipelineInitMs:20,repeatRuns:[50]},sourceSamplingMode:'full-reference-canvas',
    gpuStats:{timing:{nativeInitMs:20,bridgeRoundTripMs:25,gpuProjectionMs:3,gpuSelectionMs:4,
      uploadMs:1,readbackMs:2,wallTotalMs:50},tileCount:1,tileCells:3200,inFlightTiles:1,
      requestedInFlightTiles:24,requestedTileMiB:32,effectiveProjectionMiB:10}};
  context.presentMetrics(result);
  assert.equal(elements.metrics.hidden,false);
  assert.match(elements['metric-profile'].textContent,/25\.0 ms/);
  assert.match(elements['metric-profile'].textContent,/20\.0 ms/);
  assert.match(elements['metric-profile'].textContent,/3\.0 ms/);
  assert.doesNotMatch(elements['metric-profile'].textContent,/Readback\.mapAsync|queue\.writeBuffer/);
  assert.match(elements['metric-note'].textContent,/included in CUDA fit time/);
});
