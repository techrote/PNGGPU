/**
 * Optional native CUDA photographic matcher for the local workbench.
 *
 * Image preparation, font rasterization and ANSI encoding stay in the browser.
 * This adapter transfers the SAME prepared samples, Float32 glyph masks and
 * Float32 statistics used by the WGSL implementation. Conservative decision
 * intervals certify CPU-objective results; ambiguous cells recover on the GPU
 * using the original CPU's binary64 grouping and strict tie order.
 *
 * The local bridge owns one persistent native worker per fit; atlas/device
 * allocations are reused across tiles. CUDA-001 uses one tile at a time. A
 * requested WebGPU pipeline depth is reported separately from this actual
 * depth, and a failed CUDA request never silently changes the chosen backend.
 */

const MiB = 1024 * 1024;
const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 128 * MiB;
const MAX_METADATA_BYTES = 64 * 1024;
const decoder = new TextDecoder('utf-8', {fatal:true});
const clock = () => performance.now();

function integer(value, name, low, high) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new RangeError(`${name} must be an integer from ${low} to ${high}`);
  }
  return value;
}

function abortError(message = 'CUDA conversion cancelled') {
  return new DOMException(message, 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

function relayAbort(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason ?? abortError());
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, {once:true});
  return () => signal.removeEventListener('abort', abort);
}

function finiteTime(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid CUDA ${name} timing`);
  return value;
}

function validateInfo(info) {
  if (!info || info.available !== true) {
    throw new Error(`CUDA is unavailable: ${info?.error || 'start the optional CUDA server with start-cuda.bat'}`);
  }
  if (info.schema !== 'pnggpu-cuda-info-v1' || info.protocolVersion !== PROTOCOL_VERSION ||
      info.backend !== 'cuda' || !['float32-guarded-binary64','binary64-direct'].includes(info.precision)) {
    throw new Error('Incompatible CUDA worker; rebuild the native worker from this PNGGPU checkout');
  }
  const capability = /^(\d+)\.(\d+)$/.exec(String(info.device?.computeCapability ?? ''));
  if (!capability || Number(capability[1]) < 7 ||
      (Number(capability[1]) === 7 && Number(capability[2]) < 5)) {
    throw new Error('CUDA backend requires a compute capability 7.5 or newer GPU (TITAN RTX / RTX 20-series target)');
  }
  if (typeof info.device.name !== 'string' || !info.device.name) throw new Error('CUDA worker did not identify its GPU');
  integer(info.device.index, 'CUDA device index', 0, 65535);
  integer(info.device.totalMemoryBytes, 'CUDA device memory', 1, Number.MAX_SAFE_INTEGER);
  integer(info.device.freeMemoryBytes, 'CUDA free-memory snapshot', 0, info.device.totalMemoryBytes);
  const hardCaps = {
    maxMessageBytes:MAX_MESSAGE_BYTES,
    maxTileCells:65536,
    maxSamplesPerCell:2048,
    maxGlyphCount:65535,
    maxProjectionBytes:128 * MiB,
    maxPixelBytes:64 * MiB,
    maxRecoveryProjectionBytes:32 * MiB,
    maxRecoveryCells:1024
  };
  const limits = {};
  for (const [key, cap] of Object.entries(hardCaps)) {
    integer(info.limits?.[key], `CUDA limit ${key}`, 1, Number.MAX_SAFE_INTEGER);
    limits[key] = Math.min(info.limits[key], cap);
  }
  // The work limit bounds native kernel sublaunches, not HTTP tile payloads.
  // The native worker can subdivide a tile without extra browser round trips.
  const kernelWork = info.limits.maxKernelProjectionWork ?? info.limits.maxProjectionWork;
  if (kernelWork !== undefined) {
    limits.maxKernelProjectionWork = integer(kernelWork, 'CUDA kernel work limit', 1, Number.MAX_SAFE_INTEGER);
  }
  return limits;
}

function initializedInfo(ready, info) {
  if ((ready.protocolVersion !== undefined && ready.protocolVersion !== PROTOCOL_VERSION) ||
      (ready.precision !== undefined && ready.precision !== info.precision)) {
    throw new Error('CUDA initialization uses an incompatible protocol or arithmetic mode');
  }
  if (ready.device === undefined) return info;
  for (const key of ['index', 'name', 'computeCapability']) {
    if (ready.device?.[key] !== info.device[key]) {
      throw new Error('CUDA device changed since its capability check; select the intended GPU and retry');
    }
  }
  // Free VRAM changes between the probe and allocation. Preserve the newer
  // snapshot, without treating equality to an earlier snapshot as admission.
  const current = {...info, device:{...info.device, ...ready.device}};
  validateInfo(current);
  return Object.freeze({...current, device:Object.freeze(current.device)});
}

async function boundedBody(response, limit) {
  const lengthHeader = response.headers?.get('content-length');
  if (lengthHeader !== null && lengthHeader !== undefined) {
    if (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > limit) {
      await response.body?.cancel();
      throw new Error(`CUDA response exceeds the ${limit}-byte limit`);
    }
  }
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw new Error(`CUDA response exceeds the ${limit}-byte limit`);
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(`CUDA response exceeds the ${limit}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { combined.set(chunk, at); at += chunk.byteLength; }
  return combined;
}

