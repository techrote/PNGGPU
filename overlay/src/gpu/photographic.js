/**
 * GPU-007: pipelined tiled, reference-equivalent WebGPU photographic matching.
 *
 * The original PNG2ANSI CPU preprocessing and font atlas remain authoritative.
 * Tiling only changes the host-side packing and dispatch strategy: every cell
 * still evaluates precisely the same masks, 32-glyph shortlist and ANSI palette
 * candidates as the untiled GPU-001 reference.
 */
export class PhotographicWebGpuFitter {
  static WORKGROUP_SIZE = 64;
  static DEFAULT_TILE_CELLS = 16_384;
  static DEFAULT_TILE_MIB = 32;
  static PORTABLE_STORAGE_BINDING = 128 * 1024 * 1024;
  static PORTABLE_MAX_BUFFER = 256 * 1024 * 1024;
  static PORTABLE_WORKGROUP_LIMIT = 65_535;

  static available(gpu = globalThis.navigator?.gpu) {
    return Boolean(gpu && typeof gpu.requestAdapter === "function");
  }

  static async create(shaderSource, gpu = globalThis.navigator?.gpu) {
    if (!this.available(gpu)) throw new Error("WebGPU is unavailable: use HTTPS/localhost and a supported browser/GPU adapter");
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU did not expose an adapter; check browser settings and graphics drivers");
    // Timestamp queries are optional: never fail the renderer if the browser
    // blocks this privacy-sensitive feature or the adapter lacks support.
    let device;
    if (adapter.features?.has('timestamp-query')) {
      try { device = await adapter.requestDevice({requiredFeatures:['timestamp-query']}); }
      catch { /* Retry without timing instrumentation. */ }
    }
    if (!device) device = await adapter.requestDevice();
    const fitter = new this(device, shaderSource);
    const info=adapter.info;
    fitter.adapterInfo=info?{vendor:info.vendor||'',architecture:info.architecture||'',device:info.device||'',description:info.description||''}:null;
    try { await fitter.init(); } catch (error) { fitter.close(); throw error; }
    return fitter;
  }

  constructor(device, shaderSource) {
    this.device = device;
    this.shaderSource = shaderSource;
    this.pipelines = null;
    this.layout = null;
    this.lost = false;
    this.timestampsAvailable = Boolean(device.features?.has('timestamp-query'));
    this.adapterInfo = null;
    void device.lost.then(() => { this.lost = true; });
  }

