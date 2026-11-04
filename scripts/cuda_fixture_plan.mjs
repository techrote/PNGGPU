/** Pure host-side planning. No worker or browser is opened by this module. */
export function parseFixtureArgs(args) {
  const options={cases:[],repeats:1,tiles:[1],maxCells:1,maxWork:10000000,maxRuns:1,timeoutMs:10000,cudaMode:'float32-guarded-binary64'};
  const positionals=[];
  const integer=(s,name)=>{
    if(!/^[1-9][0-9]*$/.test(s??'')||!Number.isSafeInteger(Number(s)))throw new Error(`${name} must be a positive safe integer`);
    return Number(s);
  };
  const seen=new Set();
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(!flag.startsWith('--')){positionals.push(flag);continue;}
    if(flag==='--case') {const name=args[++i];if(!name||name.startsWith('--')||options.cases.includes(name))throw new Error('Expected unique exact --case NAME');options.cases.push(name);continue;}
    if(seen.has(flag))throw new Error(`Duplicate flag ${flag}`);seen.add(flag);
    if(flag==='--suite'||flag==='--list'||flag==='--help'){options[flag.slice(2)]=true;continue;}
    if(flag==='--allow-parity-differences'){options.allowParityDifferences=true;continue;}
    if(flag==='--skip-cpu'){options.skipCpu=true;continue;}
    if(!['--repeats','--tiles','--tile-mib','--max-cells','--max-work','--max-runs','--timeout-ms','--webgpu','--fixture-file','--cuda-mode'].includes(flag))throw new Error(`Unknown flag ${flag}`);
    const value=args[++i];
    if(flag==='--tile-mib'){options.tileMiB=integer(value,flag);if(options.tileMiB>32)throw new Error('Benchmark projection tile cap is 32 MiB');continue;}
    if(flag==='--cuda-mode'){if(!['float32-guarded-binary64','binary64-direct','float32-direct','float16-mixed'].includes(value))throw new Error('Unsupported CUDA arithmetic mode');options.cudaMode=value;continue;}
    if(flag==='--webgpu'){if(!value||value.startsWith('--'))throw new Error('Expected --webgpu PLAYWRIGHT_MODULE');options.webgpu=value;continue;}
    if(flag==='--fixture-file'){if(!value||value.startsWith('--'))throw new Error('Expected --fixture-file PATH');options.fixtureFile=value;continue;}
    if(flag==='--tiles') {
      options.tiles=(value??'').split(',').map(v=>integer(v,flag));
      if(new Set(options.tiles).size!==options.tiles.length||options.tiles.some(v=>v>65536))throw new Error('Tiles must be unique and at most 65536');
    } else {
      const key={'--repeats':'repeats','--max-cells':'maxCells','--max-work':'maxWork','--max-runs':'maxRuns','--timeout-ms':'timeoutMs'}[flag];
      options[key]=integer(value,flag);
    }
  }
  if(options.repeats>100||options.timeoutMs>30000)throw new Error('At most 100 repeats and 30000 ms timeout');
  if(options.suite&&options.cases.length)throw new Error('--suite and --case are mutually exclusive');
  if(options.suite&&options.fixtureFile)throw new Error('Prepared image input requires an exact --case');
  if(options.skipCpu&&!options.allowParityDifferences)throw new Error('--skip-cpu requires explicit --allow-parity-differences');
  if(options.tileMiB&&seen.has('--tiles'))throw new Error('Choose --tiles or --tile-mib, not both');
  if(!options.help&&!options.list&&(!positionals[0]||!positionals[1]||positionals.length!==2||(!options.suite&&!options.cases.length)))
    throw new Error('Specify WORKER OUTPUT_JSON and exact --case NAME (or explicit --suite). Use --help.');
  return {...options,worker:positionals[0],output:positionals[1]};
}

export function planFixtures(fixtures,options) {
  if(new Set(fixtures.map(f=>f.name)).size!==fixtures.length)throw new Error('Duplicate fixture names');
  for(const name of options.cases)if(!fixtures.some(f=>f.name===name))throw new Error(`Unknown exact case ${name}`);
  const selected=fixtures.filter(f=>options.suite||options.cases.includes(f.name));
  if(!selected.length)throw new Error('No cases selected');
  const backendCount=options.webgpu?2n:1n;
  let cells=0n,work=0n;
  const runs=[];
  for(const data of selected)for(const tileCells of options.tileMiB?[Math.max(1,Math.floor(options.tileMiB*1024*1024/(data.masks.length*16)))]:options.tiles)for(let repeat=0;repeat<options.repeats;repeat++) {
    const count=BigInt(data.columns)*BigInt(data.rows),glyphs=BigInt(data.masks.length),samples=BigInt(data.sampleWidth)*BigInt(data.sampleHeight);
    // Conservative logical visits for BOTH float32/guard and binary64 recovery:
    // RGB projection samples, shortlist glyphs and every retained glyph/color pair.
    // This is an input-work bound, not a FLOP count or watchdog-time guarantee.
    const keep=glyphs<32n?glyphs:32n,nf=BigInt(data.foregroundCandidates),nb=BigInt(data.backgroundCandidates);
    const visits=2n*count*(glyphs*samples*3n+samples+glyphs*(keep+1n)+16n*nf+8n*nb+keep*nf*nb);
    cells+=count*backendCount;work+=visits*backendCount;
    if(BigInt(runs.length+1)*backendCount>BigInt(options.maxRuns)||cells>BigInt(options.maxCells)||work>BigInt(options.maxWork))
      throw new Error('Planned aggregate exceeds --max-runs, --max-cells or --max-work; no GPU work started');
    runs.push({data,tileCells,repeat});
  }
  return {runs,summary:{caseNames:selected.map(f=>f.name),repeats:options.repeats,tiles:options.tileMiB?[...new Set(runs.map(r=>r.tileCells))]:options.tiles,
    tileMiB:options.tileMiB??null,backendCount:Number(backendCount),runs:runs.length*Number(backendCount),cells:Number(cells),work:Number(work),
    workUnit:'conservative logical projection/shortlist/candidate visits including full recovery, across all backends',
    limits:{maxRuns:options.maxRuns,maxCells:options.maxCells,maxWork:options.maxWork,timeoutMs:options.timeoutMs}}};
}
