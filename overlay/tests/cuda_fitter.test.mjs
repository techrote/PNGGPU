import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PhotographicCudaFitter} from '../src/gpu/cuda.js';

const MiB = 1024 * 1024;
const nativeInfo = () => ({
  schema:'pnggpu-cuda-info-v1', available:true, backend:'cuda', protocolVersion:1,
  precision:'float32-guarded-binary64',
  device:{index:0, name:'TITAN RTX (test double)', computeCapability:'7.5',
    totalMemoryBytes:24 * 1024 ** 3, freeMemoryBytes:22 * 1024 ** 3},
  limits:{maxMessageBytes:128 * MiB, maxTileCells:65536, maxSamplesPerCell:2048,
    maxGlyphCount:65535, maxProjectionBytes:128 * MiB, maxPixelBytes:64 * MiB,
    maxProjectionWork:16777216,maxRecoveryProjectionBytes:32*MiB,maxRecoveryCells:1024}
});

function sample({columns = 5, rows = 2, sampleWidth = 2, sampleHeight = 2, glyphCount = 3} = {}) {
  const pixels = new Uint8Array(columns * rows * sampleWidth * sampleHeight * 4);
  for (let cell = 0; cell < columns * rows; cell++) {
    const cx = cell % columns, cy = Math.floor(cell / columns);
    for (let y = 0; y < sampleHeight; y++) for (let x = 0; x < sampleWidth; x++) {
      const at = ((cy * sampleHeight + y) * columns * sampleWidth + cx * sampleWidth + x) * 4;
      pixels.set([cell + 1, 20 + x, 30 + y, 200 + cell], at);
    }
  }
  return {pixels, columns, rows, sampleWidth, sampleHeight,
    masks:Array.from({length:glyphCount}, (_, g) => Float32Array.from({length:sampleWidth * sampleHeight}, (_, i) => ((i + g) % 7) / 6)),
    palette:Array.from({length:16}, (_, i) => [i, i * 2, i * 3]),
    foregroundCandidates:6, backgroundCandidates:5, preferredTileCells:3, inFlightTiles:24};
}

function responseFrame(metadata, values = [], status = 0) {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const bytes = new Uint8Array(8 + json.length + values.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, status, true); view.setUint32(4, json.length, true);
  bytes.set(json, 8);
  values.forEach((value, i) => view.setUint32(8 + json.length + i * 4, value, true));
  return bytes;
}

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers:{'content-type':'application/json'}
});

function fakeBridge({info = nativeInfo(), readyMetadata = {}, onInit, onTile, onDelete} = {}) {
  const calls = [], inits = [], tiles = [], deletions = [];
  let geometry = null, sessionId = null, serial = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    calls.push({url, options});
    if (url === '/api/cuda/info') {
      assert.equal(options.method, 'GET');
      return jsonResponse(info);
    }
    if (url === '/api/cuda/session') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.equal(sessionId, null, 'prior native worker must be released');
      const bytes = new Uint8Array(options.body);
      const view = new DataView(bytes.buffer);
      const header = Array.from({length:8}, (_, i) => view.getUint32(i * 4, true));
      assert.deepEqual(header.slice(0,2), [1,1]);
      geometry = {sampleWidth:header[2], sampleHeight:header[3], glyphCount:header[4], tileCells:header[7]};
      inits.push({bytes, header});
      if (onInit) {
        const custom = await onInit({bytes, header, options});
        if (custom) return custom;
      }
      sessionId = `test_cuda_session_${++serial}`;
      return jsonResponse({ok:true, sessionId, device:info.device, ...readyMetadata});
    }
    if (url === `/api/cuda/session/${sessionId}/tile`) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      const bytes = new Uint8Array(options.body);
      const view = new DataView(bytes.buffer);
      assert.equal(view.getUint32(0, true), 2);
      const count = view.getUint32(4, true), n = geometry.sampleWidth * geometry.sampleHeight;
      assert.ok(count > 0 && count <= geometry.tileCells);
      assert.equal(bytes.byteLength, 8 + count * n * 4);
      const pixels = Array.from({length:count * n}, (_, i) => view.getUint32(8 + i * 4, true));
      const values = [];
      for (let i = 0; i < count; i++) {
        const cell = (pixels[i * n] & 255) - 1;
        values.push(cell % geometry.glyphCount, cell % 16, cell % 8, 0);
      }
      const metadata = {ok:true, cellCount:count, allocatedBytes:123456,
        recoveredCells:count,certifiedCells:0,deviceReadbackBytes:count*32,
        timing:{gpuProjectionMs:1.25, gpuSelectionMs:0.5, uploadMs:0.1, readbackMs:0.2,gpuGuardMs:0.1,gpuRecoveryProjectionMs:0.2,gpuRecoverySelectionMs:0.3,maxProjectionLaunchMs:1,maxSelectionLaunchMs:0.3}};
      const frame = responseFrame(metadata, values);
      tiles.push({bytes, pixels, count});
      const custom = onTile && await onTile({bytes, count, pixels, metadata, values, frame, options});
      return custom || new Response(frame, {headers:{'content-type':'application/octet-stream'}});
    }
    if (url === `/api/cuda/session/${sessionId}`) {
      assert.equal(options.method, 'DELETE');
      assert.equal(options.signal.aborted, false, 'cleanup must not inherit the cancelled job signal');
      deletions.push(sessionId);
      sessionId = null;
      return (onDelete && await onDelete({options})) || jsonResponse({ok:true});
    }
    assert.fail(`Unexpected CUDA request ${options.method} ${url}`);
  };
  return {fetchImpl, calls, inits, tiles, deletions};
}

