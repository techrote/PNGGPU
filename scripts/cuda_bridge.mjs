/** Optional, same-origin bridge to the local CUDA worker. No package dependencies. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const CUDA_PROTOCOL_VERSION = 1;
export const CUDA_LIMITS = Object.freeze({
  maxMessageBytes: 128 * 1024 * 1024,
  maxTileCells: 65_536,
  maxSamplesPerCell: 2048,
  maxGlyphCount: 65_535,
  maxProjectionBytes: 128 * 1024 * 1024,
  maxPixelBytes: 64 * 1024 * 1024
});
const MAX_JSON_BYTES = 64 * 1024;
const INFO_SCHEMA = 'pnggpu-cuda-info-v1';
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/** Reject DNS-rebinding hosts and cross-origin browser requests before reading bodies. */
export function assertLocalRequest(req, port, { mutation = false } = {}) {
  const host = req.headers.host;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) { allowed.add('127.0.0.1'); allowed.add('localhost'); }
  if (typeof host !== 'string' || !allowed.has(host.toLowerCase())) {
    throw new BridgeError(403, 'Use this workbench through its localhost address.');
  }
  const countHeader = name => req.rawHeaders.filter((_, i) => i % 2 === 0 &&
    req.rawHeaders[i].toLowerCase() === name).length;
  if (countHeader('host') !== 1 || countHeader('origin') > 1) {
    throw new BridgeError(403, 'Ambiguous request origin.');
  }
  const origin = req.headers.origin;
  const expectedOrigin = new URL(`http://${host}`).origin;
  if ((origin !== undefined && origin !== expectedOrigin) || (mutation && origin === undefined) ||
      req.headers['sec-fetch-site'] === 'cross-site') {
    throw new BridgeError(403, 'CUDA requests must come from this workbench origin.');
  }
  return expectedOrigin;
}

function requireBinary(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw new BridgeError(415, 'CUDA requests require application/octet-stream.');
  }
}

function readBody(req, maximum, timeoutMs) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    return Promise.reject(new BridgeError(400, 'Invalid request Content-Length.'));
  }
  if (Number(declared) > maximum) return Promise.reject(new BridgeError(413, 'CUDA request is too large.'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0, done = false;
    const finish = (error, body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd);
      req.off('error', onError); req.off('aborted', onAbort);
      if (error) { req.resume(); reject(error); } else resolve(body);
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > maximum) { finish(new BridgeError(413, 'CUDA request is too large.')); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, length));
    const onError = () => finish(new BridgeError(400, 'CUDA request body could not be read.'));
    const onAbort = () => finish(new BridgeError(499, 'CUDA request was cancelled.'));
    const timer = setTimeout(() => finish(new BridgeError(408, 'CUDA request upload timed out.')), timeoutMs);
    timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
    if (req.aborted) onAbort();
  });
}

export function validateInitPacket(body) {
  if (body.length < 32 || body.readUInt32LE(0) !== 1 || body.readUInt32LE(4) !== CUDA_PROTOCOL_VERSION) {
    throw new BridgeError(400, 'Invalid CUDA initialization packet or protocol version.');
  }
  const sampleWidth = body.readUInt32LE(8), sampleHeight = body.readUInt32LE(12);
  const glyphCount = body.readUInt32LE(16), foregroundCandidates = body.readUInt32LE(20);
  const backgroundCandidates = body.readUInt32LE(24), maxTileCells = body.readUInt32LE(28);
  if (sampleWidth < 1 || sampleWidth > 32 || sampleHeight < 1 || sampleHeight > 64 ||
      glyphCount < 1 || glyphCount > CUDA_LIMITS.maxGlyphCount ||
      foregroundCandidates < 1 || foregroundCandidates > 12 ||
      backgroundCandidates < 1 || backgroundCandidates > 8 ||
      maxTileCells < 1 || maxTileCells > CUDA_LIMITS.maxTileCells) {
    throw new BridgeError(400, 'CUDA initialization geometry or candidate counts are outside supported limits.');
  }
  const samples = sampleWidth * sampleHeight;
  const expected = 32 + glyphCount * samples * 4 + glyphCount * 16 + 16 * 16;
  if (expected !== body.length || expected > CUDA_LIMITS.maxMessageBytes) {
    throw new BridgeError(400, 'CUDA initialization payload does not match its geometry.');
  }
  if (maxTileCells * samples * 4 > CUDA_LIMITS.maxPixelBytes || maxTileCells * glyphCount * 16 > CUDA_LIMITS.maxProjectionBytes) {
    throw new BridgeError(400, 'CUDA tile exceeds the worker memory limit.');
  }
  return { sampleWidth, sampleHeight, samples, glyphCount, foregroundCandidates, backgroundCandidates, maxTileCells };
}

