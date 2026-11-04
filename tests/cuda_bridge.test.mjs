import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbenchServer, parseServerOptions } from '../scripts/serve.mjs';
import { CUDA_LIMITS, validateInitPacket } from '../scripts/cuda_bridge.mjs';
import { PhotographicCudaFitter } from '../overlay/src/gpu/cuda.js';

// Real child processes exercise framing, partial reads, cancellation and pipe errors.
// This fixture never claims to execute CUDA; device and cell results are synthetic.
const MOCK_WORKER = `
const mode = process.env.PNGGPU_MOCK_MODE || 'normal';
const device = Number(process.argv[process.argv.indexOf('--device') + 1]) || 0;
const info = {schema:'pnggpu-cuda-info-v1',backend:'cuda',protocolVersion:1,available:true,
 precision:'float32-guarded-binary64',device:{name:'test fixture (not a GPU)',index:device,
 computeCapability:'7.5',totalMemoryBytes:24*1024**3,freeMemoryBytes:20*1024**3},
 limits:{maxMessageBytes:134217728,maxTileCells:65536,maxSamplesPerCell:2048,maxGlyphCount:65535,
 maxProjectionBytes:134217728,maxPixelBytes:67108864,maxProjectionWork:16777216,maxRecoveryProjectionBytes:33554432,maxRecoveryCells:1024}};
if (process.argv.includes('--info')) {
 if (mode==='info-stall') { setInterval(()=>{},1000); }
 else if (mode==='info-overflow') process.stdout.write('x'.repeat(70000));
 else if (mode==='info-invalid') console.log(JSON.stringify({...info,protocolVersion:42}));
 else console.log(JSON.stringify(info));
} else {
 let input=Buffer.alloc(0), config;
 function reply(metadata, binary=Buffer.alloc(0), status=0) {
  const json=Buffer.from(JSON.stringify(metadata));
  const payload=Buffer.alloc(8+json.length+binary.length);
  payload.writeUInt32LE(status,0); payload.writeUInt32LE(json.length,4);
  json.copy(payload,8); binary.copy(payload,8+json.length);
  const outer=Buffer.alloc(4); outer.writeUInt32LE(payload.length);
  const frame=Buffer.concat([outer,payload]);
  if(mode==='truncated') {process.stdout.write(frame.subarray(0,frame.length-2));process.exitCode=1;process.stdin.destroy();return;}
  if(mode==='oversized') {outer.writeUInt32LE(0xffffffff);process.stdout.write(outer);return;}
  if(mode==='extra') {process.stdout.write(Buffer.concat([frame,Buffer.from([1,2,3])]));return;}
  if(mode==='invalid-json') {frame[12]=0xff;process.stdout.write(frame);return;}
  // Split prefix and payload into distinct writes, including an odd JSON size.
  process.stdout.write(frame.subarray(0,1));
  setTimeout(()=>{process.stdout.write(frame.subarray(1,3));
   setTimeout(()=>process.stdout.write(frame.subarray(3)),1);},1);
 }
 function handle(body) {
  if(body.readUInt32LE(0)===1) {
   config={samples:body.readUInt32LE(8)*body.readUInt32LE(12),glyphs:body.readUInt32LE(16)};
   if(mode==='init-error') {reply({ok:false,error:'test initialization rejection'},Buffer.alloc(0),1);return;}
   const init=()=>reply({ok:true,device:info.device,allocatedBytes:4096});
   if(mode==='slow-init') setTimeout(init,250); else init();
  } else {
   if(mode==='tile-stall') return;
   const tile=()=>{
    const count=body.readUInt32LE(4),out=Buffer.alloc(count*16);
    for(let i=0;i<count;i++) {
     out.writeUInt32LE(body.readUInt32LE(8+i*config.samples*4)%config.glyphs,i*16);
     out.writeUInt32LE(3,i*16+4);out.writeUInt32LE(2,i*16+8);
    }
    reply({ok:true,cellCount:mode==='wrong-count'?count+1:count,
      recoveredCells:count,certifiedCells:0,deviceReadbackBytes:count*32,
      timing:{gpuProjectionMs:1.25,gpuSelectionMs:2.5,uploadMs:0.1,readbackMs:0.2,gpuGuardMs:0.1,gpuRecoveryProjectionMs:0.2,gpuRecoverySelectionMs:0.3,maxProjectionLaunchMs:1,maxSelectionLaunchMs:0.3},allocatedBytes:4096},out);
   };
   if(mode==='slow-tile') setTimeout(tile,250);else tile();
  }
 }
 process.stdin.on('data',chunk=>{
  input=Buffer.concat([input,chunk]);
  while(input.length>=4 && input.length>=4+input.readUInt32LE(0)) {
   const length=input.readUInt32LE(0),body=input.subarray(4,4+length);
   input=input.subarray(4+length);handle(body);
  }
 });
}
`;

