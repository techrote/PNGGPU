/**
 * PNG2ANSI GPU-006: dependency-free ZIP32/STORE benchmark archive.
 * No network library or compression is required, so this also works offline.
 * Individual JSON files can be inspected with any normal ZIP reader.
 */
const encoder = new TextEncoder();
const table = new Uint32Array(256);
for (let i=0;i<256;i++) {
  let c=i;
  for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;
  table[i]=c>>>0;
}
export function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
const u16=(dv,at,n)=>dv.setUint16(at,n,true);
const u32=(dv,at,n)=>dv.setUint32(at,n,true);
function dosDateTime(now){
  const year=Math.max(1980,Math.min(2107,now.getUTCFullYear()));
  return {date:((year-1980)<<9)|((now.getUTCMonth()+1)<<5)|now.getUTCDate(),
    time:(now.getUTCHours()<<11)|(now.getUTCMinutes()<<5)|(now.getUTCSeconds()>>1)};
}
/** Entries: {name: relative forward-slash path, content: UTF8 string or Uint8Array}.
 * Return Blob of application/zip. Explicitly reject ZIP64-sized archives.
 */
export function benchmarkZip(entries, created=new Date()){
  if(!Array.isArray(entries)||entries.length===0||entries.length>65535)throw new RangeError('ZIP needs 1–65,535 entries');
  const parts=[],central=[],names=new Set();let offset=0,centralLength=0;
  const {date,time}=dosDateTime(created);
  for(const entry of entries){
    const name=entry?.name;
    if(typeof name!=='string'||name.length===0||name.startsWith('/')||name.includes('\\')||
       name.split('/').some(part=>part===''||part==='.'||part==='..')||names.has(name)){
      throw new RangeError('Unsafe, duplicate or empty ZIP entry path: '+name);
    }
    names.add(name);
    const filename=encoder.encode(name);
    const content=entry.content instanceof Uint8Array?entry.content:encoder.encode(String(entry.content??''));
    if(filename.length>65535||content.length>0xffffffff)throw new RangeError('ZIP32 entry exceeds limits');
    const size=content.byteLength,checksum=crc32(content);
    const local=new Uint8Array(30+filename.length),l=new DataView(local.buffer);
    u32(l,0,0x04034b50);u16(l,4,20);u16(l,6,0x0800);u16(l,8,0);
    u16(l,10,time);u16(l,12,date);u32(l,14,checksum);u32(l,18,size);u32(l,22,size);
    u16(l,26,filename.length);u16(l,28,0);local.set(filename,30);
    const directory=new Uint8Array(46+filename.length),c=new DataView(directory.buffer);
    u32(c,0,0x02014b50);u16(c,4,20);u16(c,6,20);u16(c,8,0x0800);u16(c,10,0);
    u16(c,12,time);u16(c,14,date);u32(c,16,checksum);u32(c,20,size);u32(c,24,size);
    u16(c,28,filename.length);u16(c,30,0);u16(c,32,0);u16(c,34,0);u16(c,36,0);
    u32(c,38,0);u32(c,42,offset);directory.set(filename,46);
    if(offset+local.length+size>0xffffffff)throw new RangeError('ZIP32 archive exceeds 4 GiB');
    parts.push(local,content);central.push(directory);
    offset+=local.length+size;centralLength+=directory.length;
  }
  if(offset+centralLength+22>0xffffffff)throw new RangeError('ZIP32 archive exceeds 4 GiB');
  const end=new Uint8Array(22),v=new DataView(end.buffer);
  u32(v,0,0x06054b50);u16(v,4,0);u16(v,6,0);
  u16(v,8,entries.length);u16(v,10,entries.length);
  u32(v,12,centralLength);u32(v,16,offset);u16(v,20,0);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}
export function csvRows(rows){
  const escape=v=>{const s=v===null||v===undefined?'':String(v);return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
  return rows.map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n';
}