function validateTilePacket(body, config) {
  if (body.length < 8 || body.readUInt32LE(0) !== 2) throw new BridgeError(400, 'Invalid CUDA tile packet.');
  const cellCount = body.readUInt32LE(4);
  if (cellCount < 1 || cellCount > config.maxTileCells || body.length !== 8 + cellCount * config.samples * 4) {
    throw new BridgeError(400, 'CUDA tile payload does not match its geometry.');
  }
  return cellCount;
}

function parseResponse(payload) {
  if (payload.length < 8) throw new BridgeError(502, 'CUDA worker returned a truncated response.');
  const status = payload.readUInt32LE(0), jsonLength = payload.readUInt32LE(4);
  if (status > 1 || jsonLength < 2 || jsonLength > MAX_JSON_BYTES || 8 + jsonLength > payload.length) {
    throw new BridgeError(502, 'CUDA worker returned an invalid response header.');
  }
  let metadata;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(8, 8 + jsonLength))); }
  catch { throw new BridgeError(502, 'CUDA worker returned invalid JSON metadata.'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.ok !== (status === 0)) {
    throw new BridgeError(502, 'CUDA worker returned inconsistent status metadata.');
  }
  if (status !== 0) throw new BridgeError(422, typeof metadata.error === 'string' ? metadata.error : 'CUDA worker rejected the request.');
  return { metadata, payload, dataOffset: 8 + jsonLength };
}

/** Exactly one outstanding request, with bounded framing and no shell invocation. */
class NativeSession {
  constructor({ executable, device, arithmeticMode, spawnProcess, timeoutMs, onFailure }) {
    this.closed = false;
    this.exited = false;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.pending = null;
    this.onFailure = onFailure;
    this.timeoutMs = timeoutMs;
    this.stderr = '';
    const args = ['--stdio', ...(device === null ? [] : ['--device', String(device)]),
      ...(arithmeticMode==='binary64-direct'?['--arithmetic-mode',arithmeticMode]:[])];
    this.child = spawnProcess(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child.on('error', () => this.fail(new BridgeError(503, 'Could not start the CUDA worker. Build it and check the --cuda executable path.')));
    this.child.stdin.on('error', () => this.fail(new BridgeError(502, 'CUDA worker input stream closed.')));
    this.child.stdout.on('error', () => this.fail(new BridgeError(502, 'CUDA worker output stream failed.')));
    this.child.stderr.on('error', () => {});
    this.child.stderr.on('data', chunk => {
      if (this.stderr.length < 4096) this.stderr += chunk.toString('utf8').slice(0, 4096 - this.stderr.length);
    });
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.once('close', () => {
      this.exited = true;
      clearTimeout(this.killTimer);
      this.resolveExit();
      if (!this.closed) this.fail(new BridgeError(502, 'CUDA worker exited before the session was closed.' +
        (this.stderr.trim() ? ` ${this.stderr.trim()}` : '')));
    });
  }

  request(payload, responseLimit) {
    if (this.closed) return Promise.reject(new BridgeError(502, 'CUDA worker session is closed.'));
    if (this.pending) return Promise.reject(new BridgeError(409, 'CUDA worker is already processing a tile.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new BridgeError(504, 'CUDA worker operation timed out; the session was stopped.')), this.timeoutMs);
      timer.unref?.();
      this.pending = { resolve, reject, timer, responseLimit, prefix: Buffer.alloc(4), prefixBytes: 0,
        payload: null, payloadBytes: 0 };
      const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length);
      const written = error => { if (error) this.fail(new BridgeError(502, 'Could not write the CUDA worker request.')); };
      this.child.stdin.write(prefix, written);
      this.child.stdin.write(payload, written);
    });
  }