function parseJson(bytes, context) {
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`Invalid JSON from CUDA ${context}`);
  }
}

async function request(fetchImpl, path, {
  method = 'GET', body, signal, timeoutMs = 120000,
  limit = MAX_METADATA_BYTES, binary = false
} = {}) {
  const controller = new AbortController();
  const stopRelaying = relayAbort(signal, controller);
  const timer = setTimeout(() => controller.abort(new Error(`CUDA ${method} request timed out`)), timeoutMs);
  try {
    throwIfAborted(controller.signal);
    const headers = {Accept:binary ? 'application/octet-stream' : 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    const response = await fetchImpl(path, {
      method, body, headers, signal:controller.signal,
      cache:'no-store', credentials:'same-origin', mode:'same-origin', redirect:'error'
    });
    const bytes = await boundedBody(response, response.ok ? limit : MAX_METADATA_BYTES);
    if (!response.ok) {
      let detail = '';
      try { detail = parseJson(bytes, 'error').error || ''; } catch { /* Static servers may return HTML. */ }
      if (response.status === 404 && path === '/api/cuda/info') {
        throw new Error('CUDA is unavailable on this server. Build the native worker and run start-cuda.bat');
      }
      throw new Error(`CUDA request failed (HTTP ${response.status})${detail ? `: ${String(detail).slice(0,1000)}` : ''}`);
    }
    throwIfAborted(controller.signal);
    if (binary) return bytes;
    if (response.status === 204 && bytes.byteLength === 0) return {ok:true};
    return parseJson(bytes, 'service');
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    stopRelaying();
  }
}

function inputGeometry(data, info) {
  const {columns, rows, sampleWidth, sampleHeight, masks, palette, pixels,
    sampleProvider = null, foregroundCandidates, backgroundCandidates} = data;
  integer(columns, 'Columns', 1, 1024);
  integer(rows, 'Rows', 1, 1024);
  integer(sampleWidth, 'Sample width', 1, 32);
  integer(sampleHeight, 'Sample height', 1, 64);
  integer(foregroundCandidates, 'Foreground candidate count', 1, 12);
  integer(backgroundCandidates, 'Background candidate count', 1, 8);
  const glyphCount = integer(masks?.length, 'Glyph count', 1, info.limits.maxGlyphCount);
  const cells = columns * rows, samples = sampleWidth * sampleHeight;
  if (samples > info.limits.maxSamplesPerCell) throw new RangeError('CUDA samples/cell exceed the native worker limit');
  if (!Array.isArray(masks) || masks.some(mask => !mask || mask.length !== samples) ||
      !Array.isArray(palette) || palette.length !== 16 || palette.some(rgb => !rgb || rgb.length !== 3)) {
    throw new RangeError('Pixel/mask/palette geometry mismatch');
  }
  if (sampleProvider !== null ? typeof sampleProvider !== 'function' :
      !(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== cells * samples * 4) {
    throw new RangeError('Pixel/mask/palette geometry mismatch');
  }
  for (const mask of masks) for (const value of mask) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Glyph mask values must be finite and between 0 and 1');
  }
  for (const color of palette) for (const value of color) {
    if (!Number.isFinite(value) || value < 0 || value > 255) throw new RangeError('ANSI palette values must be finite and between 0 and 255');
  }
  return {cells, samples, glyphCount};
}

function packInit(data, plan, glyphCount, samples) {
  const bytes = new Uint8Array(32 + glyphCount * samples * 4 + glyphCount * 16 + 256);
  const view = new DataView(bytes.buffer);
  const header = [1, PROTOCOL_VERSION, data.sampleWidth, data.sampleHeight, glyphCount,
    data.foregroundCandidates, data.backgroundCandidates, plan.tileCells];
  header.forEach((value, i) => view.setUint32(i * 4, value, true));
  const statsStart = 32 + glyphCount * samples * 4;
  let at = 32;
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    let sum = 0, squareSum = 0;
    for (const value of data.masks[glyph]) {
      view.setFloat32(at, value, true); at += 4;
      sum += value; squareSum += value * value;
    }
    // Keep these binary64 sums and final float32 conversion identical to the
    // existing WebGPU host, including the variance floor and reserved zero.
    const statsAt = statsStart + glyph * 16;
    view.setFloat32(statsAt, sum / samples, true);
    view.setFloat32(statsAt + 4, squareSum, true);
    view.setFloat32(statsAt + 8, Math.max(squareSum - sum * sum / samples, 1e-8), true);
  }
  const paletteStart = statsStart + glyphCount * 16;
  for (let color = 0; color < 16; color++) {
    for (let channel = 0; channel < 3; channel++) {
      view.setFloat32(paletteStart + color * 16 + channel * 4, data.palette[color][channel], true);
    }
  }
  return bytes;
}

