"""Verify and package the finite parkour measurements. No GPU operations."""
from pathlib import Path
import json, hashlib, statistics, csv, shutil, sys

ROOT=Path(__file__).resolve().parent.parent
RAW=ROOT/'build/qualification'
cropped=len(sys.argv)>1 and sys.argv[1]=='cropped'
if len(sys.argv)>1 and not cropped:raise SystemExit('Optional argument: cropped')
prefix='parkour-crop' if cropped else 'parkour'
OUT=ROOT/('qualification/gtx1650super-motion-cropped' if cropped else 'qualification/gtx1650super-motion')
OUT.mkdir(parents=True,exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
matrix=json.loads((RAW/(prefix+'-matrix')/'matrix.json').read_text())
assert matrix['benchmarkCompleted'] and len(matrix['sessions'])==8
assert matrix.get('layout','letterboxed')==('cropped' if cropped else 'letterboxed')
paths=[RAW/(prefix+'-initial.json'),RAW/(prefix+'-initial-fp64.json')]+[Path(e['report']) for e in matrix['sessions']]
summary={'schema':'pnggpu-cuda-motion-results-v1','qualificationAccepted':False,'cpuComparison':{'skipped':True},
         'batches':{},'sessions':[],'sourceVideo':json.loads((ROOT/'qualification/gtx1650super-warm-frames/motion-candidate.json').read_text())}
summary['sourceVideo']['usedInMotionMeasurements']=True
summary['sourceVideo'].pop('usedInWarmMeasurements',None)
summary['layout']='cropped' if cropped else 'letterboxed'
summary['sourceVideo']['nextScope']='First120framesperprecision; eight30-frame comparisons'
packed=bytearray();offsets={};all_rows=[];word_frames={}
for path in paths:
    raw=path.read_bytes();r=json.loads(raw)
    assert r['benchmarkCompleted'] and not r.get('error') and not r['cleanupErrors'] and not r['sourceStatus']
    b=Path(r['outputsPath']).read_bytes();assert sha(b)==r['outputsSha256']
    workers=[p for p in r['processes'] if '--stdio' in p['args']];assert len(workers)==1 and workers[0]['exited']
    a=r['batch']['atlas'];width=a['columns'];kind='characterization' if len(r['frames'])==120 else 'comparison'
    assert r['batch']['fitMode']==('crop-16:9' if cropped else 'contain-black')
    assert a['rows']==(width*9//32 if cropped else width//2)
    key=f'{kind}-{width}-{r["mode"]}-{r["tileMiB"]}';summary['batches'][str(width)]=r.pop('batch')
    r.update(key=key,batchWidth=width,rawReport=str(path),rawReportSha256=sha(raw),rawOutputsSha256=sha(b))
    del r['outputsPath']
    for f in r['frames']:
        data=b[f['offset']:f['offset']+f['cells']*4];assert sha(data)==f['tupleSha256']
        assert f['stats']['sessionReused']==(f['index']>0)
        if f['index']>0:assert f['stats']['timing']['nativeInitMs']==f['stats']['timing']['atlasUploadMs']==0
        identity=(width,len(data),sha(data))
        if identity not in offsets:offsets[identity]=len(packed);packed.extend(data)
        f['offset']=offsets[identity]
        word_frames[(kind,width,r['mode'],r['tileMiB'],f['index'])]=data
        t=f['stats']['timing'];all_rows.append([key,f['index'],f['fitMs'],t['gpuProjectionMs']+t['gpuSelectionMs'],f['preparedFrameToAnsiMs'],f['inputReadAndHashMs'],f['ansiMs'],t['tilePackMs'],t['bridgeRoundTripMs']])
    summary['sessions'].append(r)
assert len(all_rows)==480
summary['quality']=[]
for width,count in [(160,120),(320,30)]:
    kind='characterization' if width==160 else 'comparison'
    for i in range(count):
        a=word_frames[(kind,width,'float32-direct',32,i)];b=word_frames[(kind,width,'binary64-direct',32,i)]
        changed=sum(a[j:j+4]!=b[j:j+4] for j in range(0,len(a),4))
        summary['quality'].append({'columns':width,'frame':i,'changedTuples':changed,'cells':len(a)//4})
for width in [160,320]:
    for mode in ['float32-direct','binary64-direct']:
        for i in range(30):
            a=word_frames[('comparison',width,mode,16,i)];b=word_frames[('comparison',width,mode,32,i)];assert a==b
            if width==160:assert a==word_frames[('characterization',width,mode,32,i)]
summary.update(benchmarkCompleted=True,totalFrames=480,totalCells=sum(f['cells'] for r in summary['sessions'] for f in r['frames']),
               outputsSha256=sha(packed),uniqueOutputSpans=len(offsets),tileInvarianceExact=True,first30RepeatExact=True)
(OUT/'outputs.bin').write_bytes(packed)
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
with (OUT/'frames.csv').open('w',newline='',encoding='utf-8') as f:
    w=csv.writer(f,lineterminator='\n');w.writerow(['configuration','frame','fitMs','kernelMs','preparedFrameToAnsiMs','inputReadAndHashMs','ansiMs','packMs','bridgeMs']);w.writerows(all_rows)
for path in (RAW/(prefix+'-previews')).glob('*'):
    if path.is_file():shutil.copyfile(path,OUT/path.name)
print(json.dumps({'frames':480,'cells':summary['totalCells'],'packedBytes':len(packed),'tileInvarianceExact':True,
                  'qualityRanges':{str(width):[min(q['changedTuples'] for q in summary['quality'] if q['columns']==width),max(q['changedTuples'] for q in summary['quality'] if q['columns']==width)] for width in [160,320]}}))
