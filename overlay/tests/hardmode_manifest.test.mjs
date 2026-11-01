import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../fixtures/hardmode/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));

test('hardmode corpus contains all five original supplied benchmark images with verifiable hashes',async()=>{
  assert.equal(manifest.schema,'png2ansi-hardmode-v1');
  assert.equal(manifest.images.length,5);
  assert.deepEqual(manifest.images.map(e=>e.file).sort(),[
    'bland-blocks-2048.png','colour-blocks-2048.png','holo-boots-blocks-1024.png',
    'holo-stealth-cloak-1024.png','oversharpened-forestry-crt-2048.png'].sort());
  for (const item of manifest.images) {
    assert.match(item.file,/^[a-z0-9-]+\.png$/);
    const bytes=await readFile(new URL(item.file,root));
    assert.equal(bytes.length,item.size_bytes,item.file);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a',item.file);
    assert.equal(bytes.readUInt32BE(16),item.width,item.file);
    assert.equal(bytes.readUInt32BE(20),item.height,item.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.file);
    assert.ok(item.stress.length>=2);
  }
});

test('hardmode presets respect CPU reference or GPU-007 extended schema',()=>{
  assert.ok(manifest.suites.length>=8);
  const high=manifest.suites.filter(s=>s.id.startsWith('GPU-006 recommended'));
  assert.equal(high.length,6);
  assert.deepEqual(high.map(s=>s.tileCells),[8192,16384,32768,65536,131072,262144]);
  assert.ok(high.every(s=>s.gpuRepeats===5&&s.inFlightTiles===2));
  for (const s of manifest.suites) {
    assert.ok(s.columns<=1024&&s.rows<=1024&&s.sampleW<=32&&s.sampleH<=64);
    assert.ok(s.foreground<=12&&s.background<=8);
  }
});
