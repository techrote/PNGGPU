"""Render actual packed CUDA tuples with the measured original font atlas."""
from pathlib import Path
import json
import hashlib
import subprocess
import sys
import numpy as np
from PIL import Image

ROOT=Path.cwd()

def render_cells(data, atlas, palette, columns, rows):
    cells=np.frombuffer(data,dtype=np.uint8).reshape(-1,4)
    assert len(cells)==columns*rows
    glyph=cells[:,0].astype(np.uint16)+(cells[:,1].astype(np.uint16)<<8)
    import base64
    alpha=np.frombuffer(base64.b64decode(atlas['alpha']),dtype=np.uint8).reshape(-1,atlas['height'],atlas['width'])
    coverage=(alpha.astype(np.float64)/255).astype(np.float32).astype(np.float64)[glyph]
    palette=np.asarray(palette,dtype=np.float64)
    fg=palette[cells[:,2]][:,None,None,:];bg=palette[cells[:,3]][:,None,None,:]
    rgb=np.floor(bg+coverage[:,:,:,None]*(fg-bg)+0.5).astype(np.uint8)
    return rgb.reshape(rows,columns,atlas['height'],atlas['width'],3).transpose(0,2,1,3,4).reshape(rows*atlas['height'],columns*atlas['width'],3)

def verify_renderer(palette):
    base=ROOT/'qualification/GTX_PRECISION_BENCHMARK'
    s=json.loads((base/'summary.json').read_text());r=s['cases'][0];setting=s['settings'][r['setting']]
    atlas=json.loads((base/'atlas.json').read_text())
    with (base/'outputs.bin').open('rb') as f:
        f.seek(r['offset']);data=f.read(r['cells']*4)
    # The palette is fixed by the original artifact; read measured warm batch later.
    rgb=render_cells(data,atlas,palette,setting['columns'],setting['rows'])
    expected=np.asarray(Image.open(base/r['preview']).convert('RGB'))
    assert np.array_equal(rgb,expected),'Renderer differs from original workbench PNG'

def render_report(report_path,out_path,count=None):
    report=json.loads(Path(report_path).read_text());assert report['benchmarkCompleted'] and not report.get('error')
    raw=Path(report['outputsPath']).read_bytes();assert hashlib.sha256(raw).hexdigest()==report['outputsSha256']
    a=report['batch']['atlas'];high=report['batch']['highAtlas'];width=a['columns']*high['width'];height=a['rows']*high['height']
    out_path=Path(out_path);out_path.parent.mkdir(parents=True,exist_ok=True)
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{width}x{height}',
             '-r','30','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','12','-pix_fmt','yuv420p','-movflags','+faststart',str(out_path)]
    process=subprocess.Popen(command,stdin=subprocess.PIPE)
    frames=report['frames'][:count]
    try:
        for frame in frames:
            data=raw[frame['offset']:frame['offset']+frame['cells']*4]
            assert hashlib.sha256(data).hexdigest()==frame['tupleSha256']
            rgb=render_cells(data,high,a['palette'],a['columns'],a['rows'])
            if frame['index'] in {0,29,119}:Image.fromarray(rgb).save(out_path.with_name(out_path.stem+f'-frame{frame["index"]+1:04d}.png'))
            process.stdin.write(rgb.tobytes())
        process.stdin.close();assert process.wait()==0
    finally:
        if process.poll() is None:process.kill();process.wait()
    print(json.dumps({'video':str(out_path),'frames':len(frames),'width':width,'height':height,'playbackFps':30,'realtimeClaim':False}),flush=True)

if __name__=='__main__':
    verify_renderer(json.loads(Path(sys.argv[1]).read_text())['batch']['atlas']['palette'])
    render_report(sys.argv[1],sys.argv[2],int(sys.argv[3]) if len(sys.argv)>3 else None)