function initPacket({ width = 2, height = 1, glyphs = 2, maxTileCells = 8 } = {}) {
  const packet = Buffer.alloc(32 + glyphs * width * height * 4 + glyphs * 16 + 256);
  [1, 1, width, height, glyphs, 6, 5, maxTileCells].forEach((value, i) => packet.writeUInt32LE(value, i * 4));
  return packet;
}
function tilePacket(count = 3, samples = 2) {
  const packet = Buffer.alloc(8 + count * samples * 4);
  packet.writeUInt32LE(2); packet.writeUInt32LE(count, 4);
  for (let i = 0; i < count * samples; i++) packet.writeUInt32LE(i + 1, 8 + i * 4);
  return packet;
}

async function fixture(t, { mode = 'normal', disabled = false, cudaOptions = {}, cudaDevice = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pnggpu-cuda-bridge-'));
  const app = join(directory, 'app');
  await mkdir(app);
  await writeFile(join(app, 'index.html'), '<!doctype html><p>Workbench test fixture</p>');
  await writeFile(join(app, 'module.js'), 'export const testFixture = true;');
  const worker = join(directory, 'mock_worker.cjs');
  await writeFile(worker, MOCK_WORKER);
  const children = new Set(), launches = [];
  const spawnProcess = (executable, args, options) => {
    launches.push({ executable, args, shell: options.shell });
    const child = spawn(process.execPath, [worker, ...args], { ...options,
      env: { ...process.env, PNGGPU_MOCK_MODE: mode } });
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  };
  const server = createWorkbenchServer({ appDirectory: app, cudaExecutable: disabled ? null : '/trusted/cuda-worker',
    cudaDevice, cudaOptions: { spawnProcess, ...cudaOptions } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeCuda(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const child of children) child.kill();
    await Promise.all([...children].map(child => once(child, 'close')));
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { Origin: origin, 'Content-Type': 'application/octet-stream' };
  const send = (path, { method = 'GET', body, requestHeaders = {}, chunks = null } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { ...(method === 'GET' || method === 'HEAD' ? {} : headers), ...requestHeaders } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('error', reject);
      res.on('end', () => {
        const buffer = Buffer.concat(parts);
        resolve({ status: res.statusCode, headers: res.headers, body: buffer,
          text: () => buffer.toString('utf8'), json: () => JSON.parse(buffer.toString('utf8')) });
      });
    });
    req.on('error', reject);
    if (chunks) { for (const part of chunks) req.write(part); }
    else if (body) req.write(body);
    req.end();
  });
  const open = async () => {
    const response = await send('/api/cuda/session', { method: 'POST', body: initPacket() });
    assert.equal(response.status, 200, response.text());
    return response.json().sessionId;
  };
  return { server, directory, port, origin, send, open, launches, children, headers };
}

async function waitFor(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail('Timed out waiting for native child lifecycle');
}

test('default server serves the workbench and reports CUDA disabled without spawning a process', async t => {
  const app = await fixture(t, { disabled: true });
  const home = await app.send('/');
  assert.equal(home.status, 200); assert.match(home.text(), /Workbench test fixture/);
  const module = await app.send('/module.js', { method: 'HEAD' });
  assert.equal(module.status, 200); assert.equal(module.body.length, 0);
  assert.match(module.headers['content-type'], /javascript/);
  const info = await app.send('/api/cuda/info');
  assert.equal(info.status, 200); assert.equal(info.json().available, false);
  assert.match(info.json().error, /optional/);
  assert.equal((await app.send('/api/cuda/session', { method: 'POST', body: initPacket() })).status, 503);
  assert.equal(app.launches.length, 0);
});