  receive(chunk) {
    if (this.closed) return;
    const pending = this.pending;
    if (!pending) { this.fail(new BridgeError(502, 'CUDA worker emitted an unsolicited response.')); return; }
    let offset = 0;
    if (pending.prefixBytes < 4) {
      const take = Math.min(4 - pending.prefixBytes, chunk.length);
      chunk.copy(pending.prefix, pending.prefixBytes, 0, take);
      pending.prefixBytes += take; offset += take;
      if (pending.prefixBytes < 4) return;
      const length = pending.prefix.readUInt32LE(0);
      if (length < 8 || length > pending.responseLimit || length > CUDA_LIMITS.maxMessageBytes) {
        this.fail(new BridgeError(502, 'CUDA worker response exceeds the allowed frame size.')); return;
      }
      pending.payload = Buffer.alloc(length);
    }
    const take = Math.min(pending.payload.length - pending.payloadBytes, chunk.length - offset);
    chunk.copy(pending.payload, pending.payloadBytes, offset, offset + take);
    pending.payloadBytes += take; offset += take;
    if (offset !== chunk.length) { this.fail(new BridgeError(502, 'CUDA worker emitted trailing response bytes.')); return; }
    if (pending.payloadBytes === pending.payload.length) {
      let result;
      try { result = parseResponse(pending.payload); }
      catch (error) { this.fail(error); return; }
      this.pending = null; clearTimeout(pending.timer); pending.resolve(result);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.close(error);
    this.onFailure(error);
  }

  close(error = new BridgeError(499, 'CUDA session was cancelled.')) {
    if (this.closed) return this.exitPromise;
    this.closed = true;
    if (this.pending) {
      const { reject, timer } = this.pending;
      this.pending = null; clearTimeout(timer); reject(error);
    }
    if (!this.exited) {
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      this.child.kill();
      // Some POSIX workers may ignore SIGTERM. This timer does not keep Node alive.
      this.killTimer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 1000);
      this.killTimer.unref?.();
    }
    return this.exitPromise;
  }
}

