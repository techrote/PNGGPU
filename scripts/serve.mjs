// Node.js fallback if Python 3 is not installed. No external dependencies.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { spawn } from 'node:child_process';

const app = resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || '8000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('ERROR: port must be between 1 and 65535.'); process.exit(2);
}
const types = {'.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.wgsl':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.ttf':'font/ttf', '.ans':'application/octet-stream'};
const server = createServer(async (req,res)=>{
  try {
    if (req.method!=='GET' && req.method!=='HEAD') {
      res.writeHead(405); res.end('Method not allowed'); return;
    }
    const uri = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(uri.pathname);
    const path = resolve(app, '.'+pathname);
    if (path!==app && !path.startsWith(app+sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const info = await stat(path);
    const file = info.isDirectory()?resolve(path,'index.html'):path;
    const bytes = await readFile(file);
    res.writeHead(200, {'Content-Type':types[extname(file).toLowerCase()]||'application/octet-stream',
                        'Cache-Control':'no-store'});
    res.end(req.method==='HEAD'?undefined:bytes);
  } catch (err) {
    res.writeHead(err.code==='ENOENT'?404:500);
    res.end(err.code==='ENOENT'?'Not found':'Server error');
  }
});
server.on('error', err => { console.error(`ERROR: ${err.message}`); process.exitCode=1; });
server.listen(port,'127.0.0.1',()=>{
  const url = `http://127.0.0.1:${port}/experiments/webgpu/photographic.html`;
  console.log(`PNG2ANSI GPU-006: ${url}\nPress Ctrl+C to stop.`);
  // Launch system default browser only on Windows. Avoid running a shell with user input.
  if (process.platform==='win32') {
    setTimeout(()=>{
      const proc = spawn('cmd.exe',['/d','/s','/c',`start "" "${url}"`],{windowsHide:true,stdio:'ignore'});
      proc.on('error',()=>{}); proc.unref();
    }, 800);
  }
});