test('CUDA capability lookup is optional and reports unavailable services without WebGPU access', async () => {
  const disabled = fakeBridge({info:{available:false, backend:'cuda', error:'Run start-cuda.bat to enable CUDA'}});
  await assert.rejects(PhotographicCudaFitter.create({fetchImpl:disabled.fetchImpl}), /start-cuda\.bat/);
  const notFound = async () => new Response('<html>Not found</html>', {status:404});
  await assert.rejects(PhotographicCudaFitter.create({fetchImpl:notFound}), /CUDA is unavailable.*start-cuda\.bat/);
  const bridge = fakeBridge();
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  assert.equal(fitter.backend, 'cuda');
  assert.equal(fitter.precision, 'float32-guarded-binary64');
  assert.equal(fitter.info.device.computeCapability, '7.5');
  assert.equal(fitter.adapterInfo.name, 'TITAN RTX (test double)');
  assert.equal(fitter.timestampsAvailable, true);
  assert.equal(bridge.inits.length, 0, 'capabilities do not allocate a render session');
});

test('worker version, precision and GPU capability are checked before any rendering', () => {
  for (const patch of [
    {protocolVersion:2}, {schema:'unknown'}, {precision:'fast-math'}, {backend:'cpu'},
    {device:{...nativeInfo().device, computeCapability:'7.0'}},
    {device:{...nativeInfo().device, freeMemoryBytes:25 * 1024 ** 3}},
    {limits:{...nativeInfo().limits, maxPixelBytes:NaN}}
  ]) {
    assert.throws(() => new PhotographicCudaFitter({...nativeInfo(), ...patch}));
  }
});

test('initialization preserves live memory telemetry but cannot silently change GPU identity', async () => {
  const freeMemoryBytes = 19 * 1024 ** 3;
  const bridge = fakeBridge({readyMetadata:{device:{...nativeInfo().device, freeMemoryBytes}, atlasUploadMs:2.5,
    protocolVersion:1, precision:'float32-guarded-binary64'}});
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  const result = await fitter.fit(sample());
  assert.equal(result.stats.cudaInfo.device.freeMemoryBytes, freeMemoryBytes);
  assert.equal(result.stats.adapterInfo.freeMemoryBytes, freeMemoryBytes);
  assert.equal(result.stats.timing.atlasUploadMs, 2.5);
  assert.ok(Math.abs(result.stats.timing.uploadMs - 2.9) < 1e-12);
  for (const readyMetadata of [
    {device:{...nativeInfo().device, index:1}},
    {device:{...nativeInfo().device, name:'A different GPU'}},
    {precision:'fast-math'}, {protocolVersion:2}
  ]) {
    const changed = fakeBridge({readyMetadata});
    const renderer = await PhotographicCudaFitter.create({fetchImpl:changed.fetchImpl});
    await assert.rejects(renderer.fit(sample()), /CUDA.*(changed|incompatible)/);
    assert.equal(changed.tiles.length, 0);
    assert.equal(changed.deletions.length, 1);
  }
});