function probeWorker({ executable, device, arithmeticMode, spawnProcess, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let child, output = '', stderr = '', done = false, timer;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) { child?.kill(); reject(error); } else resolve(value);
    };
    const onAbort = () => finish(new BridgeError(499, 'CUDA device detection was stopped.'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try { child = spawnProcess(executable, ['--info', ...(device === null ? [] : ['--device', String(device)]),
      ...(arithmeticMode==='binary64-direct'?['--arithmetic-mode',arithmeticMode]:[])],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch { finish(new BridgeError(503, 'Could not start the CUDA worker. Build it and check the --cuda executable path.')); return; }
    timer = setTimeout(() => finish(new BridgeError(504, 'CUDA device detection timed out.')), timeoutMs);
    timer.unref?.();
    child.once('error', () => finish(new BridgeError(503, 'Could not start the CUDA worker. Build it and check the --cuda executable path.')));
    child.stdout.on('error', () => finish(new BridgeError(502, 'CUDA device detection output failed.')));
    child.stderr.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (Buffer.byteLength(output) + chunk.length > MAX_JSON_BYTES) { finish(new BridgeError(502, 'CUDA device report is too large.')); return; }
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
    child.once('close', code => {
      if (done) return;
      let value;
      try { value = JSON.parse(output); } catch {
        finish(new BridgeError(503, 'CUDA worker did not return a device report.' + (stderr.trim() ? ` ${stderr.trim()}` : ''))); return;
      }
      if (value?.schema !== INFO_SCHEMA || value.backend !== 'cuda' || value.protocolVersion !== CUDA_PROTOCOL_VERSION ||
          typeof value.available !== 'boolean' || (code !== 0 && value.available)||
          (value.available&&value.precision!==arithmeticMode)) {
        finish(new BridgeError(502, 'CUDA worker uses an incompatible device-report protocol.')); return;
      }
      finish(null, value);
    });
  });
}

export function createCudaBridge({ executable = null, device = null, arithmeticMode='float32-guarded-binary64', spawnProcess = spawn,
    idleTimeoutMs = 120_000, operationTimeoutMs = 120_000, infoTimeoutMs = 15_000,
    uploadTimeoutMs = 30_000, maxRequestBytes = CUDA_LIMITS.maxMessageBytes } = {}) {
  if (device !== null && (!Number.isSafeInteger(device) || device < 0)) throw new RangeError('CUDA device index must be a non-negative integer.');
  if(!['float32-guarded-binary64','binary64-direct'].includes(arithmeticMode))throw new RangeError('Unsupported CUDA arithmetic mode');
  if (![idleTimeoutMs, operationTimeoutMs, infoTimeoutMs, uploadTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 32 || maxRequestBytes > CUDA_LIMITS.maxMessageBytes) {
    throw new RangeError('Invalid CUDA bridge limits.');
  }
  let session = null, infoPromise = null, infoAbort = null;
  const disabled = { schema: INFO_SCHEMA, backend: 'cuda', protocolVersion: CUDA_PROTOCOL_VERSION, available: false,
    error: 'CUDA is optional. Start start-cuda.bat, or launch this server with --cuda PATH to the built native worker.' };
  const closeSession = (entry, error) => {
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    clearTimeout(entry.idleTimer); entry.state = 'closed';
    // Keep the allocation slot reserved until the native process has actually
    // exited. A subsequent fit must not race the previous CUDA context cleanup.
    entry.closing = Promise.resolve(entry.worker?.close(error)).then(() => {
      if (session === entry) session = null;
    });
    return entry.closing;
  };
  const armIdle = entry => {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => closeSession(entry, new BridgeError(408, 'CUDA session expired while idle.')), idleTimeoutMs);
    entry.idleTimer.unref?.();
  };
  const watchDisconnect = (req, res, entry) => {
    const cleanup = () => { req.off('aborted', abort); res.off('close', close); res.off('finish', cleanup); };
    const abort = () => { void closeSession(entry, new BridgeError(499, 'CUDA request was cancelled.')); cleanup(); };
    const close = () => { if (!res.writableFinished) abort(); cleanup(); };
    req.once('aborted', abort); res.once('close', close);
    res.once('finish', cleanup);
    return () => {
      // res.end() can precede a lost connection. Retain the watcher until the
      // response has actually finished, especially for the session-ID response.
      if (!res.writableEnded || res.writableFinished || res.destroyed) cleanup();
    };
  };

  return {
    close() { infoAbort?.abort(); return closeSession(session); },
    async handle(req, res) {
      if (!req.url?.startsWith('/api/cuda/') && req.url !== '/api/cuda') return false;
      let entry = null, unwatch = () => {};
      try {
        const origin = assertLocalRequest(req, req.socket.localPort, { mutation: req.method !== 'GET' && req.method !== 'HEAD' });
        const url = new URL(req.url, origin);
        if (url.search) throw new BridgeError(400, 'CUDA endpoints do not accept query parameters.');
        const path = url.pathname;
        if (path === '/api/cuda/info') {
          if (req.method !== 'GET') throw new BridgeError(405, 'CUDA device information requires GET.');
          if (!executable) { sendJson(res, 200, disabled); return true; }
          if (!infoPromise) {
            infoAbort = new AbortController();
            infoPromise = probeWorker({ executable, device, arithmeticMode, spawnProcess, timeoutMs: infoTimeoutMs, signal: infoAbort.signal })
              .catch(error => ({ ...disabled, error: error.message })).finally(() => { infoPromise = null; infoAbort = null; });
          }
          sendJson(res, 200, await infoPromise); return true;
        }
        if (!executable) throw new BridgeError(503, disabled.error);
        if (path === '/api/cuda/session') {
          if (req.method !== 'POST') throw new BridgeError(405, 'Creating a CUDA session requires POST.');
          requireBinary(req);
          if (session) throw new BridgeError(409, 'The local CUDA worker is busy. Finish or stop the active conversion first.');
          entry = { id: randomBytes(32).toString('base64url'), state: 'initializing', worker: null, config: null };
          session = entry; unwatch = watchDisconnect(req, res, entry);
          const body = await readBody(req, maxRequestBytes, uploadTimeoutMs);
          if (entry.state === 'closed') throw new BridgeError(499, 'CUDA request was cancelled.');
          entry.config = validateInitPacket(body);
          entry.worker = new NativeSession({ executable, device, arithmeticMode, spawnProcess, timeoutMs: operationTimeoutMs,
            onFailure: error => closeSession(entry, error) });
          const response = await entry.worker.request(body, 8 + MAX_JSON_BYTES);
          if (response.payload.length !== response.dataOffset) throw new BridgeError(502, 'CUDA initialization returned unexpected binary data.');
          entry.state = 'ready'; armIdle(entry);
          sendJson(res, 200, { ...response.metadata, ok: true, sessionId: entry.id });
          return true;
        }
        const match = /^\/api\/cuda\/session\/([^/]+)(\/tile)?$/.exec(path);
        if (!match || !SESSION_ID.test(match[1])) throw new BridgeError(404, 'Unknown CUDA endpoint.');
        if (!session || session.id !== match[1]) throw new BridgeError(404, 'CUDA session is closed or unknown. Start the conversion again.');
        if (!match[2]) {
          if (req.method !== 'DELETE') throw new BridgeError(405, 'Closing a CUDA session requires DELETE.');
          await closeSession(session); sendJson(res, 200, { ok: true }); return true;
        }
        if (req.method !== 'POST') throw new BridgeError(405, 'CUDA tiles require POST.');
        requireBinary(req);
        if (session.state !== 'ready') throw new BridgeError(409, 'A tile is already running in this CUDA session.');
        entry = session; entry.state = 'busy'; clearTimeout(entry.idleTimer);
        unwatch = watchDisconnect(req, res, entry);
        const body = await readBody(req, Math.min(maxRequestBytes, 8 + entry.config.maxTileCells * entry.config.samples * 4), uploadTimeoutMs);
        const cellCount = validateTilePacket(body, entry.config);
        const response = await entry.worker.request(body, 8 + MAX_JSON_BYTES + cellCount * 16);
        if (response.metadata.cellCount !== cellCount || response.payload.length - response.dataOffset !== cellCount * 16) {
          throw new BridgeError(502, 'CUDA worker returned an unexpected number of cells.');
        }
        entry.state = 'ready'; armIdle(entry);
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': response.payload.length,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(response.payload);
        }
        return true;
      } catch (error) {
        if (entry) await closeSession(entry, error);
        // Stop oversized or stalled uploads instead of retaining an HTTP connection.
        if ((error.status === 413 || error.status === 408) && !res.headersSent) res.setHeader('Connection', 'close');
        req.resume();
        sendJson(res, error.status || 500, { ok: false, error: error.status ? error.message : 'CUDA bridge failed.' });
        return true;
      } finally { unwatch(); }
    }
  };
}
