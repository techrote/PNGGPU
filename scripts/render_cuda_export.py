"""CPU-only rendering of verified CUDA tuples; preserves original video audio."""
from pathlib import Path
import base64, hashlib, json, subprocess, sys
import numpy as np
from PIL import Image
from render_cuda_video import render_cells

def digest(b): return hashlib.sha256(b).hexdigest()
def load(p): return json.loads(Path(p).read_text(encoding='utf-8'))

def lookup_table(atlas,palette):
    alpha=np.frombuffer(base64.b64decode(atlas['alpha']),np.uint8).reshape(-1,atlas['height'],atlas['width'])
    coverage=(alpha.astype(np.float64)/255).astype(np.float32).astype(np.float64)
    p=np.asarray(palette,dtype=np.float64)
    table=np.empty((len(alpha),16,16,atlas['height'],atlas['width'],3),np.uint8)
    for i,m in enumerate(coverage):
        fg=p[:,None,None,None,:];bg=p[None,:,None,None,:]
        table[i]=np.floor(bg+m[None,None,:,:,None]*(fg-bg)+.5).astype(np.uint8)
    return table

def render(data,table,columns,rows):
    c=np.frombuffer(data,np.uint8).reshape(-1,4)
    g=c[:,0].astype(np.uint16)+(c[:,1].astype(np.uint16)<<8)
    assert len(c)==columns*rows and np.max(g)<len(table) and np.max(c[:,2:])<16
    rgb=table[g,c[:,2],c[:,3]];h,w=table.shape[3:5]
    return rgb.reshape(rows,columns,h,w,3).transpose(0,2,1,3,4).reshape(rows*h,columns*w,3)

def main():
    plan_path,key,folder=sys.argv[1:];plan=load(plan_path);v=next(v for v in plan['variants'] if v['key']==key)
    out=Path(folder);r=load(out/'report.json');assert r['completed'] and not r.get('error') and not r['cleanupErrors']
    assert r['key']==key and r['geometry']==v['geometry'] and r['planSha256']==digest(Path(plan_path).read_bytes())
    raw=(out/'tuples.bin').read_bytes();assert digest(raw)==r['tuplesSha256'] and len(raw)==r['tuplesBytes']
    assert len(r['frames'])==plan['frameCount'];c,rows=v['geometry']['columns'],v['geometry']['rows'];frame_bytes=c*rows*4
    table=lookup_table(v['highAtlas'],v['palette']);width=c*v['highAtlas']['width'];height=rows*v['highAtlas']['height']
    first=render(raw[:frame_bytes],table,c,rows)
    assert np.array_equal(first,render_cells(raw[:frame_bytes],v['highAtlas'],v['palette'],c,rows))
    # Verify the renderer against a PNG produced by the original browser renderer.
    base=Path('qualification/GTX_PRECISION_BENCHMARK');historical=load(base/'summary.json');f=historical['cases'][0];s=historical['settings'][f['setting']];a=load(base/'atlas.json')
    with (base/'outputs.bin').open('rb') as inp: inp.seek(f['offset']);b=inp.read(f['cells']*4)
    assert np.array_equal(render(b,lookup_table(a,v['palette']),s['columns'],s['rows']),np.asarray(Image.open(base/f['preview']).convert('RGB')))
    target=out/(key+'.mp4')
    cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-threads','2','-f','rawvideo','-pix_fmt','rgb24','-s',f'{width}x{height}',
         '-framerate','30','-i','pipe:0','-i',plan['source'],'-map','0:v:0','-map','1:a:0?',
         '-c:v','libx264','-threads','4','-preset','fast','-crf','12','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',str(target)]
    log=(out/'encoder.txt').open('wb');p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=log)
    rendered=[]
    try:
        for index,f in enumerate(r['frames']):
            b=raw[index*frame_bytes:(index+1)*frame_bytes];assert digest(b)==f['tupleSha256']
            ansi=(out/'ansi'/f'frame_{index+1:04d}.ans').read_bytes();assert digest(ansi)==f['ansiSha256']
            rgb=render(b,table,c,rows)
            if index in {0,plan['frameCount']-1}:
                name=f'preview_{index+1:04d}.png';Image.fromarray(rgb).save(out/name);rendered.append({'file':name,'rgbSha256':digest(rgb.tobytes())})
            p.stdin.write(rgb.tobytes())
        p.stdin.close();assert p.wait(timeout=600)==0
    finally:
        if p.poll() is None:p.kill();p.wait()
        log.close()
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(target)],text=True))
    video=next(s for s in probe['streams'] if s['codec_type']=='video')
    assert int(video['nb_frames'])==plan['frameCount'] and video['avg_frame_rate']=='30/1'
    assert (video['width'],video['height'])==(width,height)
    assert abs(float(video['duration'])-plan['frameCount']/30)<1/30+.0001
    audio=[s for s in probe['streams'] if s['codec_type']=='audio'];assert bool(audio)==plan['hasAudio']
    if audio: assert abs(float(audio[0]['duration'])-plan['frameCount']/30)<.15
    result={'completed':True,'key':key,'frames':plan['frameCount'],'fps':30,'width':width,'height':height,
            'video':target.name,'videoBytes':target.stat().st_size,'videoSha256':digest(target.read_bytes()),'audio':any(s['codec_type']=='audio' for s in probe['streams']),
            'planSha256':r['planSha256'],'reportSha256':digest((out/'report.json').read_bytes()),'tuplesSha256':r['tuplesSha256'],
            'videoDuration':float(video['duration']),'audioDuration':float(audio[0]['duration']) if audio else None,
            'rendererMatchesOriginalPng':True,'rendererMatchesScalar':True,'previews':rendered}
    (out/'render.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');print(json.dumps(result),flush=True)

if __name__=='__main__': main()
