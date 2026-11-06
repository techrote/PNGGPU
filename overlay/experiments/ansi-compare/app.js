(function(){
  'use strict';
  const api=globalThis.AnsiCompare,$=id=>document.getElementById(id),letters=['A','B','C'];
  const state={variants:[],datasets:new Set(),panes:[],available:[],frame:1,active:0,generation:0,cache:new Map(),scrolling:false,wipePercent:50,wipeSwapped:false,wipePointer:null};
  const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
  const option=(value,label)=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;};
  const safeText=async(file,max)=>{if(file.size>max)throw Error(`${file.name} exceeds its file-size limit.`);return file.text();};
  const digest=async bytes=>{if(!globalThis.crypto?.subtle)return null;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');};
  function selected(){return state.panes.map(p=>state.variants.find(v=>v.id===p.select.value));}
  const group=v=>v.comparisonGroup??`${v.geometry.columns}x${v.geometry.rows}`;
  const pairLayout=()=>['ab','wipe'].includes($('layout').value);
  const comparisonSelections=()=>selected().slice(0,pairLayout()?2:3);
  function buildPanes(){
    for(let i=0;i<3;i++){
      const root=document.createElement('section');root.className='pane';root.setAttribute('aria-label',`Frame ${letters[i]}`);
      const head=document.createElement('div');head.className='pane-head';const title=document.createElement('h2');title.textContent=letters[i];const select=document.createElement('select');select.setAttribute('aria-label',`Variant ${letters[i]}`);head.append(title,select);
      const meta=document.createElement('p');meta.className='pane-meta';
      const viewport=document.createElement('div');viewport.className='viewport';viewport.tabIndex=0;viewport.setAttribute('aria-label',`${letters[i]} image; scroll or move over cells`);
      const stack=document.createElement('div');stack.className='canvas-stack';const canvas=document.createElement('canvas'),overlay=document.createElement('canvas');overlay.className='overlay';canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`Exact ANSI frame ${letters[i]}`);stack.append(canvas,overlay);viewport.append(stack);
      const actions=document.createElement('div');actions.className='pane-actions';const png=document.createElement('button'),ansi=document.createElement('button');png.type=ansi.type='button';png.textContent='Save exact PNG';ansi.textContent='Save original ANSI';actions.append(png,ansi);root.append(head,meta,viewport,actions);$('panes').append(root);
      const pane={root,select,meta,viewport,canvas,overlay,png,ansi,state:null};state.panes.push(pane);
      select.addEventListener('change',()=>{updateAvailable();render();});
      viewport.addEventListener('scroll',()=>{if(!$('linked').checked||state.scrolling)return;state.scrolling=true;for(const other of state.panes)if(other!==pane){other.viewport.scrollLeft=viewport.scrollLeft;other.viewport.scrollTop=viewport.scrollTop;}requestAnimationFrame(()=>state.scrolling=false);});
      canvas.addEventListener('pointermove',e=>inspect(pane,e));
      png.addEventListener('click',()=>{if(pane.state){const name=`${pane.state.variant.key}-frame_${String(state.frame).padStart(4,'0')}.png`;canvas.toBlob(b=>download(b,name),'image/png');}});
      ansi.addEventListener('click',()=>{if(pane.state)download(new Blob([pane.state.bytes],{type:'application/octet-stream'}),`${pane.state.variant.key}-frame_${String(state.frame).padStart(4,'0')}.ans`);});
    }
  }
  function download(blob,name){if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function importFiles(items){
    try{
      if(items.length>api.LIMITS.maxFiles)throw Error('Folder has too many files. Choose the extracted export root.');
      const files=new Map();for(const item of items){const path=(item.path??item.file.webkitRelativePath??item.file.name).replaceAll('\\','/').replace(/^\//,'');if(files.has(path))throw Error(`Ambiguous duplicate path: ${path}`);files.set(path,item.file);}
      const settings=[...files].filter(([p])=>p==='settings.json'||p.endsWith('/settings.json'));if(!settings.length)throw Error('No settings.json found. Choose the extracted ZIP root, not an ANSI subfolder.');
      let added=0;
      for(const [path,file] of settings){
        const text=await safeText(file,api.LIMITS.maxSettingsBytes),hash=await digest(new TextEncoder().encode(text));if(hash&&state.datasets.has(hash))continue;
        const plan=JSON.parse(text);if(!Array.isArray(plan.variants)||!plan.variants.length||plan.variants.length>api.LIMITS.maxVariants||!Number.isInteger(plan.frameCount)||plan.frameCount<1||plan.frameCount>10000)throw Error('Invalid export settings/variant count.');
        const prefix=path.slice(0,-'settings.json'.length),dataset=prefix.split('/').filter(Boolean).at(-1)||'export',newVariants=[],keys=new Set();
        if(state.variants.length+plan.variants.length>api.LIMITS.maxVariants)throw Error(`Load at most ${api.LIMITS.maxVariants} variants per session. Reload to clear folders.`);
        for(const v of plan.variants){
          if(typeof v.key!=='string'||!/^[-A-Za-z0-9_.]{1,160}$/.test(v.key)||v.key==='.'||v.key==='..'||keys.has(v.key))throw Error('Invalid or duplicate variant key.');keys.add(v.key);
          api.geometry(v.geometry?.columns,v.geometry?.rows);
          api.rotation(v.displayRotationDegrees??0);if(v.comparisonGroup!==undefined&&(typeof v.comparisonGroup!=='string'||!/^[-A-Za-z0-9_.]{1,80}$/.test(v.comparisonGroup)))throw Error('Invalid comparison group.');
          const frameFiles=new Map(),start=`${prefix}${v.key}/ansi/`;
          for(const [p,f] of files)if(p.startsWith(start)){const match=/^frame_(\d{4})\.ans$/.exec(p.slice(start.length));if(match){const n=Number(match[1]);if(n>=1&&n<=plan.frameCount){if(f.size>api.LIMITS.maxFrameBytes)throw Error('An ANSI frame exceeds 2 MiB.');frameFiles.set(n,f);}}}
          if(!frameFiles.size)continue;
          newVariants.push({...v,id:`${state.variants.length+newVariants.length}:${v.key}`,dataset,frameCount:plan.frameCount,fps:Number.isFinite(plan.fps)&&plan.fps>0?plan.fps:30,frameFiles,reportFile:files.get(`${prefix}${v.key}/report.json`),atlas:null,receipt:null});
        }
        if(hash)state.datasets.add(hash);state.variants.push(...newVariants);added+=newVariants.length;
      }
      if(!state.variants.length)throw Error('No ANSI frames match settings.json. Keep the extracted folder structure intact.');
      refreshSelectors();$('workspace').hidden=false;status(`${added} variants added · ${state.variants.length} available · Raw CP437 bytes, original bitmap font. Select A/B/C independently.`);await render();
    }catch(error){status(error.message,true);}
  }
  function refreshSelectors(){
    const old=$('grid').value,grids=[...new Set(state.variants.map(group))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));$('grid').replaceChildren(...grids.map(g=>option(g,g.replace('x','×'))));$('grid').value=grids.includes(old)?old:grids.includes('80x25')?'80x25':grids[0];refreshVariants();
  }
  function refreshVariants(){
    const list=state.variants.filter(v=>group(v)===$('grid').value),preferred=[list.find(v=>v.geometry.sampleWidth===4&&v.geometry.sampleHeight===8),list.find(v=>v.geometry.sampleWidth===8&&v.geometry.sampleHeight===16),list[2]??list[0]];
    state.panes.forEach((p,i)=>{const old=p.select.value;p.select.replaceChildren(...list.map(v=>option(v.id,`${v.label??v.key} · ${v.dataset}`)));p.select.value=list.some(v=>v.id===old)?old:(preferred[i]??list[Math.min(i,list.length-1)]).id;});updateAvailable();
  }
  function updateAvailable(){
    const variants=comparisonSelections();state.available=variants.every(Boolean)?[...variants[0].frameFiles.keys()].filter(n=>variants.every(v=>v.frameFiles.has(n))).sort((a,b)=>a-b):[];
    if(state.available.length&&!state.available.includes(state.frame)){const previous=state.frame;state.frame=state.available[0];status(`Frame ${previous} is not shared by the active comparison. Selected the first shared frame: ${state.frame}.`);}
    $('availableFrames').replaceChildren(...state.available.map(n=>option(String(n),String(n))));$('scrub').max=Math.max(0,state.available.length-1);$('frame').max=Math.max(1,...state.available);updateFrameControls();
  }
  function updateFrameControls(){const at=state.available.indexOf(state.frame);$('frame').value=state.frame;$('scrub').value=Math.max(0,at);$('previous').disabled=at<=0;$('next').disabled=at<0||at===state.available.length-1;const fps=selected()[0]?.fps??30;$('time').textContent=`Frame ${state.frame} · ${((state.frame-1)/fps).toFixed(3)} s · ${state.available.length} shared frames`;$('scrub').disabled=!state.available.length;}
  async function frameData(variant,n){
    const key=`${variant.id}:${n}`;if(state.cache.has(key))return state.cache.get(key);
    const pending=(async()=>{
      const file=variant.frameFiles.get(n);if(!file)throw Error(`Frame ${n} unavailable in ${variant.key}.`);
      const bytes=new Uint8Array(await file.arrayBuffer()),frame=api.decodeAnsi(bytes,{...variant.geometry,codes:variant.codes});
      variant.atlas??=api.decodeAtlas(variant);const nativeRgba=api.renderRgba(frame,variant.atlas),rgba=api.rotateRgba(nativeRgba,variant.displayRotationDegrees??0),actualHash=await digest(bytes);let integrity='No receipt checksum';
      if(variant.reportFile){
        if(!variant.receipt){const r=JSON.parse(await safeText(variant.reportFile,8*1024*1024));if(r.key!==variant.key||!Array.isArray(r.frames)||r.frames.length>10000)throw Error(`Receipt does not match ${variant.key}.`);variant.receipt=new Map(r.frames.map(f=>[f.index+1,f.ansiSha256]));}
        const expected=variant.receipt.get(n);if(expected){if(!/^[a-f0-9]{64}$/.test(expected))throw Error('Malformed receipt checksum.');if(actualHash&&actualHash!==expected)throw Error(`ANSI checksum mismatch: ${variant.key}, frame ${n}.`);integrity=actualHash?'SHA-256 verified':'Checksum unavailable in this browser';}
      }
      return {variant,bytes,frame,nativeRgba,rgba,actualHash,integrity};
    })();state.cache.set(key,pending);if(state.cache.size>3)state.cache.delete(state.cache.keys().next().value);pending.catch(()=>state.cache.delete(key));return pending;
  }
  async function render(){
    const generation=++state.generation;
    for(const p of state.panes){p.state=null;p.png.disabled=p.ansi.disabled=true;p.canvas.getContext('2d').clearRect(0,0,p.canvas.width,p.canvas.height);p.overlay.getContext('2d').clearRect(0,0,p.overlay.width,p.overlay.height);p.meta.textContent='Loading exact frame…';}clearWipe();
    $('comparison').textContent='Loading exact frame…';updateFrameControls();
    try{
      if(!state.available.length)throw Error('The selected variants have no shared frame numbers.');
      const results=await Promise.all(comparisonSelections().map(v=>frameData(v,state.frame)));if(generation!==state.generation)return;
      results.forEach((r,i)=>{const p=state.panes[i];p.state=r;p.canvas.width=p.overlay.width=r.rgba.width;p.canvas.height=p.overlay.height=r.rgba.height;p.canvas.getContext('2d').putImageData(new ImageData(r.rgba.pixels,r.rgba.width,r.rgba.height),0,0);p.meta.textContent=`${r.frame.columns}×${r.frame.rows} cells · ${r.variant.geometry.sampleWidth}×${r.variant.geometry.sampleHeight} samples · ${r.rgba.width}×${r.rgba.height} display pixels${r.variant.displayRotationDegrees?` · ${r.variant.displayRotationDegrees}° clockwise alignment`:''} · Frame ${state.frame} · ${r.integrity}`;p.png.disabled=p.ansi.disabled=false;});
      updateDifferences();updateZoom();updateLayout();if($('status').classList.contains('error'))status(`Frame ${state.frame} loaded successfully. ${state.variants.length} variants available.`);
    }catch(error){if(generation!==state.generation)return;for(const p of state.panes)p.meta.textContent='Frame unavailable — nothing rendered.';$('comparison').textContent='Comparison unavailable.';status(error.message,true);}
  }
  function updateDifferences(){
    if(!state.panes[0].state)return;const base=state.panes[0].state,lines=[];
    state.panes.forEach((p,i)=>{
      const ctx=p.overlay.getContext('2d');ctx.clearRect(0,0,p.overlay.width,p.overlay.height);if(!i||!p.state)return;
      const d=api.cellsComparable(base,p.state)?api.compare(base.frame,p.state.frame):null;let pixels=0;
      if(base.rgba.width===p.state.rgba.width&&base.rgba.height===p.state.rgba.height){const a=base.rgba.pixels,b=p.state.rgba.pixels;for(let at=0;at<a.length;at+=4)if(a[at]!==b[at]||a[at+1]!==b[at+1]||a[at+2]!==b[at+2])++pixels;}
      lines.push(`A/${letters[i]}: ${d?`${d.changed.toLocaleString()}/${d.cells.toLocaleString()} cells changed`:'different native layouts; cell counts/overlay unavailable'}${base.rgba.width===p.state.rgba.width&&base.rgba.height===p.state.rgba.height?` · ${pixels.toLocaleString()} aligned pixels changed`:' · display sizes differ'}`);
      if(d&&$('differences').checked){ctx.save();const rot=p.state.variant.displayRotationDegrees??0,n=p.state.nativeRgba;if(rot===90){ctx.translate(n.height,0);ctx.rotate(Math.PI/2);}if(rot===180){ctx.translate(n.width,n.height);ctx.rotate(Math.PI);}if(rot===270){ctx.translate(0,n.width);ctx.rotate(-Math.PI/2);}ctx.fillStyle='rgba(255,70,180,.32)';const a=p.state.variant.atlas;for(let cell=0;cell<d.mask.length;cell++)if(d.mask[cell])ctx.fillRect(cell%p.state.frame.columns*a.width,Math.floor(cell/p.state.frame.columns)*a.height,a.width,a.height);ctx.restore();}
    });$('comparison').textContent=lines.join('   |   ');
  }
  function updateZoom(){const visible=state.panes.filter(p=>!p.root.hidden&&p.state),fit=$('zoom').value==='fit';if(visible.length){const width=Math.max(1,Math.min(...visible.map(p=>p.viewport.clientWidth||$('wipeViewport').clientWidth||1))),z=fit?api.fitScale(visible.map(p=>p.state.rgba),width,Math.min(innerHeight*.66,700)):Number($('zoom').value);for(const p of visible){p.scale=z;for(const c of [p.canvas,p.overlay]){c.style.width=`${c.width*z}px`;c.style.height=`${c.height*z}px`;}}$('scaleNotice').textContent=fit?`Fit display: ${(z*100).toFixed(1)}% at a common scale. Full-resolution pixels and downloads are unchanged; choose 1× to inspect exact CSS pixels.`:`${z}× integer pixel zoom. Larger frames may scroll; paired scrolling can be linked.`;}updateWipe();}
  function updateLayout(){const mode=$('layout').value,single=mode==='single';$('panes').classList.toggle('single',single);$('panes').classList.toggle('pair',mode==='ab'||mode==='wipe');$('panes').classList.toggle('wipe-mode',mode==='wipe');$('wipe').hidden=mode!=='wipe';state.panes.forEach((p,i)=>p.root.hidden=single?i!==state.active:(mode==='ab'||mode==='wipe')&&i===2);document.querySelectorAll('[data-pane]').forEach(b=>{const active=Number(b.dataset.pane)===state.active;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});requestAnimationFrame(updateZoom);}
  function inspectDisplay(x,y){const values=state.panes.map((p,i)=>{if(!p.state)return `${letters[i]} unavailable`;const n=p.state.nativeRgba,q=api.displayToNative(x,y,n.width,n.height,p.state.variant.displayRotationDegrees??0);if(!q)return`${letters[i]} outside frame`;const a=p.state.variant.atlas,col=Math.floor(q.x/a.width),row=Math.floor(q.y/a.height),cell=row*p.state.frame.columns+col,f=p.state.frame,c=f.glyph[cell];return`${letters[i]} col ${col+1}, row ${row+1}: ${JSON.stringify(api.CP437[c])} / CP437 ${c} / fg ${f.fg[cell]} / bg ${f.bg[cell]}`;});$('inspection').textContent=`Aligned display pixel ${x+1}, ${y+1} · ${values.join('   |   ')}`;}
  function inspect(pane,event){if(!pane.state)return;const rect=pane.canvas.getBoundingClientRect();inspectDisplay(Math.floor((event.clientX-rect.left)*pane.canvas.width/rect.width),Math.floor((event.clientY-rect.top)*pane.canvas.height/rect.height));}
  function clearWipe(){const c=$('wipeCanvas');c.getContext('2d').clearRect(0,0,c.width,c.height);$('wipeSave').disabled=true;}
  function updateWipe(){if($('layout').value!=='wipe')return;const a=state.panes[0],b=state.panes[1],ready=a.state&&b.state,matching=ready&&a.canvas.width===b.canvas.width&&a.canvas.height===b.canvas.height;for(const el of [$('wipePosition'),$('wipeDivider'),$('wipeSwap'),$('wipeSave')])el.disabled=!matching;$('wipeStage').hidden=!matching;
    if(!matching){clearWipe();$('wipeNotice').textContent=ready?'Wipe unavailable: aligned display dimensions differ. Use side-by-side; images are never stretched to fake registration.':'Loading A/B…';return;}
    $('wipeNotice').textContent='Same source pixel coordinates on both sides. Drag the divider, or use its keyboard arrows / Home / End.';const left=state.wipeSwapped?b:a,right=state.wipeSwapped?a:b,c=$('wipeCanvas');if(c.width!==a.canvas.width||c.height!==a.canvas.height){c.width=a.canvas.width;c.height=a.canvas.height;}const ctx=c.getContext('2d'),x=api.wipeBoundary(c.width,state.wipePercent);ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(left.canvas,0,0);ctx.save();ctx.beginPath();ctx.rect(x,0,c.width-x,c.height);ctx.clip();ctx.drawImage(right.canvas,0,0);ctx.restore();
    const z=$('zoom').value==='fit'?api.fitScale([a.state.rgba],Math.max(1,$('wipeViewport').clientWidth),Math.min(innerHeight*.66,700)):Number($('zoom').value);c.style.width=`${c.width*z}px`;c.style.height=`${c.height*z}px`;$('wipeStage').style.width=`${c.width*z}px`;$('wipeDivider').style.left=`${100*x/c.width}%`;$('wipeDivider').setAttribute('aria-valuenow',String(state.wipePercent));$('wipeDivider').setAttribute('aria-valuetext',`${state.wipePercent}% ${state.wipeSwapped?'B':'A'} on the left`);$('wipePosition').value=state.wipePercent;$('wipePercent').textContent=`${state.wipePercent}% ${state.wipeSwapped?'B':'A'} / ${100-state.wipePercent}% ${state.wipeSwapped?'A':'B'}`;$('wipeLabels').textContent=`Left: ${state.wipeSwapped?'B':'A'} — ${left.state.variant.label??left.state.variant.key} · Right: ${state.wipeSwapped?'A':'B'} — ${right.state.variant.label??right.state.variant.key}`;
  }
  function goFrame(n){if(!state.available.includes(n)){status(`Frame ${n} is not shared by the active comparison. Use Previous/Next or the frame slider.`,true);updateFrameControls();return;}state.frame=n;render();}
  function step(delta){if(!state.available.length)return;const at=state.available.indexOf(state.frame);goFrame(state.available[Math.max(0,Math.min(state.available.length-1,at+delta))]);}
  async function droppedFiles(data){const files=[];async function walk(entry){if(files.length>api.LIMITS.maxFiles)throw Error('Too many files in this folder.');if(entry.isFile){const file=await new Promise((r,j)=>entry.file(r,j));files.push({file,path:entry.fullPath.replace(/^\//,'')});}else if(entry.isDirectory){const reader=entry.createReader();for(;;){const entries=await new Promise((r,j)=>reader.readEntries(r,j));if(!entries.length)break;for(const child of entries)await walk(child);}}}const entries=[...data.items].map(item=>item.webkitGetAsEntry?.()).filter(Boolean);if(entries.length)for(const entry of entries)await walk(entry);else for(const file of data.files)files.push({file,path:file.name});return files;}
  buildPanes();globalThis.ansiCompareLoadFiles=importFiles;
  if(globalThis.ANSI_COMPARE_BUNDLE){const items=Object.entries(globalThis.ANSI_COMPARE_BUNDLE).map(([path,b64])=>({path,file:new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],path.split('/').at(-1))}));importFiles(items);}
  $('folder').addEventListener('change',event=>{importFiles([...event.target.files].map(file=>({file,path:file.webkitRelativePath||file.name})));event.target.value='';});document.querySelector('label[for=folder]').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('folder').click();}});
  const drop=$('drop');for(const type of ['dragenter','dragover'])drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add('dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));drop.addEventListener('drop',async e=>{e.preventDefault();drop.classList.remove('dragging');try{status('Indexing local folder…');await importFiles(await droppedFiles(e.dataTransfer));}catch(error){status(error.message,true);}});
  const switchPane=i=>{state.active=i;$('layout').value='single';updateAvailable();updateLayout();render();};
  $('grid').addEventListener('change',()=>{refreshVariants();render();});$('frame').addEventListener('change',()=>goFrame(Number($('frame').value)));$('scrub').addEventListener('input',()=>goFrame(state.available[Number($('scrub').value)]));$('previous').addEventListener('click',()=>step(-1));$('next').addEventListener('click',()=>step(1));$('zoom').addEventListener('change',updateZoom);$('layout').addEventListener('change',()=>{updateAvailable();updateLayout();render();});$('differences').addEventListener('change',updateDifferences);document.querySelectorAll('[data-pane]').forEach(b=>b.addEventListener('click',()=>switchPane(Number(b.dataset.pane))));
  let wipeQueued=false;const setWipe=value=>{state.wipePercent=Math.round(Math.max(0,Math.min(100,value)));if(!wipeQueued){wipeQueued=true;requestAnimationFrame(()=>{wipeQueued=false;updateWipe();});}};
  $('wipePosition').addEventListener('input',()=>setWipe(Number($('wipePosition').value)));$('wipeSwap').addEventListener('click',()=>{state.wipeSwapped=!state.wipeSwapped;updateWipe();});$('wipeSave').addEventListener('click',()=>{if(!$('wipeSave').disabled)$('wipeCanvas').toBlob(b=>download(b,`ab-comparison-frame_${String(state.frame).padStart(4,'0')}.png`),'image/png');});
  const pointerPosition=e=>{const r=$('wipeCanvas').getBoundingClientRect();if(r.width>0)setWipe((e.clientX-r.left)*100/r.width);};
  $('wipeStage').addEventListener('pointerdown',e=>{if($('wipeDivider').disabled||e.button!==0)return;e.preventDefault();state.wipePointer=e.pointerId;$('wipeStage').setPointerCapture(e.pointerId);$('wipeDivider').focus();pointerPosition(e);});
  $('wipeStage').addEventListener('pointermove',e=>{if(state.wipePointer===e.pointerId)pointerPosition(e);else{const r=$('wipeCanvas').getBoundingClientRect();if(r.width&&r.height)inspectDisplay(Math.floor((e.clientX-r.left)*$('wipeCanvas').width/r.width),Math.floor((e.clientY-r.top)*$('wipeCanvas').height/r.height));}});
  for(const type of ['pointerup','pointercancel'])$('wipeStage').addEventListener(type,e=>{if(state.wipePointer===e.pointerId){state.wipePointer=null;if($('wipeStage').hasPointerCapture(e.pointerId))$('wipeStage').releasePointerCapture(e.pointerId);}});
  $('wipeDivider').addEventListener('keydown',e=>{const delta=e.shiftKey?10:1;if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();setWipe(e.key==='Home'?0:e.key==='End'?100:state.wipePercent+(e.key==='ArrowLeft'?-delta:delta));}});
  window.addEventListener('resize',()=>requestAnimationFrame(updateZoom));
  document.addEventListener('keydown',e=>{if(e.target.matches('input,select,textarea,[role=slider]')||$('workspace').hidden)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step((e.key==='ArrowLeft'?-1:1)*(e.shiftKey?10:1));}if(/^[123]$/.test(e.key))switchPane(Number(e.key)-1);});
})();