test('CUDA tile limits use actual buffer/payload limits and report the requested versus actual pipeline depth', () => {
  const plan = PhotographicCudaFitter.tilePlan(nativeInfo(), {
    columns:1024, rows:1024, sampleWidth:32, sampleHeight:64, glyphCount:219,
    preferredTileMiB:1024, inFlightTiles:24
  });
  assert.equal(plan.tileCells, 8192, '64 MiB raster is the limiting allocation');
  assert.equal(plan.rasterBufferBytes, 64 * MiB);
  assert.equal(plan.tileCount, 128);
  assert.equal(plan.requestedInFlightTiles, 24);
  assert.equal(plan.inFlightTiles, 1);
  assert.equal(plan.maxKernelProjectionWork, 16777216);
  assert.ok(plan.tileCells * 219 * 2048 > plan.maxKernelProjectionWork,
    'native kernel work segmentation must not create tiny HTTP tiles');
  assert.ok(plan.projectionBufferBytes <= 128 * MiB);
  assert.equal(plan.nativeBufferBytes, 219 * 2048 * 4 + 219 * 16 + 256 +
    plan.projectionBufferBytes + plan.rasterBufferBytes + plan.tileCells * 16+plan.recoveryProjectionBytes);
  assert.throws(() => PhotographicCudaFitter.tilePlan(nativeInfo(), {
    columns:1, rows:1, sampleWidth:32, sampleHeight:64, glyphCount:65535
  }), /atlas exceeds/);
  assert.throws(() => PhotographicCudaFitter.tilePlan(nativeInfo(), {
    columns:1025, rows:1, sampleWidth:1, sampleHeight:1, glyphCount:1
  }), /Columns/);
  const malformed=nativeInfo();malformed.limits.maxRecoveryProjectionBytes=1;
  assert.throws(()=>PhotographicCudaFitter.tilePlan(malformed,{columns:1,rows:1,sampleWidth:1,sampleHeight:1,glyphCount:1}),/recovery row/);
});

test('browser packs atlas statistics, palette and cell-major RGB identically to WebGPU, then stitches a partial tile', async () => {
  const data = sample(), bridge = fakeBridge(), events = [];
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  const result = await fitter.fit({...data, onProgress:event => events.push(event)});
  assert.deepEqual(bridge.inits[0].header, [1,1,2,2,3,6,5,3]);
  const bytes = bridge.inits[0].bytes, view = new DataView(bytes.buffer);
  const statsAt = 32 + 3 * 4 * 4, paletteAt = statsAt + 3 * 16;
  for (let g = 0; g < data.masks.length; g++) {
    let sum = 0, squareSum = 0;
    for (let i = 0; i < data.masks[g].length; i++) {
      const value = data.masks[g][i];
      assert.equal(view.getFloat32(32 + (g * 4 + i) * 4, true), value);
      sum += value; squareSum += value * value;
    }
    assert.equal(view.getFloat32(statsAt + g * 16, true), Math.fround(sum / 4));
    assert.equal(view.getFloat32(statsAt + g * 16 + 4, true), Math.fround(squareSum));
    assert.equal(view.getFloat32(statsAt + g * 16 + 8, true), Math.fround(Math.max(squareSum - sum * sum / 4, 1e-8)));
    assert.equal(view.getUint32(statsAt + g * 16 + 12, true), 0);
  }
  for (let color = 0; color < 16; color++) {
    for (let channel = 0; channel < 3; channel++) {
      assert.equal(view.getFloat32(paletteAt + color * 16 + channel * 4, true), data.palette[color][channel]);
    }
    assert.equal(view.getUint32(paletteAt + color * 16 + 12, true), 0);
  }
  assert.deepEqual(bridge.tiles.map(tile => tile.count), [3,3,3,1]);
  const expectedPixels = [];
  for (let cell = 0; cell < 10; cell++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    expectedPixels.push((cell + 1) | ((20 + x) << 8) | ((30 + y) << 16));
  }
  assert.deepEqual(bridge.tiles.flatMap(tile => tile.pixels), expectedPixels);
  assert.deepEqual([...result.chosen], Array.from({length:10}, (_, i) => i % 3));
  assert.deepEqual([...result.fg], Array.from({length:10}, (_, i) => i % 16));
  assert.deepEqual([...result.bg], Array.from({length:10}, (_, i) => i % 8));
  assert.deepEqual(events.map(event => event.completedCells), [3,6,9,10]);
  assert.deepEqual(events.map(event => event.completedTiles), [1,2,3,4]);
  assert.ok(events.every(event => event.backend === 'cuda' && event.totalCells === 10 && event.inFlightCapacity === 1));
  assert.equal(result.stats.backend, 'cuda');
  assert.equal(result.stats.timing.gpuProjectionMs, 5);
  assert.equal(result.stats.timing.gpuSelectionMs, 2);
  assert.equal(result.stats.timing.uploadMs, 0.4);
  assert.equal(result.stats.timing.readbackMs, 0.8);
  assert.equal(result.stats.timing.writeBufferMs, null, 'CUDA must not report fake WebGPU queue timings');
  assert.ok(result.stats.timing.nativeInitMs >= 0);
  assert.ok(result.stats.timing.bridgeRoundTripMs >= 0);
  assert.ok(result.stats.timing.wallTotalMs >= result.stats.timing.nativeInitMs);
  assert.equal(result.stats.readbackBytes, 10 * 32,'Includes guard result inspection and recovered results');
  assert.equal(result.stats.recoveredCells,10);
  assert.equal(result.stats.certifiedCells,0);
  assert.equal(result.stats.uploadedBytes, bytes.length - 32 + 10 * 4 * 4);
  assert.equal(bridge.deletions.length, 1);
});

