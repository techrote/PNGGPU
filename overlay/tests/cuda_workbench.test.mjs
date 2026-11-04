import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PhotographicCudaFitter} from '../src/gpu/cuda.js';
import {estimateGpuMemory,evaluateVramBudget,validateDeclaredVramGiB} from '../src/gpu/memory.js';
import {requiresStreamedSamples,PREVIEW_MAX_PIXELS} from '../src/gpu/streamed_samples.js';
import {validateWorkbenchInputs,WORKBENCH_LIMITS} from '../src/gpu/workload.js';
import {milliseconds,bytes,gpuProfileStages} from '../src/gpu/metrics.js';

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
