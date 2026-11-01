# PNG2ANSI GPU research — GPU-004 profiled tiled photographic matcher and hardmode suite

This workbench is a **GPU-first fidelity experiment**, not a replacement for the existing PNG2ANSI release. The original `src/core.js` and pyANSI remain the CPU reference. The current photographed-art parity target is unchanged: classic CP437, 16 foreground/8 background colours, the original 32-glyph shortlist and identical fitting equations. The WebGPU path never reduces candidate counts or sampling to meet a time target.

## Install / run

Use the complete Windows installer (`setup.bat` / `start.bat`). The installer fetches a pinned upstream checkout on first launch; no prior GPU-001 or GPU-002 installation is required. No files under `src/core.js`, `src/app.js` or the existing `PNG2ANSI-web.html` release are changed.

```powershell
# Start in a PNG2ANSI checkout, after extracting the overlay ZIP into this directory.
npm test
py -m http.server 8000 --bind 127.0.0.1
```

Open `http://localhost:8000/experiments/webgpu/photographic.html` using a WebGPU-enabled browser. HTTPS and localhost are supported; direct `file://` is not guaranteed to expose WebGPU. The original standalone CPU HTML release remains unchanged.

- Upload an image or select a built-in **Hardmode image**, then click **Load sample**.
- Choose columns, rows, sampling density, foreground/background candidates and optional GPU tile target.
- Click **Compare CPU / GPU** to compare whole ANSI byte streams or uncheck **Compare against CPU** for GPU-only large research cases.
- Choose a **Benchmark preset**, click **Apply preset**, then click **Benchmark all five** to run the five original images sequentially with the same parameter configuration; save the resulting JSON report.
- The **Stop after current image** button stops a running suite between images (it cannot interrupt an in-flight GPU dispatch or synchronous CPU reference call).

## GPU work-unit limit: 125 billion

`src/gpu/workload.js` sets the GPU research ceiling to **125,000,000,000 work units**. This is independent of the original CPU app's unchanged **125,000,000** limit. Work units are a rough cost estimate copied from the reference photographic formula, **not** milliseconds, actual GPU operations or a memory guarantee. GPU-002's CPU comparison deliberately opts into the CPU oracle's work-limit override when selected.

The 125B ceiling does **not** expand the current PNG2ANSI schema: columns and rows each max 512; sample width max 16; sample height max 32; foreground max 12; background max 8. Invalid settings now show the parameter name, attempted value and supported range before calling `configFrom`, with an optional expandable technical stack. For example `sampleW=17` is a schema validation error, **not** a GPU dispatch or work-unit limit. The workbench also lifts its earlier narrower UI caps of 160 columns and 100 rows to the current core's 512-column/512-row maximum.

At high sampling/grid settings, preprocessing and preview creation can consume **hundreds of megabytes** in the browser, independent of GPU tiling. The original CPU conversion may take a long time when its reference work-limit override is requested. Disable CPU comparison for exploratory runs, then re-enable it for narrower reproducible parity checks. The UI does not silently downsample or reduce quality.

## GPU tiling and buffer allocation

`src/gpu/photographic.js` and `.wgsl` retain the same mathematical two-pass matcher. GPU-001 used one projection array and one one-dimensional dispatch for the entire output. GPU-002 does the following instead:

1. Derive an adaptive maximum tile size from device `maxComputeWorkgroupsPerDimension`, `maxStorageBufferBindingSize`, `maxBufferSize`, sample count and glyph count. Default preferred tile size is **16,384 cells**; the device may require smaller tiles.
2. Allocate one bounded set of per-tile raster/projection/result/readback buffers, and per-fit static glyph masks, glyph statistics and ANSI palette.
3. For each contiguous block of cells, pack their sample pixels into **cell-major** order, preserving sample iteration order. Update a uniform containing `tile_cell_count`.
4. Dispatch the projection and selection passes only for that tile, read back its compact `vec4<u32>` results, and stitch them into the global output arrays in stable cell order.
5. Keep the original best-score candidate order and tie-breaking; no candidate- or sample-reduction is introduced.

The same input image can be matched with a very small tile cap (e.g. 1, 2, 64) and a large tile cap (16,384) to stress boundaries. All outputs should be identical; the tile cap changes allocation/dispatch scheduling only. The workbench reports effective tile size and tile count. GPU work-unit estimates and shader profiles do not change with tile size.

## Hardmode benchmark corpus

The original-byte, user-supplied PNGs are stored in `fixtures/hardmode/`:

| Image | Resolution | Stress characteristics |
| --- | --- | --- |
| `holo-stealth-cloak-1024.png` | 1024×1024 | Saturated holographic fabric over detailed monochrome tiles |
| `oversharpened-forestry-crt-2048.png` | 2048×2048 | Dark rain, mud, reflections, foliage, high spatial frequency |
| `bland-blocks-2048.png` | 2048×2048 | Low-chroma geometry, repetitive tile lines and subtle shadows |
| `holo-boots-blocks-1024.png` | 1024×1024 | Detailed boots, saturated materials, low-key surroundings |
| `colour-blocks-2048.png` | 2048×2048 | Chromatic fine noise, alternating bright/dark surfaces |

`fixtures/hardmode/manifest.json` contains SHA-256 hashes, exact dimensions, descriptions and two reproducible preset configurations (`parity-baseline`, `dense-geometry`). The unit tests check each file's SHA-256, raw PNG signature and IHDR dimensions to detect accidental changes. The benchmark runner evaluates all five with the selected parameters and emits `png2ansi-webgpu-hardmode-v1` JSON including parity, timings, bytes, work estimates, tiling and image SHA-256. The image corpus is unmodified; no lossy transcode or pre-optimisation was performed.

## Performance/quality reporting (GPU-004)

The GPU-002 timing comparison was not end-to-end equivalent. **GPU-004 now separates one shared CPU prep stage from CPU fitting and GPU fitting**, and includes ANSI/PNG output stages for both pathways. The GPU timing includes packing, upload, tiled dispatch, readback and decoded cells. Optional hardware shader timestamps and expanded buffer/throughput metrics are reported when available, without guessing from host wait time. CPU reference matching is extracted without changing the production core; unit tests compare it with the original private function.

Read [WEBGPU_BENCHMARKS.md](WEBGPU_BENCHMARKS.md) for the exact measurement contract, stage meanings, reproducibility, JSON schema, and profiling workflow. User testing on GTX 1650 SUPER established good tiled throughput at 320×160 (16×16, FG8/BG8) with 9 ANSI-byte mismatches: **GPU-004 retains visibility of mismatches and does not claim unconditional exact parity.** Shader timestamps and GPU-004 host-stage outputs still need hardware qualification.

The corpus currently measures **photographic matching under neutral preprocessing**: no Derez, NL filter, or tonal changes. GPU industrial reconstruction, NL/filter parity, comprehensive source-stage parity, exhaustive glyph/palette research remain future work.

## Validation and acceptance

`npm test` retains the preexisting tests and adds `gpu_photo_contract`, `gpu_workload`, `hardmode_manifest`, `gpu_metrics`, `gpu_profiling` and `reference_photo`. The synthetic GPU mock checks multi-tile packing/order/stitching, cleanup, dispatch counts and device limit constraints. It is not a substitute for real WGSL compilation and parity on a discrete GPU.

For hardware qualification, run parity both sides of a boundary (e.g. **160×120** exceeds the GPU-001 un-tiled dispatch maximum for approximately 219 glyphs, but should now tile) and compare the same input/settings with tile targets 64 and 16,384. Record exact ANSI mismatches, first offset, GPU work units, effective tile count, and GPU/CPU timings across the five hardmode files. Zero mismatches is required; do not accept quality regressions for performance.

For future ASCIIomium integration, these WGSL kernels and the CPU-independent fitter can be hosted by native WebGPU (Dawn/wgpu) without committing to a Vulkan port. Cohesive-Techspression **section 5 only** informs later semantic intent/theme/feel controls; the rest of that spec is not a requirement here.

GPU-004 adds worker-based reference-fitting progress, tile-completion progress, hardened profiling, and cache-version separation. It does not change any WGSL matching equations, shader search constraints, preprocessing, or ANSI byte format. See `WEBGPU_BENCHMARKS.md`.

## GPU-006 note (VRAM and compute profiling)

GPU-006 raises the research **tile target** selector to 262,144, adds 2-D projection dispatches so larger physical tiles are possible within device storage limits, and displays device-clamped **effective** tile sizes. It introduces per-tile wall/host timing and per-pass GPU timestamp reporting (when exposed), plus a manually configured dedicated-VRAM preflight with a hard block at VRAM−2 GiB and a confirmed warning above VRAM−4 GiB. The CPU's original 125M work-unit guard remains unchanged and CPU parity benchmarking is now off by default. Consult `docs/WEBGPU_BENCHMARKS.md` for the exact estimation and safety contracts. No visual-quality shortcut or original fitter scoring change is introduced.

GPU-007 extends the research front end, not the original reference CPU renderer. See WEBGPU_BENCHMARKS.md for experimental streamed-image caveats.