test('streamed provider samples use the same cell-major ABI and clean up on invalid geometry', async () => {
  const providerCalls = [], data = sample(), bridge = fakeBridge();
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  const provider = async (start, count) => {
    providerCalls.push([start, count]);
    const rgba = new Uint8ClampedArray(count * 4 * 4);
    for (let cell = 0; cell < count; cell++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      rgba.set([start + cell + 1, 20 + x, 30 + y, 255], (cell * 4 + y * 2 + x) * 4);
    }
    return rgba;
  };
  const result = await fitter.fit({...data, pixels:undefined, sampleProvider:provider});
  assert.deepEqual(providerCalls, [[0,3],[3,3],[6,3],[9,1]]);
  assert.deepEqual([...result.chosen], Array.from({length:10}, (_, i) => i % 3));
  await assert.rejects(fitter.fit({...data, pixels:undefined, sampleProvider:async () => new Uint8Array(3)}), /provider returned invalid/);
  assert.equal(bridge.deletions.length, 2);
});

test('malformed input is rejected before creating a native session', async () => {
  const bridge = fakeBridge(), fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  const invalid = [
    {columns:0}, {rows:1.5}, {sampleWidth:33}, {sampleHeight:65},
    {foregroundCandidates:13}, {backgroundCandidates:9},
    {pixels:new Uint8Array(7)}, {pixels:Array(160).fill(0)},
    {masks:[new Float32Array([0])]}, {masks:[]},
    {masks:[new Float32Array([0,0,0,NaN])]},
    {masks:[new Float32Array([0,0,0,1.01])]},
    {palette:Array.from({length:16}, () => [0,0,Infinity])},
    {sampleProvider:true}, {inFlightTiles:25}, {preferredTileMiB:0}
  ];
  for (const patch of invalid) await assert.rejects(fitter.fit({...sample(), ...patch}));
  assert.equal(bridge.inits.length, 0);
  assert.equal(bridge.deletions.length, 0);
});

test('the selected CUDA path surfaces runtime failures and always releases its session', async () => {
  const bridge = fakeBridge({onTile:() => jsonResponse({error:'CUDA device lost'}, 503)});
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  await assert.rejects(fitter.fit(sample()), /CUDA device lost/);
  assert.equal(bridge.tiles.length, 1);
  assert.equal(bridge.deletions.length, 1);
  assert.equal(bridge.calls.filter(call => call.url.includes('webgpu')).length, 0);
});

test('invalid native tuples, timings and truncated frames cannot reach ANSI encoding', async () => {
  const cases = [
    ({metadata, values}) => responseFrame(metadata, [3, ...values.slice(1)]),
    ({metadata, values}) => responseFrame(metadata, [values[0],16, ...values.slice(2)]),
    ({metadata, values}) => responseFrame(metadata, [values[0],values[1],8, ...values.slice(3)]),
    ({metadata, values}) => responseFrame(metadata, [values[0],values[1],values[2],1, ...values.slice(4)]),
    ({metadata, values}) => responseFrame({...metadata, cellCount:99}, values),
    ({metadata, values}) => responseFrame({...metadata, timing:{...metadata.timing, gpuProjectionMs:-1}}, values),
    ({metadata, values}) => responseFrame({...metadata, allocatedBytes:0}, values),
    ({metadata, values}) => responseFrame({...metadata, recoveredCells:0,certifiedCells:0}, values),
    ({metadata, values}) => responseFrame({...metadata, deviceReadbackBytes:0}, values),
    ({metadata, values}) => responseFrame({...metadata, timing:{...metadata.timing,gpuRecoverySelectionMs:-1}}, values),
    ({frame}) => frame.subarray(0,frame.length - 1),
    ({frame}) => frame.subarray(0,7),
    ({metadata, values}) => responseFrame(metadata, values, 2),
    () => responseFrame({ok:false, error:'native validation failed'}, [], 1),
    ({frame}) => { const malformed = frame.slice(); new DataView(malformed.buffer).setUint32(4, 65537, true); return malformed; }
  ];
  for (const corrupt of cases) {
    const bridge = fakeBridge({onTile:args => new Response(corrupt(args))});
    const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
    await assert.rejects(fitter.fit(sample()), /CUDA/);
    assert.equal(bridge.deletions.length, 1);
  }
});

