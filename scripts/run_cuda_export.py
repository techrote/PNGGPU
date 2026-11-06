"""Sequential offline export and verified ZIP delivery. No stress/benchmark loop."""
from pathlib import Path
import hashlib,json,subprocess,sys,time,zipfile,os,signal

def load(p): return json.loads(Path(p).read_text(encoding='utf-8'))
def sha(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def run_child(command,log,timeout):
    p=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=os.name!='nt')
    try:
        code=p.wait(timeout=timeout)
        if code:raise subprocess.CalledProcessError(code,command)
    except BaseException:
        if p.poll() is None:
            if os.name=='nt':subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F'],stdout=log,stderr=subprocess.STDOUT,timeout=15,check=False)
            else:os.killpg(p.pid,signal.SIGKILL)
            p.wait(timeout=15)
        raise

def validate_render(rendered,r,plan,v,folder,plan_path):
    assert rendered['completed'] and rendered['key']==v['key']
    assert rendered['planSha256']==sha(plan_path) and rendered['reportSha256']==sha(folder/'report.json') and rendered['tuplesSha256']==r['tuplesSha256']
    assert rendered['frames']==plan['frameCount'] and rendered['fps']==30
    assert (rendered['width'],rendered['height'])==(v['geometry']['columns']*8,v['geometry']['rows']*16)
    assert rendered['audio']==plan['hasAudio'] and abs(rendered['videoDuration']-plan['frameCount']/30)<1/30+.0001
    assert sha(folder/rendered['video'])==rendered['videoSha256']