function decodeTile(bytes, count, glyphCount, chosen, fg, bg, tileStart, precision) {
  if (bytes.byteLength < 8) throw new Error('Truncated CUDA tile response');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getUint32(0, true), jsonBytes = view.getUint32(4, true);
  if (jsonBytes > MAX_METADATA_BYTES || jsonBytes > bytes.byteLength - 8) {
    throw new Error('Invalid CUDA tile response metadata length');
  }
  const metadata = parseJson(bytes.subarray(8, 8 + jsonBytes), 'tile response');
  if (status === 1 && metadata.ok === false) throw new Error(`CUDA worker failed: ${String(metadata.error || 'unknown error')}`);
  if (status !== 0 || metadata.ok !== true || metadata.cellCount !== count ||
      bytes.byteLength !== 8 + jsonBytes + count * 16) {
    throw new Error('CUDA tile response does not match the requested geometry');
  }
  for (const key of ['gpuProjectionMs', 'gpuSelectionMs', 'uploadMs', 'readbackMs']) {
    finiteTime(metadata.timing?.[key], key);
  }
  integer(metadata.allocatedBytes, 'CUDA allocated bytes', 1, Number.MAX_SAFE_INTEGER);
  integer(metadata.recoveredCells,'CUDA recovered cells',0,count);
  integer(metadata.certifiedCells,'CUDA certified cells',0,count);
  metadata.directCells=integer(metadata.directCells??0,'CUDA direct cells',0,count);
  if(precision==='binary64-direct'?(metadata.directCells!==count||metadata.recoveredCells!==0||metadata.certifiedCells!==0):
    (metadata.directCells!==0||metadata.recoveredCells+metadata.certifiedCells!==count))throw new Error('CUDA arithmetic counts do not match the tile');
  if(metadata.deviceReadbackBytes!==count*16*(metadata.recoveredCells?2:1))throw new Error('CUDA device readback byte count does not match recovery');
  for(const key of ['gpuGuardMs','gpuRecoveryProjectionMs','gpuRecoverySelectionMs','maxProjectionLaunchMs','maxSelectionLaunchMs'])finiteTime(metadata.timing?.[key],key);
  for(const key of ['gpuDirectProjectionMs','gpuDirectSelectionMs'])metadata.timing[key]=finiteTime(metadata.timing[key]??0,key);
  if(precision==='binary64-direct'&&['gpuGuardMs','gpuRecoveryProjectionMs','gpuRecoverySelectionMs'].some(k=>metadata.timing[k]!==0))throw new Error('Direct CUDA mode reported guarded/recovery work');
  if(precision!=='binary64-direct'&&['gpuDirectProjectionMs','gpuDirectSelectionMs'].some(k=>metadata.timing[k]!==0))throw new Error('Guarded CUDA mode reported direct work');
  for (let i = 0; i < count; i++) {
    const at = 8 + jsonBytes + i * 16;
    const glyph = view.getUint32(at, true), foreground = view.getUint32(at + 4, true);
    const background = view.getUint32(at + 8, true), reserved = view.getUint32(at + 12, true);
    if (glyph >= glyphCount || foreground >= 16 || background >= 8 || reserved !== 0) {
      throw new Error(`CUDA returned an invalid glyph/colour tuple for cell ${tileStart + i}`);
    }
    chosen[tileStart + i] = glyph;
    fg[tileStart + i] = foreground;
    bg[tileStart + i] = background;
  }
  return metadata;
}

