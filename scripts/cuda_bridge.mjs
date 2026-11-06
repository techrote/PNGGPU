/** Optional, same-origin bridge to the local CUDA worker. No package dependencies. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {CUDA_PROTOCOL_VERSION,CUDA_LIMITS,MAX_JSON_BYTES,BridgeError,NativeSession,probeWorker,validateInitPacket,validateTilePacket} from './cuda_worker_session.mjs';
export {CUDA_PROTOCOL_VERSION,CUDA_LIMITS,validateInitPacket} from './cuda_worker_session.mjs';
const INFO_SCHEMA='pnggpu-cuda-info-v1';
const SESSION_ID=/^[A-Za-z0-9_-]{16,128}$/;

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

export function createCudaBridge({ executable = null, device = null, arithmeticMode='float32-guarded-binary64', spawnProcess = spawn,
    idleTimeoutMs = 120_000, operationTimeoutMs = 120_000, infoTimeoutMs = 15_000,
    uploadTimeoutMs = 30_000, maxRequestBytes = CUDA_LIMITS.maxMessageBytes } = {}) {
  if (device !== null && (!Number.isSafeInteger(device) || device < 0)) throw new RangeError('CUDA device index must be a non-negative integer.');
  if(!['float32-guarded-binary64','binary64-direct','float32-direct','float16-mixed'].includes(arithmeticMode))throw new RangeError('Unsupported CUDA arithmetic mode');
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
