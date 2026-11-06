"""CPU-only exact native/aligned portraits and rotation-control comparisons."""
from pathlib import Path
import json,hashlib,sys
import numpy as np
from PIL import Image
from render_cuda_video import render_cells

root,seed=map(Path,sys.argv[1:]);load=lambda p:json.loads(p.read_text(encoding='utf-8'));s=load(root/'settings.json');r=load(root/'report.json');old=load(seed/'report.json')
assert r['completed'] and not r.get('error')
def raster(c,v):
    a=np.empty((2000,4),np.uint8);g=np.asarray(c['chosen'],np.uint16);a[:,0]=g&255;a[:,1]=g>>8;a[:,2]=c['fg'];a[:,3]=c['bg']
    return render_cells(a.tobytes(),v['highAtlas'],v['palette'],v['geometry']['columns'],v['geometry']['rows'])
result={'literalControlsExact':True,'comparisons':[]}
for c in r['cases']:
    v=next(v for v in s['variants'] if v['key']==c['key']);native=raster(c,v);rotation=v.get('displayRotationDegrees',0);aligned=np.rot90(native,k=1) if rotation==270 else native
    folder=root/c['key'];Image.fromarray(aligned).save(folder/f"preview-aligned_{c['number']:04d}.png")
    if rotation:Image.fromarray(native).save(folder/f"preview-native_{c['number']:04d}.png")
    if v['kind']!='normal':
        anchor=next(vv for vv in s['variants'] if vv['key']==v['anchor']);base=next(x for x in old['cases'] if x['key']==v['anchor'] and x['number']==c['number']);reference=raster(base,anchor)
        assert reference.shape==aligned.shape
        changed=int(np.count_nonzero(np.any(reference!=aligned,axis=2)))
        if v['kind']=='literal':assert changed==0,'Literal rotation failed exact inverse registration'
        result['comparisons'].append({'key':v['key'],'frame':c['number'],'kind':v['kind'],'changedDisplayedPixels':changed,'pixels':aligned.shape[0]*aligned.shape[1],
            'nativeWidth':native.shape[1],'nativeHeight':native.shape[0],'alignedWidth':aligned.shape[1],'alignedHeight':aligned.shape[0],
            'nativeRgbSha256':hashlib.sha256(native.tobytes()).hexdigest(),'alignedRgbSha256':hashlib.sha256(aligned.tobytes()).hexdigest()})
(root/'rotation-comparisons.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');print(json.dumps(result))