export class PhotographicCudaFitter {
  static DEFAULT_TILE_CELLS = 16384;
  static DEFAULT_TILE_MIB = 32;

  static async create({fetchImpl = globalThis.fetch, signal,
    requestTimeoutMs = 120000, infoTimeoutMs = 10000, cleanupTimeoutMs = 5000, expectedPrecision='float32-guarded-binary64'} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('CUDA bridge requires browser fetch support');
    integer(infoTimeoutMs, 'CUDA info timeout', 1, 600000);
    const info = await request(fetchImpl, '/api/cuda/info', {signal, timeoutMs:infoTimeoutMs});
    return new this(info, {fetchImpl, requestTimeoutMs, cleanupTimeoutMs,expectedPrecision});
  }

  constructor(info, {fetchImpl = globalThis.fetch, requestTimeoutMs = 120000, cleanupTimeoutMs = 5000,expectedPrecision='float32-guarded-binary64'} = {}) {
    const limits = validateInfo(info);
    if(info.precision!==expectedPrecision)throw new Error('CUDA arithmetic mode differs from explicitly requested precision');
    if (typeof fetchImpl !== 'function') throw new Error('CUDA bridge requires browser fetch support');
    this.info = Object.freeze({...info, limits:Object.freeze({...info.limits, ...limits}), device:Object.freeze({...info.device})});
    this.backend = 'cuda';
    this.precision = info.precision;
    this.adapterInfo = {...info.device, vendor:'NVIDIA', architecture:`compute_${info.device.computeCapability.replace('.', '')}`,
      description:info.device.name, backend:'cuda'};
    this.timestampsAvailable = true;
    this.requestTimeoutMs = integer(requestTimeoutMs, 'CUDA request timeout', 1, 600000);
    this.cleanupTimeoutMs = integer(cleanupTimeoutMs, 'CUDA cleanup timeout', 1, 600000);
    this.fetchImpl = fetchImpl;
    this.closed = false;
    this.activeController = null;
  }