test('same-origin HTTP requests reuse one persistent worker and preserve binary tile results', async t => {
  const app = await fixture(t, { cudaDevice: 2 });
  const info = await app.send('/api/cuda/info');
  assert.equal(info.status, 200); assert.equal(info.json().available, true);
  assert.equal(info.json().device.index, 2);
  assert.equal(info.json().limits.maxProjectionWork, 16_777_216);
  const id = await app.open();
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  for (const count of [3, 1]) {
    const response = await app.send(`/api/cuda/session/${id}/tile`, { method: 'POST', body: tilePacket(count) });
    assert.equal(response.status, 200, response.text());
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.body.readUInt32LE(0), 0);
    const jsonLength = response.body.readUInt32LE(4), dataOffset = 8 + jsonLength;
    const metadata = JSON.parse(response.body.subarray(8, dataOffset));
    assert.equal(metadata.cellCount, count); assert.equal(metadata.timing.gpuProjectionMs, 1.25);
    assert.equal(response.body.length - dataOffset, count * 16);
    assert.equal(response.body.readUInt32LE(dataOffset), 1);
    assert.equal(response.body.readUInt32LE(dataOffset + 4), 3);
  }
  assert.equal(app.launches.length, 2); // one --info process and one persistent session
  assert.deepEqual(app.launches.map(item => item.args), [['--info', '--device', '2'], ['--stdio', '--device', '2']]);
  assert.ok(app.launches.every(item => item.shell === false));
  assert.equal((await app.send(`/api/cuda/session/${id}`, { method: 'DELETE' })).status, 200);
  await waitFor(() => app.children.size === 0);
  assert.equal((await app.send(`/api/cuda/session/${id}/tile`, { method: 'POST', body: tilePacket() })).status, 404);
});

test('default device auto-selection is preserved by omitting --device', async t => {
  const app = await fixture(t);
  await app.send('/api/cuda/info');
  await app.open();
  assert.deepEqual(app.launches.map(item => item.args), [['--info'], ['--stdio']]);
});

test('browser fitter traverses HTTP, native framing and cleanup with partial final tiles', async t => {
  const app = await fixture(t);
  const fitter = await PhotographicCudaFitter.create({ fetchImpl: (path, options) =>
    fetch(new URL(path, app.origin), { ...options, headers: { ...options.headers, Origin: app.origin } }) });
  const pixels = new Uint8Array(3 * 2 * 2 * 2 * 4), events = [];
  for (let cell = 0; cell < 6; cell++) {
    const cx = cell % 3, cy = Math.floor(cell / 3);
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      pixels.set([cell + 1, 0, 0, 255], ((cy * 2 + sy) * 6 + cx * 2 + sx) * 4);
    }
  }
  const result = await fitter.fit({ pixels, columns: 3, rows: 2, sampleWidth: 2, sampleHeight: 2,
    masks: [Float32Array.of(0, 1, 0, 1), Float32Array.of(1, 0, 1, 0)],
    palette: Array.from({ length: 16 }, (_, i) => [i, i * 2, i * 3]),
    foregroundCandidates: 6, backgroundCandidates: 5, preferredTileCells: 4, inFlightTiles: 24,
    onProgress: event => events.push(event) });
  assert.deepEqual([...result.chosen], [1, 0, 1, 0, 1, 0]);
  assert.deepEqual([...result.fg], [3, 3, 3, 3, 3, 3]);
  assert.deepEqual([...result.bg], [2, 2, 2, 2, 2, 2]);
  assert.deepEqual(events.map(event => event.completedCells), [4, 6]);
  assert.equal(result.stats.inFlightTiles, 1); assert.equal(result.stats.requestedInFlightTiles, 24);
  assert.equal(result.stats.timing.gpuProjectionMs, 2.5); assert.equal(result.stats.timing.gpuSelectionMs, 5);
  assert.equal(app.launches.length, 2); assert.equal(app.children.size, 0);
  fitter.close();
});