  async init() {
    const device = this.device;
    const shader = device.createShaderModule({ label: "PNG2ANSI photographic tiled parity", code: this.shaderSource });
    const errors = await shader.getCompilationInfo();
    const failures = errors.messages.filter(m => m.type === "error");
    if (failures.length) throw new Error(`WGSL compilation failed: ${failures.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ")}`);
    const entries = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ...[1, 2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } })),
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ];
    this.layout = device.createBindGroupLayout({ entries });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const [project, select] = await Promise.all([
      device.createComputePipelineAsync({ layout, compute: { module: shader, entryPoint: "project_glyphs" } }),
      device.createComputePipelineAsync({ layout, compute: { module: shader, entryPoint: "select_cells" } })
    ]);
    this.pipelines = { project, select };
  }

  /** Resolve per-device tile limits before allocating any GPU buffers. */
  static tilePlan(device, { columns, rows, sampleWidth, sampleHeight, glyphCount, preferredTileCells = this.DEFAULT_TILE_CELLS, preferredTileMiB = null, inFlightTiles = 1 }) {
    const workgroups = device.limits.maxComputeWorkgroupsPerDimension ?? this.PORTABLE_WORKGROUP_LIMIT;
    const maxBinding = device.limits.maxStorageBufferBindingSize ?? this.PORTABLE_STORAGE_BINDING;
    const maxBuffer = device.limits.maxBufferSize ?? this.PORTABLE_MAX_BUFFER;
    const pixelsPerCell = sampleWidth * sampleHeight;
    if (!Number.isSafeInteger(inFlightTiles) || inFlightTiles < 1 || inFlightTiles > 24) {
      throw new RangeError("GPU in-flight tiles must be an integer from 1 to 24");
    }
    if (![workgroups, maxBinding, maxBuffer].every(x => Number.isSafeInteger(x) && x > 0)) {
      throw new RangeError("Device reports invalid WebGPU compute/buffer limits");
    }
    if (preferredTileMiB !== null && (!Number.isSafeInteger(preferredTileMiB) || preferredTileMiB < 1 || preferredTileMiB > 1024)) {
      throw new RangeError('Projection tile target must be an integer from 1 to 1024 MiB');
    }
    if (!Number.isSafeInteger(preferredTileCells) || preferredTileCells < 1) {
      throw new RangeError('GPU tile target must be a positive integer number of terminal cells');
    }
    const requestedCells = preferredTileMiB === null ? preferredTileCells :
      Math.max(1, Math.floor(preferredTileMiB * 1024 * 1024 / (glyphCount * 16)));
    const maxTile = Math.min(
      columns * rows,
      requestedCells,
      Math.floor(workgroups * workgroups * this.WORKGROUP_SIZE / glyphCount),
      Math.floor(workgroups * this.WORKGROUP_SIZE),
      Math.floor(Math.min(maxBinding, maxBuffer) / (glyphCount * 16)),
      Math.floor(Math.min(maxBinding, maxBuffer) / (pixelsPerCell * 4)),
      Math.floor(Math.min(maxBinding, maxBuffer) / 16)
    );
    if (maxTile < 1) {
      throw new RangeError("No valid GPU tile: per-cell projection/raster buffers exceed WebGPU storage-buffer limits");
    }
    const staticMaskBytes = glyphCount * pixelsPerCell * 4;
    const staticStatsBytes = glyphCount * 16;
    if (staticMaskBytes > Math.min(maxBinding, maxBuffer) || staticStatsBytes > Math.min(maxBinding, maxBuffer)) {
      throw new RangeError(`Glyph atlas exceeds this GPU's storage limit (${staticMaskBytes.toLocaleString()} mask bytes); smaller sample dimensions or atlas partitioning required`);
    }
    const projectionWorkgroups = Math.ceil(maxTile * glyphCount / this.WORKGROUP_SIZE);
    // Distribute groups approximately evenly across the two dimensions.
    // Simply filling X to 65,535 first can waste nearly an entire extra row
    // when the required group count exceeds a multiple by only one.
    const projectWorkgroupsY = Math.ceil(projectionWorkgroups/workgroups);
    const projectWorkgroupsX = Math.ceil(projectionWorkgroups/projectWorkgroupsY);
    return {
      requestedTileCells: requestedCells,
      requestedTileMiB: preferredTileMiB,
      effectiveProjectionMiB: maxTile * glyphCount * 16 / (1024 * 1024),
      requestedInFlightTiles: inFlightTiles,
      inFlightTiles: Math.min(inFlightTiles, Math.ceil(columns * rows / maxTile)),
      projectWorkgroupsX,projectWorkgroupsY,
      tileCells: maxTile,
      tileCount: Math.ceil(columns * rows / maxTile),
      projectionBufferBytes: maxTile * glyphCount * 16,
      rasterBufferBytes: maxTile * pixelsPerCell * 4,
      maxStorageBindingBytes: maxBinding,
      maxBufferBytes: maxBuffer,
      maxWorkgroups: workgroups
    };
  }

  /**
   * @param {object} data
   * @param {Uint8Array|Uint8ClampedArray} data.pixels - RGBA8 after CPU preprocessing (row-major image).
   * @param {Float32Array[]} data.masks - Original low-resolution per-glyph alpha masks.
   * @param {number[][]} data.palette - Original 16-colour ANSI palette.
   * @param {number} [data.preferredTileCells] - Optional host-side tile cap, default 16,384.
   * @returns {Promise<{chosen:Uint16Array,fg:Uint8Array,bg:Uint8Array,stats:object}>}
   */
  async fit(data) {
    if (!this.pipelines || this.lost) throw new Error("WebGPU fitter is uninitialised or its device was lost");
    const { pixels, masks, palette, columns, rows, sampleWidth, sampleHeight,
      foregroundCandidates, backgroundCandidates, preferredTileCells = PhotographicWebGpuFitter.DEFAULT_TILE_CELLS,
      preferredTileMiB = null, sampleProvider = null,
      captureGpuTimestamps = true, inFlightTiles = 1, onProgress = null } = data;
    const now=()=>performance.now();
    const timedStart=now();
    const positive = (n, name) => {
      if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer`);
      return n;
    };
    for (const [name, n] of Object.entries({ columns, rows, sampleWidth, sampleHeight })) positive(n, name);
    const cells = columns * rows, samples = sampleWidth * sampleHeight, glyphCount = masks?.length;
    if (!Number.isSafeInteger(cells * glyphCount) || glyphCount < 1 || glyphCount > 65535)
      throw new RangeError("Invalid cell or glyph count");
    if (!Number.isInteger(foregroundCandidates) || foregroundCandidates < 1 || foregroundCandidates > 12 ||
        !Number.isInteger(backgroundCandidates) || backgroundCandidates < 1 || backgroundCandidates > 8)
      throw new RangeError("Invalid ANSI candidate counts: foreground 1–12; background 1–8");
    if ((sampleProvider ? typeof sampleProvider !== 'function' : pixels?.length !== cells * samples * 4) ||
        masks.some(mask => mask.length !== samples) || palette?.length !== 16 ||
        palette.some(rgb => rgb.length !== 3)) throw new RangeError("Pixel/mask/palette geometry mismatch");

    const plan = PhotographicWebGpuFitter.tilePlan(this.device, {
      columns, rows, sampleWidth, sampleHeight, glyphCount, preferredTileCells, preferredTileMiB, inFlightTiles
    });
    const chosen = new Uint16Array(cells), fg = new Uint8Array(cells), bg = new Uint8Array(cells);
    const timing={
      atlasPackMs:0, bufferCreateMs:0, tilePackMs:0, writeBufferMs:0,
      encodeSubmitMs:0, readbackWaitMs:0, decodeCellsMs:0, sampleProviderMs:0,
      timestampsReadMs:0, gpuProjectionMs:null, gpuSelectionMs:null,
      slotAvailabilityWaitMs:0,firstTileCompletedMs:null,wallTotalMs:0
    };
    let checkpoint=now();
    const lowMasks = new Float32Array(glyphCount * samples);
    const maskStats = new Float32Array(glyphCount * 4);
    for (let g = 0; g < glyphCount; g++) {
      lowMasks.set(masks[g], g * samples);
      let sum = 0, squareSum = 0;
      for (const value of masks[g]) { sum += value; squareSum += value * value; }
      const mean = sum / samples;
      maskStats[g * 4] = mean;
      maskStats[g * 4 + 1] = squareSum;
      maskStats[g * 4 + 2] = Math.max(squareSum - sum * sum / samples, 1e-8);
    }
    const paletteBytes = new Float32Array(16 * 4);
    for (let i = 0; i < 16; i++) paletteBytes.set(palette[i], i * 4);
    timing.atlasPackMs=now()-checkpoint;
    const device = this.device;
    let allocatedBytes=0, uploadedBytes=0, readbackBytes=0;
    const buffers = [];
    const input = (label, bytes, type = GPUBufferUsage.STORAGE) => {
      const buffer = device.createBuffer({ label, size: Math.max(4, bytes.byteLength),
        usage: type | GPUBufferUsage.COPY_DST });
      buffers.push(buffer); allocatedBytes+=buffer.size||Math.max(4,bytes.byteLength);
      const start=now();device.queue.writeBuffer(buffer, 0, bytes);
      timing.writeBufferMs+=now()-start;uploadedBytes+=bytes.byteLength;return buffer;
    };
    const alloc = (label, size, usage) => {
      const buffer = device.createBuffer({ label, size: Math.max(4, size), usage });
      buffers.push(buffer);allocatedBytes+=buffer.size||Math.max(4,size);return buffer;
    };
    let querySet=null;
    try {
      // Atlas and palette are immutable throughout a fit. Each in-flight tile
      // owns DISTINCT uniforms, raster, projections, selections and readback.
      // Without separate per-tile bindings, queue.writeBuffer would overwrite
      // a queued job before its compute pass consumes the data.
      const glyphs = input("PNG2ANSI low masks", lowMasks);
      const stats = input("PNG2ANSI glyph statistics", maskStats);
      const colours = input("PNG2ANSI ANSI palette", paletteBytes);
      let queryBuffer=null,queryReadback=null;
      let timestampReason='timestamp-query not supported/requested by browser or adapter';
      const canTimestamp=Boolean(captureGpuTimestamps&&this.timestampsAvailable&&device.createQuerySet);
      const count=plan.tileCount*4;
      if(canTimestamp&&count<=(device.limits.maxQuerySetSize??8192)){
        querySet=device.createQuerySet({type:'timestamp',count});
        queryBuffer=alloc('PNG2ANSI timestamp resolve',count*8,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC);
        queryReadback=alloc('PNG2ANSI timestamp map',count*8,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
        timestampReason=null;
      }else if(canTimestamp){timestampReason='tile count exceeds supported query set size';}
      else if(!captureGpuTimestamps){timestampReason='disabled in workbench';}

      const slots=[];
      for(let i=0;i<plan.inFlightTiles;i++){
        const suffix=plan.inFlightTiles===1?'':` [slot ${i+1}]`;
        const uniform = input('PNG2ANSI settings'+suffix,new Uint32Array(8),GPUBufferUsage.UNIFORM);
        const raster = alloc('PNG2ANSI packed tile RGB8'+suffix,plan.rasterBufferBytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
        const dots = alloc('PNG2ANSI tile projections'+suffix,plan.projectionBufferBytes,GPUBufferUsage.STORAGE);
        const selected = alloc('PNG2ANSI tile cells'+suffix,plan.tileCells*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
        const readback = alloc('PNG2ANSI tile readback'+suffix,plan.tileCells*16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
        const bindGroup=device.createBindGroup({layout:this.layout,
          entries:[uniform,raster,glyphs,stats,colours,dots,selected].map((buffer,binding)=>({binding,resource:{buffer}}))});
        slots.push({uniform,raster,dots,selected,readback,bindGroup,
          rgbaPacked:new Uint32Array(plan.tileCells*samples)});
      }
      const sourceWidth=columns*sampleWidth;
      timing.bufferCreateMs=now()-timedStart-timing.atlasPackMs-timing.writeBufferMs;
      let completedCells=0,completedTiles=0,peakInFlightTiles=0;
      const tileMeasurements=new Array(plan.tileCount);

      // Launch is synchronous through queue.submit(), yielding only while
      // waiting for its OWN readback. Other slots can be submitted meanwhile.
      // The WebGPU queue remains ordered: this is a host/GPU overlap and
      // buffering strategy, NOT a promise of simultaneous GPU shader dispatch.
      async function launchTile(slot,tileIndex,tileStart,tileCount){
        const tileStartMs=now();
        const tileStats={index:tileIndex+1,cells:tileCount,sourceSampleMs:0,packMs:0,uploadEnqueueMs:0,encodeSubmitMs:0,
          mapWaitMs:0,decodeMs:0,wallMs:0,projectionMs:null,selectionMs:null};
        let partStart=now();
        const rgbaPacked=slot.rgbaPacked;
        if(sampleProvider){
          const sourceStart=now();
          const tileRGBA=await sampleProvider(tileStart,tileCount);
          tileStats.sourceSampleMs=now()-sourceStart;
          timing.sampleProviderMs+=tileStats.sourceSampleMs;
          if(!(tileRGBA instanceof Uint8Array || tileRGBA instanceof Uint8ClampedArray) || tileRGBA.length !== tileCount*samples*4)
            throw new RangeError('Tile sample provider returned invalid RGBA geometry');
          for(let i=0;i<tileCount*samples;i++){
            const pos=i*4;
            rgbaPacked[i]=tileRGBA[pos]|(tileRGBA[pos+1]<<8)|(tileRGBA[pos+2]<<16);
          }
        }else{
          for(let local=0;local<tileCount;local++){
            const cell=tileStart+local,cx=cell%columns,cy=Math.floor(cell/columns);
            for(let sy=0;sy<sampleHeight;sy++){
              let source=((cy*sampleHeight+sy)*sourceWidth+cx*sampleWidth)*4;
              let dest=local*samples+sy*sampleWidth;
              for(let sx=0;sx<sampleWidth;sx++,source+=4,dest++){
                rgbaPacked[dest]=pixels[source]|(pixels[source+1]<<8)|(pixels[source+2]<<16);
              }
            }
          }
        }
        tileStats.packMs=now()-partStart;timing.tilePackMs+=tileStats.packMs;
        const projectionGroups=Math.ceil(tileCount*glyphCount/PhotographicWebGpuFitter.WORKGROUP_SIZE);
        const dispatchY=Math.ceil(projectionGroups/plan.maxWorkgroups);
        const dispatchX=Math.ceil(projectionGroups/dispatchY);
        const geometry=new Uint32Array([dispatchX,rows,sampleWidth,sampleHeight,
          glyphCount,foregroundCandidates,backgroundCandidates,tileCount]);
        partStart=now();
        device.queue.writeBuffer(slot.uniform,0,geometry);
        device.queue.writeBuffer(slot.raster,0,rgbaPacked.subarray(0,tileCount*samples));
        tileStats.uploadEnqueueMs=now()-partStart;timing.writeBufferMs+=tileStats.uploadEnqueueMs;
        uploadedBytes+=geometry.byteLength+tileCount*samples*4;
        partStart=now();
        const encoder=device.createCommandEncoder();
        let pass=encoder.beginComputePass(querySet?{timestampWrites:{querySet,
          beginningOfPassWriteIndex:tileIndex*4,endOfPassWriteIndex:tileIndex*4+1}}:{});
        pass.setPipeline(this.pipelines.project);pass.setBindGroup(0,slot.bindGroup);
        pass.dispatchWorkgroups(dispatchX,dispatchY);pass.end();
        pass=encoder.beginComputePass(querySet?{timestampWrites:{querySet,
          beginningOfPassWriteIndex:tileIndex*4+2,endOfPassWriteIndex:tileIndex*4+3}}:{});
        pass.setPipeline(this.pipelines.select);pass.setBindGroup(0,slot.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(tileCount/PhotographicWebGpuFitter.WORKGROUP_SIZE));pass.end();
        encoder.copyBufferToBuffer(slot.selected,0,slot.readback,0,tileCount*16);
        device.queue.submit([encoder.finish()]);
        tileStats.encodeSubmitMs=now()-partStart;timing.encodeSubmitMs+=tileStats.encodeSubmitMs;
        partStart=now();
        await slot.readback.mapAsync(GPUMapMode.READ);
        tileStats.mapWaitMs=now()-partStart;timing.readbackWaitMs+=tileStats.mapWaitMs;
        readbackBytes+=tileCount*16;
        partStart=now();
        try{
          const result=new Uint32Array(slot.readback.getMappedRange(0,tileCount*16).slice(0));
          for(let i=0;i<tileCount;i++){
            chosen[tileStart+i]=result[i*4];fg[tileStart+i]=result[i*4+1];bg[tileStart+i]=result[i*4+2];
          }
        }finally{slot.readback.unmap();}
        tileStats.decodeMs=now()-partStart;timing.decodeCellsMs+=tileStats.decodeMs;
        tileStats.wallMs=now()-tileStartMs;
        tileMeasurements[tileIndex]=tileStats;
        completedTiles++;completedCells+=tileCount;
        if(timing.firstTileCompletedMs===null)timing.firstTileCompletedMs=now()-timedStart;
        if(onProgress)onProgress({type:'progress',stage:'gpu',completedCells,totalCells:cells,
          completedTiles,totalTiles:plan.tileCount,elapsedMs:now()-timedStart,
          inFlightCapacity:plan.inFlightTiles});
        return {slot,index:tileIndex};
      }
      const available=[...slots],active=new Map();
      async function retireOne(){
        const waiting=now();
        const finished=await Promise.race(active.values());
        timing.slotAvailabilityWaitMs+=now()-waiting;
        active.delete(finished.index);available.push(finished.slot);
      }
      try{
        for(let tileIndex=0;tileIndex<plan.tileCount;tileIndex++){
          if(this.lost)throw new Error('WebGPU device lost during tiled matching');
          if(!available.length)await retireOne();
          const slot=available.shift(),tileStart=tileIndex*plan.tileCells;
          const tileCount=Math.min(plan.tileCells,cells-tileStart);
          active.set(tileIndex,launchTile.call(this,slot,tileIndex,tileStart,tileCount));
          peakInFlightTiles=Math.max(peakInFlightTiles,active.size);
        }
        while(active.size)await retireOne();
      }catch(error){
        // Do not destroy mapped/in-use buffers while other submitted tiles run.
        await Promise.allSettled([...active.values()]);
        throw error;
      }
      if(querySet){
        checkpoint=now();
        const encoder=device.createCommandEncoder();
        encoder.resolveQuerySet(querySet,0,count,queryBuffer,0);
        encoder.copyBufferToBuffer(queryBuffer,0,queryReadback,0,count*8);
        device.queue.submit([encoder.finish()]);
        await queryReadback.mapAsync(GPUMapMode.READ);
        try{
          const stamps=new BigUint64Array(queryReadback.getMappedRange().slice(0));
          let projection=0,selection=0;
          for(let i=0;i<plan.tileCount;i++){
            const project=Number(stamps[i*4+1]-stamps[i*4])/1_000_000;
            const select=Number(stamps[i*4+3]-stamps[i*4+2])/1_000_000;
            tileMeasurements[i].projectionMs=project;
            tileMeasurements[i].selectionMs=select;
            projection+=project;selection+=select;
          }
          timing.gpuProjectionMs=projection;timing.gpuSelectionMs=selection;
        }finally{queryReadback.unmap();}
        timing.timestampsReadMs=now()-checkpoint;
      }
      timing.wallTotalMs=now()-timedStart;
      return {chosen,fg,bg,stats:{version:'GPU-007',...plan,timing,tileMeasurements,
        peakInFlightTiles,uploadedBytes,readbackBytes,allocatedBytes,
        timestampReason,adapterInfo:this.adapterInfo,
        sampleComparisons:cells*glyphCount*samples*3,
        glyphCandidates:cells*glyphCount,
        colourCandidates:cells*Math.min(32,glyphCount)*foregroundCandidates*backgroundCandidates
      }};
    }finally{
      if(querySet)querySet.destroy();
      for(const buffer of buffers)buffer.destroy();
    }
  }

  close() { this.device.destroy(); this.lost = true; }
}