  static tilePlan(info, {columns, rows, sampleWidth, sampleHeight, glyphCount,
    preferredTileCells = this.DEFAULT_TILE_CELLS, preferredTileMiB = null, inFlightTiles = 1}) {
    const limits = validateInfo(info?.info ?? info);
    integer(columns, 'Columns', 1, 1024);
    integer(rows, 'Rows', 1, 1024);
    integer(sampleWidth, 'Sample width', 1, 32);
    integer(sampleHeight, 'Sample height', 1, 64);
    integer(glyphCount, 'Glyph count', 1, limits.maxGlyphCount);
    integer(preferredTileCells, 'CUDA tile target', 1, Number.MAX_SAFE_INTEGER);
    integer(inFlightTiles, 'Requested in-flight tiles', 1, 24);
    if (preferredTileMiB !== null) integer(preferredTileMiB, 'Projection tile target (MiB)', 1, 1024);
    const samples = sampleWidth * sampleHeight, cells = columns * rows;
    if (samples > limits.maxSamplesPerCell) throw new RangeError('CUDA samples/cell exceed the native worker limit');
    const atlasBytes = glyphCount * samples * 4 + glyphCount * 16 + 256;
    if (32 + atlasBytes > limits.maxMessageBytes) throw new RangeError('Glyph atlas exceeds the CUDA message limit');
    const requestedCells = preferredTileMiB === null ? preferredTileCells :
      Math.max(1, Math.floor(preferredTileMiB * MiB / (glyphCount * 16)));
    const tileCells = Math.min(cells, requestedCells, limits.maxTileCells,
      Math.floor(limits.maxProjectionBytes / (glyphCount * 16)),
      Math.floor(limits.maxPixelBytes / (samples * 4)),
      Math.floor((limits.maxMessageBytes - 8) / (samples * 4)),
      Math.floor((limits.maxMessageBytes - 8 - MAX_METADATA_BYTES) / 16));
    if (tileCells < 1) throw new RangeError('No valid CUDA tile fits the native worker limits');
    const projectionBufferBytes = tileCells * glyphCount * 16;
    const recoveryTileCells=Math.min(tileCells,limits.maxRecoveryCells,Math.floor(limits.maxRecoveryProjectionBytes/(glyphCount*32)));
    if(recoveryTileCells<1)throw new RangeError('No precise recovery row fits the CUDA recovery buffer limit');
    const recoveryProjectionBytes=recoveryTileCells*glyphCount*32;
    const rasterBufferBytes = tileCells * samples * 4;
    return {
      backend:'cuda', requestedTileCells:requestedCells, requestedTileMiB:preferredTileMiB,
      effectiveProjectionMiB:projectionBufferBytes / MiB,
      requestedInFlightTiles:inFlightTiles, inFlightTiles:1,
      tileCells, tileCount:Math.ceil(cells / tileCells), projectionBufferBytes, rasterBufferBytes,
      recoveryTileCells,recoveryProjectionBytes,
      maxStorageBindingBytes:null, maxBufferBytes:Math.max(limits.maxProjectionBytes, limits.maxPixelBytes),
      maxMessageBytes:limits.maxMessageBytes, maxKernelProjectionWork:limits.maxKernelProjectionWork ?? null,
      nativeBufferBytes:atlasBytes + projectionBufferBytes + rasterBufferBytes + tileCells * 16 + recoveryProjectionBytes,
      pipelineNote:'One persistent native CUDA worker; sequential tiles; native kernel sublaunches are bounded independently.'
    };
  }

  tilePlan(options) { return PhotographicCudaFitter.tilePlan(this.info, options); }