def main():
    worker,plan_path,output=sys.argv[1:];out=Path(output).resolve();out.mkdir(parents=True,exist_ok=True);plan=load(plan_path)
    assert plan['completed'] and plan['mode']=='float32-direct' and len(plan['variants'])==24 and plan['frameCount']<=720
    sizes={(8,4),(16,8),(32,16),(40,12),(80,24),(80,25),(80,40),(120,34),(160,45),(160,80),(320,90),(320,160)}
    expected={(c,r,w,h) for c,r in sizes for w,h in [(4,8),(8,16)]}
    actual={(v['geometry']['columns'],v['geometry']['rows'],v['geometry']['sampleWidth'],v['geometry']['sampleHeight']) for v in plan['variants']}
    assert actual==expected and len({v['key'] for v in plan['variants']})==24
    for v in plan['variants']:
        g=v['geometry'];assert v['key']==f"{g['columns']}x{g['rows']}-samples{g['sampleWidth']}x{g['sampleHeight']}-fp32"
    begun=time.monotonic();result={'schema':'pnggpu-finished-video-export-v1','sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
        'planSha256':sha(plan_path),'frameCount':plan['frameCount'],'fps':30,'arithmetic':'float32-direct','completed':False,'variants':[]}
    try:
        for v in plan['variants']:
            assert time.monotonic()-begun<3600,'Offline batch exceeded one-hour cap'
            key=v['key'];folder=out/key;folder.mkdir(exist_ok=True);receipt=folder/'report.json'
            if receipt.exists():
                old=load(receipt);assert old['completed'] and not old.get('error') and old['planSha256']==sha(plan_path),'Incomplete/changed prior export; stop for inspection'
                assert sha(folder/'tuples.bin')==old['tuplesSha256']
            else:
                with (folder/'conversion.txt').open('wb') as log:
                    run_child(['node','scripts/export_cuda_sequence.mjs',worker,plan_path,key,str(folder)],log,900)
            rendered=folder/'render.json'
            if rendered.exists():
                validate_render(load(rendered),load(receipt),plan,v,folder,plan_path)
            else:
                with (folder/'render-console.txt').open('wb') as log:
                    run_child([sys.executable,'scripts/render_cuda_export.py',plan_path,key,str(folder)],log,900)
            r=load(receipt);video=load(rendered);assert len(r['frames'])==plan['frameCount']
            assert r['key']==key and r['geometry']==v['geometry'];validate_render(video,r,plan,v,folder,plan_path)
            result['variants'].append({'key':key,'geometry':v['geometry'],'layout':v['layout'],'render':video,
                'reportSha256':sha(receipt),'ansiFrames':len(r['frames']),'maxDeclaredGpuBytes':max(f['allocatedBytes'] for f in r['frames'])})
            (out/'manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
            print(json.dumps({'finishedVariants':len(result['variants']),'totalVariants':24,'key':key,'elapsedSeconds':round(time.monotonic()-begun,1)}),flush=True)
        result.update(completed=True,totalAnsiFrames=plan['frameCount']*24)
        (out/'manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        (out/'settings.json').write_text(json.dumps(plan,indent=2)+'\n',encoding='utf-8')
        lines=['Agentic parkour — complete FP32 ANSI/video export','',f"{plan['frameCount']} frames per clip at 30 FPS; {plan['frameCount']/30:.3f} seconds. Original audio retained: {plan['hasAudio']}.",
            '24 configurations: 12 character grids, each at 4x8 and 8x16 samples per cell.',
            'Videos use the original DejaVu Sans Mono glyph atlas, 8x16 rendered pixels per character.',
            'Doubling sample parameters changes matching detail; it does not double output dimensions.',
            'ANSI frames contain raw CP437 glyph bytes and ASCII SGR color escapes, not UTF-8. Use a CP437-aware ANSI viewer.',
            'PNG input is resampled by FFmpeg Lanczos for this export; earlier browser-prepared benchmarks are separate.',
            'Square legacy canvases retain letterboxing. Other grids use centered integral aspect crops listed below.',
            'Offline rendering speed is not a realtime pipeline or stability qualification. WebGPU remains application default.',
            'The CUDA 2 GiB reserve, depth one and bounded launches were preserved. Chunks contain at most 30 frames.',
            '', 'Character grid / samples / source crop / video pixels:']
        for v in plan['variants']:
            g=v['geometry'];lines.append(f"{v['key']}: {v['layout']}; {g['columns']*8}x{g['rows']*16} pixels")
        (out/'README.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')
        html=['<!doctype html><meta charset="utf-8"><title>Agentic parkour — FP32 comparisons</title>',
            '<style>body{font:16px system-ui;background:#10151c;color:#e7edf5;max-width:1500px;margin:30px auto;padding:0 20px}section{margin:36px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}video{width:100%;max-height:65vh;background:#000;image-rendering:pixelated}a{color:#9fcfff}small{color:#acb9ca}@media(max-width:750px){.pair{grid-template-columns:1fr}}</style>',
            f"<h1>Agentic parkour — FP32</h1><p>Complete {plan['frameCount']}-frame clips at 30 FPS. Compare 4×8 and 8×16 samples per character. Original audio retained: {plan['hasAudio']}.</p><p>Character grids and rendered dimensions stay the same when samples double. Use the playback controls; these are offline exports.</p>"]
        for c,r in sorted(sizes,key=lambda s:s[0]*s[1]):
            html.append(f'<section><h2>{c}×{r} characters · {c*8}×{r*16} pixels</h2><div class="pair">')
            for w,h in [(4,8),(8,16)]:
                key=f'{c}x{r}-samples{w}x{h}-fp32';html.append(f'<div><h3>{w}×{h} samples</h3><video controls preload="none" poster="{key}/preview_0001.png" src="{key}/{key}.mp4"></video><p><a href="{key}/{key}.mp4">Video</a> · <a href="{key}/ansi/">ANSI frames</a></p></div>')
            html.append('</div></section>')
        (out/'index.html').write_text('\n'.join(html)+'\n',encoding='utf-8')
        files=[]
        for name in ['README.txt','index.html','manifest.json','settings.json']: files.append((out/name,name))
        for v in plan['variants']:
            folder=out/v['key'];r=load(folder/'report.json');ren=load(folder/'render.json')
            for f in r['frames']:
                p=folder/'ansi'/f"frame_{f['index']+1:04d}.ans";assert sha(p)==f['ansiSha256'];files.append((p,f"{v['key']}/ansi/{p.name}"))
            for name in [ren['video'],'report.json','render.json','preview_0001.png',f"preview_{plan['frameCount']:04d}.png"]:files.append((folder/name,f"{v['key']}/{name}"))
        archive=out.with_suffix('.zip');assert not archive.exists(),'Refusing to overwrite delivery ZIP'
        with zipfile.ZipFile(archive,'w',allowZip64=True) as z:
            for p,name in files:z.write(p,name,compress_type=zipfile.ZIP_STORED if p.suffix=='.mp4' else zipfile.ZIP_DEFLATED,compresslevel=6)
        with zipfile.ZipFile(archive) as z:
            assert len(z.namelist())==len(files) and z.testzip() is None
            assert sum(n.endswith('.mp4') for n in z.namelist())==24
            assert sum(n.endswith('.ans') for n in z.namelist())==plan['frameCount']*24
        delivery={'zip':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'videos':24,'ansiFrames':plan['frameCount']*24,'entries':len(files),'crcVerified':True}
        (out.parent/(out.name+'-delivery.json')).write_text(json.dumps(delivery,indent=2)+'\n',encoding='utf-8');print(json.dumps(delivery),flush=True)
    except Exception as e:
        result['error']=repr(e);result['completed']=False;(out/'manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');raise

if __name__=='__main__':main()