test('cross-origin, opaque-origin, rebinding and missing-origin mutations are rejected before launching CUDA', async t => {
  const app = await fixture(t);
  for (const requestHeaders of [
    { Origin: 'https://example.org' }, { Origin: 'null' }, { Origin: '' },
    { Origin: `http://localhost:${app.port}` }, { Host: `rebind.example:${app.port}` },
    { Host: `127.0.0.1:${app.port + 1}` }, { 'Sec-Fetch-Site': 'cross-site' }
  ]) {
    const response = await app.send('/api/cuda/session', { method: 'POST', body: initPacket(), requestHeaders });
    assert.equal(response.status, 403, response.text());
  }
  const response = await fetch(`${app.origin}/api/cuda/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: initPacket()
  });
  assert.equal(response.status, 403);
  assert.equal((await app.send('/api/cuda/info', { requestHeaders: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(app.launches.length, 0);
});

test('binary content type, methods, endpoint paths and packet geometry are checked before child creation', async t => {
  const app = await fixture(t);
  assert.equal((await app.send('/api/cuda/session', { method: 'POST', body: initPacket(), requestHeaders: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.send('/api/cuda/session')).status, 405);
  assert.equal((await app.send('/api/cuda/info?device=0')).status, 400);
  assert.equal((await app.send('/api/cuda/run-any-command', { method: 'POST' })).status, 404);
  for (const body of [Buffer.alloc(1), initPacket().subarray(0, 40), Buffer.concat([initPacket(), Buffer.alloc(4)]), initPacket({ width: 0 })]) {
    assert.equal((await app.send('/api/cuda/session', { method: 'POST', body })).status, 400);
  }
  assert.equal(app.launches.length, 0);
  const id = await app.open();
  assert.equal((await app.send(`/api/cuda/session/${id}/tile`, { method: 'POST', body: Buffer.alloc(8) })).status, 400);
  await waitFor(() => app.children.size === 0);
});

test('initialization tile caps match native memory bounds without confusing kernel chunking with HTTP tile size', () => {
  assert.throws(() => validateInitPacket(initPacket({ width: 32, height: 64, maxTileCells: 65_536 })), /memory limit/);
  assert.throws(() => validateInitPacket(initPacket({ glyphs: 129, maxTileCells: 65_536 })), /memory limit/);
  const packet = initPacket({ width: 32, height: 64, glyphs: 219, maxTileCells: 1024 });
  assert.equal(validateInitPacket(packet).maxTileCells, 1024); // native chunks kernels within this HTTP tile
});

test('declared and streamed oversized HTTP bodies fail without allocating a worker', async t => {
  const app = await fixture(t, { cudaOptions: { maxRequestBytes: 1024 } });
  const declared = await app.send('/api/cuda/session', { method: 'POST', requestHeaders: { 'Content-Length': '2048' } });
  assert.equal(declared.status, 413);
  const streamed = await app.send('/api/cuda/session', { method: 'POST', chunks: [Buffer.alloc(600), Buffer.alloc(600)] });
  assert.equal(streamed.status, 413);
  assert.equal(app.launches.length, 0);
  assert.ok(await app.open());
});

test('one active session prevents competing allocations and DELETE permits a new session', async t => {
  const app = await fixture(t);
  const id = await app.open();
  assert.equal((await app.send('/api/cuda/session', { method: 'POST', body: initPacket() })).status, 409);
  assert.equal(app.launches.length, 1);
  await app.send(`/api/cuda/session/${id}`, { method: 'DELETE' });
  assert.equal(app.children.size, 0);
  const next = await app.open();
  assert.notEqual(next, id); assert.equal(app.launches.length, 2);
});

test('a session is reserved while its native initialization is pending', async t => {
  const app = await fixture(t, { mode: 'slow-init' });
  const pending = app.open();
  await waitFor(() => app.launches.length === 1);
  const competing = await app.send('/api/cuda/session', { method: 'POST', body: initPacket() });
  assert.equal(competing.status, 409);
  assert.ok(await pending);
});

test('tiles are serialized and DELETE cancels a pending tile and releases the worker', async t => {
  const app = await fixture(t, { mode: 'slow-tile' });
  const id = await app.open(), path = `/api/cuda/session/${id}/tile`;
  const pending = app.send(path, { method: 'POST', body: tilePacket() });
  await delay(25);
  assert.equal((await app.send(path, { method: 'POST', body: tilePacket() })).status, 409);
  assert.equal((await app.send(`/api/cuda/session/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await pending).status, 499);
  await waitFor(() => app.children.size === 0);
});

test('disconnecting a tile HTTP request terminates the native worker', async t => {
  const app = await fixture(t, { mode: 'tile-stall' });
  const id = await app.open();
  const controller = new AbortController();
  const pending = fetch(`${app.origin}/api/cuda/session/${id}/tile`, { method: 'POST', body: tilePacket(),
    headers: app.headers, signal: controller.signal });
  await delay(25);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await waitFor(() => app.children.size === 0);
  assert.ok(await app.open());
});

test('disconnecting initialization before receiving the session ID releases the worker', async t => {
  const app = await fixture(t, { mode: 'slow-init' });
  const controller = new AbortController();
  const pending = fetch(`${app.origin}/api/cuda/session`, { method: 'POST', body: initPacket(),
    headers: app.headers, signal: controller.signal });
  await waitFor(() => app.launches.length === 1);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await waitFor(() => app.children.size === 0);
  assert.ok(await app.open());
});