  async fit(data) {
    if (this.closed) throw new Error('CUDA fitter is closed');
    if (this.activeController) throw new Error('CUDA fitter is already converting an image');
    const {cells, samples, glyphCount} = inputGeometry(data, this.info);
    const plan = this.tilePlan({...data, glyphCount});
    if (data.onProgress != null && typeof data.onProgress !== 'function') throw new TypeError('onProgress must be a function');
    const controller = new AbortController();
    const stopRelaying = relayAbort(data.signal, controller);
    this.activeController = controller;
    const timedStart = clock();
    const timing = {
      atlasPackMs:0, bufferCreateMs:0, tilePackMs:0, sampleProviderMs:0, decodeCellsMs:0,
      writeBufferMs:null, encodeSubmitMs:null, readbackWaitMs:null, timestampsReadMs:0,
      slotAvailabilityWaitMs:0, firstTileCompletedMs:null, wallTotalMs:0,
      nativeInitMs:0, atlasUploadMs:null, bridgeRoundTripMs:0, uploadMs:0, readbackMs:0,
      gpuProjectionMs:0, gpuSelectionMs:0, gpuGuardMs:0,gpuRecoveryProjectionMs:0,gpuRecoverySelectionMs:0,
      gpuDirectProjectionMs:0,gpuDirectSelectionMs:0,
      maxProjectionLaunchMs:0,maxSelectionLaunchMs:0,cleanupMs:0
    };
    let sessionId = null, primaryError = null;
    try {
      throwIfAborted(controller.signal);
      let at = clock();
      const chosen = new Uint16Array(cells), fg = new Uint8Array(cells), bg = new Uint8Array(cells);
      timing.bufferCreateMs = clock() - at;
      at = clock();
      const init = packInit(data, plan, glyphCount, samples);
      timing.atlasPackMs = clock() - at;
      at = clock();
      const ready = await request(this.fetchImpl, '/api/cuda/session', {
        method:'POST', body:init, signal:controller.signal, timeoutMs:this.requestTimeoutMs
      });
      timing.nativeInitMs = clock() - at;
      if (typeof ready.sessionId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(ready.sessionId)) {
        throw new Error('CUDA bridge returned an invalid session identifier');
      }
      sessionId = ready.sessionId;
      if (ready.ok !== true) throw new Error(`CUDA worker initialization failed: ${ready.error || 'invalid response'}`);
      const cudaInfo = initializedInfo(ready, this.info);
      if (ready.atlasUploadMs !== undefined) {
        timing.atlasUploadMs = finiteTime(ready.atlasUploadMs, 'atlasUploadMs');
        timing.uploadMs += timing.atlasUploadMs;
      }
      const tileMeasurements = [];
      let uploadedBytes = init.byteLength - 32, readbackBytes = 0;
      let requestPayloadBytes = init.byteLength, tileResponseBytes = 0, allocatedBytes = null;
      for (let tileStart = 0, tileIndex = 0; tileStart < cells; tileStart += plan.tileCells, tileIndex++) {
        throwIfAborted(controller.signal);
        const tileCount = Math.min(plan.tileCells, cells - tileStart), tileStarted = clock();
        const tile = {index:tileIndex + 1, cells:tileCount, sourceSampleMs:0, packMs:0,
          uploadEnqueueMs:null, encodeSubmitMs:null, mapWaitMs:null, decodeMs:0,
          wallMs:0, projectionMs:0, selectionMs:0, bridgeRoundTripMs:0, uploadMs:0, readbackMs:0};
        let sampled = null;
        if (data.sampleProvider) {
          at = clock();
          sampled = await data.sampleProvider(tileStart, tileCount);
          tile.sourceSampleMs = clock() - at;
          timing.sampleProviderMs += tile.sourceSampleMs;
          throwIfAborted(controller.signal);
          if (!(sampled instanceof Uint8Array || sampled instanceof Uint8ClampedArray) || sampled.length !== tileCount * samples * 4) {
            throw new RangeError('Tile sample provider returned invalid RGBA geometry');
          }
        }
        at = clock();
        const payload = new Uint8Array(8 + tileCount * samples * 4);
        const packed = new DataView(payload.buffer);
        packed.setUint32(0, 2, true); packed.setUint32(4, tileCount, true);
        const putPixel = (source, src, dest) => packed.setUint32(8 + dest * 4,
          source[src] | (source[src + 1] << 8) | (source[src + 2] << 16), true);
        if (sampled) {
          for (let i = 0; i < tileCount * samples; i++) putPixel(sampled, i * 4, i);
        } else {
          const sourceWidth = data.columns * data.sampleWidth;
          for (let local = 0; local < tileCount; local++) {
            const cell = tileStart + local, cx = cell % data.columns, cy = Math.floor(cell / data.columns);
            for (let sy = 0; sy < data.sampleHeight; sy++) {
              let src = ((cy * data.sampleHeight + sy) * sourceWidth + cx * data.sampleWidth) * 4;
              let dest = local * samples + sy * data.sampleWidth;
              for (let sx = 0; sx < data.sampleWidth; sx++, src += 4, dest++) putPixel(data.pixels, src, dest);
            }
          }
        }
        tile.packMs = clock() - at; timing.tilePackMs += tile.packMs;
        throwIfAborted(controller.signal);
        at = clock();
        const response = await request(this.fetchImpl, `/api/cuda/session/${sessionId}/tile`, {
          method:'POST', body:payload, signal:controller.signal, timeoutMs:this.requestTimeoutMs,
          binary:true, limit:8 + MAX_METADATA_BYTES + tileCount * 16
        });
        tile.bridgeRoundTripMs = clock() - at; timing.bridgeRoundTripMs += tile.bridgeRoundTripMs;
        at = clock();
        const native = decodeTile(response, tileCount, glyphCount, chosen, fg, bg, tileStart,this.precision);
        tile.decodeMs = clock() - at; timing.decodeCellsMs += tile.decodeMs;
        tile.projectionMs = native.timing.gpuProjectionMs; tile.selectionMs = native.timing.gpuSelectionMs;
        tile.uploadMs = native.timing.uploadMs; tile.readbackMs = native.timing.readbackMs;
        tile.recoveredCells=native.recoveredCells;tile.certifiedCells=native.certifiedCells;
        tile.directCells=native.directCells;
        tile.recoveryReasons=native.recoveryReasons??null;
        for(const key of ['gpuGuardMs','gpuRecoveryProjectionMs','gpuRecoverySelectionMs','gpuDirectProjectionMs','gpuDirectSelectionMs']) {
          tile[key]=native.timing[key];timing[key]+=native.timing[key];
        }
        for(const key of ['maxProjectionLaunchMs','maxSelectionLaunchMs']) {
          tile[key]=native.timing[key];timing[key]=Math.max(timing[key],native.timing[key]);
        }
        tile.projectionSublaunches = native.projectionSublaunches === undefined ? null :
          integer(native.projectionSublaunches, 'CUDA projection sublaunch count', 1, Number.MAX_SAFE_INTEGER);
        tile.selectionSublaunches = native.selectionSublaunches === undefined ? null :
          integer(native.selectionSublaunches, 'CUDA selection sublaunch count', 1, Number.MAX_SAFE_INTEGER);
        timing.gpuProjectionMs += tile.projectionMs; timing.gpuSelectionMs += tile.selectionMs;
        timing.uploadMs += tile.uploadMs; timing.readbackMs += tile.readbackMs;
        allocatedBytes = native.allocatedBytes;
        tile.deviceReadbackBytes=native.deviceReadbackBytes;
        uploadedBytes += tileCount * samples * 4; readbackBytes += native.deviceReadbackBytes;
        requestPayloadBytes += payload.byteLength; tileResponseBytes += response.byteLength;
        tile.wallMs = clock() - tileStarted;
        tileMeasurements.push(tile);
        if (timing.firstTileCompletedMs === null) timing.firstTileCompletedMs = clock() - timedStart;
        if (data.onProgress) data.onProgress({type:'progress', stage:'gpu', backend:'cuda',
          completedCells:tileStart + tileCount, totalCells:cells, completedTiles:tileIndex + 1,
          totalTiles:plan.tileCount, elapsedMs:clock() - timedStart, inFlightCapacity:1});
      }
      throwIfAborted(controller.signal);
      return {chosen, fg, bg, stats:{version:'CUDA-001', ...plan, precision:this.precision,
        timing, tileMeasurements, peakInFlightTiles:1, uploadedBytes, readbackBytes, allocatedBytes,
        recoveredCells:tileMeasurements.reduce((sum,tile)=>sum+tile.recoveredCells,0),
        certifiedCells:tileMeasurements.reduce((sum,tile)=>sum+tile.certifiedCells,0),
        directCells:tileMeasurements.reduce((sum,tile)=>sum+tile.directCells,0),
        requestPayloadBytes, tileResponseBytes, adapterInfo:{...this.adapterInfo, ...cudaInfo.device}, cudaInfo,
        projectionSublaunches:tileMeasurements.every(tile => tile.projectionSublaunches !== null) ?
          tileMeasurements.reduce((sum, tile) => sum + tile.projectionSublaunches, 0) : null,
        selectionSublaunches:tileMeasurements.every(tile => tile.selectionSublaunches !== null) ?
          tileMeasurements.reduce((sum, tile) => sum + tile.selectionSublaunches, 0) : null,
        timestampReason:null, timestampSource:'CUDA events; sums of bounded native kernel launches',
        sampleComparisons:cells * glyphCount * samples * 3, glyphCandidates:cells * glyphCount,
        colourCandidates:cells * Math.min(32, glyphCount) * data.foregroundCandidates * data.backgroundCandidates,
        timingNotes:'Fit wall includes native initialization, local HTTP transfer, CUDA work, decoding and session cleanup. Projection/selection use CUDA events; upload/readback use native host timers around transfer and synchronization. Atlas upload is included in initialization, and tile CUDA times are included in bridge round-trip time.'
      }};
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (sessionId) {
        const at = clock();
        try {
          const closed = await request(this.fetchImpl, `/api/cuda/session/${sessionId}`, {
            method:'DELETE', timeoutMs:this.cleanupTimeoutMs
          });
          if (closed.ok !== true) throw new Error('CUDA bridge did not acknowledge session cleanup');
        } catch (error) {
          // Keep the useful compute/abort error if cleanup also fails. An
          // otherwise successful fit must not hide a worker left allocated.
          if (!primaryError) throw new Error(`CUDA session cleanup failed: ${error.message}`);
        } finally {
          timing.cleanupMs = clock() - at;
          timing.wallTotalMs = clock() - timedStart;
          stopRelaying();
          this.activeController = null;
        }
      } else {
        timing.wallTotalMs = clock() - timedStart;
        stopRelaying();
        this.activeController = null;
      }
    }
  }

  close() {
    this.closed = true;
    this.activeController?.abort(abortError());
  }
}
