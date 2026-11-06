// Local workbench server. CUDA is opt-in; the default server needs no native build.
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { assertLocalRequest, createCudaBridge, sendJson } from './cuda_bridge.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ttf': 'font/ttf', '.ans': 'application/octet-stream' };

export function createWorkbenchServer({ appDirectory = '.', cudaExecutable = null, cudaDevice = null,
    cudaOptions = {} } = {}) {
  const app = resolve(appDirectory);
  const bridge = createCudaBridge({ ...cudaOptions, executable: cudaExecutable, device: cudaDevice });
  const server = createServer(async (req, res) => {
    try {
      const origin = assertLocalRequest(req, req.socket.localPort);
      if (!req.url?.startsWith('/')) { sendJson(res, 400, { error: 'Invalid request URL.' }); return; }
      if (await bridge.handle(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405); res.end('Method not allowed'); return;
      }
      const uri = new URL(req.url, origin);
      const pathname = decodeURIComponent(uri.pathname);
      const path = resolve(app, '.' + pathname);
      if (path !== app && !path.startsWith(app + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
      const info = await stat(path);
      const file = info.isDirectory() ? resolve(path, 'index.html') : path;
      // A symlink in the served tree must not expose files outside the application.
      const [actualRoot, actualFile] = await Promise.all([realpath(app), realpath(file)]);
      if (actualFile !== actualRoot && !actualFile.startsWith(actualRoot + sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const bytes = await readFile(actualFile);
      res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500);
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error.status ? error.message : status === 404 ? 'Not found' : status === 400 ? 'Invalid request URL' : 'Server error');
      }
    }
  });
  server.on('close', () => bridge.close());
  // Expose explicit native cleanup to callers stopping a server with in-flight requests.
  server.closeCuda = () => bridge.close();
  return server;
}

export function parseServerOptions(args) {
  const appDirectory = resolve(args[0] || '.');
  const port = Number(args[1] || '8000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('port must be between 1 and 65535.');
  let cudaExecutable = null, cudaDevice = null;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (flag === '--cuda' && cudaExecutable === null && value && !value.startsWith('--')) cudaExecutable = resolve(value);
    else if (flag === '--device' && cudaDevice === null && value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      cudaDevice = Number(value);
    } else throw new RangeError('Usage: node scripts/serve.mjs APP_DIRECTORY PORT [--cuda WORKER_PATH] [--device INDEX]');
  }
  if (cudaDevice !== null && !cudaExecutable) throw new RangeError('--device requires --cuda.');
  return { appDirectory, port, cudaExecutable, cudaDevice };
}

async function main() {
  const options = parseServerOptions(process.argv.slice(2));
  const server = createWorkbenchServer(options);
  server.on('error', error => { console.error(`ERROR: ${error.message}`); server.closeCuda(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.closeCuda(); server.closeAllConnections(); server.close();
  });
  server.listen(options.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${options.port}/experiments/webgpu/photographic.html${options.cudaExecutable ? '?backend=cuda' : ''}`;
    console.log(`PNGGPU workbench: ${url}\nCUDA bridge: ${options.cudaExecutable ? 'enabled (select CUDA in the workbench)' : 'disabled (WebGPU only)'}\nPress Ctrl+C to stop.`);
    // The URL only contains a validated numeric port and a fixed backend flag.
    if (process.platform === 'win32') {
      const timer = setTimeout(() => {
        const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => {}); child.unref();
      }, 800);
      timer.unref();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 2; });
}