test('native operation timeout kills the worker and makes a retry possible', async t => {
  const app = await fixture(t, { mode: 'tile-stall', cudaOptions: { operationTimeoutMs: 1000 } });
  const id = await app.open();
  const response = await app.send(`/api/cuda/session/${id}/tile`, { method: 'POST', body: tilePacket() });
  assert.equal(response.status, 504); assert.match(response.json().error, /timed out/);
  await waitFor(() => app.children.size === 0);
  assert.ok(await app.open());
});

test('idle sessions expire and release their native allocations', async t => {
  const app = await fixture(t, { cudaOptions: { idleTimeoutMs: 40 } });
  const id = await app.open();
  await waitFor(() => app.children.size === 0);
  assert.equal((await app.send(`/api/cuda/session/${id}`, { method: 'DELETE' })).status, 404);
  assert.ok(await app.open());
});

for (const mode of ['truncated', 'oversized', 'extra', 'invalid-json', 'init-error']) {
  test(`worker ${mode} response fails the request and releases the session`, async t => {
    const app = await fixture(t, { mode });
    const response = await app.send('/api/cuda/session', { method: 'POST', body: initPacket() });
    assert.equal(response.status, mode === 'init-error' ? 422 : 502, response.text());
    assert.equal(response.json().ok, false);
    await waitFor(() => app.children.size === 0);
    const retry = await app.send('/api/cuda/session', { method: 'POST', body: initPacket() });
    assert.notEqual(retry.status, 409);
  });
}

test('a wrong native result count is rejected before returning binary data', async t => {
  const app = await fixture(t, { mode: 'wrong-count' });
  const id = await app.open();
  const response = await app.send(`/api/cuda/session/${id}/tile`, { method: 'POST', body: tilePacket() });
  assert.equal(response.status, 502); assert.match(response.json().error, /number of cells/);
  await waitFor(() => app.children.size === 0);
});

for (const mode of ['info-invalid', 'info-overflow', 'info-stall']) {
  test(`device detection ${mode} reports unavailable while the workbench keeps working`, async t => {
    const app = await fixture(t, { mode, cudaOptions: { infoTimeoutMs: 1000 } });
    const response = await app.send('/api/cuda/info');
    assert.equal(response.status, 200); assert.equal(response.json().available, false);
    assert.ok(response.json().error); assert.equal((await app.send('/')).status, 200);
    await waitFor(() => app.children.size === 0);
  });
}

test('server shutdown cancels an in-flight device probe', async t => {
  const app = await fixture(t, { mode: 'info-stall' });
  const pending = app.send('/api/cuda/info');
  await waitFor(() => app.launches.length === 1);
  await app.server.closeCuda();
  assert.equal((await pending).json().available, false);
  await waitFor(() => app.children.size === 0);
});

test('a missing executable reports a useful error and leaves the static app usable', async t => {
  const app = await fixture(t, { cudaOptions: { spawnProcess: spawn } });
  const info = await app.send('/api/cuda/info');
  assert.equal(info.status, 200); assert.equal(info.json().available, false);
  assert.match(info.json().error, /Could not start/);
  const initial = await app.send('/api/cuda/session', { method: 'POST', body: initPacket() });
  assert.equal(initial.status, 503); assert.match(initial.json().error, /executable path/);
  assert.equal((await app.send('/')).status, 200);
});

test('CLI accepts explicit optional CUDA/device arguments and rejects malformed options', () => {
  const plain = parseServerOptions(['PNG2ANSI', '8000']);
  assert.equal(plain.cudaExecutable, null); assert.equal(plain.cudaDevice, null);
  const cuda = parseServerOptions(['PNG2ANSI', '8001', '--cuda', 'native worker.exe', '--device', '2']);
  assert.equal(cuda.cudaExecutable, resolve('native worker.exe')); assert.equal(cuda.cudaDevice, 2);
  for (const args of [ ['app', '0'], ['app', '65536'], ['app', '8000', '--cuda'],
    ['app', '8000', '--device', '1'], ['app', '8000', '--cuda', 'worker', '--device', '-1'],
    ['app', '8000', '--cuda', 'worker', '--device', 'NaN'],
    ['app', '8000', '--cuda', 'worker', '--device', '9007199254740992'],
    ['app', '8000', '--unknown', 'cmd'], ['app', '8000', '--cuda', 'a', '--cuda', 'b'] ]) {
    assert.throws(() => parseServerOptions(args));
  }
  assert.equal(CUDA_LIMITS.maxMessageBytes, 134_217_728);
});
