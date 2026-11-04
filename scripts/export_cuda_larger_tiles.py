"""Verify larger-tile outputs against the preserved cropped baseline."""
from pathlib import Path
import json,hashlib
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'qualification/gtx1650super-motion-cropped'
RAW=ROOT/'build/qualification/parkour-larger-tiles'
sha=lambda b:hashlib.sha256(b).hexdigest()
base=json.loads((OUT/'summary.json').read_text());packed=(OUT/'outputs.bin').read_bytes()
assert sha(packed)==base['outputsSha256']
sweep=json.loads((RAW/'sweep.json').read_text());assert sweep['benchmarkCompleted']
sweep['preservedOutputs']='outputs.bin';sweep['offsetsReferTo']='cropped baseline archive'
assert len(sweep['sessions']) in (2,4)
for entry in sweep['sessions']:
    raw=Path(entry['output']).read_bytes();assert sha(raw)==entry['reportSha256']
    r=json.loads(raw);assert r['benchmarkCompleted'] and not r.get('error') and not r['cleanupErrors']
    assert r['batch']['atlas']['columns']==320 and r['batch']['atlas']['rows']==90 and len(r['frames'])==30
    b=Path(r['outputsPath']).read_bytes();assert sha(b)==r['outputsSha256']
    prior=next(p for p in base['sessions'] if p['key']==f'comparison-320-{r["mode"]}-32')
    for f,p in zip(r['frames'],prior['frames']):
        data=b[f['offset']:f['offset']+f['cells']*4]
        assert sha(data)==f['tupleSha256']==p['tupleSha256']
        assert data==packed[p['offset']:p['offset']+p['cells']*4]
        f['offset']=p['offset']
    r.pop('batch');r['batchWidth']=320;r['rawOutputsPath']=r.pop('outputsPath')
    entry['result']=r
(OUT/'tile-sweep.json').write_text(json.dumps(sweep,indent=2)+'\n',encoding='utf-8')
print(f'Exported {len(sweep["sessions"])} larger-tile sequences; every output matches the committed baseline')
