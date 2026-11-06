/* Raw CP437 + ANSI SGR decoder for original PNG2ANSI exports. No terminal execution. */
(function(root){
  'use strict';
  const CP437="\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\x7fÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
  const LIMITS=Object.freeze({maxCells:51200,maxFrameBytes:2*1024*1024,maxPixels:8388608,maxSettingsBytes:32*1024*1024,maxFiles:50000,maxVariants:96});
  const positive=(n,max)=>Number.isSafeInteger(n)&&n>=1&&n<=max;
  function geometry(columns,rows){if(!positive(columns,320)||!positive(rows,160)||columns*rows>LIMITS.maxCells)throw Error('Unsupported frame geometry (maximum 320×160 characters).');return columns*rows;}
  function decodeAnsi(bytes,{columns,rows,codes}){
    const count=geometry(columns,rows);
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>LIMITS.maxFrameBytes)throw Error('ANSI frame exceeds the 2 MiB bound or is empty.');
    if(!Array.isArray(codes)||!codes.length||codes.length>256||new Set(codes).size!==codes.length||codes.some(c=>!Number.isInteger(c)||c<32||c>255))throw Error('Invalid CP437 vocabulary.');
    const allowed=new Set(codes),glyph=new Uint8Array(count),fg=new Uint8Array(count),bg=new Uint8Array(count);
    let at=0,bold=false,explicitBright=false,foreground=7,background=0,closed=false;
    for(let p=0;p<bytes.length;){
      const b=bytes[p++];
      if(b===27){
        if(bytes[p++]!==91)throw Error('Unsupported ANSI control: only CSI SGR is accepted.');
        let body='';while(p<bytes.length&&bytes[p]!==109){if(body.length>=40||!(bytes[p]===59||bytes[p]>=48&&bytes[p]<=57))throw Error('Malformed or unsupported ANSI control.');body+=String.fromCharCode(bytes[p++]);}
        if(p>=bytes.length||bytes[p++]!==109)throw Error('Truncated ANSI SGR sequence.');
        const values=body===''?[0]:body.split(';').map(s=>{if(!/^\d{1,3}$/.test(s))throw Error('Invalid SGR parameter.');return Number(s);});
        for(const v of values){
          if(v===0){bold=false;explicitBright=false;foreground=7;background=0;if(at===count)closed=true;}
          else if(v===1)bold=true;
          else if(v===22)bold=false;
          else if(v>=30&&v<=37){foreground=v-30;explicitBright=false;}
          else if(v>=40&&v<=47)background=v-40;
          else if(v>=90&&v<=97){foreground=v-90;explicitBright=true;}
          else if(v>=100&&v<=107)background=v-100+8;
          else throw Error(`Unsupported SGR ${v}; this viewer accepts the exported 16-color palette only.`);
        }
        continue;
      }
      if(b===10||b===13){if(at===0||at%columns!==0)throw Error('Unexpected line break inside a row.');if(b===13&&bytes[p]===10)++p;continue;}
      if(b<32||!allowed.has(b))throw Error(`Glyph byte 0x${b.toString(16)} is not in this frame's CP437 atlas.`);
      if(at>=count)throw Error('ANSI frame contains too many cells.');
      glyph[at]=b;fg[at]=foreground+(bold||explicitBright?8:0);bg[at]=background;++at;
    }
    if(at!==count)throw Error(`ANSI cell count ${at} differs from ${columns}×${rows}.`);
    if(!closed)throw Error('ANSI export is missing its closing reset.');
    return {columns,rows,glyph,fg,bg};
  }
  function decodeAtlas(variant){
    const {geometry:g,codes,palette,highAtlas:a}=variant;if(!g||!a)throw Error('Settings are missing frame geometry or the original glyph atlas.');geometry(g.columns,g.rows);
    if(!Array.isArray(codes)||!codes.length||codes.length>256||new Set(codes).size!==codes.length||codes.some(c=>!Number.isInteger(c)||c<32||c>255))throw Error('Invalid glyph codes.');
    if(!Array.isArray(palette)||palette.length!==16||palette.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255)))throw Error('Invalid 16-color palette.');
    if(!positive(a.width,64)||!positive(a.height,64)||g.columns*a.width*g.rows*a.height>LIMITS.maxPixels||typeof a.alpha!=='string'||a.alpha.length>2*1024*1024)throw Error('Glyph atlas/rendering size exceeds limits.');
    const text=typeof atob==='function'?atob(a.alpha):Buffer.from(a.alpha,'base64').toString('binary');
    if(text.length!==codes.length*a.width*a.height)throw Error('Glyph atlas byte count differs from its settings.');
    const alpha=Uint8Array.from(text,ch=>ch.charCodeAt(0)),indices=new Int16Array(256).fill(-1);codes.forEach((c,i)=>indices[c]=i);return {width:a.width,height:a.height,alpha,indices,palette,codes};
  }
  function renderRgba(frame,atlas){
    const width=frame.columns*atlas.width,height=frame.rows*atlas.height;if(width*height>LIMITS.maxPixels)throw Error('Rendered frame exceeds the pixel bound.');
    const pixels=new Uint8ClampedArray(width*height*4),area=atlas.width*atlas.height;
    for(let cell=0;cell<frame.glyph.length;cell++){
      const glyph=atlas.indices[frame.glyph[cell]];if(glyph<0)throw Error('Glyph missing from bitmap atlas.');const f=atlas.palette[frame.fg[cell]],b=atlas.palette[frame.bg[cell]];if(!f||!b)throw Error('Invalid frame palette index.');
      const cx=cell%frame.columns,cy=Math.floor(cell/frame.columns);
      for(let y=0;y<atlas.height;y++)for(let x=0;x<atlas.width;x++){const m=Math.fround(atlas.alpha[glyph*area+y*atlas.width+x]/255),p=((cy*atlas.height+y)*width+cx*atlas.width+x)*4;for(let k=0;k<3;k++)pixels[p+k]=Math.floor(b[k]+m*(f[k]-b[k])+.5);pixels[p+3]=255;}
    }return {width,height,pixels};
  }
  function compare(a,b){if(a.columns!==b.columns||a.rows!==b.rows)throw Error('Compare frames at the same character grid.');const mask=new Uint8Array(a.glyph.length);let changed=0;for(let i=0;i<mask.length;i++)if(a.glyph[i]!==b.glyph[i]||a.fg[i]!==b.fg[i]||a.bg[i]!==b.bg[i]){mask[i]=1;++changed;}return {changed,cells:mask.length,mask};}
  function rotation(value=0){if(![0,90,180,270].includes(value))throw Error('Display rotation must be 0, 90, 180 or 270 degrees clockwise.');return value;}
  function displayDimensions(width,height,degrees=0){rotation(degrees);if(!positive(width,LIMITS.maxPixels)||!positive(height,LIMITS.maxPixels)||width*height>LIMITS.maxPixels)throw Error('Display pixel bound exceeded.');return degrees===90||degrees===270?{width:height,height:width}:{width,height};}
  function displayToNative(x,y,width,height,degrees=0){const d=displayDimensions(width,height,degrees);if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=d.width||y>=d.height)return null;switch(degrees){case 90:return{x:y,y:height-1-x};case 180:return{x:width-1-x,y:height-1-y};case 270:return{x:width-1-y,y:x};default:return{x,y};}}
  function rotateRgba(image,degrees=0){const d=displayDimensions(image.width,image.height,degrees);if(!(image.pixels instanceof Uint8ClampedArray)||image.pixels.length!==image.width*image.height*4)throw Error('Invalid RGBA image.');if(degrees===0)return image;const pixels=new Uint8ClampedArray(image.pixels.length);for(let y=0;y<d.height;y++)for(let x=0;x<d.width;x++){let sx,sy;if(degrees===90){sx=y;sy=image.height-1-x;}else if(degrees===180){sx=image.width-1-x;sy=image.height-1-y;}else{sx=image.width-1-y;sy=x;}const src=(sy*image.width+sx)*4,dest=(y*d.width+x)*4;pixels[dest]=image.pixels[src];pixels[dest+1]=image.pixels[src+1];pixels[dest+2]=image.pixels[src+2];pixels[dest+3]=image.pixels[src+3];}return{...d,pixels};}
  function wipeBoundary(width,percent){if(!positive(width,LIMITS.maxPixels)||typeof percent!=='number'||!Number.isFinite(percent))throw Error('Invalid wipe geometry.');return Math.round(width*Math.max(0,Math.min(100,percent))/100);}
  function fitScale(images,availableWidth,availableHeight){if(!images.length||!Number.isFinite(availableWidth)||!Number.isFinite(availableHeight)||availableWidth<=0||availableHeight<=0)throw Error('Invalid fit area.');for(const im of images)displayDimensions(im.width,im.height);return Math.min(1,availableWidth/Math.max(...images.map(im=>im.width)),availableHeight/Math.max(...images.map(im=>im.height)));}
  function cellsComparable(a,b){return a.frame.columns===b.frame.columns&&a.frame.rows===b.frame.rows&&a.variant.atlas.width===b.variant.atlas.width&&a.variant.atlas.height===b.variant.atlas.height&&rotation(a.variant.displayRotationDegrees??0)===rotation(b.variant.displayRotationDegrees??0);}
  root.AnsiCompare=Object.freeze({CP437,LIMITS,decodeAnsi,decodeAtlas,renderRgba,compare,geometry,rotation,displayDimensions,displayToNative,rotateRgba,wipeBoundary,fitScale,cellsComparable});
})(typeof globalThis==='object'?globalThis:this);