test('response byte limits are enforced even with chunked HTTP data', async () => {
  const hugeJson = new TextEncoder().encode(JSON.stringify({...nativeInfo(), padding:'x'.repeat(65536)}));
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(hugeJson.subarray(0,32768));
      controller.enqueue(hugeJson.subarray(32768)); controller.close();
    }
  }));
  await assert.rejects(PhotographicCudaFitter.create({fetchImpl}), /response exceeds/);
  const headerFetch = async () => new Response('{}', {headers:{'content-length':'1048576'}});
  await assert.rejects(PhotographicCudaFitter.create({fetchImpl:headerFetch}), /response exceeds/);
});

test('AbortSignal and close cancel CUDA work and use an independent cleanup request', async () => {
  const controller = new AbortController();
  const bridge = fakeBridge({onTile:() => { controller.abort(); }});
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  await assert.rejects(fitter.fit({...sample(), signal:controller.signal}), {name:'AbortError'});
  assert.equal(bridge.deletions.length, 1);
  const closedBridge = fakeBridge({onTile:() => { closedFitter.close(); }});
  const closedFitter = await PhotographicCudaFitter.create({fetchImpl:closedBridge.fetchImpl});
  await assert.rejects(closedFitter.fit(sample()), {name:'AbortError'});
  assert.equal(closedBridge.deletions.length, 1);
  await assert.rejects(closedFitter.fit(sample()), /closed/);
});

test('already-cancelled work creates no session and does not permanently occupy the fitter', async () => {
  const controller = new AbortController(); controller.abort();
  const bridge = fakeBridge(), fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  await assert.rejects(fitter.fit({...sample(), signal:controller.signal}), {name:'AbortError'});
  assert.equal(bridge.inits.length, 0);
  const result = await fitter.fit(sample());
  assert.equal(result.chosen.length, 10);
  assert.equal(bridge.deletions.length, 1);
});

test('an HTTP timeout releases the worker; simultaneous fits cannot share native buffers', async () => {
  let tileEntered;
  const started = new Promise(resolve => { tileEntered = resolve; });
  const bridge = fakeBridge({onTile:({options}) => new Promise((resolve, reject) => {
    tileEntered();
    options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
  })});
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl, requestTimeoutMs:50});
  const first = fitter.fit(sample());
  await started;
  await assert.rejects(fitter.fit(sample()), /already converting/);
  await assert.rejects(first, /timed out/);
  assert.equal(bridge.deletions.length, 1);
});

test('session cleanup errors cannot mask a compute error or silently pass a successful fit', async () => {
  const cleanupFailure = () => jsonResponse({error:'release failed'}, 500);
  const failedBridge = fakeBridge({onTile:() => jsonResponse({error:'kernel failure'}, 500), onDelete:cleanupFailure});
  const failedFitter = await PhotographicCudaFitter.create({fetchImpl:failedBridge.fetchImpl});
  await assert.rejects(failedFitter.fit(sample()), /kernel failure/);
  const completedBridge = fakeBridge({onDelete:cleanupFailure});
  const completedFitter = await PhotographicCudaFitter.create({fetchImpl:completedBridge.fetchImpl});
  await assert.rejects(completedFitter.fit(sample()), /session cleanup failed.*release failed/);
  assert.equal(completedFitter.activeController, null);
});

test('UTF-8 JSON byte length need not align the native results to a four-byte boundary', async () => {
  const bridge = fakeBridge({onTile:({metadata, values}) => {
    const extended = {...metadata, message:'Turing ✓'};
    const frame = responseFrame(extended, values);
    return new Response(frame);
  }});
  const fitter = await PhotographicCudaFitter.create({fetchImpl:bridge.fetchImpl});
  const result = await fitter.fit(sample());
  assert.deepEqual([...result.chosen], Array.from({length:10}, (_, i) => i % 3));
});
