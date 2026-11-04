"""Export verified finite warm-frame receipts; performs no device operations."""
from pathlib import Path
import csv
import hashlib
import json
import struct

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'build/qualification/warm-matrix'
OUT = ROOT / 'qualification/gtx1650super-warm-frames'
OUT.mkdir(parents=True, exist_ok=True)
sha = lambda b: hashlib.sha256(b).hexdigest()
matrix = json.loads((RAW / 'matrix.json').read_text())
assert matrix['benchmarkCompleted'] and len(matrix['sessions']) == 8
summary = {**matrix, 'sessions': [], 'outputs': 'outputs.bin', 'cpuComparison': {'skipped': True}}
packed = bytearray()
csv_rows = []
for entry in matrix['sessions']:
    raw = Path(entry['report']).read_bytes()
    assert sha(raw) == entry['reportSha256']
    r = json.loads(raw)
    assert r['benchmarkCompleted'] and not r.get('error') and not r['cleanupErrors']
    assert len(r['frames']) == 6
    workers = [p for p in r['processes'] if '--stdio' in p['args']]
    assert len(workers) == 1 and workers[0]['exited']
    r['rawReport'] = entry['report']
    r['rawReportSha256'] = sha(raw)
    for frame in r['frames']:
        b = b''.join(struct.pack('<HBB', *t) for t in frame.pop('actualTuples'))
        assert sha(b) == frame['tupleSha256'] == frame['coldTupleSha256']
        assert frame['equivalentToColdBaseline'] is True
        assert frame['stats']['sessionReused'] == (frame['index'] > 0)
        frame.update(offset=len(packed), cells=len(b)//4)
        packed.extend(b)
        t = frame['stats']['timing']
        csv_rows.append([entry['key'], frame['index'], frame['inputIndex'], frame['phase'], frame['wallMs'],
                         t['gpuProjectionMs']+t['gpuSelectionMs'], t['nativeInitMs'], t['tilePackMs'],
                         t['bridgeRoundTripMs'], t['uploadMs'], t['readbackMs'], t['decodeCellsMs'], frame['driverGuardMs']])
    summary['sessions'].append({'key': entry['key'], **r})
assert len(csv_rows) == 48 and len(packed) == 1536000*4
summary['outputsSha256'] = sha(packed)
(OUT/'outputs.bin').write_bytes(packed)
(OUT/'summary.json').write_text(json.dumps(summary, indent=2)+'\n', encoding='utf-8')
with (OUT/'frames.csv').open('w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f, lineterminator='\n')
    writer.writerow(['configuration','frame','image','phase','wallMs','kernelMs','nativeInitMs','tilePackMs',
                     'bridgeMs','uploadMs','readbackMs','decodeMs','driverGuardMs'])
    writer.writerows(csv_rows)
for size in ('one','small'):
    for mode in ('float32-direct','binary64-direct'):
        name=f'warm-{size}-{mode}.json'
        (OUT/name).write_bytes((ROOT/'build/qualification'/name).read_bytes())
    name=f'warm-{size}.input.json'
    (OUT/name).write_bytes((ROOT/'build/qualification'/name).read_bytes())
print(f'Exported {len(csv_rows)} frames / {len(packed)//4} cells with exact cold-baseline hashes')
