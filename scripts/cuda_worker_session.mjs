/** Shared private-process binary protocol. No HTTP listener or GPU work on import. */
export const CUDA_PROTOCOL_VERSION = 1;
export const CUDA_LIMITS = Object.freeze({
  maxMessageBytes: 128 * 1024 * 1024,
  maxTileCells: 65_536,
  maxSamplesPerCell: 2048,
  maxGlyphCount: 65_535,
  maxProjectionBytes: 128 * 1024 * 1024,
  maxPixelBytes: 64 * 1024 * 1024
});
export const MAX_JSON_BYTES = 64 * 1024;
const INFO_SCHEMA = 'pnggpu-cuda-info-v1';
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;

export class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

export function validateTilePacket(body, config) {
  if (body.length < 8 || body.readUInt32LE(0) !== 2) throw new BridgeError(400, 'Invalid CUDA tile packet.');
  const cellCount = body.readUInt32LE(4);
  if (cellCount < 1 || cellCount > config.maxTileCells || body.length !== 8 + cellCount * config.samples * 4) {
    throw new BridgeError(400, 'CUDA tile payload does not match its geometry.');
  }
  return cellCount;
}

export function validateRasterTilePacket(body,config) {
  if(body.length<20||body.readUInt32LE(0)!==3||body.length>CUDA_LIMITS.maxMessageBytes)throw new BridgeError(400,'Invalid raster tile packet');
  const count=body.readUInt32LE(4),columns=body.readUInt32LE(8),rows=body.readUInt32LE(12),start=body.readUInt32LE(16),bytes=count*config.samples*4;
  if(count<1||count>config.maxTileCells||columns<1||columns>1024||rows<1||rows>1024||start+count>columns*rows||
    bytes>CUDA_LIMITS.maxPixelBytes||body.length!==20+bytes)throw new BridgeError(400,'Raster tile geometry exceeds bounds');
  return count;
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
export class NativeSession {
  constructor({ executable, device, arithmeticMode, spawnProcess, timeoutMs, onFailure }) {
    this.closed = false;
    this.exited = false;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.pending = null;
    this.onFailure = onFailure;
    this.timeoutMs = timeoutMs;
    this.stderr = '';
    const args = ['--stdio', ...(device === null ? [] : ['--device', String(device)]),
      ...(arithmeticMode!=='float32-guarded-binary64'?['--arithmetic-mode',arithmeticMode]:[])];
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
    if (!Buffer.isBuffer(payload) || payload.length < 4 || payload.length > CUDA_LIMITS.maxMessageBytes ||
        !Number.isSafeInteger(responseLimit) || responseLimit < 8 || responseLimit > CUDA_LIMITS.maxMessageBytes)
      return Promise.reject(new BridgeError(400, 'Invalid bounded CUDA message.'));
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

export function probeWorker({ executable, device, arithmeticMode, spawnProcess, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let child, output = '', stderr = '', done = false, timer,killTimer;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        child?.kill();
        if(child?.exitCode===null){killTimer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1000);killTimer.unref?.();}
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(new BridgeError(499, 'CUDA device detection was stopped.'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try { child = spawnProcess(executable, ['--info', ...(device === null ? [] : ['--device', String(device)]),
      ...(arithmeticMode!=='float32-guarded-binary64'?['--arithmetic-mode',arithmeticMode]:[])],
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
      clearTimeout(killTimer);
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

