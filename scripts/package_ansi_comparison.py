"""Build a small offline quality viewer without modifying the prior video ZIP."""
from pathlib import Path
import base64,json,shutil,sys,zipfile,hashlib
source,out=map(Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=True)
settings=json.loads((source/'settings.json').read_text(encoding='utf-8'))
settings['variants']=[{k:v for k,v in item.items() if k in {'key','label','style','geometry','config','codes','palette','highAtlas','layout','preparation','displayRotationDegrees','comparisonGroup','sourceRotationDegrees','fontPolicy','kind','anchor','highAtlasSha256','lowAtlasSha256'}} for item in settings['variants']]
(out/'settings.json').write_text(json.dumps(settings,separators=(',',':'))+'\n',encoding='utf-8')
assets=Path('overlay/experiments/ansi-compare')
for name in ['index.html','parser.js','app.js','styles.css','README.md']:shutil.copy2(assets/name,out/name)
shutil.copy2(source/'report.json',out/'study-report.json')
bundle={'settings.json':base64.b64encode((out/'settings.json').read_bytes()).decode()}
for item in settings['variants']:
    key=item['key'];folder=out/key;shutil.copytree(source/key,folder,dirs_exist_ok=True)
    for f in folder.rglob('*'):
        if f.is_file() and (f.suffix=='.ans' or f.name=='report.json'):bundle[f.relative_to(out).as_posix()]=base64.b64encode(f.read_bytes()).decode()
(out/'demo.js').write_text('globalThis.ANSI_COMPARE_BUNDLE='+json.dumps(bundle,separators=(',',':'))+';\n',encoding='utf-8')
notes='''80x25 quality screen

Open index.html in Chrome/Edge. The study loads automatically; no server needed.
A/B/C use the same exact frame number. Keys 1/2/3 switch at a fixed image origin.
Arrow keys step the three available frames: 1, 360, 719. Select other variants
for sampling, resampling, candidate counts and image/NL controls. Use Layout to
select A/B side by side, A/B/C, instant switching or the draggable A/B wipe.
The wipe clips aligned whole images at the same pixel coordinate; it does not
scale each half separately. Industrial
presets use the original CPU industrial renderer with neutral image/NL settings;
they are a separate style, not a CUDA industrial implementation.

Use Open extracted export folder to add the earlier full-video ZIP's folder.
That supplies all719frames for its original4x8/8x16configurations. Sparse study
variants restrict shared navigation to1/360/719when selected alongside them.

The new photographic presets use the pinned original Canvas preprocessing.
Browser 'Lanczos' means high-quality smoothing; it is not an exact named kernel.
The two Original export presets retain their actual FFmpeg-Lanczos ANSI bytes.
Keep that preparation difference separate from changes within the new presets.

Raw .ans glyph bytes are CP437 with ASCII color escapes. The old video's ZIP
README mistakenly called them UTF-8; its actual bytes need no repair. This viewer
uses the original bitmap atlas and palette, avoiding terminal-font differences
and MP4 compression. Cell/pixel differences do not determine which looks better.
The previous ZIP remains unchanged.

When portrait variants are included: native grid25x80 and cell16x8 produce400x640
pixels; rotate-back270 degrees aligns them to640x400. Literal controls rotate
saved cell positions and glyph pixels exactly, without matching again. Rotated-
atlas refits rerun FP32 on permuted samples and may differ through accumulation
order. Upright refits use7px DejaVu in16x8cells, a changed font/shape policy.
Standard terminal CP437 does not itself express a custom rotated glyph atlas;
the saved atlas and this viewer define the exact rendering. Cell differences
across unlike native grids are disabled; displayed-pixel comparisons still apply.
'''
(out/'STUDY.txt').write_text(notes,encoding='utf-8')
archive=out.with_suffix('.zip')
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(out.rglob('*')):
        if f.is_file():z.write(f,f.relative_to(out).as_posix())
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
receipt={'zip':str(archive.resolve()),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'variants':len(settings['variants']),'frames':settings['selectedFrames'],'ansiFrames':len(list(out.rglob('*.ans'))),'crcVerified':True}
(out.parent/(out.name+'-delivery.json')).write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
